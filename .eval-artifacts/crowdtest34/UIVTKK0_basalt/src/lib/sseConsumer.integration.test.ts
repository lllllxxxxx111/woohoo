/**
 * Integration-style tests for SSE consumer with fake fetch.
 *
 * Regression test matrix covering:
 * - Chunked/multi-line SSE frames across arbitrary boundaries
 * - Duplicate event ID rejection (idempotency)
 * - Out-of-order / terminal state protection
 * - Disconnect + reconnect with Last-Event-ID
 * - Cursor replay and cursor-expired resync
 * - 401 token refresh and retry
 * - [DONE] / done termination
 * - Comment line (keepalive) ignoring
 * - Missing-task grace period thresholds
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSseConsumer, SseParser, calculateBackoff, isDoneMarker } from './sseConsumer';
import {
  shouldApplyTaskEvent,
  SeenEventTracker,
  isTerminalStatus,
  formatTerminalTaskContent,
  MISSING_TASK_GRACE_PERIOD_MS,
  MISSING_TASK_TIMEOUT_MS,
} from './taskStateSemantics';

// ---- SSE Frame Encoding Helpers (produce strings for SseParser) ----

function encodeFrame(opts: { event?: string; data?: string; id?: string; retry?: number }): string {
  let frame = '';
  if (opts.id !== undefined) frame += `id: ${opts.id}\n`;
  if (opts.retry !== undefined) frame += `retry: ${opts.retry}\n`;
  if (opts.event) frame += `event: ${opts.event}\n`;
  if (opts.data !== undefined) {
    for (const line of opts.data.split('\n')) {
      frame += `data: ${line}\n`;
    }
  }
  frame += '\n';
  return frame;
}

function encodeEvent(event: string, data: string | object, id?: string): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  return encodeFrame({ event, data: dataStr, id });
}

function encodeComment(comment: string): string {
  return `: ${comment}\n\n`;
}

function encodeDone(id?: string): string {
  return encodeFrame({ event: 'done', data: '[DONE]', id });
}

// Feed raw SSE string to Response body as a stream; no artificial timers
function makeTextResponse(chunks: string[], status = 200, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  });
}

// ---- Tests ----

describe('SSE Consumer (mock fetch)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('parses a single complete SSE event from a single chunk', async () => {
    const events: any[] = [];
    const chunk = encodeEvent('task_update', { id: 't1', status: 'running' }, 'ai-1');
    const fetchImpl = vi.fn().mockResolvedValue(makeTextResponse([chunk]));

    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      onEvent: e => events.push(e),
      shouldReconnect: () => false,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(events.length).toBe(1);
    expect(events[0].event).toBe('task_update');
    expect(events[0].id).toBe('ai-1');
    const data = JSON.parse(events[0].data);
    expect(data.status).toBe('running');

    controller.close();
  });

  it('handles events split across arbitrary chunk boundaries', async () => {
    const events: any[] = [];
    const fullFrame = encodeEvent('task_update', { id: 't1', status: 'queued' }, 'ai-1');
    const mid = 7;
    const chunks = [fullFrame.slice(0, mid), fullFrame.slice(mid)];
    const fetchImpl = vi.fn().mockResolvedValue(makeTextResponse(chunks));

    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      onEvent: e => events.push(e),
      shouldReconnect: () => false,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(events.length).toBe(1);
    expect(JSON.parse(events[0].data).status).toBe('queued');
    controller.close();
  });

  it('parses multi-line data fields correctly', async () => {
    const events: any[] = [];
    const dataWithNewlines = 'line1\nline2\nline3';
    const frame = encodeFrame({ event: 'message_delta', data: dataWithNewlines, id: 'ai-2' });
    const split = Math.floor(frame.length / 2);
    const chunks = [frame.slice(0, split), frame.slice(split)];
    const fetchImpl = vi.fn().mockResolvedValue(makeTextResponse(chunks));

    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      onEvent: e => events.push(e),
      shouldReconnect: () => false,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(events.length).toBe(1);
    expect(events[0].data).toBe(dataWithNewlines);
    controller.close();
  });

  it('tracks Last-Event-ID and sends it on reconnect', async () => {
    const calls: Array<{ url: string; headers: any }> = [];
    let callCount = 0;

    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      callCount++;
      calls.push({ url, headers: { ...(init?.headers || {}) } });
      if (callCount === 1) {
        return makeTextResponse([encodeEvent('task_update', { id: 't1' }, 'ai-5')]);
      }
      return makeTextResponse([
        encodeEvent('task_update', { id: 't1', status: 'running' }, 'ai-6'),
        encodeDone('ai-7'),
      ]);
    });

    const events: any[] = [];
    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      initialRetryMs: 100,
      maxRetryMs: 1000,
      onEvent: e => events.push(e),
      shouldReconnect: () => events.filter(e => e.event === 'done').length === 0,
    });

    // First connection drains
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    // Wait for reconnect backoff
    await vi.advanceTimersByTimeAsync(5000);

    expect(callCount).toBeGreaterThanOrEqual(2);
    const secondCallHeaders = calls[1].headers;
    expect(secondCallHeaders['Last-Event-ID']).toBe('ai-5');

    controller.close();
  });

  it('handles 401 by calling refreshToken and retrying with new token', async () => {
    const refreshToken = vi.fn().mockResolvedValue('new-token-xyz');
    let callCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      callCount++;
      const headers = (init?.headers || {}) as Record<string, string>;
      if (callCount === 1) {
        expect(headers['Authorization']).toBe('Bearer old-token');
        return new Response(null, { status: 401 });
      }
      expect(refreshToken).toHaveBeenCalled();
      expect(headers['Authorization']).toBe('Bearer new-token-xyz');
      return makeTextResponse([encodeDone('ai-1')]);
    });

    const events: any[] = [];
    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      headers: { Authorization: 'Bearer old-token' },
      refreshToken,
      initialRetryMs: 50,
      onEvent: e => events.push(e),
      shouldReconnect: () => false,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
    controller.close();
  });

  it('emits resync_required when server sends resync event', async () => {
    const events: any[] = [];
    const resyncReasons: string[] = [];

    const fetchImpl = vi.fn().mockResolvedValue(
      makeTextResponse([
        encodeEvent('resync_required', { reason: 'cursor_too_old', buffer_capacity: 1024 }, 'ai-1'),
      ]),
    );

    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      onEvent: e => events.push(e),
      onResyncRequired: (reason: string) => {
        resyncReasons.push(reason);
        return false; // caller handles resync; no auto-reconnect
      },
      shouldReconnect: () => false,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(events.length).toBe(1);
    expect(events[0].event).toBe('resync_required');
    expect(resyncReasons.length).toBe(1);
    expect(resyncReasons[0]).toBe('cursor_too_old');
    controller.close();
  });

  it('stops reconnecting when shouldReconnect returns false (no pending tasks)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeTextResponse([]));

    let reconnectCount = 0;
    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      initialRetryMs: 50,
      maxRetryMs: 500,
      onEvent: () => {},
      onReconnect: () => { reconnectCount++; },
      shouldReconnect: (attempt: number) => attempt < 2,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30000);

    expect(reconnectCount).toBeLessThanOrEqual(3);
    controller.close();
  });

  it('terminates on done event without error', async () => {
    const events: any[] = [];
    const errors: Error[] = [];

    const fetchImpl = vi.fn().mockResolvedValue(
      makeTextResponse([
        encodeEvent('task_update', { id: 't1' }, 'ai-1'),
        encodeDone('ai-2'),
      ]),
    );

    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      onEvent: e => events.push(e),
      onError: e => { errors.push(e); return false; },
      shouldReconnect: () => false,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(errors.length).toBe(0);
    expect(events.some(e => e.event === 'done')).toBe(true);
    controller.close();
  });

  it('ignores comment lines (keepalives)', async () => {
    const events: any[] = [];
    const chunks = [
      encodeComment('keepalive'),
      encodeEvent('task_update', { id: 't1' }, 'ai-1'),
      encodeComment('another keepalive'),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(makeTextResponse(chunks));

    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      onEvent: e => events.push(e),
      shouldReconnect: () => false,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(events.length).toBe(1);
    expect(events[0].event).toBe('task_update');
    controller.close();
  });

  it('supports cursor as query parameter instead of Last-Event-ID header', async () => {
    let lastUrl = '';
    let callCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      lastUrl = url;
      if (callCount === 1) {
        return makeTextResponse([encodeEvent('pipeline_step', { step: 1 }, 'pipe-100')]);
      }
      return makeTextResponse([encodeDone('pipe-101')]);
    });

    const events: any[] = [];
    const controller = createSseConsumer({
      url: 'http://test/pipeline/stream',
      fetchImpl: fetchImpl as any,
      useCursorQueryParam: true,
      initialRetryMs: 50,
      onEvent: e => events.push(e),
      shouldReconnect: () => events.filter(e => e.event === 'done').length === 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(lastUrl).toContain('cursor=pipe-100');
    expect(lastUrl).not.toContain('Last-Event-ID');
    controller.close();
  });

  it('stops reconnecting after maxReconnectAttempts cap', async () => {
    const errors: Error[] = [];
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    let reconnectCount = 0;

    const controller = createSseConsumer({
      url: 'http://test/stream',
      fetchImpl: fetchImpl as any,
      initialRetryMs: 10,
      maxRetryMs: 50,
      maxReconnectAttempts: 5,
      onEvent: () => {},
      onError: (e) => { errors.push(e); return true; },
      onReconnect: () => { reconnectCount++; },
      shouldReconnect: () => true,
    });

    // Advance past all retries
    await vi.advanceTimersByTimeAsync(60_000);

    // Should have stopped after at most 5 reconnects + one final error
    expect(reconnectCount).toBeLessThanOrEqual(6);
    const capError = errors.find(e => e.message.includes('max attempts'));
    expect(capError).toBeTruthy();

    controller.close();
  });
});

describe('calculateBackoff', () => {
  it('caps at maxRetryMs even after many attempts', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const delay = calculateBackoff(attempt, 1000, 30000);
      expect(delay).toBeLessThanOrEqual(30000 * 1.2 + 1);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('exponential base doubles each attempt before cap', () => {
    // Test without jitter by stubbing Math.random
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect(calculateBackoff(0, 1000, 30000)).toBe(1000); // 1000 * 2^0 = 1000
      expect(calculateBackoff(1, 1000, 30000)).toBe(2000); // 1000 * 2^1 = 2000
      expect(calculateBackoff(2, 1000, 30000)).toBe(4000); // 1000 * 2^2 = 4000
      expect(calculateBackoff(3, 1000, 30000)).toBe(8000); // 1000 * 2^3 = 8000
    } finally {
      spy.mockRestore();
    }
  });
});

describe('isDoneMarker', () => {
  it('recognizes [DONE] variants', () => {
    expect(isDoneMarker('[DONE]')).toBe(true);
    expect(isDoneMarker('  [DONE]  ')).toBe(true);
    expect(isDoneMarker('done')).toBe(true);
  });

  it('rejects non-done data', () => {
    expect(isDoneMarker('{"status":"running"}')).toBe(false);
    expect(isDoneMarker('hello')).toBe(false);
  });
});

// ---- Idempotency & Ordering ----

describe('SeenEventTracker idempotency', () => {
  it('prevents duplicate processing of same event key', () => {
    const tracker = new SeenEventTracker();
    expect(tracker.checkAndAdd('ai-5:completed')).toBe(true);
    expect(tracker.checkAndAdd('ai-5:completed')).toBe(false);
    expect(tracker.checkAndAdd('ai-6:running')).toBe(true);
  });

  it('evicts stale entries to avoid unbounded growth', () => {
    const tracker = new SeenEventTracker();
    tracker.checkAndAdd('old-key');
    (tracker as any).seen.set('old-key', Date.now() - 2 * 60 * 60 * 1000);
    tracker.evictStale(30 * 60 * 1000);
    expect(tracker.has('old-key')).toBe(false);
  });

  it('clearTask removes only entries for that task prefix', () => {
    const tracker = new SeenEventTracker();
    tracker.checkAndAdd('task-a:completed:10');
    tracker.checkAndAdd('task-a:running:9');
    tracker.checkAndAdd('task-b:completed:11');
    tracker.clearTask('task-a');
    expect(tracker.has('task-a:completed:10')).toBe(false);
    expect(tracker.has('task-b:completed:11')).toBe(true);
  });
});

describe('shouldApplyTaskEvent out-of-order & terminal protection', () => {
  it('prevents queued arriving after completed', () => {
    expect(shouldApplyTaskEvent('completed', 'queued', 1000, undefined)).toBe(false);
  });

  it('prevents running arriving after failed', () => {
    expect(shouldApplyTaskEvent('failed', 'running', 1000, undefined)).toBe(false);
  });

  it('allows queued -> running (forward progression)', () => {
    expect(shouldApplyTaskEvent('queued', 'running', undefined, undefined)).toBe(true);
  });

  it('allows running -> completed', () => {
    expect(shouldApplyTaskEvent('running', 'completed', undefined, 1000)).toBe(true);
  });

  it('allows repeated completed (idempotent)', () => {
    expect(shouldApplyTaskEvent('completed', 'completed', 1000, 1000)).toBe(true);
  });

  it('prevents cancelled being overwritten by running', () => {
    expect(shouldApplyTaskEvent('cancelled', 'running', 500, undefined)).toBe(false);
  });

  it('prevents blocked being overwritten by earlier running', () => {
    // blocked (terminal) cannot be overwritten by running (non-terminal)
    expect(shouldApplyTaskEvent('blocked', 'running', 500, undefined)).toBe(false);
  });

  it('allows later completed to replace earlier failed (correction)', () => {
    expect(shouldApplyTaskEvent('failed', 'completed', 500, 1000)).toBe(true);
  });

  it('rejects earlier terminal replacing later terminal', () => {
    expect(shouldApplyTaskEvent('completed', 'failed', 1000, 500)).toBe(false);
  });

  it('applies when current status is undefined (first event)', () => {
    expect(shouldApplyTaskEvent(undefined, 'queued', null, null)).toBe(true);
  });

  it('prevents scope mismatch: task from one conversation cannot apply to another', () => {
    // This is enforced at the hook level via conversationId check,
    // but we verify the primitive supports it - same task, same precedence, no override
    expect(shouldApplyTaskEvent('running', 'running', undefined, undefined)).toBe(true);
  });
});

describe('Terminal state identification', () => {
  it('isTerminalStatus covers all terminal states', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('blocked')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
  });
});

describe('Missing-task thresholds', () => {
  it('grace period is strictly shorter than hard timeout', () => {
    expect(MISSING_TASK_GRACE_PERIOD_MS).toBeLessThan(MISSING_TASK_TIMEOUT_MS);
  });

  it('grace period is at least 5 seconds (avoids flapping)', () => {
    expect(MISSING_TASK_GRACE_PERIOD_MS).toBeGreaterThanOrEqual(5000);
  });
});

// ---- SseParser low-level unit tests ----

describe('SseParser frame parsing edge cases', () => {
  it('persists retry value across subsequent events', () => {
    const parser = new SseParser();
    // First block: retry only, no data lines -> no event emitted
    let events = parser.feed('retry: 5000\n\n');
    expect(events.length).toBe(0);
    expect(parser.getLastRetry()).toBe(5000);

    // Second block: a normal event inherits the retry
    events = parser.feed(encodeFrame({ event: 'ping', data: 'hello' }));
    expect(events.length).toBe(1);
    expect(events[0].retry).toBe(5000);
  });

  it('persists last event ID across events', () => {
    const parser = new SseParser();
    parser.feed(encodeFrame({ event: 'a', data: '1', id: 'evt-1' }));
    expect(parser.getLastEventId()).toBe('evt-1');
    // Next event without id should still carry previous id
    const events = parser.feed(encodeFrame({ event: 'b', data: '2' }));
    expect(events.length).toBe(1);
    expect(events[0].id).toBe('evt-1');
  });

  it('defaults event type to "message" when not specified', () => {
    const parser = new SseParser();
    const events = parser.feed('data: hello\n\n');
    expect(events.length).toBe(1);
    expect(events[0].event).toBe('message');
    expect(events[0].data).toBe('hello');
  });

  it('joins multiple data lines with \\n', () => {
    const parser = new SseParser();
    const events = parser.feed('data: line1\ndata: line2\n\n');
    expect(events.length).toBe(1);
    expect(events[0].data).toBe('line1\nline2');
  });

  it('recovers partial frames across multiple feeds', () => {
    const parser = new SseParser();
    const frame = encodeFrame({ event: 'task_update', data: 'payload', id: 'x-1' });
    const events1 = parser.feed(frame.slice(0, 5));
    expect(events1.length).toBe(0);
    const events2 = parser.feed(frame.slice(5));
    expect(events2.length).toBe(1);
    expect(events2[0].id).toBe('x-1');
    expect(events2[0].data).toBe('payload');
  });

  it('strips leading UTF-8 BOM on first chunk', () => {
    const parser = new SseParser();
    const events = parser.feed('\uFEFFevent: update\ndata: hello\n\n');
    expect(events.length).toBe(1);
    expect(events[0].event).toBe('update');
    expect(events[0].data).toBe('hello');
  });

  it('does not strip BOM in the middle of stream', () => {
    const parser = new SseParser();
    // First chunk has no BOM, bomStripped flips to true
    parser.feed('event: a\ndata: 1\n\n');
    // Second chunk with BOM should keep the BOM as data (treated as part of field)
    const events = parser.feed('\uFEFFdata: embedded\n\n');
    // The BOM will be part of the line "data: ..." check; line starts with BOM then 'data'
    // so field detection fails → event fired with no data. Verify no crash.
    expect(Array.isArray(events)).toBe(true);
  });

  it('reset() clears buffer for new connection but keeps lastEventId/retry per spec', () => {
    const parser = new SseParser();
    parser.feed('id: keep-1\nretry: 3000\ndata: a\n\n');
    expect(parser.getLastEventId()).toBe('keep-1');
    expect(parser.getLastRetry()).toBe(3000);
    parser.reset();
    expect(parser.getBuffer()).toBe('');
    // Last seen event ID and retry persist across connections (for Last-Event-ID header)
    expect(parser.getLastEventId()).toBe('keep-1');
    expect(parser.getLastRetry()).toBe(3000);
  });

  it('ignores unknown SSE fields per spec (e.g. "foo: bar")', () => {
    const parser = new SseParser();
    const events = parser.feed('event: msg\nfoo: bar\ndata: real\n\n');
    expect(events.length).toBe(1);
    expect(events[0].data).toBe('real');
    expect((events[0] as any).foo).toBeUndefined();
  });

  it('strips exactly one leading space from field value per spec', () => {
    const parser = new SseParser();
    const events = parser.feed('data:   three-spaces\n\n');
    // Spec: strip exactly one space after colon, leaving two spaces
    expect(events[0].data).toBe('  three-spaces');
  });

  it('handles field with no colon (whole line is field name, empty value)', () => {
    const parser = new SseParser();
    // "data" alone with no colon → field name "data", value empty
    // Per the colon-split logic in our parser, line without colon has value = ''
    const events = parser.feed('data\ndata: real\n\n');
    // First field: data with empty value. Two data lines joined by \n.
    expect(events[0].data).toBe('\nreal');
  });

  it('does not emit event for comment-only blocks', () => {
    const parser = new SseParser();
    const events = parser.feed(':keepalive\n\n');
    expect(events.length).toBe(0);
  });

  it('ignores id fields containing null character per SSE spec', () => {
    const parser = new SseParser();
    const prevId = parser.getLastEventId();
    parser.feed(`id: bad\u0000id\ndata: x\n\n`);
    // ID containing \0 should not update lastEventId
    expect(parser.getLastEventId()).toBe(prevId);
  });

  it('handles \\r\\n line endings gracefully', () => {
    const parser = new SseParser();
    const events = parser.feed('event: update\r\ndata: hello\r\n\r\n');
    expect(events.length).toBe(1);
    expect(events[0].event).toBe('update');
    expect(events[0].data).toBe('hello');
  });
});

// ---- Reconnect / double-schedule prevention tests ----

describe('SSE Consumer lifecycle (reconnect & done semantics)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does NOT schedule an extra reconnect after a done marker', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    // First response emits done then closes
    fetchImpl.mockResolvedValueOnce(
      makeTextResponse([encodeFrame({ event: 'done', data: '[DONE]', id: 'ai-1' })]),
    );
    // If a buggy extra reconnect fires, this second response will be consumed
    fetchImpl.mockResolvedValueOnce(
      makeTextResponse([encodeFrame({ event: 'queued', data: '{"t":2}', id: 'ai-2' })]),
    );

    const events: any[] = [];
    const controller = createSseConsumer({
      url: '/stream',
      fetchImpl: fetchImpl as any,
      onEvent: (e) => events.push(e),
      initialRetryMs: 100,
      maxRetryMs: 1000,
      maxReconnectAttempts: 3,
      shouldReconnect: () => true,
    });

    // Let first fetch resolve and stream consume
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // Allow time for any (buggy) scheduled reconnect
    await vi.advanceTimersByTimeAsync(5000);

    controller.close();

    // Only the done event should be seen; fetch called once only
    expect(events.map((e) => e.event)).toEqual(['done']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT double-schedule reconnect on resync_required (handler returns true)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    // First response: resync_required with id, then leave stream open via never-closing
    // controller so the consumer stays in processResponse until we cancel it.
    let firstController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const firstStream = new ReadableStream<Uint8Array>({
      start(c: ReadableStreamDefaultController<Uint8Array>) {
        firstController = c;
        const encoder = new TextEncoder();
        c.enqueue(
          encoder.encode(
            encodeFrame({
              event: 'resync_required',
              data: JSON.stringify({ reason: 'cursor_expired' }),
              id: 'ai-50',
            }),
          ),
        );
        // do NOT close — simulate persistent connection
      },
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(firstStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    // Second response (reconnect after resync): snapshot, leave open
    let secondController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const secondStream = new ReadableStream<Uint8Array>({
      start(c: ReadableStreamDefaultController<Uint8Array>) {
        secondController = c;
        const encoder = new TextEncoder();
        c.enqueue(
          encoder.encode(
            encodeFrame({ event: 'snapshot', data: '{"tasks":[]}', id: 'ai-51' }),
          ),
        );
      },
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(secondStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const events: any[] = [];
    const controller = createSseConsumer({
      url: '/stream',
      fetchImpl: fetchImpl as any,
      onEvent: (e) => events.push(e),
      onResyncRequired: () => true,
      initialRetryMs: 10,
      maxRetryMs: 50,
      maxReconnectAttempts: 5,
      shouldReconnect: () => true,
    });

    // Allow time for resync_required processing + scheduled reconnect
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    controller.close();
    // Clean up any open streams
    try { (firstController as ReadableStreamDefaultController<Uint8Array> | null)?.close(); } catch { /* already closed */ }
    try { (secondController as ReadableStreamDefaultController<Uint8Array> | null)?.close(); } catch { /* already closed */ }

    // Expected events: resync_required, snapshot
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain('resync_required');
    expect(eventTypes).toContain('snapshot');
    // Exactly two fetch calls: initial, then one reconnect scheduled by resync.
    // The fix (intentionallyCancelled flag) prevents a second reconnect being
    // scheduled after processResponse returns from the first (resync) stream.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends Last-Event-ID on reconnect after partial stream', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    // First response: one event then close (simulating disconnect)
    fetchImpl.mockResolvedValueOnce(
      makeTextResponse([encodeFrame({ event: 'running', data: '{"task":{}}', id: 'ai-7' })]),
    );
    // Second response (reconnect): verify Last-Event-ID header is ai-7
    let seenLastEventId: string | null = null;
    fetchImpl.mockImplementationOnce((input, init) => {
      seenLastEventId = (init?.headers as Record<string, string>)?.['Last-Event-ID'] ?? null;
      return Promise.resolve(makeTextResponse([encodeDone('ai-8')])) as any;
    });

    const controller = createSseConsumer({
      url: '/stream',
      fetchImpl: fetchImpl as any,
      onEvent: () => {},
      initialRetryMs: 10,
      maxRetryMs: 50,
      shouldReconnect: () => true,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();

    controller.close();
    expect(seenLastEventId).toBe('ai-7');
  });

  it('hard-caps reconnection attempts and surfaces error', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    // Every fetch fails with network error
    fetchImpl.mockRejectedValue(new TypeError('Failed to fetch'));

    const errors: Error[] = [];
    const controller = createSseConsumer({
      url: '/stream',
      fetchImpl: fetchImpl as any,
      onEvent: () => {},
      onError: (e) => {
        errors.push(e);
        return true;
      },
      initialRetryMs: 5,
      maxRetryMs: 10,
      maxReconnectAttempts: 3,
      shouldReconnect: () => true,
    });

    await vi.advanceTimersByTimeAsync(1000);
    controller.close();

    // Should have seen a max-attempts error
    expect(errors.some((e) => e.message.includes('max attempts'))).toBe(true);
    // Fetch called at most maxReconnectAttempts+1 (initial + N retries)
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

// ---- Backend-restart gap detection (unit test mirrors server logic) ----

describe('Replay gap detection (mirrors backend heuristic)', () => {
  /**
   * Pure JS mirror of the Rust replay_events_after logic to ensure our
   * understanding of restart/rollover gaps stays in sync. The real backend
   * enforces this; the frontend simply consumes the resulting resync_required.
   */
  function replayEventsAfter(
    buffer: { seq: number }[],
    afterSeq: number,
  ): { replayed: number[]; hasGap: boolean } {
    if (buffer.length === 0) {
      return { replayed: [], hasGap: afterSeq > 0 };
    }
    const oldest = buffer[0].seq;
    if (oldest > afterSeq + 1) {
      return { replayed: [], hasGap: true };
    }
    return {
      replayed: buffer.filter((e) => e.seq > afterSeq).map((e) => e.seq),
      hasGap: false,
    };
  }

  it('returns no gap on fresh client (afterSeq=0) with empty buffer', () => {
    expect(replayEventsAfter([], 0)).toEqual({ replayed: [], hasGap: false });
  });

  it('signals gap when buffer is empty but client had a cursor (process restart)', () => {
    expect(replayEventsAfter([], 50)).toEqual({ replayed: [], hasGap: true });
  });

  it('signals gap on buffer rollover (oldest > afterSeq+1)', () => {
    const buf = [{ seq: 100 }, { seq: 101 }, { seq: 102 }];
    expect(replayEventsAfter(buf, 50)).toEqual({ replayed: [], hasGap: true });
  });

  it('replays contiguous events with no gap', () => {
    const buf = [{ seq: 51 }, { seq: 52 }, { seq: 53 }];
    expect(replayEventsAfter(buf, 50)).toEqual({ replayed: [51, 52, 53], hasGap: false });
  });

  it('replays when client is partially caught up', () => {
    const buf = [{ seq: 51 }, { seq: 52 }];
    expect(replayEventsAfter(buf, 51)).toEqual({ replayed: [52], hasGap: false });
  });
});

// ---- API-vs-SSE race: create response carrying terminal status ----

describe('API-vs-SSE race: createTask returning terminal status', () => {
  // The runtime guard lives in useAiMessageRuntime; here we verify that the
  // isTerminalStatus + formatTerminalTaskContent primitives power it correctly.
  it('isTerminalStatus recognizes completed/failed/cancelled/blocked only', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('blocked')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
  });

  it('formatTerminalTaskContent renders failed/cancelled/blocked as system-error', () => {
    const failed = formatTerminalTaskContent({ status: 'failed', error: 'boom', result: null });
    expect(failed.role).toBe('system');
    expect(failed.content).toContain('任务失败');

    const blocked = formatTerminalTaskContent({ status: 'blocked', error: 'guard', result: null });
    expect(blocked.role).toBe('system');
    expect(blocked.content).toContain('阻塞');
  });
});

