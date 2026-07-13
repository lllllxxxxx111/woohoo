/**
 * Robust, reusable SSE (Server-Sent Events) consumer.
 *
 * Features:
 * - Correctly handles arbitrary chunk boundaries (event/data/id/retry multi-line frames)
 * - Strips leading UTF-8 BOM; decodes mid-character safely via streaming TextDecoder
 * - Flushes final decoder bytes at stream end
 * - Tracks last event ID and sends Last-Event-ID on reconnect
 * - Exponential backoff with jitter (capped)
 * - Hard cap on reconnect attempts to prevent infinite loops
 * - 401 token refresh with single retry
 * - Handles [DONE] / done termination
 * - Handles resync_required signal
 * - Can be stopped; does not reconnect when shouldReconnect returns false
 * - Supports cursor query parameter for servers that prefer it over Last-Event-ID header
 */

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
}

export interface SseConsumerOptions {
  /** URL to connect to */
  url: string;
  /** Fetch implementation (injectable for testing) */
  fetchImpl?: typeof fetch;
  /** Extra headers (Authorization, etc.) */
  headers?: Record<string, string>;
  /** Called for each complete SSE event */
  onEvent: (event: SseEvent) => void;
  /** Called when the connection is established */
  onOpen?: () => void;
  /** Called when a reconnection attempt is about to happen */
  onReconnect?: (attempt: number, delayMs: number) => void;
  /** Called on error; return false to stop reconnecting */
  onError?: (error: Error) => boolean | void;
  /** Called when server sends resync_required; return true to trigger reconnect with fresh cursor */
  onResyncRequired?: (reason: string, data: unknown) => boolean;
  /** Token refresh callback: return new token string */
  refreshToken?: () => Promise<string>;
  /** Whether to keep reconnecting; receives current retry attempt number */
  shouldReconnect?: (attempt: number) => boolean;
  /** Initial retry delay in ms (default 1000) */
  initialRetryMs?: number;
  /** Maximum retry delay in ms (default 30000) */
  maxRetryMs?: number;
  /** Absolute cap on consecutive reconnect attempts (default 50) */
  maxReconnectAttempts?: number;
  /** Whether to append cursor as ?cursor= query param instead of using header */
  useCursorQueryParam?: boolean;
  /** Abort signal for external cancellation */
  signal?: AbortSignal;
}

export interface SseController {
  /** Stop the consumer permanently */
  close: () => void;
  /** Get the last seen event ID */
  getLastEventId: () => string | null;
  /** Manually trigger reconnect (e.g. after resync) */
  reconnect: () => void;
}

const DEFAULT_INITIAL_RETRY_MS = 1000;
const DEFAULT_MAX_RETRY_MS = 30000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 50;

const BOM = '\uFEFF';

/**
 * Parse raw SSE text into complete events.
 * Handles multi-line data fields (joined with \n per SSE spec).
 * Accumulates partial frames across calls. Strips leading BOM.
 */
export class SseParser {
  private buffer = '';
  private lastRetry: number | null = null;
  private lastEventId: string | null = null;
  private events: SseEvent[] = [];
  private bomStripped = false;

  /** Feed a chunk of text; returns any complete events parsed */
  feed(chunk: string): SseEvent[] {
    // Strip a leading UTF-8 BOM that some servers emit at stream start
    if (!this.bomStripped) {
      this.bomStripped = true;
      if (chunk.startsWith(BOM)) {
        chunk = chunk.slice(1);
      }
    }
    this.buffer += chunk;

    // Process complete events from buffer. We do NOT pre-normalize the entire
    // buffer (that caused bugs when \r and \n arrived in separate chunks — a
    // trailing \r would be eagerly converted to \n, creating a spurious blank
    // line when the next chunk arrived with \n). Instead we scan for event
    // boundaries explicitly, treating \r\n, \r, and \n all as line terminators,
    // and treating any sequence of two+ terminators (possibly mixed) as an
    // event separator per W3C SSE spec.
    while (true) {
      const boundary = this.findEventBoundary(this.buffer);
      if (boundary < 0) break;
      const rawBlock = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary);
      // Strip leading separator line terminators from remaining buffer so the
      // next iteration starts at the next event.
      this.buffer = this.buffer.replace(/^(\r\n|\r|\n)+/, '');
      this.parseBlock(rawBlock);
    }

