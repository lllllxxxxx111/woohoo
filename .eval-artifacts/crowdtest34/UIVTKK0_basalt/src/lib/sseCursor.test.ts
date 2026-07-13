/**
 * Cursor semantics regression tests.
 *
 * Exercises the contract between server SSE endpoints and the SSE consumer:
 * - Event ID namespaces (ai-N / pipe-N / collab-N) parse correctly
 * - After resync_required followed by a snapshot with current-seq id, the
 *   consumer's lastEventId is the snapshot id (so reconnect does NOT loop)
 * - Reconnect sends Last-Event-ID header using the last event's id
 * - Consumer correctly uses lastEventId from snapshot events (not just lifecycle)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSseConsumer, SseParser } from './sseConsumer';

function encodeFrame(opts: { event?: string; data?: string; id?: string }): string {
  let s = '';
  if (opts.id !== undefined) s += `id: ${opts.id}\n`;
  if (opts.event) s += `event: ${opts.event}\n`;
  if (opts.data !== undefined) {
    for (const line of opts.data.split('\n')) s += `data: ${line}\n`;
  }
  return s + '\n';
}

function makeResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Cursor namespaces (pure JS mirrors server parse_event_id)', () => {
  // These mirror the Rust parse_event_id functions across AI/Pipeline/Collab.
  const parseAi = (id: string) => {
    const m = id.match(/^ai-(\d+)$/);
    return m ? Number(m[1]) : null;
  };
  const parsePipe = (id: string) => {
    const m = id.match(/^pipe-(-?\d+)$/);
    return m ? Number(m[1]) : null;
  };
  const parseCollab = (id: string) => {
    const m = id.match(/^collab-(\d+)$/);
    return m ? Number(m[1]) : null;
  };

  it('parses ai-N format', () => {
    expect(parseAi('ai-0')).toBe(0);
    expect(parseAi('ai-42')).toBe(42);
    expect(parseAi('ai-99999999999')).toBe(99999999999);
  });

  it('rejects malformed / cross-namespace IDs', () => {
    expect(parseAi('pipe-5')).toBeNull();
    expect(parseAi('collab-5')).toBeNull();
    expect(parseAi('ai-')).toBeNull();
    expect(parseAi('ai-x')).toBeNull();
    expect(parseAi('ai-5-extra')).toBeNull();
  });

  it('parses pipe-N format (rowids can be large)', () => {
    expect(parsePipe('pipe-0')).toBe(0);
    expect(parsePipe('pipe-1000')).toBe(1000);
    expect(parsePipe('pipe-5')).not.toBeNull();
    expect(parsePipe('ai-5')).toBeNull();
  });

  it('parses collab-N format', () => {
    expect(parseCollab('collab-0')).toBe(0);
    expect(parseCollab('collab-1')).toBe(1);
    expect(parseCollab('ai-1')).toBeNull();
  });
});

describe('SSE consumer cursor after resync_required + snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('advances lastEventId to snapshot id after resync_required (no reconnect loop)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    // Enqueue resync_required + snapshot as a SINGLE chunk (like TCP buffering
    // or axum's SSE flushing multiple yields together). This is important:
    // handleEvent(resync_required) cancels the reader but the for-loop still
    // processes the already-parsed snapshot in the same batch, advancing
    // lastEventId to the snapshot id before reconnect.
    let ctrl1: ReadableStreamDefaultController<Uint8Array> | null = null;
    const s1 = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl1 = c;
        const enc = new TextEncoder();
        const combined =
          encodeFrame({
            event: 'resync_required',
            data: JSON.stringify({ reason: 'cursor_expired' }),
            id: 'ai-50',
          }) +
          encodeFrame({
            event: 'snapshot',
            data: JSON.stringify({ tasks: [] }),
            id: 'ai-77',
          });
        c.enqueue(enc.encode(combined));
      },
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(s1, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    // Second response: should be called with Last-Event-ID: ai-77 (NOT ai-50)
    let capturedLastEventId: string | null = null;
    let ctrl2: ReadableStreamDefaultController<Uint8Array> | null = null;
    const s2 = new ReadableStream<Uint8Array>({
      start(c) { ctrl2 = c; },
    });
    fetchImpl.mockImplementationOnce((_input, init) => {
      capturedLastEventId = (init?.headers as Record<string, string>)?.['Last-Event-ID'] ?? null;
      return Promise.resolve(new Response(s2, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    });

    const controller = createSseConsumer({
      url: '/stream',
      fetchImpl: fetchImpl as any,
      onEvent: () => {},
      onResyncRequired: () => true,
      initialRetryMs: 5,
      maxRetryMs: 10,
      shouldReconnect: () => true,
    });

    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();

    controller.close();
    try { (ctrl1 as any)?.close(); } catch { /* noop */ }
    try { (ctrl2 as any)?.close(); } catch { /* noop */ }

    // After snapshot id=ai-77, reconnect must send ai-77 not ai-50
    expect(capturedLastEventId).toBe('ai-77');
  });

  it('includes Last-Event-ID header on reconnect from a normal event id', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(makeResponse([
      encodeFrame({ event: 'running', data: '{}', id: 'ai-5' }),
    ]));
    let captured: string | null = null;
    fetchImpl.mockImplementationOnce((_input, init) => {
      captured = (init?.headers as Record<string, string>)?.['Last-Event-ID'] ?? null;
      return Promise.resolve(makeResponse([encodeFrame({ event: 'done', data: '[DONE]', id: 'ai-6' })]));
    });

    const controller = createSseConsumer({
      url: '/stream',
      fetchImpl: fetchImpl as any,
      onEvent: () => {},
      initialRetryMs: 5,
      shouldReconnect: () => true,
    });

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    controller.close();
    expect(captured).toBe('ai-5');
  });

  it('persists lastEventId across parser.reset() (SSE spec)', () => {
    const p = new SseParser();
    p.feed(encodeFrame({ event: 'x', data: 'a', id: 'ai-10' }));
    expect(p.getLastEventId()).toBe('ai-10');
    p.reset(); // reset between connections
    // lastEventId persists per SSE spec (used for Last-Event-ID on reconnect)
    expect(p.getLastEventId()).toBe('ai-10');
  });
});
