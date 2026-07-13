/**
 * Robust, reusable SSE (Server-Sent Events) consumer for the frontend.
 *
 * Features:
 * - Proper SSE frame parsing: handles arbitrary chunk boundaries, multi-line data,
 *   event/data/id/retry fields, comment lines, and blank-line frame delimiters.
 * - Auto-reconnect with exponential backoff (capped at MAX_RECONNECT_DELAY_MS).
 * - Sends Last-Event-ID header on reconnect for cursor-based replay.
 * - Handles 401 responses by attempting token refresh before reconnecting.
 * - Supports [DONE] / done event termination.
 * - Does NOT infinitely reconnect when there are no active subscribers.
 * - Exposes connection state callbacks for UI indication.
 *
 * Protocol reference: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

export interface SseEvent {
  /** Event type (from `event:` field), defaults to 'message'. */
  event: string;
  /** Event data (from `data:` field(s), joined by newlines). */
  data: string;
  /** Event ID (from `id:` field), if present. */
  id: string | null;
  /** Retry interval in ms (from `retry:` field), if present. */
  retry: number | null;
}

export interface SseConsumerOptions {
  /** URL or path to fetch (relative URLs resolved against base URL). */
  url: string;
  /** Authorization token (Bearer). If provided, added as Authorization header. */
  token?: string | null;
  /** Called for each parsed SSE event. */
  onEvent: (event: SseEvent) => void;
  /** Called when connection state changes. */
  onStateChange?: (state: SseConnectionState) => void;
  /** Called on non-recoverable errors. */
  onError?: (error: Error) => void;
  /** Called when the stream is done ([DONE] or 'done' event received). */
  onDone?: () => void;
  /** Custom fetch implementation (for testing). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Initial Last-Event-ID value to send on first connection. */
  initialLastEventId?: string | null;
  /** Max reconnect delay in ms. Default: 30000 (30s). */
  maxReconnectDelayMs?: number;
  /** Base reconnect delay in ms. Default: 1000 (1s). */
  baseReconnectDelayMs?: number;
  /** Whether to auto-reconnect. Default: true. */
  autoReconnect?: boolean;
  /** Extra headers to send. */
  headers?: Record<string, string>;
  /** Called when a 401 is received; should return a new token or null. */
  onUnauthorized?: () => Promise<string | null>;
  /** Signal that the consumer is still active; return false to stop reconnecting. */
  shouldReconnect?: () => boolean;
}

export type SseConnectionState =
  | 'connecting'
  | 'open'
  | 'closed'
  | 'reconnecting'
  | 'error';

const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 50; // Hard cap to prevent infinite reconnect storms

/**
 * Parse a raw SSE text chunk into complete and partial frames.
 *
 * Returns an array of complete SseEvents and the remaining partial text
 * that should be prepended to the next chunk.
 *
 * This correctly handles:
 * - Lines split across chunk boundaries
 * - Multiple `data:` fields joined by newlines
 * - `event:`, `id:`, `retry:` fields
 * - Comment lines starting with `:`
 * - Blank line as frame delimiter
 * - `\r\n`, `\r`, `\n` line endings
 */
export function parseSseChunk(
  buffer: string,
): { events: SseEvent[]; remaining: string } {
  const events: SseEvent[] = [];

  // Strip UTF-8 BOM if present (U+FEFF at start of stream)
  const bomStripped = buffer.charCodeAt(0) === 0xFEFF ? buffer.slice(1) : buffer;

  // Normalize line endings
  const normalized = bomStripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Find the last double-newline (blank line = frame delimiter).
  // Everything AFTER the last \n\n is a partial frame that has not yet
  // been terminated — it must be carried over to the next chunk.
  const lastDoubleNewline = normalized.lastIndexOf('\n\n');

  let completeSection: string;
  let remaining: string;

  if (lastDoubleNewline === -1) {
    // No complete frames yet — the entire buffer is a partial frame.
    completeSection = '';
    remaining = normalized;
  } else {
    completeSection = normalized.slice(0, lastDoubleNewline + 2); // include the delimiter
    remaining = normalized.slice(lastDoubleNewline + 2);
  }

  // Parse each complete frame (separated by blank lines)
  const frames = completeSection.split('\n\n');
  for (const frame of frames) {
    if (frame === '') continue; // skip empty splits (leading/consecutive blank lines)

    let eventType = 'message';
    const dataLines: string[] = [];
    let eventId: string | null = null;
    let retryMs: number | null = null;

    for (const line of frame.split('\n')) {
      // Comment line (starts with ':') — skip per spec
      if (line.startsWith(':')) {
        continue;
      }

      // Parse field:value
      const colonIndex = line.indexOf(':');
      let field: string;
      let value: string;

      if (colonIndex === -1) {
        field = line;
        value = '';
      } else {
        field = line.slice(0, colonIndex);
        value = line.slice(colonIndex + 1);
        // SSE spec: single space after colon is stripped
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
      }

      switch (field) {
        case 'event':
          eventType = value;
          break;
        case 'data':
          dataLines.push(value);
          break;
        case 'id':
          // IDs containing null are ignored per spec
          if (!value.includes('\0')) {
            eventId = value;
          }
          break;
        case 'retry': {
          const parsed = parseInt(value, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            retryMs = parsed;
          }
          break;
        }
        default:
          // Unknown field ignored per spec
          break;
      }
    }

    // Dispatch frame if it has data or a non-default event type
    // (pure comment/heartbeat frames with no fields are skipped)
    if (dataLines.length > 0 || eventType !== 'message') {
      events.push({
        event: eventType,
        data: dataLines.join('\n'),
        id: eventId,
        retry: retryMs,
      });
    }
  }

  return { events, remaining };
}

