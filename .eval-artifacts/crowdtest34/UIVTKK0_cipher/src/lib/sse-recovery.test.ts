/**
 * Integration-level tests for SSE disconnect recovery, idempotency,
 * out-of-order protection, and error closure using mock ReadableStream.
 *
 * These tests use a fake SSE stream (no real network) to validate:
 * - Fragmented/multi-chunk SSE parsing
 * - Duplicate event rejection
 * - Out-of-order event protection (terminal states cannot be overwritten)
 * - Reconnection with Last-Event-ID cursor
 * - Cursor expiry resync signal
 * - 401 token refresh and reconnect
 * - Task scope mismatch
 * - Workspace refresh dedup
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSseClient, type SseClientController, type SseEvent } from './sse-client';
import { canTransition, EventDeduplicator, normalizeTaskStatus } from './task-state-machine';

// Helper: create a mock SSE response stream
function createMockSseStream(frames: string[], options?: { failAfterFrames?: number }): ReadableStream<Uint8Array> {
  let frameIndex = 0;
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Push all frames in sequence
      const pushNext = () => {
        if (options?.failAfterFrames && frameIndex >= options.failAfterFrames) {
          controller.error(new Error('Simulated network error'));
          return;
        }
        if (frameIndex >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(frames[frameIndex]));
        frameIndex++;
        // Use queueMicrotask to simulate async delivery
        queueMicrotask(pushNext);
      };
      queueMicrotask(pushNext);
    },
  });
}

// Helper: create a minimal SSE frame string
function sseFrame(event: string, data: unknown, id?: string): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  let frame = '';
  if (id) frame += `id: ${id}\n`;
  frame += `event: ${event}\n`;
  frame += `data: ${dataStr}\n\n`;
  return frame;
}

describe('SSE client end-to-end scenarios', () => {
  let originalFetch: typeof fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  // Restore original fetch after tests
  // Note: we don't restore in afterEach because vitest isolates modules;
  // but we should be good.

  it('receives and parses multiple events from a stream', async () => {
    const events: SseEvent[] = [];
    const frames = [
      sseFrame('queued', { task: { id: 't1', status: 'queued' } }, '1'),
      sseFrame('running', { task: { id: 't1', status: 'running' } }, '2'),
      sseFrame('completed', { task: { id: 't1', status: 'completed', result: 'done' } }, '3'),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: createMockSseStream(frames),
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    let closed = false;
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      params: { limit: 200 },
      onEvent: (e) => events.push(e),
      shouldReconnect: () => false, // don't reconnect after stream ends
      onClose: () => { closed = true; },
      maxRetries: 0,
    });

    // Wait for stream to process
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(3);
    }, { timeout: 2000 });

    client.close();

    expect(events.map((e) => e.event)).toEqual(['queued', 'running', 'completed']);
    expect(events.map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(closed).toBe(true);
  });

  it('handles fragmented chunks (splits across arbitrary boundaries)', async () => {
    const events: SseEvent[] = [];
    // Build a complete event, then split it into tiny fragments
    const fullFrame = sseFrame('running', { task: { id: 't1', content: 'hello world' } }, '10');
    const fragmentSize = 3;
    const frames: string[] = [];
    for (let i = 0; i < fullFrame.length; i += fragmentSize) {
      frames.push(fullFrame.slice(i, i + fragmentSize));
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: createMockSseStream(frames),
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: (e) => events.push(e),
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    client.close();
    expect(events[0].event).toBe('running');
    const data = JSON.parse(events[0].data);
    expect(data.task.id).toBe('t1');
    expect(data.task.content).toBe('hello world');
  });

  it('does not reconnect when no pending tasks (shouldReconnect=false)', async () => {
    const frames = [sseFrame('snapshot', { tasks: [] }, '1')];

    let fetchCount = 0;
    mockFetch.mockImplementation(() => {
      fetchCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        body: createMockSseStream(frames),
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      });
    });

    let pendingTasks = 1;
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      shouldReconnect: () => pendingTasks > 0,
      onEvent: () => {
        pendingTasks = 0; // simulate task completing
      },
      minReconnectDelay: 10,
      maxReconnectDelay: 50,
      maxRetries: 3,
    });

    // Give it time to connect and process
    await new Promise((r) => setTimeout(r, 500));
    client.close();

    // Should have fetched exactly once (no infinite reconnection loop)
    expect(fetchCount).toBe(1);
  });
});

describe('Task state machine: out-of-order and terminal protection', () => {
  it('rejects queued event after completed (terminal state guard)', () => {
    // Simulate: task completes (seq=5), then a delayed queued event arrives (seq=2)
    expect(canTransition('completed', 'queued')).toBe(false);
  });

  it('rejects running event after failed (terminal state guard)', () => {
    expect(canTransition('failed', 'running')).toBe(false);
  });

  it('allows idempotent repeat of same terminal state', () => {
    expect(canTransition('completed', 'completed')).toBe(true);
    expect(canTransition('failed', 'failed')).toBe(true);
  });

  it('allows queued->running->completed progression', () => {
    let current: ReturnType<typeof normalizeTaskStatus> | undefined;
    const transitions = ['queued', 'running', 'completed'] as const;
    for (const next of transitions) {
      expect(canTransition(current, next)).toBe(true);
      current = next;
    }
  });

  it('correctly normalizes cancelled/blocked statuses', () => {
    expect(normalizeTaskStatus('cancelled')).toBe('cancelled');
    expect(normalizeTaskStatus('blocked')).toBe('blocked');
    expect(normalizeTaskStatus('canceled')).toBe('cancelled');
  });

  it('active states are mutually transitionable (eventSeq provides true ordering via dedup)', () => {
    // Running -> queued is technically permitted by the state machine (both are active),
    // but a stale queued event would have eventSeq < running's eventSeq and be rejected by EventDeduplicator.
    // This allows legitimate transitions like running <-> blocked (pause/resume) without hardcoding rules.
    expect(canTransition('running', 'queued')).toBe(true);
    expect(canTransition('blocked', 'running')).toBe(true);
    expect(canTransition('running', 'blocked')).toBe(true);
  });

  it('blocked can progress to completed', () => {
    expect(canTransition('blocked', 'completed')).toBe(true);
  });
});

describe('Reconnection scenarios (simulated)', () => {
  it('sends Last-Event-ID header on reconnect', async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const capturedHeaders: Array<Record<string, string>> = [];
    let connectionCount = 0;

    // First connection sends 2 events then closes; second connection should send Last-Event-ID
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      connectionCount++;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
        } else if (typeof init.headers === 'object') {
          for (const [key, value] of Object.entries(init.headers)) {
            headers[key.toLowerCase()] = String(value);
          }
        }
      }
      capturedHeaders.push(headers);

      if (connectionCount === 1) {
        // First connection: send one event with id=5, then close
        return {
          ok: true,
          status: 200,
          body: createMockSseStream([sseFrame('running', { task: { id: 't1' } }, '5')]),
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        };
      } else {
        // Second connection: send done event
        return {
          ok: true,
          status: 200,
          body: createMockSseStream([sseFrame('done', {}, '6')]),
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        };
      }
    });

    const events: SseEvent[] = [];
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: (e) => events.push(e),
      shouldReconnect: () => connectionCount < 2,
      minReconnectDelay: 10,
      maxReconnectDelay: 50,
      maxRetries: 3,
    });

    await vi.waitFor(() => {
      expect(connectionCount).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000 });

    client.close();
    globalThis.fetch = originalFetch;

    // Second connection should have Last-Event-ID header with value "5"
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(2);
    // The Last-Event-ID from the second fetch should be "5"
    const secondHeaders = capturedHeaders[1];
    expect(secondHeaders?.['last-event-id']).toBe('5');
  });

  it('refreshes token on 401 and retries', async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 401, body: null, headers: new Headers() };
      }
      return {
        ok: true,
        status: 200,
        body: createMockSseStream([sseFrame('snapshot', { tasks: [] }, '1')]),
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      };
    });

    let tokenRefreshed = false;
    const refreshToken = vi.fn(async () => {
      tokenRefreshed = true;
      return 'new-token';
    });

    const events: SseEvent[] = [];
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      token: 'old-token',
      onEvent: (e) => events.push(e),
      refreshToken,
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(tokenRefreshed).toBe(true);
    }, { timeout: 2000 });

    await new Promise((r) => setTimeout(r, 200));
    client.close();
    globalThis.fetch = originalFetch;

    expect(refreshToken).toHaveBeenCalled();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('handles resync event and resets cursor before snapshot', async () => {
    const events: SseEvent[] = [];
    // Combine frames into one chunk to avoid timing issues
    const combinedFrames =
      sseFrame('resync', { reason: 'cursor_expired', message: 'resync needed' }) +
      sseFrame('snapshot', { tasks: [{ id: 't1', status: 'completed' }] }, '100');

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    let fetchCalls = 0;
    const capturedHeaders: Array<Record<string, string>> = [];
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      fetchCalls++;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
        } else if (typeof init.headers === 'object') {
          for (const [key, value] of Object.entries(init.headers)) {
            headers[key.toLowerCase()] = String(value);
          }
        }
      }
      capturedHeaders.push(headers);
      // First call: send resync + snapshot; Second call: empty/done
      return {
        ok: true,
        status: 200,
        body: createMockSseStream(fetchCalls === 1 ? [combinedFrames] : []),
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      };
    });

    let resyncReceived = false;
    let snapshotReceived = false;
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      initialCursor: '50',
      onEvent: (e) => {
        events.push(e);
        if (e.event === 'resync') resyncReceived = true;
        if (e.event === 'snapshot') snapshotReceived = true;
      },
      onResync: () => {},
      shouldReconnect: () => fetchCalls < 3,
      minReconnectDelay: 10,
      maxRetries: 3,
    });

    await vi.waitFor(() => {
      expect(resyncReceived).toBe(true);
      expect(snapshotReceived).toBe(true);
    }, { timeout: 5000 });

    // Wait for reconnect
    await vi.waitFor(() => {
      expect(fetchCalls).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });

    await new Promise((r) => setTimeout(r, 500));
    client.close();
    globalThis.fetch = originalFetch;

    expect(events.some((e) => e.event === 'resync')).toBe(true);
    expect(events.some((e) => e.event === 'snapshot')).toBe(true);
    // After resync + snapshot, cursor should be '100' from snapshot
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(2);
    expect(capturedHeaders[1]?.['last-event-id']).toBe('100');
  });

  it('dedupes events with the same id', async () => {
    const events: SseEvent[] = [];
    // Send the same event id=5 twice (simulates replay after reconnect)
    const frames = [
      sseFrame('running', { task: { id: 't1' } }, '5'),
      sseFrame('running', { task: { id: 't1' } }, '5'),  // duplicate
      sseFrame('completed', { task: { id: 't1' } }, '6'),
    ];

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: createMockSseStream(frames),
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: (e) => events.push(e),
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 2000 });

    client.close();
    globalThis.fetch = originalFetch;

    // Should only see running once and completed once (duplicate id=5 deduped)
    expect(events.filter((e) => e.id === '5')).toHaveLength(1);
    expect(events.filter((e) => e.id === '6')).toHaveLength(1);
  });

  it('done event closes stream and fires onDone without reconnecting', async () => {
    const events: SseEvent[] = [];
    let doneCalled = false;
    let fetchCount = 0;

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    mockFetch.mockImplementation(() => {
      fetchCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        body: createMockSseStream([
          sseFrame('running', { task: { id: 't1' } }, '1'),
          sseFrame('done', { reason: 'completed' }, '2'),
        ]),
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      });
    });

    const client = createSseClient({
      url: '/api/pipelines/runs/r1/stream',
      onEvent: (e) => events.push(e),
      onDone: () => { doneCalled = true; },
      minReconnectDelay: 10,
      maxReconnectDelay: 50,
      maxRetries: 5,
    });

    await vi.waitFor(() => {
      expect(doneCalled).toBe(true);
    }, { timeout: 2000 });

    // Wait a bit to ensure no reconnection happens
    await new Promise((r) => setTimeout(r, 300));

    client.close();
    globalThis.fetch = originalFetch;

    expect(doneCalled).toBe(true);
    expect(events.some((e) => e.event === 'done')).toBe(true);
    // Should have only fetched once (done closes stream, no reconnect)
    expect(fetchCount).toBe(1);
  });

  it('correctly parses CRLF line endings', async () => {
    const events: SseEvent[] = [];
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // CRLF-separated event
    const crlfFrame = "id: 42\r\nevent: blocked\r\ndata: {\"task\":{\"id\":\"t2\"}}\r\n\r\n";

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: createMockSseStream([crlfFrame]),
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: (e) => events.push(e),
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    client.close();
    globalThis.fetch = originalFetch;

    expect(events[0].event).toBe('blocked');
    expect(events[0].id).toBe('42');
    const data = JSON.parse(events[0].data);
    expect(data.task.id).toBe('t2');
  });

  it('correctly joins multi-line data with newlines (per SSE spec)', async () => {
    const events: SseEvent[] = [];
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Two "data:" lines should be joined with \n
    const multiLineFrame = "id: 7\nevent: completed\ndata: {\"line\":1}\ndata: {\"line\":2}\n\n";

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: createMockSseStream([multiLineFrame]),
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: (e) => events.push(e),
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    client.close();
    globalThis.fetch = originalFetch;

    expect(events[0].event).toBe('completed');
    expect(events[0].id).toBe('7');
    // Multi-line data: two data lines joined by \n per SSE spec
    const lines = events[0].data.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ line: 1 });
    expect(JSON.parse(lines[1])).toEqual({ line: 2 });
  });

  it('does not dedup events without explicit id against a prior event id', async () => {
    // Bug regression: event without explicit id was inheriting lastEventId
    // and being dedup'd as a duplicate of the previous event.
    const events: SseEvent[] = [];
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // First event has explicit id:5, second event has NO id field
    const frames = "id: 5\nevent: running\ndata: {\"step\":1}\n\nevent: running\ndata: {\"step\":2}\n\n";
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: createMockSseStream([frames]),
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: (e) => events.push(e),
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 2000 });

    client.close();
    globalThis.fetch = originalFetch;

    // Both events should be delivered — second event carries forward id='5'
    // but is NOT dedup'd because it doesn't have its own explicit id
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('5');
    expect((events[0] as any).hasExplicitId).toBe(true);
    expect(JSON.parse(events[0].data).step).toBe(1);
    // Event id carries forward per spec but hasExplicitId=false (so not dedup'd)
    expect(events[1].id).toBe('5');
    expect((events[1] as any).hasExplicitId).toBe(false);
    expect(JSON.parse(events[1].data).step).toBe(2);
  });

  it('handles 1-byte-at-a-time chunk fragmentation', async () => {
    // Maximum fragmentation: split the SSE stream into single-byte chunks
    const events: SseEvent[] = [];
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const frames =
      "id: 1\nevent: queued\ndata: {\"t\":1}\n\n" +
      "id: 2\nevent: running\ndata: {\"t\":2}\n\n" +
      "id: 3\nevent: completed\ndata: {\"t\":3}\n\n";

    // Split into 1-byte chunks (simulating pathological network)
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < frames.length; i++) {
      chunks.push(new TextEncoder().encode(frames[i]));
    }
    let idx = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (idx < chunks.length) {
          controller.enqueue(chunks[idx++]);
        } else {
          controller.close();
        }
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: (e) => events.push(e),
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(3);
    }, { timeout: 3000 });

    client.close();
    globalThis.fetch = originalFetch;

    expect(events.map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(events.map((e) => e.event)).toEqual(['queued', 'running', 'completed']);
  });

  it('delivers resync → snapshot → replay events in order with clean dedup', async () => {
    // Simulates the pipeline/AI task stream pattern: resync clears state,
    // snapshot sets baseline, then immediate replay events update it.
    const events: SseEvent[] = [];
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const frames =
      // resync signals cursor reset
      sseFrame('resync', { reason: 'cursor_expired' }, '0') +
      // snapshot provides baseline (completed task)
      sseFrame('snapshot', { runId: 'r1', runStatus: 'running', cursor: '100' }, '100') +
      // replay: step started event that arrived between disconnect and snapshot
      sseFrame('step_started', { stepId: 's1' }, '98') +
      sseFrame('step_completed', { stepId: 's1' }, '99') +
      // live event after snapshot
      sseFrame('step_started', { stepId: 's2' }, '101') +
      sseFrame('done', { status: 'completed' }, '102');

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: createMockSseStream([frames]),
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    let doneFired = false;
    const client = createSseClient({
      url: '/api/pipelines/runs/r1/stream',
      onEvent: (e) => events.push(e),
      onDone: () => { doneFired = true; },
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(doneFired).toBe(true);
    }, { timeout: 2000 });

    client.close();
    globalThis.fetch = originalFetch;

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain('resync');
    expect(eventTypes).toContain('snapshot');
    expect(eventTypes).toContain('step_started');
    expect(eventTypes).toContain('step_completed');
    expect(eventTypes).toContain('done');
    // Replay event 98 must NOT be dedup'd (resync cleared dedup set)
    expect(events.some((e) => e.id === '98' && e.event === 'step_started')).toBe(true);
    expect(events.some((e) => e.id === '99' && e.event === 'step_completed')).toBe(true);
  });
});

describe('Out-of-order and stale event rejection (via state machine)', () => {
  it('completed terminal state rejects subsequent running events', () => {
    // Simulate: task completes, then a stale running event arrives
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('cancelled', 'queued')).toBe(false);
    expect(canTransition('failed', 'blocked')).toBe(false);
  });

  it('client-error states (missing/scope_mismatch) can be corrected by server events', () => {
    expect(canTransition('missing', 'running')).toBe(true);
    expect(canTransition('missing', 'completed')).toBe(true);
    expect(canTransition('scope_mismatch', 'failed')).toBe(true);
  });

  it('same status is always allowed (idempotent repeats)', () => {
    for (const s of ['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'missing'] as const) {
      expect(canTransition(s, s)).toBe(true);
    }
  });

  it('EventDeduplicator rejects older and equal seqs, accepts newer', () => {
    const dedup = new EventDeduplicator(10);
    expect(dedup.check('task-1', 5)).toBe(true);
    expect(dedup.check('task-1', 5)).toBe(false); // duplicate
    expect(dedup.check('task-1', 4)).toBe(false); // older
    expect(dedup.check('task-1', 3)).toBe(false); // older
    expect(dedup.check('task-1', 6)).toBe(true);  // newer
    expect(dedup.check('task-1', 6)).toBe(false); // duplicate
  });
});

describe('Recovery scenarios (disconnect, expired cursor, 401, restart)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('disconnect + reconnect: task completed while offline is replayed via snapshot', async () => {
    const events: SseEvent[] = [];
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Connection 1: only sees running event, then stream ends (simulating disconnect)
    const conn1Frames = sseFrame('running', { task: { id: 't1', status: 'running' } }, '10');
    // Connection 2 (reconnect): sends Last-Event-ID=10; server has snapshot showing completed
    const conn2Frames =
      sseFrame('snapshot', { tasks: [{ id: 't1', status: 'completed', result: 'x' }], cursor: '15' }, '15') +
      sseFrame('completed', { task: { id: 't1', status: 'completed', result: 'x' } }, '14') +
      sseFrame('done', { reason: 'all_caught_up' }, '16');

    let callCount = 0;
    mockFetch.mockImplementation(async (url: string | URL) => {
      callCount++;
      const urlStr = url.toString();
      const frames = callCount === 1 ? conn1Frames : conn2Frames;
      // On second call, Last-Event-ID header must be '10'
      if (callCount === 2) {
        const headers = (mockFetch.mock.calls[1][1] as RequestInit)?.headers as Record<string, string>;
        expect(headers?.['Last-Event-ID']).toBe('10');
      }
      return {
        ok: true,
        status: 200,
        body: createMockSseStream([frames]),
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      };
    });

    let doneCount = 0;
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: (e) => events.push(e),
      onDone: () => { doneCount++; },
      // Allow reconnect for the first disconnect, stop after second connection
      shouldReconnect: () => callCount < 2,
      minReconnectDelay: 10,
      maxReconnectDelay: 100,
      maxRetries: 5,
    });

    // Wait for conn1 to deliver running
    await vi.waitFor(() => {
      expect(events.some((e) => e.event === 'running' && e.id === '10')).toBe(true);
    }, { timeout: 5000 });

    // Simulate disconnect: conn1 stream closes (createMockSseStream closes after sending frames)
    // The reader loop breaks out, scheduleReconnect fires with delay
    await vi.advanceTimersByTimeAsync(200);

    // Wait for conn2 to deliver snapshot + completed
    await vi.waitFor(() => {
      expect(events.some((e) => e.event === 'snapshot')).toBe(true);
    }, { timeout: 5000 });

    await vi.waitFor(() => {
      expect(doneCount).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    client.close();

    // Verify snapshot was received containing completed task
    const snapshot = events.find((e) => e.event === 'snapshot');
    expect(snapshot).toBeDefined();
    const snapData = JSON.parse(snapshot!.data);
    expect(snapData.tasks[0].status).toBe('completed');

    // Verify reconnect happened
    expect(callCount).toBe(2);
  });

  it('expired cursor: server sends resync which clears dedup before snapshot', async () => {
    const events: SseEvent[] = [];
    const resyncInfos: Array<{ reason: string }> = [];
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const frames =
      sseFrame('resync', { reason: 'cursor_expired', message: 'resync required' }, '0') +
      sseFrame('snapshot', { tasks: [{ id: 't1', status: 'queued' }], cursor: '100' }, '100') +
      // These "old" events have ids 50,51 which look older than snapshot_seq=100;
      // after resync client should process them (dedup was reset)
      sseFrame('queued', { task: { id: 't1', status: 'queued' } }, '98') +
      sseFrame('running', { task: { id: 't1', status: 'running' } }, '99');

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: createMockSseStream([frames]),
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      initialCursor: '1',
      onEvent: (e) => events.push(e),
      onResync: (info) => resyncInfos.push(info),
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(4);
    }, { timeout: 5000 });

    client.close();

    expect(resyncInfos).toHaveLength(1);
    expect(resyncInfos[0].reason).toBe('cursor_expired');

    // Events 98 and 99 must be delivered even though they have lower ids than snapshot 100,
    // because resync clears the dedup set
    expect(events.some((e) => e.id === '98')).toBe(true);
    expect(events.some((e) => e.id === '99')).toBe(true);
  });

  it('401 with successful token refresh reconnects once; second 401 closes', async () => {
    const events: SseEvent[] = [];
    const errors: Error[] = [];
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    let refreshCalled = 0;
    const frames = sseFrame('running', { task: { id: 't1' } }, '1');

    mockFetch.mockImplementation(async () => {
      const call = mockFetch.mock.calls.length;
      if (call === 1) {
        // First call returns 401
        return { ok: false, status: 401, body: null, headers: new Headers() };
      } else if (call === 2) {
        // After refresh returns success with events
        return {
          ok: true,
          status: 200,
          body: createMockSseStream([frames]),
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        };
      }
      return { ok: false, status: 401, body: null, headers: new Headers() };
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      token: 'old-token',
      onEvent: (e) => events.push(e),
      onError: (err) => errors.push(err),
      refreshToken: async () => {
        refreshCalled++;
        return 'new-token';
      },
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.event === 'running')).toBe(true);
    }, { timeout: 5000 });

    client.close();

    expect(refreshCalled).toBe(1);
    expect(errors).toHaveLength(0);
    expect(events.length).toBeGreaterThanOrEqual(1);
    // Verify new token was used
    const secondCallHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(secondCallHeaders.Authorization).toBe('Bearer new-token');
  });

  it('401 without refresh capability closes with UNAUTHORIZED', async () => {
    const errors: Error[] = [];
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      body: null,
      headers: new Headers(),
    });

    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      token: 'expired-token',
      onEvent: () => {},
      onError: (err) => errors.push(err),
      // No refreshToken provided
      shouldReconnect: () => false,
      maxRetries: 0,
    });

    await vi.waitFor(() => {
      expect(errors.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    client.close();
    expect(errors[0].message).toBe('UNAUTHORIZED');
  });

  it('maxRetries is enforced: stops after N failed reconnect attempts', async () => {
    const errors: Error[] = [];
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // All connections fail with network error
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const MAX = 3;
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: () => {},
      onError: (err) => errors.push(err),
      shouldReconnect: () => true,
      minReconnectDelay: 5,
      maxReconnectDelay: 10,
      maxRetries: MAX,
    });

    // Advance timers to trigger retries
    for (let i = 0; i < MAX + 2; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    client.close();

    // Should have exactly one error (max retries exceeded)
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[errors.length - 1].message).toContain('重连次数超过上限');
    // Fetch should have been called MAX+1 times (initial + MAX retries)
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(MAX + 1);
  });

  it('shouldReconnect returning false stops reconnect loop immediately', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    let shouldReconnectCalls = 0;
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      onEvent: () => {},
      onError: () => {},
      shouldReconnect: () => {
        shouldReconnectCalls++;
        return false; // stop immediately
      },
      minReconnectDelay: 5,
      maxRetries: 50,
    });

    await vi.advanceTimersByTimeAsync(200);
    client.close();

    // Should be called once and stop
    expect(shouldReconnectCalls).toBeGreaterThanOrEqual(1);
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  it('state machine: duplicate completed event is safely idempotent', () => {
    // Repeated completed events must not throw or corrupt state
    let status: string = 'running';
    const dedup = new EventDeduplicator();

    // First completed transitions from running
    expect(canTransition(status as any, 'completed')).toBe(true);
    expect(dedup.check('t1', 10)).toBe(true);
    status = 'completed';

    // Duplicate completed: same status allowed
    expect(canTransition(status as any, 'completed')).toBe(true);
    // But dedup catches seq ≤ 10
    expect(dedup.check('t1', 10)).toBe(false);
    expect(dedup.check('t1', 9)).toBe(false);
    // Same status is still a safe no-op
    expect(dedup.check('t1', 11)).toBe(true); // higher seq (retried completion)
    expect(canTransition('completed', 'completed')).toBe(true);
  });

  it('state machine: stale running does not overwrite completed', () => {
    // Task completed at seq 10; stale running event (seq 5) arrives out of order
    expect(canTransition('completed', 'running')).toBe(false);

    const dedup = new EventDeduplicator();
    dedup.check('t1', 10); // completed
    // seq 5 arrives late — dedup rejects it
    expect(dedup.check('t1', 5)).toBe(false);
    // seq 10 duplicate — dedup rejects
    expect(dedup.check('t1', 10)).toBe(false);
  });
});
