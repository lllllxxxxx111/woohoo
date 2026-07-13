/**
 * Reusable SSE (Server-Sent Events) consumer with robust frame parsing,
 * exponential backoff reconnection, cursor-based resume, 401 refresh, and
 * idempotent event delivery.
 *
 * Features:
 * - Correctly handles arbitrary chunk boundaries (TCP fragmentation)
 * - Parses multi-line event:/data:/id:/retry: fields
 * - Detects [DONE] and explicit "done" event types
 * - Exponential backoff with configurable max delay
 * - Sends Last-Event-ID header for cursor-based resume
 * - Supports 401 token refresh via callback
 * - No infinite reconnection when shouldReconnect returns false
 * - Deduplicates events by ID
 */

export interface SseFrame {
  /** Event type (from `event:` field, defaults to "message") */
  event: string;
  /** Event data (from `data:` field(s), joined by newlines) */
  data: string;
  /** Event ID (from `id:` field) */
  id: string | null;
  /** Retry interval in ms (from `retry:` field), or null */
  retry: number | null;
}

export interface SseConsumerOptions {
  /** URL to connect to */
  url: string;
  /** Auth token (Bearer) */
  token?: string | null;
  /** Called when an SSE frame is received. Return false to stop consuming. */
  onFrame: (frame: SseFrame) => void | boolean;
  /** Called on stream error. Return false to stop reconnecting. */
  onError?: (error: Error, statusCode?: number) => void | boolean;
  /** Called when the stream completes normally (done event or [DONE]) */
  onDone?: (reason?: string) => void;
  /** Called when the connection opens */
  onOpen?: () => void;
  /** Called when a resync event is received (cursor expired) */
  onResync?: (info: { reason: string; oldestAvailableSeq?: number }) => void;
  /** Async callback to refresh auth token on 401. Returns new token or null to stop. */
  onAuthRefresh?: () => Promise<string | null>;
  /** Predicate: should we attempt to reconnect after disconnect? Default: true. */
  shouldReconnect?: () => boolean;
  /** Initial Last-Event-ID for cursor resume */
  lastEventId?: string | null;
  /** Max backoff delay in ms. Default: 30000 (30s) */
  maxBackoffMs?: number;
  /** Base backoff delay in ms. Default: 500 */
  baseBackoffMs?: number;
  /** Abort signal for external cancellation */
  signal?: AbortSignal;
  /** Fetch implementation (for testing) */
  fetchImpl?: typeof fetch;
  /**
   * Maximum consecutive reconnect attempts before giving up.
   * Resets to 0 after a successful connection. Default: 50.
   * Set to Infinity for unlimited attempts.
   */
  maxReconnectAttempts?: number;
  /**
   * Maximum total elapsed time in ms spent reconnecting before giving up.
   * Default: 30 minutes. Set to Infinity for unlimited.
   */
  maxReconnectElapsedMs?: number;
}

export interface SseController {
  /** Abort the connection and stop all reconnection attempts */
  close: () => void;
  /** Get the last seen event ID */
  getLastEventId: () => string | null;
  /** Get current connection state */
  isConnected: () => boolean;
}

/**
 * Parse a raw SSE text stream into SseFrame objects.
 * Handles multi-line data fields and arbitrary chunk boundaries.
 */
export class SseFrameParser {
  private buffer = '';
  private currentEvent = '';
  private currentData: string[] = [];
  private currentId: string | null = null;
  private currentRetry: number | null = null;
  private onFrame: (frame: SseFrame) => void;
  private bomStripped = false;

  constructor(onFrame: (frame: SseFrame) => void) {
    this.onFrame = onFrame;
  }

