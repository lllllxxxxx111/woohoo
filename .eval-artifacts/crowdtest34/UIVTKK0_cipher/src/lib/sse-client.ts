/**
 * Robust SSE (Server-Sent Events) client with:
 * - Proper frame parsing (chunk-safe, multi-line data, id/event/retry/comments)
 * - [DONE] / done event termination
 * - Exponential backoff reconnection with configurable max delay
 * - Last-Event-ID cursor for resumable replay
 * - 401 token refresh integration
 * - Event deduplication by ID
 * - Resync signal handling
 * - Configurable auto-reconnect guard (no infinite reconnect when no tasks pending)
 *
 * Protocol reference: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

export type SseEvent = {
  id: string;
  event: string;
  data: string;
  retry?: number;
};

export type SseClientOptions = {
  /** Full URL or path (relative urls resolved against baseUrl or window.location.origin) */
  url: string;
  /** Base URL for resolving relative paths (e.g. Tauri backend). Overrides window.location.origin. */
  baseUrl?: string;
  /** Async function to resolve base URL (useful when URL requires probing, e.g. Tauri port discovery). Called once on first connect. */
  getBaseUrl?: () => Promise<string>;
  /** Authorization token (Bearer) */
  token?: string;
  /** Initial cursor (event ID to resume from) */
  initialCursor?: string;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Query parameters to append */
  params?: Record<string, string | number | undefined>;

  /** Called when connection opens */
  onOpen?: () => void;
  /** Called for each parsed SSE event */
  onEvent: (event: SseEvent) => void;
  /** Called when server sends terminal 'done' event (single-entity streams like pipeline runs) */
  onDone?: () => void;
  /** Called on connection close (clean or error) */
  onClose?: () => void;
  /** Called on non-recoverable error */
  onError?: (error: Error) => void;
  /** Called when server requests a full resync (cursor expired) */
  onResync?: (info: { reason: string; message?: string }) => void;
  /** Called when connection state changes */
  onConnectionChange?: (connected: boolean) => void;

  /**
   * Called before reconnect to check if we should keep trying.
   * Return false to stop reconnection.
   * Default: always reconnect (subject to maxRetries).
   */
  shouldReconnect?: () => boolean;

  /** Called to refresh token on 401. Must return new token or throw. */
  refreshToken?: () => Promise<string>;

  /** Minimum reconnect delay (ms). Default: 500 */
  minReconnectDelay?: number;
  /** Maximum reconnect delay (ms). Default: 30000 */
  maxReconnectDelay?: number;
  /** Maximum number of consecutive reconnect attempts before giving up. Default: 50 */
  maxRetries?: number;
  /** Abort signal for external cancellation */
  signal?: AbortSignal;
};

export type SseClientController = {
  /** Immediately disconnect and stop reconnecting */
  close: () => void;
  /** Get the last seen event ID (cursor) */
  getLastEventId: () => string;
  /** Manually trigger reconnect (e.g., after cursor invalidation) */
  reconnect: () => void;
  /** Update the auth token */
  setToken: (token: string) => void;
};

/**
 * Parse a chunk of SSE text into events.
 * Handles chunk boundaries (partial lines across chunks), multi-line data,
 * id:, event:, retry:, and comment lines per the HTML SSE spec.
 *
 * Spec reference: https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * Exported for testing.
 */
export class SseFrameParser {
  private buffer = '';
  private currentEvent: Partial<SseEvent> & { _hasExplicitId?: boolean } = {};
  private currentData = '';
  private lastEventId = '';
  private dispatch?: (event: SseEvent & { hasExplicitId: boolean }) => void;
  private bomStripped = false;

  constructor(dispatch?: (event: SseEvent & { hasExplicitId: boolean }) => void) {
    this.dispatch = dispatch;
  }