    const result = this.events;
    this.events = [];
    return result;
  }

  /**
   * Find the end of the next complete event (position after its terminating
   * blank line). Returns -1 if the buffer does not yet contain a full event.
   *
   * A blank line per SSE spec is two consecutive line terminators (the first
   * ends the last field line, the second is the "empty line" separator).
   * \r\n counts as a single terminator.
   */
  private findEventBoundary(buf: string): number {
    let i = 0;
    let terminatorsSeen = 0;
    while (i < buf.length) {
      const ch = buf.charCodeAt(i);
      if (ch === 0x0d /* \r */) {
        // CRLF
        if (i + 1 < buf.length && buf.charCodeAt(i + 1) === 0x0a /* \n */) {
          i += 2;
        } else {
          i += 1;
        }
        terminatorsSeen += 1;
        if (terminatorsSeen >= 2) return i;
        continue;
      }
      if (ch === 0x0a /* \n */) {
        i += 1;
        terminatorsSeen += 1;
        if (terminatorsSeen >= 2) return i;
        continue;
      }
      // Non-terminator character: reset the run of terminators.
      terminatorsSeen = 0;
      i += 1;
    }
    // Trailing CR without a following character: we can't yet tell if this is
    // a lone \r terminator or the start of \r\n. Wait for more data.
    if (buf.length > 0 && buf.charCodeAt(buf.length - 1) === 0x0d) {
      // Back up the scan: if the buffer ends with \r we need to leave it in
      // buffer so the next chunk can resolve it. The loop above walked past
      // it counting one terminator, so we need to signal "not yet complete"
      // even if we have >=2 terminators in total but the last char is \r.
      // In practice this only matters when the boundary would end exactly at
      // the trailing \r: conservatively return -1 to defer.
      return -1;
    }
    return -1;
  }

  /** Reset parser state between connections */
  reset(): void {
    this.buffer = '';
    this.bomStripped = false;
    // lastRetry and lastEventId intentionally persist per SSE spec
  }

  /** Get the most recently seen retry value (persists across events per SSE spec) */
  getLastRetry(): number | null {
    return this.lastRetry;
  }

  /** Get the most recently seen event ID */
  getLastEventId(): string | null {
    return this.lastEventId;
  }

  /**
   * Parse one complete event block. The block may use any mix of \r\n, \r, \n
   * line endings; we split uniformly before processing.
   */
  private parseBlock(block: string) {
    // Normalize line endings within this complete block only (safe because
    // the block is complete — no risk of splitting CRLF across boundaries).
    const normalized = block.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const event: Partial<SseEvent> = {
      event: 'message',
      data: '',
      id: this.lastEventId,
      retry: this.lastRetry,
    };
    const dataLines: string[] = [];
    let hasData = false;
    let hasExplicitEvent = false;

    for (const line of normalized.split('\n')) {
      if (line === '') continue;
      if (line.startsWith(':')) {
        // Comment line, ignore
        continue;
      }

      // Per SSE spec: split on first colon; if no colon, whole line is field with empty value
      const colonIdx = line.indexOf(':');
      let field: string;
      let value: string;
      if (colonIdx === -1) {
        field = line;
        value = '';
      } else {
        field = line.slice(0, colonIdx);
        value = line.slice(colonIdx + 1);
        // Strip exactly one leading space from value per SSE spec
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
      }

      switch (field) {
        case 'event':
          event.event = value;
          hasExplicitEvent = true;
          break;
        case 'data':
          dataLines.push(value);
          hasData = true;
          break;
        case 'id':
          // Per spec, ignore IDs containing null character
          if (!value.includes('\0')) {
            event.id = value;
            this.lastEventId = value;
          }
          break;
        case 'retry': {
          const retryValue = parseInt(value, 10);
          if (!isNaN(retryValue)) {
            event.retry = retryValue;
            this.lastRetry = retryValue;
          }
          break;
        }
        default:
          // Unknown field; ignore per spec
          break;
      }
    }

    if (hasData || hasExplicitEvent) {
      // Per SSE spec, multiple data lines are joined with \n
      event.data = dataLines.join('\n');
      this.events.push(event as SseEvent);
    }
  }

  /** Get any remaining buffer content (for cleanup/debug) */
  getBuffer(): string {
    return this.buffer;
  }
}