/**
 * Check if SSE event data indicates a done/[DONE] signal.
 */
export function isDoneSignal(event: SseEvent): boolean {
  if (event.event === 'done') return true;
  const trimmed = event.data.trim();
  return trimmed === '[DONE]' || trimmed === '"[DONE]"' || trimmed === 'data: [DONE]';
}

export class SseConsumer {
  private options: Required<
    Pick<
      SseConsumerOptions,
      | 'maxReconnectDelayMs'
      | 'baseReconnectDelayMs'
      | 'autoReconnect'
    >
  > &
    SseConsumerOptions;

  private abortController: AbortController | null = null;
  private lastEventId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private currentState: SseConnectionState = 'closed';
  private currentRetryMs: number | null = null;

  constructor(options: SseConsumerOptions) {
    this.options = {
      maxReconnectDelayMs: DEFAULT_MAX_RECONNECT_DELAY_MS,
      baseReconnectDelayMs: DEFAULT_BASE_RECONNECT_DELAY_MS,
      autoReconnect: true,
      ...options,
    };
    this.lastEventId = options.initialLastEventId ?? null;
  }

  /** Start connecting. Returns a promise that resolves when the stream ends. */
  async connect(): Promise<void> {
    this.stopped = false;
    await this.doConnect();
  }

  /** Stop the consumer permanently (no more reconnects). */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.setState('closed');
  }

  /** Get current last-event-id (useful for cursor persistence). */
  getLastEventId(): string | null {
    return this.lastEventId;
  }

  /** Update the auth token (e.g., after refresh). */
  setToken(token: string | null): void {
    this.options.token = token;
  }

  private setState(state: SseConnectionState): void {
    if (this.currentState !== state) {
      this.currentState = state;
      this.options.onStateChange?.(state);
    }
  }

  private async doConnect(): Promise<void> {
    if (this.stopped) return;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    this.abortController = controller;

    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    try {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        ...(this.options.headers ?? {}),
      };

      if (this.options.token) {
        headers['Authorization'] = `Bearer ${this.options.token}`;
      }

      if (this.lastEventId != null && this.lastEventId !== '') {
        headers['Last-Event-ID'] = this.lastEventId;
      }

      const response = await fetchImpl(this.options.url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (response.status === 401 && this.options.onUnauthorized && !this.stopped) {
        // Attempt token refresh once. If refresh fails, stop — don't loop.
        const newToken = await this.options.onUnauthorized();
        if (newToken && !this.stopped) {
          this.options.token = newToken;
          this.abortController = null;
          await this.doConnect();
          return;
        }
        // Token refresh failed — set error state and stop reconnecting
        this.setState('error');
        this.options.onError?.(new Error('SSE authentication failed after token refresh'));
        this.setState('closed');
        return;
      }

      if (!response.ok) {
        throw new Error(`SSE HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      this.setState('open');
      this.reconnectAttempt = 0;

      const streamResult = await this.consumeStream(response.body);

      // If done signal was received, don't reconnect — stream completed normally
      if (streamResult === 'done') {
        this.setState('closed');
        return;
      }
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.setState('closed');
        return;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      this.options.onError?.(error);
      this.setState('error');

      if (this.shouldReconnect()) {
        this.scheduleReconnect();
        return;
      }
    }

    // Stream ended normally (not via done signal) — reconnect if appropriate
    if (!this.stopped && this.shouldReconnect()) {
      this.scheduleReconnect();
    } else {
      this.setState('closed');
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<'done' | 'closed'> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneSignal = false;

    const processEvents = (events: SseEvent[]) => {
      for (const event of events) {
        if (this.stopped) return;
        if (event.id !== null) {
          this.lastEventId = event.id;
        }
        if (event.retry !== null) {
          this.currentRetryMs = event.retry;
        }
        if (isDoneSignal(event)) {
          doneSignal = true;
          this.options.onDone?.();
          return;
        }
        this.options.onEvent(event);
      }
    };

    try {
      while (!this.stopped && !doneSignal) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSseChunk(buffer);
        buffer = remaining;
        processEvents(events);
      }

      // Stream ended — flush any remaining partial frame per SSE spec
      if (!doneSignal && buffer.trim() !== '') {
        const { events } = parseSseChunk(buffer + '\n\n');
        processEvents(events);
      }
    } finally {
      reader.releaseLock();
    }

    return doneSignal ? 'done' : 'closed';
  }

  private shouldReconnect(): boolean {
    if (this.stopped) return false;
    if (!this.options.autoReconnect) return false;
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return false;
    if (this.options.shouldReconnect && !this.options.shouldReconnect()) return false;
    return true;
  }

  private scheduleReconnect(): void {
    // Use server-sent retry if available, otherwise exponential backoff
    const baseDelay = this.currentRetryMs ?? this.options.baseReconnectDelayMs;
    const delay = Math.min(
      baseDelay * Math.pow(2, Math.min(this.reconnectAttempt, 10)),
      this.options.maxReconnectDelayMs,
    );
    // Add jitter (0-30% of delay)
    const jitter = Math.random() * 0.3 * delay;
    const totalDelay = Math.floor(delay + jitter);

    this.reconnectAttempt++;
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, totalDelay);
  }
}

/**
 * Create an SSE consumer. Returns the consumer instance.
 * Call `.connect()` to start the connection, `.stop()` to disconnect.
 *
 * NOTE: Does NOT auto-connect — callers must explicitly call `.connect()`
 * after wiring up any refs/callbacks to avoid missed events or races.
 */
export function createSseConsumer(options: SseConsumerOptions): SseConsumer {
  return new SseConsumer(options);
}