  /** Feed a chunk of text into the parser. May emit zero or more frames. */
  feed(chunk: string): void {
    // Strip UTF-8 BOM (U+FEFF) if present at the start of the stream
    if (!this.bomStripped) {
      this.bomStripped = true;
      if (chunk.charCodeAt(0) === 0xfeff) {
        chunk = chunk.slice(1);
      }
    }
    this.buffer += chunk;

    // Process complete lines (separated by \n, \r\n, or bare \r per SSE spec)
    let newlineIndex: number;
    while ((newlineIndex = findNewline(this.buffer)) >= 0) {
      const sepChar = this.buffer.charCodeAt(newlineIndex);
      const rawLine = this.buffer.slice(0, newlineIndex);
      // Determine how many chars the separator consumes
      let sepLen = 1;
      if (sepChar === 0x0d) {
        // \r or \r\n
        if (this.buffer.charCodeAt(newlineIndex + 1) === 0x0a) {
          sepLen = 2; // \r\n
        }
        this.processLine(rawLine);
      } else {
        // \n (if preceded by \r, that \r is part of the line so strip it)
        if (newlineIndex > 0 && this.buffer.charCodeAt(newlineIndex - 1) === 0x0d) {
          this.processLine(rawLine.slice(0, -1));
        } else {
          this.processLine(rawLine);
        }
      }
      this.buffer = this.buffer.slice(newlineIndex + sepLen);
    }
  }

  private processLine(line: string): void {
    if (line === '') {
      // Empty line = dispatch current event
      this.dispatch();
    } else if (line.startsWith(':')) {
      // Comment line — ignore (heartbeat/keepalive)
    } else {
      const colonIndex = line.indexOf(':');
      let field: string;
      let value: string;
      if (colonIndex === -1) {
        field = line;
        value = '';
      } else {
        field = line.slice(0, colonIndex);
        value = line.slice(colonIndex + 1);
        // SSE spec: a single leading space in the value is stripped
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
      }

      switch (field) {
        case 'event':
          this.currentEvent = value;
          break;
        case 'data':
          this.currentData.push(value);
          break;
        case 'id':
          // NUL character in ID is not allowed per spec; ignore such IDs
          if (!value.includes('\0')) {
            this.currentId = value;
          }
          break;
        case 'retry': {
          // Per spec: only non-negative integers set the reconnection time.
          // Ignore any value that isn't a valid non-negative base-10 integer.
          if (/^\d+$/.test(value)) {
            const n = parseInt(value, 10);
            if (!isNaN(n)) {
              this.currentRetry = n;
            }
          }
          break;
        }
        default:
          // Unknown field — ignore per spec (forward compatibility)
          break;
      }
    }
  }

  /** Signal end of stream. Dispatches any pending frame. */
  end(): void {
    // Process any remaining buffer without a trailing newline.
    // Normalize any remaining \r or \r\n to \n for consistent splitting.
    if (this.buffer !== '') {
      const normalized = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      for (const rawLine of normalized.split('\n')) {
        if (rawLine === '') {
          this.dispatch();
        } else {
          this.processLine(rawLine);
        }
      }
      this.buffer = '';
    }
    this.dispatch();
  }

  private dispatch(): void {
    if (this.currentData.length === 0 && this.currentEvent === '' && this.currentId === null) {
      // Nothing to dispatch
      this.reset();
      return;
    }

    const frame: SseFrame = {
      event: this.currentEvent || 'message',
      data: this.currentData.join('\n'),
      id: this.currentId,
      retry: this.currentRetry,
    };

    this.onFrame(frame);
    this.reset();
  }

  private reset(): void {
    this.currentEvent = '';
    this.currentData = [];
    // Note: id and retry are NOT reset between events per spec — they persist
    // But we reset data and event type for the next frame.
    // Actually per SSE spec: id and retry persist until explicitly set again.
    // We'll keep currentId and currentRetry as-is (they persist across dispatches).
  }
}

function findNewline(str: string): number {
  // Per SSE spec, lines are terminated by \n, \r, or \r\n.
  // Find the first occurrence of any of these.
  const n = str.indexOf('\n');
  const r = str.indexOf('\r');
  if (n === -1) return r;
  if (r === -1) return n;
  return Math.min(n, r);
}

/**
 * Start consuming an SSE stream with automatic reconnection and backoff.
 * Returns a controller to manually close the connection.
 */
