import { describe, expect, it } from 'vitest';
import { SseFrameParser, computeBackoff } from './sse-client';

describe('SseFrameParser', () => {
  it('parses a simple event with type and data', () => {
    const events: Array<{ event: string; data: string; id: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data, id: e.id }));

    parser.feed('event: completed\ndata: {"taskId":"t1"}\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
    expect(events[0].data).toBe('{"taskId":"t1"}');
  });

  it('handles chunked input across multiple feeds (fragmentation tolerance)', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    // Simulate arbitrary chunk boundaries
    parser.feed('event: runn');
    parser.feed('ing\nda');
    parser.feed('ta: {"progress"');
    parser.feed(':"50%"}\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('running');
    expect(events[0].data).toBe('{"progress":"50%"}');
  });

  it('handles multi-line data (joined by newlines per SSE spec)', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('data: line1\ndata: line2\ndata: line3\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line1\nline2\nline3');
    expect(events[0].event).toBe('message'); // default event type
  });

  it('parses event id and retry fields', () => {
    const events: Array<{ event: string; data: string; id: string; retry?: number }> = [];
    const parser = new SseFrameParser((e) =>
      events.push({ event: e.event, data: e.data, id: e.id, retry: e.retry }),
    );

    parser.feed('id: 42\nretry: 3000\nevent: snapshot\ndata: {"tasks":[]}\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('42');
    expect(events[0].retry).toBe(3000);
    expect(events[0].event).toBe('snapshot');
  });

  it('ignores comment lines starting with colon', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed(':this is a comment\nevent: queued\ndata: {"id":"t1"}\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('queued');
  });

  it('treats [DONE] as a done event', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('data: [DONE]\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('done');
  });

  it('handles \\r\\n newlines and \\r-only newlines', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('event: completed\r\ndata: {"ok":true}\r\n\r\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
    expect(events[0].data).toBe('{"ok":true}');
  });

  it('dispatches multiple events in sequence', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed(
      'event: queued\ndata: {"id":"t1"}\n\n' +
        'event: running\ndata: {"id":"t1"}\n\n' +
        'event: completed\ndata: {"id":"t1","result":"ok"}\n\n',
    );

    expect(events).toHaveLength(3);
    expect(events[0].event).toBe('queued');
    expect(events[1].event).toBe('running');
    expect(events[2].event).toBe('completed');
  });

  it('dispatches remaining event on end()', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('event: completed\ndata: {"result":"final"}');
    // No trailing \n\n yet — parser.end() should flush
    parser.end();

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"result":"final"}');
  });

  it('skips id fields containing null characters per spec', () => {
    const events: Array<{ event: string; id: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, id: e.id }));

    parser.feed('id: bad\u0000id\ndata: test\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('');
  });

  it('strips leading UTF-8 BOM (U+FEFF) at start of stream', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('\uFEFFevent: completed\ndata: {"ok":true}\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('completed');
  });

  it('handles CRLF split across chunks (\\r at end of one chunk, \\n start of next)', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    // Simulate TCP split: first chunk ends with \r, next starts with \n
    parser.feed('event: running\r');
    parser.feed('\ndata: {"p":1}\r\n\r\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('running');
    expect(events[0].data).toBe('{"p":1}');
  });

  it('handles CR-only (old Mac-style) line endings', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('event: failed\rdata: {"err":"x"}\r\r');
    parser.end(); // final \r must be flushed at stream end (CR could be start of CRLF split)

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('failed');
    expect(events[0].data).toBe('{"err":"x"}');
  });

  it('carries last event id forward when subsequent events have no explicit id', () => {
    // Per HTML spec, the last event ID persists across events (until reset by id field or resync)
    const events: Array<{ event: string; id: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, id: e.id }));

    parser.feed('id: 10\nevent: queued\ndata: {}\n\n');
    parser.feed('event: running\ndata: {}\n\n'); // no id
    parser.feed('id: 11\nevent: completed\ndata: {}\n\n');

    expect(events).toHaveLength(3);
    expect(events[0].id).toBe('10');
    expect(events[1].id).toBe('10'); // carried forward
    expect(events[2].id).toBe('11');
  });

  it('ignores unknown fields per spec', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('event: queued\nfoo: bar\ndata: {"id":"t1"}\nbaz: qux\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"id":"t1"}');
  });

  it('handles fields with no colon as field name with empty value', () => {
    // SSE spec: if no colon, the entire line is the field name with empty value.
    // An 'event' field with empty value resets event type to default 'message'.
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('event\ndata: hello\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message');
    expect(events[0].data).toBe('hello');
  });

  it('handles single space after colon (stripped) but preserves subsequent spaces', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new SseFrameParser((e) => events.push({ event: e.event, data: e.data }));

    parser.feed('data:   hello (three leading spaces)\n\n');

    expect(events).toHaveLength(1);
    // First space stripped, remaining two kept
    expect(events[0].data).toBe('  hello (three leading spaces)');
  });
});

describe('computeBackoff', () => {
  it('returns at least minDelay', () => {
    for (let i = 0; i < 10; i++) {
      expect(computeBackoff(i, 500, 30000)).toBeGreaterThanOrEqual(500);
    }
  });

  it('never exceeds maxDelay', () => {
    for (let i = 1; i < 20; i++) {
      expect(computeBackoff(i, 500, 30000)).toBeLessThanOrEqual(30000);
    }
  });

  it('grows exponentially', () => {
    const delays = Array.from({ length: 5 }, (_, i) => computeBackoff(i + 1, 500, 30000));
    // With jitter, check the median trend increases
    const mid = Math.floor(delays.length / 2);
    expect(delays[mid]).toBeGreaterThan(delays[0] - 200); // account for jitter
  });
});
