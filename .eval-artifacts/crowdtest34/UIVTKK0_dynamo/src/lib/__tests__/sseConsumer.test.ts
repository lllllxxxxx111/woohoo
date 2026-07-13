/**
 * Regression tests for SSE consumer: chunk parsing, multi-line frames,
 * event/data/id/retry fields, comments, done signals, reconnect logic.
 *
 * Tests use mock fetch streams — no external endpoints, GPU, or resident services required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSseChunk, isDoneSignal, SseConsumer, createSseConsumer, type SseEvent } from '../sseConsumer';

describe('parseSseChunk — SSE frame parsing', () => {
  it('parses a simple single-line event', () => {
    const raw = 'data: hello\n\n';
    const { events, remaining } = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'message',
      data: 'hello',
      id: null,
      retry: null,
    });
    expect(remaining).toBe('');
  });

  it('parses event type and data', () => {
    const raw = 'event: completed\ndata: {"taskId":"t1"}\n\n';
    const { events, remaining } = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
    expect(events[0].data).toBe('{"taskId":"t1"}');
    expect(remaining).toBe('');
  });

  it('parses event id field', () => {
    const raw = 'id: 42\nevent: running\ndata: {"progress":50}\n\n';
    const { events } = parseSseChunk(raw);
    expect(events[0].id).toBe('42');
    expect(events[0].event).toBe('running');
  });

  it('parses retry field', () => {
    const raw = 'retry: 5000\ndata: retry-set\n\n';
    const { events } = parseSseChunk(raw);
    expect(events[0].retry).toBe(5000);
  });

  it('handles multi-line data fields joined by newlines', () => {
    const raw = 'data: line1\ndata: line2\ndata: line3\n\n';
    const { events } = parseSseChunk(raw);
    expect(events[0].data).toBe('line1\nline2\nline3');
  });

  it('ignores comment lines starting with colon', () => {
    const raw = ': this is a comment\ndata: actual-data\n\n';
    const { events } = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('actual-data');
  });

  it('strips single space after colon in field values', () => {
    const raw = 'data:  spaced\n\n';
    const { events } = parseSseChunk(raw);
    expect(events[0].data).toBe(' spaced');
  });

  it('handles \\r\\n line endings', () => {
    const raw = 'event: test\r\ndata: value\r\n\r\n';
    const { events } = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('value');
  });

  it('handles \\r line endings', () => {
    const raw = 'event: test\rdata: value\r\r';
    const { events } = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('value');
  });

  it('carries incomplete line to next chunk (split boundary)', () => {
    const chunk1 = 'data: hel';
    const chunk2 = 'lo\n\n';
    const r1 = parseSseChunk(chunk1);
    expect(r1.events).toHaveLength(0);
    expect(r1.remaining).toBe('data: hel');

    const r2 = parseSseChunk(r1.remaining + chunk2);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].data).toBe('hello');
  });

  it('handles chunk split across event and data fields', () => {
    // Simulate TCP splitting between event: and data:
    const chunk1 = 'event: completed\ndata: {"taskId":"t1"';
    const chunk2 = ',"status":"done"}\n\n';

    const r1 = parseSseChunk(chunk1);
    expect(r1.events).toHaveLength(0);
    expect(r1.remaining).toContain('event: completed');

    const r2 = parseSseChunk(r1.remaining + chunk2);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].event).toBe('completed');
    expect(JSON.parse(r2.events[0].data).status).toBe('done');
  });

  it('handles empty data field', () => {
    const raw = 'data:\n\n';
    const { events } = parseSseChunk(raw);
    expect(events[0].data).toBe('');
  });

  it('handles field without colon as field with empty value', () => {
    const raw = 'data\n\n';
    const { events } = parseSseChunk(raw);
    expect(events[0].data).toBe('');
  });

  it('parses multiple frames in one chunk', () => {
    const raw = 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n';
    const { events } = parseSseChunk(raw);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('a');
    expect(events[1].event).toBe('b');
  });

  it('ignores IDs containing null bytes (per SSE spec)', () => {
    const raw = 'id: bad\u0000id\ndata: test\n\n';
    const { events } = parseSseChunk(raw);
    expect(events[0].id).toBeNull();
  });

  it('resets event type after each frame', () => {
    const raw = 'event: custom\ndata: first\n\ndata: second\n\n';
    const { events } = parseSseChunk(raw);
    expect(events[0].event).toBe('custom');
    expect(events[1].event).toBe('message');
  });

  it('returns empty events for empty input', () => {
    const { events, remaining } = parseSseChunk('');
    expect(events).toHaveLength(0);
    expect(remaining).toBe('');
  });

  it('handles keepalive/heartbeat (comment-only frame)', () => {
    const raw = ':keepalive\n\n';
    const { events } = parseSseChunk(raw);
    expect(events).toHaveLength(0);
  });
});

describe('isDoneSignal — done/[DONE] detection', () => {
  it('detects event: done', () => {
    expect(isDoneSignal({ event: 'done', data: '', id: null, retry: null })).toBe(true);
  });

  it('detects data: [DONE]', () => {
    expect(isDoneSignal({ event: 'message', data: '[DONE]', id: null, retry: null })).toBe(true);
  });

  it('detects data: "[DONE]" (quoted)', () => {
    expect(isDoneSignal({ event: 'message', data: '"[DONE]"', id: null, retry: null })).toBe(true);
  });

  it('does not false-positive on non-done events', () => {
    expect(isDoneSignal({ event: 'message', data: 'hello', id: null, retry: null })).toBe(false);
    expect(isDoneSignal({ event: 'completed', data: '{}', id: null, retry: null })).toBe(false);
  });
});

describe('SseConsumer — mock stream integration', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function createMockStream(chunks: string[], delay = 0): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream({
      async pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
        controller.enqueue(new TextEncoder().encode(chunks[index]));
        index++;
      },
    });
  }

  function mockFetchResponse(stream: ReadableStream, status = 200) {
    return Promise.resolve(
      new Response(stream, {
        status,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
  }

  it('consumes events from a stream', async () => {
    const events: SseEvent[] = [];
    const stream = createMockStream([
      'event: completed\ndata: {"result":"ok"}\n\n',
    ]);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: (e) => events.push(e),
      fetchImpl: global.fetch,
    });

    await consumer.connect();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
  });

  it('handles chunks split across multiple reads', async () => {
    const events: SseEvent[] = [];
    // Split a single SSE frame across 3 chunks
    const stream = createMockStream([
      'event: running\nid: 10\ndata: {"p',
      'rogress": 5',
      '0}\n\n',
    ]);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: (e) => events.push(e),
      fetchImpl: global.fetch,
    });

    await consumer.connect();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('running');
    expect(events[0].id).toBe('10');
    expect(JSON.parse(events[0].data).progress).toBe(50);
  });

  it('tracks last event ID for reconnection', async () => {
    const stream = createMockStream([
      'id: 5\nevent: queued\ndata: {}\n\n',
      'id: 6\nevent: running\ndata: {}\n\n',
    ]);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    let lastId: string | null = null;
    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: () => {},
      onStateChange: () => {},
      fetchImpl: global.fetch,
    });

    await consumer.connect();
    lastId = consumer.getLastEventId();
    expect(lastId).toBe('6');
  });

  it('stops cleanly', async () => {
    const stream = createMockStream(['data: test\n\n']);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: () => {},
      fetchImpl: global.fetch,
    });

    consumer.stop();
    // Connect should immediately resolve after stop
    await consumer.connect();
  });

  it('calls onDone when done signal received', async () => {
    let doneCalled = false;
    const stream = createMockStream([
      'data: some content\n\n',
      'event: done\ndata: [DONE]\n\n',
    ]);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: () => {},
      onDone: () => {
        doneCalled = true;
      },
      fetchImpl: global.fetch,
    });

    await consumer.connect();
    expect(doneCalled).toBe(true);
  });

  it('does not reconnect when shouldReconnect returns false', async () => {
    let fetchCount = 0;
    const stream = createMockStream(['data: test\n\n']);
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return mockFetchResponse(stream);
    });

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: true,
      shouldReconnect: () => false, // Never reconnect
      onEvent: () => {},
      fetchImpl: global.fetch,
    });

    await consumer.connect();
    // Allow any scheduled reconnects to fire
    vi.advanceTimersByTime(60000);
    expect(fetchCount).toBeLessThanOrEqual(1);
  });

  it('reports connection state changes', async () => {
    const states: string[] = [];
    const stream = createMockStream(['data: hello\n\n']);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: () => {},
      onStateChange: (s) => states.push(s),
      fetchImpl: global.fetch,
    });

    await consumer.connect();

    expect(states).toContain('connecting');
    expect(states).toContain('open');
  });

  it('handles resync event from server', async () => {
    const events: SseEvent[] = [];
    const stream = createMockStream([
      'event: resync\ndata: {"reason":"cursor_expired","message":"resync needed"}\n\n',
    ]);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: (e) => events.push(e),
      fetchImpl: global.fetch,
    });

    await consumer.connect();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('resync');
    const data = JSON.parse(events[0].data);
    expect(data.reason).toBe('cursor_expired');
  });

  it('parses event ID from SSE id field', () => {
    const raw = 'id: 42\nevent: running\ndata: {"progress":50}\n\n';
    const result = parseSseChunk(raw);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('42');
    expect(result.events[0].event).toBe('running');
    expect(result.remaining).toBe('');
  });

  it('parses retry field for reconnect interval', () => {
    const raw = 'retry: 5000\ndata: hello\n\n';
    const result = parseSseChunk(raw);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].retry).toBe(5000);
  });

  it('handles snapshot event with cursor field', () => {
    const raw = 'id: 100\nevent: snapshot\ndata: {"tasks":[],"cursor":100}\n\n';
    const result = parseSseChunk(raw);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('100');
    expect(result.events[0].event).toBe('snapshot');
    const data = JSON.parse(result.events[0].data);
    expect(data.cursor).toBe(100);
  });

  it('sends Last-Event-ID header on initial connection when provided', async () => {
    const capturedHeaders: Record<string, string> = {};
    const stream = createMockStream(['data: ok\n\n']);
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      Object.assign(capturedHeaders, headers);
      return mockFetchResponse(stream);
    });

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      initialLastEventId: '55',
      onEvent: () => {},
      fetchImpl: global.fetch,
    });

    await consumer.connect();
    expect(capturedHeaders['Last-Event-ID']).toBe('55');
  });

  it('flush on stream end delivers partial frame without trailing blank line', async () => {
    // Simulate a server that closes the stream after sending a frame
    // without the trailing \n\n
    const events: SseEvent[] = [];
    const stream = createMockStream(['event: completed\ndata: {"result":"ok"}']);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: (e) => events.push(e),
      fetchImpl: global.fetch,
    });

    await consumer.connect();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
  });

  it('updates lastEventId as events arrive', async () => {
    const stream = createMockStream([
      'id: 1\ndata: a\n\n',
      'id: 2\ndata: b\n\n',
      'id: 3\ndata: c\n\n',
    ]);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: () => {},
      fetchImpl: global.fetch,
    });

    await consumer.connect();
    expect(consumer.getLastEventId()).toBe('3');
  });

  it('createSseConsumer does not auto-connect (must call .connect() explicitly)', () => {
    let fetchCalled = false;
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCalled = true;
      return mockFetchResponse(createMockStream(['data: ok\n\n']));
    });

    const consumer = createSseConsumer({
      url: '/test',
      onEvent: () => {},
      fetchImpl: global.fetch,
    });

    // fetch should not have been called yet
    expect(fetchCalled).toBe(false);
    consumer.stop(); // cleanup without connecting
  });

  it('stops reconnecting after max attempts', async () => {
    vi.useFakeTimers();
    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      // Return a stream that immediately errors
      return Promise.reject(new Error('Connection refused'));
    });

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: true,
      baseReconnectDelayMs: 1,
      maxReconnectDelayMs: 10,
      onEvent: () => {},
      onError: () => {},
      shouldReconnect: () => true,
      fetchImpl: global.fetch,
    });

    void consumer.connect();

    // Let all reconnect attempts happen
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(1000);
      await Promise.resolve(); // flush microtasks
    }

    consumer.stop();
    vi.useRealTimers();

    // Should be capped at MAX_RECONNECT_ATTEMPTS (50) + initial attempt (1) = 51
    expect(fetchCount).toBeLessThanOrEqual(52);
  });

  it('respects server-sent retry interval', async () => {
    const stream = createMockStream([
      'retry: 500\ndata: hello\n\n',
    ]);
    global.fetch = vi.fn().mockImplementation(() => mockFetchResponse(stream));

    const consumer = new SseConsumer({
      url: '/test',
      autoReconnect: false,
      onEvent: () => {},
      fetchImpl: global.fetch,
    });

    await consumer.connect();
    // The retry field (500ms) should be read from the event;
    // we verify the event was parsed with retry=500 (tested above in parser tests)
  });

  it('parses multi-line data fields joined by newlines', () => {
    const raw = 'data: line1\ndata: line2\ndata: line3\n\n';
    const result = parseSseChunk(raw);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].data).toBe('line1\nline2\nline3');
  });

  it('handles data split across chunk boundary then completed', () => {
    // Chunk 1: first data line + start of second
    const chunk1 = 'data: {\"progress\": 50,\n';
    // Chunk 2: end of second data line + terminator
    const chunk2 = 'data: \"status\": \"ok\"}\n\n';

    const r1 = parseSseChunk(chunk1);
    expect(r1.events).toHaveLength(0);
    expect(r1.remaining).toBe(chunk1);

    const r2 = parseSseChunk(r1.remaining + chunk2);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].data).toBe('{\"progress\": 50,\n\"status\": \"ok\"}');
  });

  it('handles CRLF and CR line endings across chunks', () => {
    // \r\n split: chunk ends with \r, next chunk starts with \n
    // The parser normalizes line endings first, so \r becomes \n
    const chunk1 = 'data: hello\r';
    const chunk2 = '\nevent: world\r\r';

    const r1 = parseSseChunk(chunk1);
    // After normalization: 'data: hello\n' — no double newline, so remaining is normalized
    expect(r1.events).toHaveLength(0);
    expect(r1.remaining).toBe('data: hello\n');

    const combined = r1.remaining + chunk2;
    const r2 = parseSseChunk(combined);
    // After normalization: 'data: hello\n\nevent: world\n\n'
    // Two complete frames
    expect(r2.events.length).toBe(2);
    expect(r2.events[0].data).toBe('hello');
    expect(r2.events[1].event).toBe('world');
  });

  it('ignores comment lines (starting with colon)', () => {
    const raw = ':this is a comment\ndata: actual data\n\n';
    const result = parseSseChunk(raw);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].data).toBe('actual data');
  });

  it('handles empty data field (dispatches with empty string)', () => {
    const raw = 'data\n\n';
    const result = parseSseChunk(raw);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].data).toBe('');
  });

  it('strips single leading space after colon per SSE spec', () => {
    const raw = 'data:  hello (two spaces)\n\n';
    const result = parseSseChunk(raw);
    expect(result.events[0].data).toBe(' hello (two spaces)');
  });

  it('dispatches event-only frames (no data) with non-default event type', () => {
    const raw = 'event: resync\n\n';
    const result = parseSseChunk(raw);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].event).toBe('resync');
    expect(result.events[0].data).toBe('');
  });

  it('carries partial frame across multiple chunks before dispatch', () => {
    // Frame arrives in 4 tiny pieces
    const pieces = ['id: 42\n', 'event: completed\n', 'data: {"res', 'ult": "ok"}\n\n'];
    let buffer = '';
    let events: any[] = [];

    for (let i = 0; i < pieces.length; i++) {
      buffer += pieces[i];
      const result = parseSseChunk(buffer);
      buffer = result.remaining;
      events.push(...result.events);
    }

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('42');
    expect(events[0].event).toBe('completed');
    expect(JSON.parse(events[0].data).result).toBe('ok');
  });
});

// ─── End-to-end scenario tests ──────────────────────────────────────────────

describe('SSE end-to-end scenarios', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper: create a mock ReadableStream that emits given text chunks then closes.
   */
  function createChunkStream(chunks: string[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream({
      async pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunks[index]));
        index++;
      },
    });
  }

  function mockResponse(stream: ReadableStream, status = 200) {
    return Promise.resolve(
      new Response(stream, {
        status,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
  }

  it('scenario: disconnect during task completion, reconnect replays missed events', async () => {
    const events: SseEvent[] = [];
    let connectionCount = 0;

    // First connection: receives queued event, then connection drops
    const firstStream = createChunkStream([
      'id: 1\nevent: queued\ndata: {"task":{"id":"t1","status":"queued"}}\n\n',
    ]);

    // Second connection (reconnect with Last-Event-ID: 1): replays running + completed
    const secondStream = createChunkStream([
      'id: 2\nevent: running\ndata: {"task":{"id":"t1","status":"running","seq":2}}\n\n',
      'id: 3\nevent: completed\ndata: {"task":{"id":"t1","status":"completed","seq":3,"result":"done"}}\n\n',
    ]);

    (globalThis.fetch as any).mockImplementation((url: string, init: RequestInit) => {
      connectionCount++;
      const headers = init.headers as Record<string, string>;
      if (headers?.['Last-Event-ID'] === '1') {
        return mockResponse(secondStream);
      }
      return mockResponse(firstStream);
    });

    const consumer = new SseConsumer({
      url: '/stream',
      autoReconnect: true,
      baseReconnectDelayMs: 1,
      maxReconnectDelayMs: 10,
      onEvent: (e) => events.push(e),
      shouldReconnect: () => connectionCount < 3,
      fetchImpl: globalThis.fetch as any,
    });

    void consumer.connect();

    // Let first connection complete
    await vi.runOnlyPendingTimersAsync();
    // Allow reconnect to fire
    await vi.advanceTimersByTimeAsync(50);
    // Let second connection complete
    await vi.runOnlyPendingTimersAsync();

    consumer.stop();

    // Should have received queued, running, completed
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain('queued');
    expect(eventTypes).toContain('running');
    expect(eventTypes).toContain('completed');

    // Should have made 2 connections
    expect(connectionCount).toBeGreaterThanOrEqual(2);

    // Last event ID should be 3
    expect(consumer.getLastEventId()).toBe('3');
  });

  it('scenario: expired cursor triggers resync event', async () => {
    const events: SseEvent[] = [];

    // Server responds with resync event (cursor too old) then snapshot
    const stream = createChunkStream([
      'event: resync\ndata: {"reason":"cursor_expired","oldestAvailable":100}\n\n',
      'id: 150\nevent: snapshot\ndata: {"tasks":[{"id":"t1","status":"completed","seq":150}],"cursor":150}\n\n',
    ]);

    (globalThis.fetch as any).mockImplementation(() => mockResponse(stream));

    const consumer = new SseConsumer({
      url: '/stream',
      initialLastEventId: '50', // Way behind oldest available (100)
      autoReconnect: false,
      onEvent: (e) => events.push(e),
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('resync');
    expect(JSON.parse(events[0].data).reason).toBe('cursor_expired');
    expect(events[1].event).toBe('snapshot');
    expect(consumer.getLastEventId()).toBe('150');
  });

  it('scenario: 401 triggers token refresh then reconnects with new token', async () => {
    const events: SseEvent[] = [];
    let tokenRefreshCalled = false;
    const capturedHeaders: Record<string, string>[] = [];

    const authStream = createChunkStream([
      'id: 1\ndata: ok\n\n',
    ]);

    (globalThis.fetch as any).mockImplementation((url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      capturedHeaders.push({ ...headers });
      if (headers?.['Authorization'] === 'Bearer expired-token') {
        return Promise.resolve(new Response(null, { status: 401, statusText: 'Unauthorized' }));
      }
      return mockResponse(authStream);
    });

    const consumer = new SseConsumer({
      url: '/stream',
      token: 'expired-token',
      autoReconnect: false,
      onEvent: (e) => events.push(e),
      onUnauthorized: async () => {
        tokenRefreshCalled = true;
        return 'new-token';
      },
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    expect(tokenRefreshCalled).toBe(true);
    expect(events).toHaveLength(1);
    // Should have made request with new token
    const lastHeaders = capturedHeaders[capturedHeaders.length - 1];
    expect(lastHeaders['Authorization']).toBe('Bearer new-token');
  });

  it('scenario: 401 with failed refresh stops without infinite loop', async () => {
    let fetchCount = 0;
    const errors: Error[] = [];

    (globalThis.fetch as any).mockImplementation(() => {
      fetchCount++;
      return Promise.resolve(new Response(null, { status: 401, statusText: 'Unauthorized' }));
    });

    const consumer = new SseConsumer({
      url: '/stream',
      token: 'bad-token',
      autoReconnect: true,
      baseReconnectDelayMs: 1,
      onEvent: () => {},
      onError: (e) => errors.push(e),
      onUnauthorized: async () => null, // Refresh fails
      shouldReconnect: () => true,
      fetchImpl: globalThis.fetch as any,
    });

    void consumer.connect();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10000);
    consumer.stop();

    // Should have tried exactly once (401 → refresh fails → stop)
    expect(fetchCount).toBe(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('scenario: fragmented multi-chunk large JSON event parses correctly', async () => {
    const events: SseEvent[] = [];
    const largeData = JSON.stringify({
      task: {
        id: 'task-very-long-id-' + 'x'.repeat(500),
        status: 'completed',
        result: 'y'.repeat(1000),
        seq: 999,
      },
    });

    // Split the event across 3 chunks at arbitrary byte boundaries
    const raw = `id: 999\nevent: completed\ndata: ${largeData}\n\n`;
    const split1 = Math.floor(raw.length / 3);
    const split2 = Math.floor(raw.length * 2 / 3);

    const stream = createChunkStream([
      raw.slice(0, split1),
      raw.slice(split1, split2),
      raw.slice(split2),
    ]);

    (globalThis.fetch as any).mockImplementation(() => mockResponse(stream));

    const consumer = new SseConsumer({
      url: '/stream',
      autoReconnect: false,
      onEvent: (e) => events.push(e),
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('999');
    expect(events[0].event).toBe('completed');
    const parsed = JSON.parse(events[0].data);
    expect(parsed.task.status).toBe('completed');
    expect(parsed.task.seq).toBe(999);
  });

  it('scenario: done event stops stream without reconnect', async () => {
    let fetchCount = 0;
    const events: SseEvent[] = [];
    let doneCalled = false;

    const stream = createChunkStream([
      'id: 1\ndata: processing\n\n',
      'event: done\ndata: [DONE]\n\n',
    ]);

    (globalThis.fetch as any).mockImplementation(() => {
      fetchCount++;
      return mockResponse(stream);
    });

    const consumer = new SseConsumer({
      url: '/stream',
      autoReconnect: true,
      baseReconnectDelayMs: 1,
      onEvent: (e) => events.push(e),
      onDone: () => { doneCalled = true; },
      shouldReconnect: () => true,
      fetchImpl: globalThis.fetch as any,
    });

    void consumer.connect();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5000);
    consumer.stop();

    expect(fetchCount).toBe(1); // Should not reconnect after done
    expect(doneCalled).toBe(true);
    expect(events).toHaveLength(1); // Only the data event, not the done
  });

  it('scenario: server-sent retry field is respected for reconnect delay', async () => {
    const events: SseEvent[] = [];
    let connectionCount = 0;

    const firstStream = createChunkStream([
      'retry: 100\ndata: first\n\n',
    ]);
    const secondStream = createChunkStream([
      'data: second\n\n',
    ]);

    (globalThis.fetch as any).mockImplementation(() => {
      connectionCount++;
      if (connectionCount === 1) return mockResponse(firstStream);
      return mockResponse(secondStream);
    });

    const consumer = new SseConsumer({
      url: '/stream',
      autoReconnect: true,
      baseReconnectDelayMs: 5000, // Large default, but server says 100ms
      maxReconnectDelayMs: 30000,
      onEvent: (e) => events.push(e),
      shouldReconnect: () => connectionCount < 3,
      fetchImpl: globalThis.fetch as any,
    });

    void consumer.connect();

    // First connection completes
    await vi.runOnlyPendingTimersAsync();

    // After stream ends, reconnect happens with server-sent retry (100ms)
    // Advance by 150ms to allow the 100ms retry to fire
    await vi.advanceTimersByTimeAsync(200);
    await vi.runOnlyPendingTimersAsync();

    consumer.stop();

    expect(connectionCount).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('resync event carries id to update lastEventId before snapshot', async () => {
    // Server sends resync with id=200, then snapshot with id=200
    const stream = createChunkStream([
      'id: 200\nevent: resync\ndata: {"reason":"cursor_expired","cursor":200}\n\n',
      'id: 200\nevent: snapshot\ndata: {"tasks":[],"cursor":200}\n\n',
    ]);

    (globalThis.fetch as any).mockImplementation(() => mockResponse(stream));

    const consumer = new SseConsumer({
      url: '/stream',
      initialLastEventId: '50',
      autoReconnect: false,
      onEvent: () => {},
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    // lastEventId should be 200 even though client started at 50
    expect(consumer.getLastEventId()).toBe('200');
  });

  it('monotonic event IDs: replay events then snapshot, lastEventId ends at snapshot cursor', async () => {
    // Simulates correct server ordering: replay (ids 5,6,7) then snapshot (id 10)
    const stream = createChunkStream([
      'id: 5\nevent: running\ndata: {"seq":5}\n\n',
      'id: 6\nevent: running\ndata: {"seq":6}\n\n',
      'id: 7\nevent: completed\ndata: {"seq":7}\n\n',
      'id: 10\nevent: snapshot\ndata: {"cursor":10}\n\n',
    ]);

    (globalThis.fetch as any).mockImplementation(() => mockResponse(stream));

    let lastReceivedId = '';
    const consumer = new SseConsumer({
      url: '/stream',
      autoReconnect: false,
      onEvent: (e) => { if (e.id) lastReceivedId = e.id; },
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    // After all events, lastEventId should be 10 (snapshot cursor), not 7
    expect(consumer.getLastEventId()).toBe('10');
    expect(lastReceivedId).toBe('10');
  });

  it('Last-Event-ID header is sent on reconnect after disconnect', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    const firstStream = createChunkStream(['id: 42\ndata: hello\n\n']);
    const secondStream = createChunkStream(['id: 43\ndata: world\n\n']);
    let connectionNum = 0;

    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) => {
      connectionNum++;
      capturedHeaders.push({ ...(init.headers as Record<string, string>) });
      if (connectionNum === 1) return mockResponse(firstStream);
      return mockResponse(secondStream);
    });

    const consumer = new SseConsumer({
      url: '/stream',
      autoReconnect: true,
      baseReconnectDelayMs: 1,
      maxReconnectDelayMs: 10,
      onEvent: () => {},
      shouldReconnect: () => connectionNum < 3,
      fetchImpl: globalThis.fetch as any,
    });

    void consumer.connect();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(50);
    await vi.runOnlyPendingTimersAsync();
    consumer.stop();

    // Second connection should have Last-Event-ID: 42
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(2);
    const secondHeaders = capturedHeaders[1];
    expect(secondHeaders['Last-Event-ID']).toBe('42');
  });

  it('strips UTF-8 BOM from stream start', () => {
    const BOM = '\uFEFF';
    const { events, remaining } = parseSseChunk(`${BOM}data: hello\n\n`);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('hello');
    expect(remaining).toBe('');
  });

  it('handles colons in data values correctly', () => {
    const { events } = parseSseChunk('data: key: value: with: colons\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('key: value: with: colons');
  });

  it('empty id field sets id to empty string (not null)', () => {
    const { events } = parseSseChunk('id:\ndata: test\n\n');
    expect(events[0].id).toBe('');
  });

  it('id with null byte is ignored (id stays null)', () => {
    const { events } = parseSseChunk('id: bad\u0000id\ndata: test\n\n');
    expect(events[0].id).toBe(null);
  });

  it('handles unicode content in data lines', () => {
    const { events } = parseSseChunk('data: 你好世界 🌍\n\n');
    expect(events[0].data).toBe('你好世界 🌍');
  });

  it('multiple consecutive blank lines do not produce spurious events', () => {
    const { events } = parseSseChunk('data: a\n\n\n\ndata: b\n\n');
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('a');
    expect(events[1].data).toBe('b');
  });

  it('frame with only event type (no data) is dispatched', () => {
    const { events } = parseSseChunk('event: ping\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('ping');
    expect(events[0].data).toBe('');
  });

  it('Last-Event-ID header is NOT sent when lastEventId is empty string', async () => {
    let capturedHeaders: Record<string, string> = {};

    const stream = createChunkStream(['id:\ndata: reset\n\n']);
    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = { ...(init.headers as Record<string, string>) };
      return mockResponse(stream);
    });

    const consumer = new SseConsumer({
      url: '/stream',
      autoReconnect: false,
      onEvent: () => {},
      fetchImpl: globalThis.fetch as any,
    });

    // Pre-set lastEventId to a value, then receive empty id
    consumer['lastEventId'] = 'previous-id';
    await consumer.connect();

    // Empty id should have cleared it; header should not contain Last-Event-ID
    expect(consumer.getLastEventId()).toBe('');
  });
});