  /** Feed a chunk of text and emit complete events via dispatch callback. */
  feed(chunk: string) {
    this.buffer += chunk;

    // Strip one leading UTF-8 BOM (U+FEFF) at start of stream, per spec
    if (!this.bomStripped && this.buffer.length > 0) {
      if (this.buffer.charCodeAt(0) === 0xfeff) {
        this.buffer = this.buffer.slice(1);
      }
      this.bomStripped = true;
    }

    // Process line by line; keep last partial line in buffer.
    // We must handle \r\n, \r, and \n as line terminators.
    // If a \r appears as the LAST character in buffer, leave it there —
    // the next chunk may start with \n (split CRLF across chunks).
    let i = 0;
    while (i < this.buffer.length) {
      const c = this.buffer[i];
      if (c === '\n') {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        i = 0;
        this.processLine(line);
      } else if (c === '\r') {
        // Check if this is \r\n (possibly split across chunks)
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === '\n') {
            // CRLF within buffer
            const line = this.buffer.slice(0, i);
            this.buffer = this.buffer.slice(i + 2);
            i = 0;
            this.processLine(line);
          } else {
            // Lone \r within buffer (not followed by \n)
            const line = this.buffer.slice(0, i);
            this.buffer = this.buffer.slice(i + 1);
            i = 0;
            this.processLine(line);
          }
        } else {
          // \r is the LAST character in buffer. Could be the start of CRLF split
          // across chunks. Wait for more data before deciding.
          break;
        }
      } else {
        i++;
      }
    }
  }

  /** Signal end of stream - flush any remaining data as a final line + dispatch. */
  end() {
    // If buffer has a trailing \r (left over from split CRLF scenario), treat it as a line terminator
    if (this.buffer.endsWith('\r')) {
      const line = this.buffer.slice(0, -1);
      this.processLine(line);
      this.buffer = '';
    } else if (this.buffer.length > 0) {
      // Process remaining content as a line even without trailing terminator (spec allows this)
      this.processLine(this.buffer);
      this.buffer = '';
    }
    this.dispatchEvent();
  }

  private processLine(line: string) {
    if (line === '') {
      // Empty line dispatches the current event
      this.dispatchEvent();
      return;
    }

    // Comment lines start with ':'
    if (line.startsWith(':')) {
      return;
    }

    // Check for field:value or field: value (single space after colon is stripped per spec)
    const colonIndex = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIndex === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    }

    switch (field) {
      case 'event':
        this.currentEvent.event = value;
        break;
      case 'data':
        // Multi-line data is joined by \n per spec
        if (this.currentData.length > 0) {
          this.currentData += '\n';
        }
        this.currentData += value;
        break;
      case 'id':
        // Ignore ids containing U+0000 null per spec; otherwise update last event id
        if (!value.includes('\0')) {
          this.currentEvent.id = value;
          this.currentEvent._hasExplicitId = true;
          this.lastEventId = value;
        }
        break;
      case 'retry': {
        const retryMs = parseInt(value, 10);
        if (!isNaN(retryMs) && retryMs >= 0) {
          this.currentEvent.retry = retryMs;
        }
        break;
      }
      default:
        // Unknown field, ignore per spec
        break;
    }
  }

  private dispatchEvent() {
    const data = this.currentData;
    this.currentData = '';

    // If data is empty and no event type/id/retry was set, this is a heartbeat/comment-only; skip
    if (data === '' && !this.currentEvent.event && !this.currentEvent.id && !this.currentEvent.retry) {
      this.currentEvent = {};
      return;
    }

    const hasExplicitId = this.currentEvent._hasExplicitId === true;
    // Per SSE spec: id field carries forward to subsequent events for Last-Event-ID.
    // However, for DEDUP we only treat events with their own explicit id as dedupable,
    // because carried-forward ids don't represent a unique identity for the new event.
    // event.id always reflects the current last-event-id (for cursor tracking by consumers).
    const eventId = hasExplicitId
      ? (this.currentEvent.id ?? '')
      : this.lastEventId;

    const event: SseEvent & { hasExplicitId: boolean } = {
      id: eventId,
      // Per SSE spec: empty event type buffer → default to 'message'
      event: (this.currentEvent.event && this.currentEvent.event.length > 0)
        ? this.currentEvent.event
        : 'message',
      data,
      retry: this.currentEvent.retry,
      hasExplicitId,
    };

    this.currentEvent = {};

    // Check for terminal sentinels: [DONE] (OpenAI-style) or explicit 'done' data
    if (data === '[DONE]' || data === 'done') {
      if (this.dispatch) {
        this.dispatch({ ...event, event: 'done' });
      }
      return;
    }

    if (this.dispatch) {
      this.dispatch(event);
    }
  }
}

/**
 * Connect to an SSE endpoint with robust reconnection, cursor replay,
 * exponential backoff, and 401 refresh support.
 */