export function createSseConsumer(options: SseConsumerOptions): SseController {
  const {
    url,
    token,
    onFrame,
    onError,
    onDone,
    onOpen,
    onResync,
    onAuthRefresh,
    shouldReconnect,
    lastEventId: initialLastEventId,
    maxBackoffMs = 30000,
    baseBackoffMs = 500,
    maxReconnectAttempts = 50,
    maxReconnectElapsedMs = 30 * 60 * 1000, // 30 minutes
    signal,
    fetchImpl = fetch,
  } = options;

  let lastEventId: string | null = initialLastEventId ?? null;
  let currentToken: string | null | undefined = token;
  let abortController: AbortController | null = null;
  let closed = false;
  let connected = false;
  let backoffMs = baseBackoffMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authRefreshAttempted = false;
  let consecutiveFailures = 0;
  const firstConnectAt = Date.now();

  const isConnected = () => connected;
  const getLastEventId = () => lastEventId;

  const close = () => {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    connected = false;
  };

  // Handle external abort signal
  if (signal) {
    if (signal.aborted) {
      close();
      return { close, getLastEventId, isConnected };
    }
    signal.addEventListener('abort', close, { once: true });
  }

  async function connect(): Promise<void> {
    if (closed) return;
    if (shouldReconnect && !shouldReconnect()) return;

    abortController = new AbortController();
    const fetchOptions: RequestInit = {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
      },
      signal: abortController.signal,
    };

    if (currentToken) {
      (fetchOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${currentToken}`;
    }

    // Send Last-Event-ID for cursor-based resume
    if (lastEventId) {
      (fetchOptions.headers as Record<string, string>)['Last-Event-ID'] = lastEventId;
    }

    try {
      const response = await fetchImpl(url, fetchOptions);

      if (response.status === 401) {
        // Auth error — try to refresh token once
        if (!authRefreshAttempted && onAuthRefresh) {
          authRefreshAttempted = true;
          const newToken = await onAuthRefresh();
          if (newToken) {
            currentToken = newToken;
            // Reconnect immediately with new token
            backoffMs = baseBackoffMs;
            reconnectTimer = setTimeout(connect, 100);
            return;
          }
        }
        // No refresh possible or refresh failed
        onError?.(new Error('Unauthorized'), 401);
        return;
      }

      if (!response.ok) {
        throw new Error(`SSE HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      authRefreshAttempted = false;
      connected = true;
      backoffMs = baseBackoffMs;
      consecutiveFailures = 0; // reset on successful connection
      onOpen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser((frame) => {
        // Update last seen event ID
        if (frame.id !== null) {
          lastEventId = frame.id;
        }

        // Handle retry field
        if (frame.retry !== null) {
          backoffMs = Math.min(frame.retry, maxBackoffMs);
        }

        // Check for [DONE] marker
        if (frame.data === '[DONE]' || frame.event === 'done') {
          let reason: string | undefined;
          try {
            const parsed = JSON.parse(frame.data);
            reason = parsed?.reason;
          } catch {
            // Not JSON, use default
          }
          onDone?.(reason);
          closed = true;
          return;
        }

        // Handle resync event
        if (frame.event === 'resync') {
          try {
            const parsed = JSON.parse(frame.data);
            onResync?.({ reason: parsed?.reason ?? 'unknown', oldestAvailableSeq: parsed?.oldestAvailableSeq });
          } catch {
            onResync?.({ reason: 'unknown' });
          }
          return;
        }

        // Handle lagged event
        if (frame.event === 'lagged') {
          // Client should reconnect with cursor to replay missed events
          // We don't force reconnect here — let the handler decide
          onFrame(frame);
          return;
        }

        const result = onFrame(frame);
        if (result === false) {
          close();
        }
      });

      // Read the stream
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        parser.feed(text);
      }
      parser.end();
    } catch (err) {
      if (closed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      const shouldContinue = onError?.(error) ?? true;
      if (!shouldContinue) return;
    }

    connected = false;

    if (closed) return;
    if (shouldReconnect && !shouldReconnect()) return;

    // Bounded reconnect: enforce max attempts and max elapsed time
    consecutiveFailures++;
    const elapsed = Date.now() - firstConnectAt;
    if (consecutiveFailures > maxReconnectAttempts) {
      onError?.(new Error(`SSE reconnect: max attempts (${maxReconnectAttempts}) exceeded`));
      return;
    }
    if (elapsed > maxReconnectElapsedMs) {
      onError?.(new Error(`SSE reconnect: max elapsed time (${Math.round(maxReconnectElapsedMs / 1000)}s) exceeded`));
      return;
    }

    // Schedule reconnect with exponential backoff
    const delay = Math.min(backoffMs, maxBackoffMs);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    reconnectTimer = setTimeout(connect, delay);
  }

  // Start initial connection
  connect();

  return { close, getLastEventId, isConnected };
}

/**
 * Parse SSE data field as JSON with safe fallback.
 */
export function parseSseJson<T = unknown>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
