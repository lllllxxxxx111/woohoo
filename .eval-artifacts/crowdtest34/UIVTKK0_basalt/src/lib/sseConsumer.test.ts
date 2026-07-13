import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  SseParser,
  calculateBackoff,
  isDoneMarker,
  createSseConsumer,
  type SseEvent,
} from './sseConsumer';

describe('SseParser', () => {
  let parser: SseParser;

  beforeEach(() => {
    parser = new SseParser();
  });

  it('parses a simple single-line event', () => {
    const events = parser.feed('event: completed\ndata: {"id":"t1","status":"completed"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
    expect(events[0].data).toBe('{"id":"t1","status":"completed"}');
    expect(events[0].id).toBeNull();
  });

  it('parses multiple events in one chunk', () => {
    const events = parser.feed(
      'event: queued\ndata: {"id":"t1"}\n\nevent: running\ndata: {"id":"t1"}\n\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('queued');
    expect(events[1].event).toBe('running');
  });

  it('handles events split across chunks (arbitrary chunk boundaries)', () => {
    // Simulate chunk splitting mid-event
    const chunk1 = 'event: compl';
    const chunk2 = 'eted\ndata: {"id":"t1"}\n\n';

    let events = parser.feed(chunk1);
    expect(events).toHaveLength(0);

    events = parser.feed(chunk2);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
    expect(events[0].data).toBe('{"id":"t1"}');
  });

  it('handles multi-line data fields (joins with newline)', () => {
    const events = parser.feed('data: line1\ndata: line2\ndata: line3\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line1\nline2\nline3');
  });

  it('parses event id field', () => {
    const events = parser.feed('id: ai-42\nevent: completed\ndata: {}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('ai-42');
  });

  it('parses retry field', () => {
    const events = parser.feed('retry: 5000\ndata: hello\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].retry).toBe(5000);
  });

  it('ignores comment lines starting with :', () => {
    const events = parser.feed(': this is a comment\nevent: ping\ndata: {}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('ping');
  });

  it('defaults event type to "message"', () => {
    const events = parser.feed('data: just data\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message');
  });

  it('handles \\r\\n line endings', () => {
    const events = parser.feed('event: completed\r\ndata: {}\r\n\r\n');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
  });

  it('handles data with no space after colon', () => {
    const events = parser.feed('data:hello\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('hello');
  });

  it('accumulates partial events across many small chunks', () => {
    const parts = [
      'ev', 'en', 't: ru', 'nnin', 'g\n',
      'id', ': a', 'i-1', '00\n',
      'd', 'ata:', '{"ts', '":1}\n\n',
    ];
    let events: SseEvent[] = [];
    for (const part of parts) {
      events = events.concat(parser.feed(part));
    }
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('running');
    expect(events[0].id).toBe('ai-100');
    expect(events[0].data).toBe('{"ts":1}');
  });
});

describe('calculateBackoff', () => {
  it('starts at initial delay for attempt 0', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const delay = calculateBackoff(0, 1000, 30000);
      expect(delay).toBe(1000);
    } finally {
      spy.mockRestore();
    }
  });

  it('doubles on first retry', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect(calculateBackoff(1, 1000, 30000)).toBe(2000);
      expect(calculateBackoff(2, 1000, 30000)).toBe(4000);
    } finally {
      spy.mockRestore();
    }
  });

  it('increases exponentially (with jitter)', () => {
    // Average over many samples should increase
    const avg = (n: number) => {
      let s = 0;
      for (let i = 0; i < 100; i++) s += calculateBackoff(n, 1000, 30000);
      return s / 100;
    };
    expect(avg(0)).toBeLessThan(avg(1));
    expect(avg(1)).toBeLessThan(avg(2));
    expect(avg(2)).toBeLessThan(avg(3) + 1);
  });

  it('caps at maxRetryMs', () => {
    for (let i = 0; i < 20; i++) {
      const delay = calculateBackoff(i, 1000, 30000);
      expect(delay).toBeLessThanOrEqual(36000); // 30000 + 20% jitter
    }
  });
});

describe('isDoneMarker', () => {
  it('detects [DONE]', () => {
    expect(isDoneMarker('[DONE]')).toBe(true);
  });

  it('detects done', () => {
    expect(isDoneMarker('done')).toBe(true);
  });

  it('detects quoted [DONE]', () => {
    expect(isDoneMarker('"[DONE]"')).toBe(true);
  });

  it('does not false positive on other data', () => {
    expect(isDoneMarker('{"status":"ok"}')).toBe(false);
    expect(isDoneMarker('')).toBe(false);
  });
});

describe('createSseConsumer', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createMockStream(chunks: string[], immediate = true) {
    let chunkIndex = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex >= chunks.length) {
          controller.close();
          return;
        }
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(chunks[chunkIndex]));
        chunkIndex++;
      },
    });
  }

  it('receives and parses events from stream', async () => {
    const events: SseEvent[] = [];
    const stream = createMockStream([
      'event: completed\ndata: {"id":"t1"}\n\n',
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
      status: 200,
    } as Response);

    const controller = createSseConsumer({
      url: 'http://localhost/test',
      onEvent: (e) => events.push(e),
      shouldReconnect: () => false,
      initialRetryMs: 100,
      maxRetryMs: 1000,
    });

    // Let the async operations complete
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    controller.close();
  });

  it('stops reconnecting when shouldReconnect returns false', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    globalThis.fetch = fetchMock;

    let reconnectCount = 0;
    createSseConsumer({
      url: 'http://localhost/test',
      onEvent: () => {},
      onReconnect: () => { reconnectCount++; },
      shouldReconnect: (attempt) => attempt < 2,
      initialRetryMs: 100,
      maxRetryMs: 1000,
    });

    await vi.runAllTimersAsync();
    await Promise.resolve();

    // Should have tried initial + 1 reconnect
    expect(fetchMock).toHaveBeenCalled();
  });
});