export function createSseClient(options: SseClientOptions): SseClientController {
  const {
    url,
    baseUrl: staticBaseUrl,
    getBaseUrl: resolveBaseUrl,
    token: initialToken,
    initialCursor,
    headers: extraHeaders,
    params,
    onOpen,
    onEvent,
    onDone,
    onClose,
    onError,
    onResync,
    onConnectionChange,
    shouldReconnect,
    refreshToken,
    minReconnectDelay = 500,
    maxReconnectDelay = 30000,
    maxRetries = 50,
    signal,
  } = options;

  let currentToken = initialToken;
  let lastEventId = initialCursor ?? '';
  let retryDelay = minReconnectDelay;
  let retries = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let closed = false;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let resolvedBaseUrl: string | null = staticBaseUrl ?? null;

  /** Already-seen event IDs to prevent duplicate processing. */
  const seenEventIds = new Set<string>();
  /** Max size of dedup set (prevents unbounded growth) */
  const MAX_DEDUP_SET = 2000;
  const dedupPruneThreshold = 1500;

  async function ensureBaseUrl(): Promise<string> {
    if (resolvedBaseUrl) return resolvedBaseUrl;
    if (resolveBaseUrl) {
      resolvedBaseUrl = await resolveBaseUrl();
      return resolvedBaseUrl;
    }
    // Fallback: same-origin (browser) or localhost (Node test)
    if (typeof window !== 'undefined' && window.location?.origin) {
      resolvedBaseUrl = window.location.origin;
    } else {
      resolvedBaseUrl = 'http://localhost';
    }
    return resolvedBaseUrl;
  }

  function buildUrl(cursor: string): string {
    let resolved: URL;
    try {
      resolved = new URL(url);
    } catch {
      // url is relative — resolve against discovered base
      const base = resolvedBaseUrl || (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost';
      resolved = new URL(url, base);
    }
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          resolved.searchParams.set(key, String(value));
        }
      }
    }
    if (cursor && !resolved.searchParams.has('cursor')) {
      resolved.searchParams.set('cursor', cursor);
    }
    return resolved.toString();
  }

  function trackEventId(id: string) {
    if (!id) return;
    lastEventId = id;
    seenEventIds.add(id);
    // Prune when set gets too large
    if (seenEventIds.size > MAX_DEDUP_SET) {
      const ids = Array.from(seenEventIds);
      seenEventIds.clear();
      // Keep the most recent entries
      for (const idVal of ids.slice(-dedupPruneThreshold)) {
        seenEventIds.add(idVal);
      }
    }
  }

  function isDuplicate(id: string): boolean {
    if (!id) return false;
    return seenEventIds.has(id);
  }

  function dispatchEvent(event: SseEvent & { hasExplicitId?: boolean }) {
    // Handle server-recommended retry interval
    if (event.retry !== undefined) {
      retryDelay = Math.max(minReconnectDelay, Math.min(maxReconnectDelay, event.retry));
    }

    const hasId = event.hasExplicitId === true && !!event.id;

    // Deduplicate only events that carry an explicit id — events without
    // an id cannot be reliably dedup'd and should pass through.
    if (hasId && isDuplicate(event.id)) {
      return;
    }

    // Handle resync signal
    if (event.event === 'resync') {
      // Reset cursor so subsequent events (especially snapshot) establish new baseline
      lastEventId = '';
      seenEventIds.clear();
      try {
        const info = JSON.parse(event.data);
        onResync?.({ reason: info.reason ?? 'unknown', message: info.message });
      } catch {
        onResync?.({ reason: 'unknown' });
      }
    }

    // Track event ID for deduplication and reconnect cursor.
    // Per SSE spec, lastEventId updates when event has an explicit id: field.
    if (hasId) {
      trackEventId(event.id);
    }

    // Handle done event — terminal signal, close cleanly without reconnect
    if (event.event === 'done') {
      closed = true;
      try { onDone?.(); } catch {}
      try { onEvent(event); } catch (err) { console.error('[SSE] Event handler error:', err); }
      // Abort current connection so reader loop exits
      if (abortController && !abortController.signal.aborted) {
        abortController.abort();
      }
      // Note: onConnectionChange(false) and onClose() are called from the reader
      // loop finally block (lines 497-498) after abort breaks us out.
      return;
    }

    try {
      onEvent(event);
    } catch (err) {
      console.error('[SSE] Event handler error:', err);
    }
  }

  async function connect(attemptToken?: string, isRetryAfter401 = false): Promise<void> {
    if (closed) return;
    if (signal?.aborted) return;

    abortController = new AbortController();

    // Combine external signal with internal abort
    if (signal) {
      signal.addEventListener('abort', () => {
        abortController?.abort();
      }, { once: true });
    }

    // Ensure base URL is resolved (async for Tauri port probing)
    try {
      await ensureBaseUrl();
    } catch (err) {
      if (!closed && !abortController.signal.aborted) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    const connectToken = attemptToken ?? currentToken;
    const connectUrl = buildUrl(lastEventId);

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...extraHeaders,
    };
    if (connectToken) {
      headers.Authorization = `Bearer ${connectToken}`;
    }
    if (lastEventId) {
      headers['Last-Event-ID'] = lastEventId;
    }

    let response: Response;
    try {
      response = await fetch(connectUrl, {
        method: 'GET',
        headers,
        signal: abortController.signal,
        cache: 'no-store',
      });
    } catch (err) {
      if (abortController.signal.aborted || closed) return;
      // Network error - schedule reconnect
      onConnectionChange?.(false);
      scheduleReconnect();
      return;
    }

    // Handle 401 - try refreshing token once
    if (response.status === 401 && !isRetryAfter401 && refreshToken) {
      try {
        const newToken = await refreshToken();
        currentToken = newToken;
        // Retry immediately with new token
        return connect(newToken, true);
      } catch (refreshErr) {
        onError?.(new Error('认证已过期，请重新登录'));
        onConnectionChange?.(false);
        closed = true;
        return;
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        onError?.(new Error('UNAUTHORIZED'));
        onConnectionChange?.(false);
        closed = true;
        return;
      }
      onConnectionChange?.(false);
      scheduleReconnect();
      return;
    }

    if (!response.body) {
      onConnectionChange?.(false);
      scheduleReconnect();
      return;
    }

    // Connection established
    onConnectionChange?.(true);
    onOpen?.();
    retries = 0;
    retryDelay = minReconnectDelay;

    const parser = new SseFrameParser(dispatchEvent);
    const reader = response.body.getReader();
    currentReader = reader;
    const decoder = new TextDecoder();

    try {
      while (!abortController.signal.aborted && !closed) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.end();
    } catch (err) {
      if (abortController.signal.aborted || closed) {
        // Normal cancellation
      } else if (err instanceof TypeError && isNetworkError(err)) {
        // Network error - will reconnect
      } else {
        console.error('[SSE] Read error:', err);
      }
    } finally {
      reader.releaseLock();
      currentReader = null;
    }

    onConnectionChange?.(false);
    onClose?.();

    if (!closed && !signal?.aborted) {
      scheduleReconnect();
    }
  }

  function scheduleReconnect(delay?: number) {
    if (closed) return;
    if (signal?.aborted) return;

    // Check if we should stop reconnecting
    if (shouldReconnect && !shouldReconnect()) {
      closed = true;
      return;
    }

    retries += 1;
    if (retries > maxRetries) {
      onError?.(new Error(`SSE 重连次数超过上限 (${maxRetries})，请刷新页面重试`));
      closed = true;
      return;
    }

    const reconnectDelay = delay ?? computeBackoff(retries, minReconnectDelay, maxReconnectDelay);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelay);
  }

  function close() {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (currentReader) {
      try { currentReader.cancel(); } catch { /* ignore */ }
      currentReader = null;
    }
    abortController?.abort();
    onConnectionChange?.(false);
  }

  function reconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    abortController?.abort();
    retries = 0;
    // Connect on next tick (allow current stack to unwind)
    setTimeout(() => { void connect(); }, 0);
  }

  function setToken(token: string) {
    currentToken = token;
  }

  // Start initial connection
  void connect();

  return {
    close,
    getLastEventId: () => lastEventId,
    reconnect,
    setToken,
  };
}

/** Compute exponential backoff with jitter. */
export function computeBackoff(
  attempt: number,
  minDelay: number,
  maxDelay: number,
): number {
  const base = Math.min(maxDelay, minDelay * Math.pow(2, Math.max(0, attempt - 1)));
  // Add jitter: ±25% to avoid thundering herd
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(minDelay, Math.min(maxDelay, Math.round(base + jitter)));
}

function isNetworkError(err: TypeError): boolean {
  const msg = err.message;
  return (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('network') ||
    msg.includes('aborted') ||
    msg.includes('Load failed')
  );
}