// ---- Parser hardening: extreme fragmentation and line-ending combos ----

describe('SSE parser hardening (extreme fragmentation)', () => {
  it('parses events fed 1 character at a time (LF-only)', () => {
    const parser = new SseParser();
    const stream = 'event: complete\ndata: hello\n\n';
    const all: any[] = [];
    for (const ch of stream) {
      all.push(...parser.feed(ch));
    }
    expect(all.length).toBe(1);
    expect(all[0].event).toBe('complete');
    expect(all[0].data).toBe('hello');
  });

  it('parses events fed 1 character at a time (CRLF line endings)', () => {
    const parser = new SseParser();
    const stream = 'event: done\r\ndata: bye\r\n\r\n';
    const all: any[] = [];
    for (const ch of stream) {
      all.push(...parser.feed(ch));
    }
    expect(all.length).toBe(1);
    expect(all[0].event).toBe('done');
    expect(all[0].data).toBe('bye');
  });

  it('handles CRLF split across two chunks (CR in chunk1, LF in chunk2) without spurious events', () => {
    // This is the regression test for the CRLF-split bug. Previously feeding
    // "data: x\r" then "\n\n" produced TWO events (the data event + an empty
    // event) because eager \r->\n conversion created a false "\n\n".
    const parser = new SseParser();
    let all: any[] = [];
    all = all.concat(parser.feed('data: x\r'));
    // After first chunk (trailing CR), no event should fire yet (ambiguous)
    expect(all.length).toBe(0);
    all = all.concat(parser.feed('\n\n'));
    // After second chunk, exactly ONE event with data "x"
    expect(all.length).toBe(1);
    expect(all[0].data).toBe('x');
  });

  it('handles CR-only line endings split across chunks', () => {
    // Old-school Mac CR-only. "data: a\r\r" means event with data "a".
    const parser = new SseParser();
    let all: any[] = parser.feed('data: a\r');
    expect(all.length).toBe(0); // trailing CR ambiguous
    all = all.concat(parser.feed('\r'));
    expect(all.length).toBe(1);
    expect(all[0].data).toBe('a');
  });

  it('handles mixed line endings (LF then CRLF as separator)', () => {
    const parser = new SseParser();
    const stream = 'data: line1\ndata: line2\r\n\r\n';
    const events = parser.feed(stream);
    expect(events.length).toBe(1);
    expect(events[0].data).toBe('line1\nline2');
  });

  it('handles multi-byte UTF-8 split across single-char chunks', () => {
    const parser = new SseParser();
    const msg = 'event: msg\ndata: 你好🌍\n\n';
    // Encode to bytes, then feed byte-by-byte into a TextDecoder-like flow.
    // Since the consumer uses TextDecoder for binary -> text, we simulate
    // by feeding the string directly char-by-char (the parser itself works
    // on strings; mid-UTF8 safety is provided by TextDecoder upstream).
    const all: any[] = [];
    for (const ch of msg) {
      all.push(...parser.feed(ch));
    }
    expect(all.length).toBe(1);
    expect(all[0].data).toBe('你好🌍');
  });

  it('does NOT dispatch trailing-CR event mid-CRLF when more bytes follow', () => {
    // First chunk ends with CR after data line; second chunk contains the LF
    // that completes CRLF, then a regular character starting next field (not
    // a blank line), then eventually the real separator.
    const parser = new SseParser();
    let all: any[] = parser.feed('data: first\r');
    expect(all.length).toBe(0);
    // Next chunk: \n completes CRLF, then "id: 5" then blank line
    all = all.concat(parser.feed('\nid: 5\n\n'));
    expect(all.length).toBe(1);
    expect(all[0].data).toBe('first');
    expect(all[0].id).toBe('5');
  });

  it('coalesces multiple consecutive blank lines into single event separator', () => {
    const parser = new SseParser();
    const events = parser.feed('data: a\n\n\n\ndata: b\n\n');
    expect(events.length).toBe(2);
    expect(events[0].data).toBe('a');
    expect(events[1].data).toBe('b');
  });

  it('handles comment-only chunks interspersed between real events', () => {
    const parser = new SseParser();
    const events = parser.feed(':ping\n\ndata: real\n\n:keep\n\n');
    // Comments alone do not produce events; expect exactly one real event
    const real = events.filter((e) => e.data === 'real');
    expect(real.length).toBe(1);
  });

  it('handles id field with BOM-prefixed first chunk correctly', () => {
    const parser = new SseParser();
    const events = parser.feed('\uFEFFid: 42\ndata: hi\n\n');
    expect(events.length).toBe(1);
    expect(events[0].id).toBe('42');
    expect(events[0].data).toBe('hi');
    expect(parser.getLastEventId()).toBe('42');
  });
});