/**
 * Calculate backoff delay with jitter.
 * Uses exponential backoff: base * 2^attempt, with ±20% jitter.
 */
export function calculateBackoff(
  attempt: number,
  initialMs: number,
  maxMs: number,
): number {
  const exponential = initialMs * Math.pow(2, Math.min(attempt, 10));
  const capped = Math.min(exponential, maxMs);
  // Add ±20% jitter
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/**
 * Check if data contains a [DONE] marker
 */
export function isDoneMarker(data: string): boolean {
  const trimmed = data.trim();
  return trimmed === '[DONE]' || trimmed === '"[DONE]"' || trimmed === 'done';
}

/**
 * Start consuming an SSE stream.
 * Returns a controller that can be used to stop or reconnect.
 */
export function createSseConsumer(options: SseConsumerOptions): SseController {
  const {
    url,
    fetchImpl = typeof globalThis !== 'undefined' ? globalThis.fetch : (() => { throw new Error('No fetch implementation available'); })(),
    headers = {},
    onEvent,
    onOpen,
    onReconnect,
    onError,
    onResyncRequired,
    refreshToken,
    shouldReconnect = () => true,
    initialRetryMs = DEFAULT_INITIAL_RETRY_MS,
    maxRetryMs = DEFAULT_MAX_RETRY_MS,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    useCursorQueryParam = false,
    signal,
  } = options;

  let closed = false;
  let retryAttempt = 0;
  let lastEventId: string | null = null;
  let currentAbortController: AbortController | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  const parser = new SseParser();

  const stop = () => {
    closed = true;
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  };

  // Handle external abort signal
  if (signal) {
    if (signal.aborted) {
      return { close: stop, getLastEventId: () => lastEventId, reconnect: () => {} };
    }
    signal.addEventListener('abort', stop, { once: true });
  }

  const buildUrl = (): string => {
    if (useCursorQueryParam && lastEventId) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}cursor=${encodeURIComponent(lastEventId)}`;
    }
    return url;
  };

  const buildHeaders = (token?: string): Record<string, string> => {
    const h: Record<string, string> = {
      Accept: 'text/event-stream',
      ...headers,
    };
    if (token) {
      h.Authorization = `Bearer ${token}`;
    }
    if (lastEventId && !useCursorQueryParam) {
      h['Last-Event-ID'] = lastEventId;
    }
    return h;
  };

  const processResponse = async (response: Response) => {
    if (!response.body) {
      throw new Error('Response has no readable stream body');
    }

    onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    parser.reset();
    let receivedEvent = false;
    // Set to true when we intentionally cancel the reader (done/resync),
    // so the outer loop does not schedule an extra reconnect.
    let intentionallyCancelled = false;

    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any remaining buffered bytes in the decoder
          const tail = decoder.decode();
          if (tail) {
            const events = parser.feed(tail);
            for (const event of events) {
              if (closed) break;
              handleEvent(event);
            }
          }
          break;
        }

        const text = decoder.decode(value, { stream: true });
        if (!text) continue;
        const events = parser.feed(text);
        for (const event of events) {
          if (closed) break;
          handleEvent(event);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }

    function handleEvent(event: SseEvent) {
      // Update last event ID
      if (event.id) {
        lastEventId = event.id;
      }

      // Mark connection as healthy (we received data), reset backoff attempt counter
      if (!receivedEvent) {
        receivedEvent = true;
        retryAttempt = 0;
      }

      // Deliver event to consumer (done/resync events are observable too)
      onEvent(event);

      // Check for [DONE] marker or explicit done event type: terminal stream end.
      // Cancel reader and do NOT schedule a reconnect.
      if (isDoneMarker(event.data) || event.event === 'done') {
        intentionallyCancelled = true;
        try { reader.cancel('done'); } catch { /* ignore */ }
        return;
      }

      // Check for resync_required: cancel reader and schedule a reconnect with
      // fresh cursor (after onResyncRequired handler may have side effects).
      if (event.event === 'resync_required') {
        try {
          const payload = JSON.parse(event.data);
          const shouldReconnectAfterResync = onResyncRequired?.(payload.reason ?? 'unknown', payload);
          if (shouldReconnectAfterResync) {
            intentionallyCancelled = true;
            try { reader.cancel('resync'); } catch { /* ignore */ }
            scheduleReconnect(0);
          }
        } catch {
          // Payload wasn't JSON - already delivered to consumer
        }
      }
    }

    return intentionallyCancelled;
  };

  const scheduleReconnect = (delay?: number) => {
    if (closed) return;
    retryAttempt += 1;

    // Hard cap on consecutive reconnect attempts to prevent infinite loops
    if (retryAttempt > maxReconnectAttempts) {
      onError?.(new Error(`SSE reconnect exceeded max attempts (${maxReconnectAttempts})`));
      return;
    }

    if (!shouldReconnect(retryAttempt)) {
      return;
    }
    const delayMs = delay ?? calculateBackoff(retryAttempt, initialRetryMs, maxRetryMs);
    onReconnect?.(retryAttempt, delayMs);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      void connect();
    }, delayMs);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;

    currentAbortController = new AbortController();
    if (signal) {
      // Chain the external signal
      signal.addEventListener('abort', () => currentAbortController?.abort(), { once: true });
    }

    try {
      const response = await fetchImpl(buildUrl(), {
        headers: buildHeaders(),
        signal: currentAbortController.signal,
        cache: 'no-store',
      });

      if (response.status === 401 && refreshToken) {
        // Try to refresh token and retry once
        try {
          const newToken = await refreshToken();
          if (!closed) {
            const retryResponse = await fetchImpl(buildUrl(), {
              headers: buildHeaders(newToken),
              signal: currentAbortController.signal,
              cache: 'no-store',
            });
            if (!retryResponse.ok) {
              throw new Error(`SSE request failed after token refresh: ${retryResponse.status}`);
            }
            const intentionallyCancelled = await processResponse(retryResponse);
            // Stream ended normally; only reconnect if we didn't already schedule one
            // (resync) and weren't told to stop (done).
            if (!closed && !intentionallyCancelled) scheduleReconnect();
            return;
          }
        } catch (refreshError) {
          const shouldKeepTrying = onError?.(
            refreshError instanceof Error ? refreshError : new Error(String(refreshError)),
          );
          if (shouldKeepTrying !== false && !closed) {
            scheduleReconnect();
          }
          return;
        }
      }

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      const intentionallyCancelled = await processResponse(response);
      // Stream ended normally (server closed). Only schedule a reconnect if we
      // did not already do so inside handleEvent (resync path) or if the stream
      // was not intentionally terminated via done marker.
      if (!closed && !intentionallyCancelled) {
        scheduleReconnect();
      }
    } catch (err) {
      if (closed) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (currentAbortController?.signal.aborted) return;

      const error = err instanceof Error ? err : new Error(String(err));
      const shouldKeepTrying = onError?.(error);
      if (shouldKeepTrying !== false) {
        scheduleReconnect();
      }
    }
  };

  // Start initial connection
  void connect();

  return {
    close: stop,
    getLastEventId: () => lastEventId,
    reconnect: () => {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      retryAttempt = 0;
      void connect();
    },
  };
}
