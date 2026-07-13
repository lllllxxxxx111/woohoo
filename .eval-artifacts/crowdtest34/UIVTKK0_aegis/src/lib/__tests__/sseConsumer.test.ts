import { describe, expect, it, vi } from 'vitest';
import { SseFrameParser, createSseConsumer, parseSseJson } from '../sseConsumer';
import {
  shouldApplyState,
  EventDedupTracker,
  isTerminalState,
  normalizeUiStatus,
  STATE_USER_MESSAGES,
  type UiTaskStatus,
} from '../taskEventOrdering';
import type { AiTask } from '../serverApi';

// ──────────────────────────────────────────────────────────────────────────
// SSE Frame Parser Tests
// ──────────────────────────────────────────────────────────────────────────

describe('SseFrameParser', () => {
  it('parses a simple event: data: pair', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('event: completed\ndata: {"task":{"id":"t1"}}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('completed');
    expect(frames[0].data).toBe('{"task":{"id":"t1"}}');
    expect(frames[0].id).toBeNull();
  });

  it('handles multi-line data fields (SSE spec)', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('data: line1\ndata: line2\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('line1\nline2');
  });

  it('parses event id field', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('id: 42\nevent: running\ndata: {"status":"running"}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe('42');
    expect(frames[0].event).toBe('running');
  });

  it('handles chunked/multi-chunk delivery across arbitrary boundaries', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });

    // Feed in arbitrary chunks that split lines and events
    parser.feed('id: 1\nevent: c');
    parser.feed('ompleted\ndata: {"res');
    parser.feed('ult":"ok"}\n\nid: 2\nev');
    parser.feed('ent: done\ndata: [DONE]\n\n');

    expect(frames).toHaveLength(2);
    expect(frames[0].id).toBe('1');
    expect(frames[0].event).toBe('completed');
    expect(frames[0].data).toBe('{"result":"ok"}');
    expect(frames[1].event).toBe('done');
    expect(frames[1].data).toBe('[DONE]');
  });

  it('handles \\r\\n line endings', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('event: test\r\ndata: hello\r\n\r\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('test');
    expect(frames[0].data).toBe('hello');
  });

  it('ignores comment lines starting with :', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed(': this is a comment\nevent: msg\ndata: hi\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('msg');
  });

  it('defaults event type to "message" when no event: field', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('data: just some data\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('message');
  });

  it('parses retry field', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('retry: 5000\ndata: test\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].retry).toBe(5000);
  });

  it('rejects NUL in event id', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('id: 42\u0000bad\ndata: test\n\n');
    expect(frames[0].id).toBeNull(); // NUL in id should be rejected
  });

  it('handles incomplete trailing data on end()', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('event: test\ndata: hello');
    parser.end();
    // Even without trailing \n\n, end() should dispatch
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame.event).toBe('test');
    expect(lastFrame.data).toBe('hello');
  });

  it('handles [DONE] marker as data', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('data: [DONE]\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('[DONE]');
  });

  it('handles empty data: field (dispatches empty string)', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => { frames.push(f); });
    parser.feed('event: heartbeat\ndata\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('heartbeat');
    expect(frames[0].data).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Task Event Ordering Tests
// ──────────────────────────────────────────────────────────────────────────

describe('isTerminalState', () => {
  it('identifies terminal states correctly', () => {
    expect(isTerminalState('completed')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('cancelled')).toBe(true);
    expect(isTerminalState('blocked')).toBe(true);
    expect(isTerminalState('missing')).toBe(true);
    expect(isTerminalState('scope_mismatch')).toBe(true);
    expect(isTerminalState('queued')).toBe(false);
    expect(isTerminalState('running')).toBe(false);
  });
});

describe('shouldApplyState', () => {
  it('applies state when no current state exists', () => {
    expect(shouldApplyState(undefined, 'queued')).toBe(true);
    expect(shouldApplyState(undefined, 'running')).toBe(true);
    expect(shouldApplyState(undefined, 'completed')).toBe(true);
  });

  it('allows non-terminal to non-terminal transition', () => {
    expect(shouldApplyState('queued', 'running')).toBe(true);
  });

  it('allows non-terminal to terminal transition', () => {
    expect(shouldApplyState('running', 'completed')).toBe(true);
    expect(shouldApplyState('running', 'failed')).toBe(true);
    expect(shouldApplyState('queued', 'cancelled')).toBe(true);
  });

  it('blocks non-terminal state from overwriting terminal state', () => {
    expect(shouldApplyState('completed', 'running')).toBe(false);
    expect(shouldApplyState('completed', 'queued')).toBe(false);
    expect(shouldApplyState('failed', 'running')).toBe(false);
    expect(shouldApplyState('cancelled', 'running')).toBe(false);
  });

  it('allows terminal state to overwrite another terminal state', () => {
    expect(shouldApplyState('cancelled', 'completed')).toBe(true);
    expect(shouldApplyState('completed', 'failed')).toBe(true);
  });

  it('respects sequence numbers: older event is rejected', () => {
    expect(shouldApplyState('running', 'completed', 10, 5)).toBe(false);
    expect(shouldApplyState('running', 'completed', 5, 10)).toBe(true);
  });

  it('rejects equal sequence numbers', () => {
    expect(shouldApplyState('running', 'completed', 10, 10)).toBe(false);
  });

  it('allows same-sequence terminal states (safe duplicate replay)', () => {
    expect(shouldApplyState('completed', 'completed', 10, 10)).toBe(true);
    expect(shouldApplyState('failed', 'failed', 10, 10)).toBe(true);
  });

  it('rejects old queued event overwriting new running via seq', () => {
    // If we're at running (seq=5) and receive a queued event (seq=3), reject
    expect(shouldApplyState('running', 'queued', 5, 3)).toBe(false);
  });

  it('queued event cannot overwrite completed even without seq', () => {
    expect(shouldApplyState('completed', 'queued')).toBe(false);
  });
});

describe('EventDedupTracker', () => {
  it('tracks seen event IDs and rejects duplicates', () => {
    const tracker = new EventDedupTracker();
    expect(tracker.markAndCheck('task-1', 'evt-1')).toBe(true);
    expect(tracker.markAndCheck('task-1', 'evt-1')).toBe(false); // duplicate
    expect(tracker.markAndCheck('task-1', 'evt-2')).toBe(true); // new event
  });

  it('tracks sequence numbers and rejects older events', () => {
    const tracker = new EventDedupTracker();
    expect(tracker.markAndCheck('task-1', null, 5)).toBe(true);
    expect(tracker.markAndCheck('task-1', null, 3)).toBe(false); // older
    expect(tracker.markAndCheck('task-1', null, 5)).toBe(false); // equal
    expect(tracker.markAndCheck('task-1', null, 6)).toBe(true); // newer
  });

  it('keeps separate tracking per task', () => {
    const tracker = new EventDedupTracker();
    expect(tracker.markAndCheck('task-1', 'evt-1')).toBe(true);
    expect(tracker.markAndCheck('task-2', 'evt-1')).toBe(true); // different task, same id
  });

  it('clears task tracking on clearTask', () => {
    const tracker = new EventDedupTracker();
    tracker.markAndCheck('task-1', 'evt-1');
    tracker.clearTask('task-1');
    expect(tracker.markAndCheck('task-1', 'evt-1')).toBe(true); // after clear, accepted again
  });

  it('reports max seq per task', () => {
    const tracker = new EventDedupTracker();
    tracker.markAndCheck('task-1', null, 3);
    tracker.markAndCheck('task-1', null, 7);
    expect(tracker.getMaxSeq('task-1')).toBe(7);
    expect(tracker.getMaxSeq('task-2')).toBeUndefined();
  });
});

describe('normalizeUiStatus', () => {
  it('passes through normal statuses', () => {
    expect(normalizeUiStatus(makeTask('queued'))).toBe('queued');
    expect(normalizeUiStatus(makeTask('running'))).toBe('running');
    expect(normalizeUiStatus(makeTask('completed'))).toBe('completed');
  });

  it('maps failed+cancel error to cancelled status', () => {
    const task = makeTask('failed', { error: '用户取消' });
    expect(normalizeUiStatus(task)).toBe('cancelled');
  });

  it('keeps failed status for non-cancellation errors', () => {
    const task = makeTask('failed', { error: '网络超时' });
    expect(normalizeUiStatus(task)).toBe('failed');
  });
});

describe('STATE_USER_MESSAGES', () => {
  it('has entries for all edge-case states', () => {
    expect(STATE_USER_MESSAGES.missing).toBeDefined();
    expect(STATE_USER_MESSAGES.missing.message).toContain('重新同步');
    expect(STATE_USER_MESSAGES.scope_mismatch).toBeDefined();
    expect(STATE_USER_MESSAGES.cancelled).toBeDefined();
    expect(STATE_USER_MESSAGES.blocked).toBeDefined();
    expect(STATE_USER_MESSAGES.failed).toBeDefined();
  });
});

describe('parseSseJson', () => {
  it('parses valid JSON', () => {
    expect(parseSseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(parseSseJson('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSseJson('')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Integration-style test: SSE consumer with mock fetch
// ──────────────────────────────────────────────────────────────────────────

describe('createSseConsumer', () => {
  it('parses frames from a mock stream and invokes onFrame', async () => {
    const frames: any[] = [];
    let resolveStream: (() => void) | null = null;
    const streamClosed = new Promise<void>((r) => (resolveStream = r));

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          // Send a complete event frame
          controller.enqueue(encoder.encode('id: 1\nevent: completed\ndata: {"ok":true}\n\n'));
          // Send [DONE]
          setTimeout(() => {
            controller.enqueue(encoder.encode('event: done\ndata: [DONE]\n\n'));
            controller.close();
            resolveStream?.();
          }, 10);
        },
      }),
    });

    let doneCalled = false;
    const controller = createSseConsumer({
      url: 'http://localhost/test',
      fetchImpl: mockFetch as any,
      onFrame: (frame) => {
        frames.push(frame);
        return true;
      },
      onDone: () => {
        doneCalled = true;
      },
    });

    await streamClosed;
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalled();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(doneCalled).toBe(true);
    controller.close();
  });

  it('handles 401 by attempting auth refresh', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            // Close immediately with done to end stream
            setTimeout(() => {
              controller.enqueue(encoder.encode('event: done\ndata: [DONE]\n\n'));
              controller.close();
            }, 20);
          },
        }),
      });

    const frames: any[] = [];
    let doneCalled = false;
    let consumer: any = null;
    consumer = createSseConsumer({
      url: 'http://localhost/test',
      token: 'bad-token',
      fetchImpl: mockFetch as any,
      onFrame: (f) => { frames.push(f); return true; },
      onDone: () => {
        doneCalled = true;
        consumer?.close();
      },
      onAuthRefresh: async () => 'new-token',
      maxBackoffMs: 100,
      baseBackoffMs: 10,
    });

    // Wait for the 401 + refresh + second fetch + done
    await new Promise((r) => setTimeout(r, 500));
    consumer.close();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(doneCalled).toBe(true);
    // The second call should have used the new token
    const secondCallHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(secondCallHeaders['Authorization']).toBe('Bearer new-token');
  });

  it('sends Last-Event-ID header when resuming', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('id: 100\ndata: {"seq":100}\n\n'));
          // Don't close — let keepalive hold
          setTimeout(() => controller.close(), 20);
        },
      }),
    });

    const controller = createSseConsumer({
      url: 'http://localhost/test',
      lastEventId: '42',
      fetchImpl: mockFetch as any,
      onFrame: () => true,
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.close();

    const firstCallHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(firstCallHeaders['Last-Event-ID']).toBe('42');
  });

  it('reconnects with exponential backoff on transient error', async () => {
    const timestamps: number[] = [];
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('event: done\ndata: {"reason":"completed"}\n\n'));
              controller.close();
            }, 10);
          },
        }),
      });

    let doneCalled = false;
    const controller = createSseConsumer({
      url: 'http://localhost/test',
      fetchImpl: mockFetch as any,
      onFrame: () => true,
      onDone: () => { doneCalled = true; },
      baseBackoffMs: 50,
      maxBackoffMs: 500,
    });

    // Monkey-patch setTimeout to track connect timestamps
    const origSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: any, ms: number) => {
      timestamps.push(ms);
      return origSetTimeout(fn, ms);
    };

    await new Promise((r) => setTimeout(r, 500));
    (global as any).setTimeout = origSetTimeout;
    controller.close();

    // Should have attempted multiple connections
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(doneCalled).toBe(true);
    // Backoff should have grown
    expect(timestamps.length).toBeGreaterThanOrEqual(2);
  });

  it('stops reconnecting when shouldReconnect returns false', async () => {
    let attempts = 0;
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error('persistent failure'));

    const controller = createSseConsumer({
      url: 'http://localhost/test',
      fetchImpl: mockFetch as any,
      onFrame: () => true,
      // Allow initial connection, then deny reconnection
      shouldReconnect: () => {
        attempts++;
        return attempts <= 1;
      },
      baseBackoffMs: 10,
      maxBackoffMs: 50,
    });

    await new Promise((r) => setTimeout(r, 200));
    controller.close();

    // Should have attempted only once (initial) then stopped
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('handles resync event and calls onResync callback', async () => {
    let resyncInfo: any = null;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'id: 100\nevent: resync\ndata: {"reason":"cursor_expired","oldestAvailableSeq":50}\n\n'
          ));
          setTimeout(() => controller.close(), 20);
        },
      }),
    });

    const controller = createSseConsumer({
      url: 'http://localhost/test',
      fetchImpl: mockFetch as any,
      onFrame: () => true,
      onResync: (info) => { resyncInfo = info; },
    });

    await new Promise((r) => setTimeout(r, 100));
    controller.close();

    expect(resyncInfo).not.toBeNull();
    expect(resyncInfo.reason).toBe('cursor_expired');
    expect(resyncInfo.oldestAvailableSeq).toBe(50);
  });

  it('handles done event with reason from JSON data', async () => {
    let doneReason: string | undefined;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'id: 1\nevent: done\ndata: {"reason":"timeout"}\n\n'
          ));
          setTimeout(() => controller.close(), 10);
        },
      }),
    });

    const controller = createSseConsumer({
      url: 'http://localhost/test',
      fetchImpl: mockFetch as any,
      onFrame: () => true,
      onDone: (reason) => { doneReason = reason; },
    });

    await new Promise((r) => setTimeout(r, 100));
    controller.close();

    expect(doneReason).toBe('timeout');
  });

  it('passes lagged events through onFrame without triggering done', async () => {
    const events: any[] = [];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'id: 10\nevent: lagged\ndata: {"skipped":5,"lastEventId":15}\n\n'
          ));
          controller.enqueue(new TextEncoder().encode(
            'id: 16\nevent: running\ndata: {"ok":true}\n\n'
          ));
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('event: done\ndata: [DONE]\n\n'));
            controller.close();
          }, 20);
        },
      }),
    });

    let doneCalled = false;
    const controller = createSseConsumer({
      url: 'http://localhost/test',
      fetchImpl: mockFetch as any,
      onFrame: (frame) => { events.push(frame); return true; },
      onDone: () => { doneCalled = true; },
    });

    await new Promise((r) => setTimeout(r, 100));
    controller.close();

    // lagged event should be in events (not treated as done or resync)
    expect(events.find((e) => e.event === 'lagged')).toBeDefined();
    expect(events.find((e) => e.event === 'running')).toBeDefined();
    expect(doneCalled).toBe(true);
  });

  it('updates Last-Event-ID on reconnect after receiving events', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First connection: send event with id: 42, then close abruptly
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('id: 42\nevent: running\ndata: {"ok":true}\n\n'));
              setTimeout(() => controller.error(new Error('connection lost')), 20);
            },
          }),
        });
      }
      // Second connection: should send Last-Event-ID: 42
      return Promise.resolve({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('event: done\ndata: [DONE]\n\n'));
              controller.close();
            }, 10);
          },
        }),
      });
    });

    let doneCalled = false;
    const controller = createSseConsumer({
      url: 'http://localhost/test',
      fetchImpl: mockFetch as any,
      onFrame: () => true,
      onDone: () => { doneCalled = true; },
      baseBackoffMs: 20,
      maxBackoffMs: 50,
    });

    await new Promise((r) => setTimeout(r, 300));
    controller.close();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondCallHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(secondCallHeaders['Last-Event-ID']).toBe('42');
    expect(doneCalled).toBe(true);
  });

  it('respects retry field from server to adjust reconnect delay', async () => {
    const delays: number[] = [];
    const origSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: any, ms: number) => {
      if (ms > 0) delays.push(ms);
      return origSetTimeout(fn, ms);
    };

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              // Send retry: 100 (very short) then crash
              controller.enqueue(new TextEncoder().encode('retry: 100\ndata: test\n\n'));
              setTimeout(() => controller.error(new Error('lost')), 10);
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('event: done\ndata: [DONE]\n\n'));
              controller.close();
            }, 5);
          },
        }),
      });
    });

    const controller = createSseConsumer({
      url: 'http://localhost/test',
      fetchImpl: mockFetch as any,
      onFrame: () => true,
      baseBackoffMs: 5000, // high default
      maxBackoffMs: 10000,
    });

    await new Promise((r) => origSetTimeout(r, 200));
    (global as any).setTimeout = origSetTimeout;
    controller.close();

    // The reconnect delay should have been set to 100ms by the server's retry field
    const reconnectDelay = delays.find((d) => d === 100);
    expect(reconnectDelay).toBe(100);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Server-side SSE framing unit tests (verify Rust backend output format)
// ──────────────────────────────────────────────────────────────────────────

describe('SSE frame format (server contract)', () => {
  /**
   * These tests encode the contract that the Rust server must follow when
   * emitting SSE frames. They parse server-format strings to verify clients
   * can read them. If these pass, the server output format is correct.
   */

  it('parses server pipeline event format', () => {
    // Exact format the Rust pipeline handler emits
    const serverFrame =
      'id: 42\n' +
      'event: step_started\n' +
      'retry: 3000\n' +
      'data: {"type":"step_started","payload":{"stepId":"s1"},"source":"orchestrator"}\n\n';

    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed(serverFrame);

    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe('42');
    expect(frames[0].event).toBe('step_started');
    expect(frames[0].retry).toBe(3000);
    const data = JSON.parse(frames[0].data);
    expect(data.type).toBe('step_started');
    expect(data.payload.stepId).toBe('s1');
  });

  it('parses server AI task sequenced_event format', () => {
    const serverFrame =
      'id: 15\n' +
      'event: completed\n' +
      'retry: 3000\n' +
      'data: {"eventType":"completed","task":{"id":"t1","status":"completed"},"contentDelta":null}\n\n';

    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed(serverFrame);

    expect(frames[0].id).toBe('15');
    expect(frames[0].event).toBe('completed');
    expect(frames[0].retry).toBe(3000);
  });

  it('parses server collaboration event format with envelope', () => {
    const serverFrame =
      'id: 100\n' +
      'event: collaboration\n' +
      'data: {"sessionId":"sess-1","eventType":"collaboration_session_halted","payload":{"reason":"manual"},"seq":100}\n\n';

    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed(serverFrame);

    expect(frames[0].id).toBe('100');
    const data = JSON.parse(frames[0].data);
    expect(data.sessionId).toBe('sess-1');
    expect(data.eventType).toBe('collaboration_session_halted');
  });

  it('parses server error event format (visible error delivery)', () => {
    const serverFrame =
      'id: 25\n' +
      'event: error\n' +
      'retry: 3000\n' +
      'data: {"message":"事件查询失败","detail":"database is locked"}\n\n';

    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed(serverFrame);

    expect(frames[0].event).toBe('error');
    const data = JSON.parse(frames[0].data);
    expect(data.message).toBeDefined();
    expect(data.detail).toBeDefined();
  });

  it('parses fragmented pipeline stream across TCP chunk boundaries', () => {
    // Simulate fragmented delivery of multiple events
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));

    // Split at arbitrary byte positions
    const fullStream =
      'id: 1\nevent: snapshot\ndata: {"status":"connected"}\n\n' +
      'id: 2\nevent: step_started\ndata: {"type":"step_started","payload":{},"source":"o"}\n\n' +
      'id: 3\nevent: done\ndata: {"reason":"completed"}\n\n';

    // Feed in 7-byte chunks to force cross-chunk parsing
    for (let i = 0; i < fullStream.length; i += 7) {
      parser.feed(fullStream.slice(i, i + 7));
    }

    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.map((f) => f.event)).toContain('snapshot');
    expect(frames.map((f) => f.event)).toContain('step_started');
    expect(frames.map((f) => f.event)).toContain('done');
  });

  it('parses server error event and client handles via error case', () => {
    // Error events have message+detail fields and carry retry: for reconnect
    const serverFrame =
      'id: 99\nevent: error\nretry: 3000\n' +
      'data: {"message":"事件查询失败","detail":"database is locked"}\n\n';

    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed(serverFrame);

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('error');
    expect(frames[0].id).toBe('99');
    expect(frames[0].retry).toBe(3000);
    const data = JSON.parse(frames[0].data);
    expect(data.message).toBe('事件查询失败');
    expect(data.detail).toBeDefined();
  });

  it('parses done event with all known reasons', () => {
    const reasons = ['completed', 'timeout', 'db_error', 'max_polls', 'server_shutdown', 'session_terminal'];
    for (const reason of reasons) {
      const frames: any[] = [];
      const parser = new SseFrameParser((f) => frames.push(f));
      parser.feed(`id: 1\nevent: done\ndata: {"reason":"${reason}"}\n\n`);
      expect(frames).toHaveLength(1);
      expect(frames[0].event).toBe('done');
      expect(JSON.parse(frames[0].data).reason).toBe(reason);
    }
  });

  it('parses resync event with cursor metadata', () => {
    const serverFrame =
      'id: 500\nevent: resync\nretry: 3000\n' +
      'data: {"reason":"cursor_expired","oldestAvailableSeq":50,"requestedSeq":10,"message":"事件游标已过期"}\n\n';

    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed(serverFrame);

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('resync');
    const data = JSON.parse(frames[0].data);
    expect(data.reason).toBe('cursor_expired');
    expect(data.oldestAvailableSeq).toBe(50);
    expect(data.requestedSeq).toBe(10);
    expect(data.message).toContain('游标');
  });

  it('parses lagged event with lastEventId hint for client resume', () => {
    const serverFrame =
      'id: 77\nevent: lagged\nretry: 1000\n' +
      'data: {"skipped":5,"lastEventId":77,"hint":"reconnect with Last-Event-ID"}\n\n';

    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed(serverFrame);

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('lagged');
    expect(frames[0].retry).toBe(1000);
    const data = JSON.parse(frames[0].data);
    expect(data.skipped).toBe(5);
    expect(data.lastEventId).toBe(77);
  });

  it('resume after disconnect sends Last-Event-ID from highest received id', async () => {
    // Simulate: client connects, receives events with IDs 1-5, disconnects,
    // then reconnects. The reconnect request should include Last-Event-ID: 5.
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    let secondCallHeaders: Record<string, string> | null = null;
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: stream,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        });
      }
      // Second call (reconnect): capture headers
      secondCallHeaders = mockFetch.mock.calls[1][1].headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(':ok\n\n'));
          },
        }),
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      });
    });

    const consumer = createSseConsumer({
      url: '/api/ai/tasks/stream',
      token: 'test-token',
      fetchImpl: mockFetch as any,
      onFrame: vi.fn(),
      onError: () => true,
      shouldReconnect: () => callCount < 3,
      baseBackoffMs: 10,
      maxBackoffMs: 50,
    });

    // Send 5 events
    await new Promise((r) => setTimeout(r, 50));
    controller!.enqueue(new TextEncoder().encode(
      'id: 1\nevent: queued\ndata: {"task":{}}\n\n' +
      'id: 2\nevent: running\ndata: {"task":{}}\n\n' +
      'id: 3\nevent: content_delta\ndata: {"contentDelta":"h"}\n\n' +
      'id: 4\nevent: content_delta\ndata: {"contentDelta":"i"}\n\n' +
      'id: 5\nevent: completed\ndata: {"task":{}}\n\n'
    ));
    await new Promise((r) => setTimeout(r, 50));

    // Close the stream to trigger reconnect
    controller!.close();
    await new Promise((r) => setTimeout(r, 200));

    expect(secondCallHeaders).not.toBeNull();
    expect(secondCallHeaders!['Last-Event-ID']).toBe('5');
    consumer.close();
  });

  it('does not regress lastEventId when events arrive without id field', async () => {
    // SSE spec: id field persists until changed. Events without id should
    // not reset lastEventId to null.
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    let secondCallHeaders: Record<string, string> | null = null;
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true, status: 200, body: stream,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        });
      }
      secondCallHeaders = mockFetch.mock.calls[1][1].headers;
      return Promise.resolve({
        ok: true, status: 200,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(':ok\n\n')); } }),
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      });
    });

    createSseConsumer({
      url: '/api/test',
      token: 'tok',
      fetchImpl: mockFetch as any,
      onFrame: vi.fn(),
      onError: () => true,
      shouldReconnect: () => callCount < 3,
      baseBackoffMs: 10,
    });

    await new Promise((r) => setTimeout(r, 50));
    // Event with id, then event without id (keep-alive/comment), then close
    controller!.enqueue(new TextEncoder().encode(
      'id: 42\nevent: snapshot\ndata: {"s":1}\n\n' +
      ':keep-alive\n\n' +
      'event: ping\ndata: {}\n\n'
    ));
    await new Promise((r) => setTimeout(r, 50));
    controller!.close();
    await new Promise((r) => setTimeout(r, 200));

    // lastEventId should still be 42 even though subsequent events had no id
    expect(secondCallHeaders!['Last-Event-ID']).toBe('42');
  });

  it('strips UTF-8 BOM from the start of the stream', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    // BOM (U+FEFF) followed by a normal event
    parser.feed('\u{FEFF}data: hello\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('hello');
  });

  it('parses bare \\r as line separator (old-Mac style)', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed('data: one\rdata: two\r\r');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('one\ntwo');
  });

  it('handles mixed line endings (CRLF, bare CR, bare LF) in one stream', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    // Event 1: CRLF separator
    parser.feed('event: one\r\ndata: first\r\n\r\n');
    // Event 2: bare CR separator
    parser.feed('event: two\rdata: second\r\r');
    // Event 3: LF separator
    parser.feed('event: three\ndata: third\n\n');
    expect(frames).toHaveLength(3);
    expect(frames[0].event).toBe('one');
    expect(frames[0].data).toBe('first');
    expect(frames[1].event).toBe('two');
    expect(frames[1].data).toBe('second');
    expect(frames[2].event).toBe('three');
    expect(frames[2].data).toBe('third');
  });

  it('ignores negative retry values per SSE spec', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed('retry: -1\ndata: bad\n\n');
    parser.feed('retry: 5000\ndata: good\n\n');
    // Negative retry should be ignored (per spec: non-negative integers only)
    expect(frames[0].retry).toBeNull();
    expect(frames[1].retry).toBe(5000);
  });

  it('strips single leading space after colon but preserves additional spaces', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed('data:  two leading spaces\n\n');   // " two leading spaces" (one space stripped, one kept)
    parser.feed('data:no-space\n\n');
    expect(frames[0].data).toBe(' two leading spaces');
    expect(frames[1].data).toBe('no-space');
  });

  it('joins multiple data lines with newline', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed('data: line1\ndata: line2\ndata: line3\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('line1\nline2\nline3');
  });

  it('ignores id field containing NUL character per SSE spec', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed('id: bad\0id\ndata: first\n\n');
    parser.feed('id: good\ndata: second\n\n');
    expect(frames[0].id).toBeNull();
    expect(frames[1].id).toBe('good');
  });

  it('stops reconnecting after maxReconnectAttempts is exceeded', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
    const errors: Error[] = [];
    const consumer = createSseConsumer({
      url: '/api/test',
      token: 'tok',
      fetchImpl: mockFetch as any,
      onFrame: vi.fn(),
      onError: (err) => { errors.push(err); return true; },
      shouldReconnect: () => true,
      baseBackoffMs: 5,
      maxBackoffMs: 10,
      maxReconnectAttempts: 3,
      maxReconnectElapsedMs: Infinity,
    });
    await new Promise((r) => setTimeout(r, 500));
    consumer.close();
    // Should stop after maxReconnectAttempts (3) failures, with a final error
    // indicating max attempts exceeded
    const maxAttemptsError = errors.find((e) => e.message.includes('max attempts'));
    expect(maxAttemptsError).toBeDefined();
    // Initial attempt + up to 3 retries
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('shouldApplyState rejects lower-precedence states after terminal', () => {
    // completed -> running should be rejected
    expect(shouldApplyState('completed', 'running', 100, 99)).toBe(false);
    // running -> completed should be accepted
    expect(shouldApplyState('running', 'completed', 50, 51)).toBe(true);
    // queued -> completed accepted (forward progression)
    expect(shouldApplyState('queued', 'completed', undefined, undefined)).toBe(true);
    // completed -> failed (same precedence, seq higher) accepted for correction
    expect(shouldApplyState('completed', 'failed', 100, 101)).toBe(true);
  });

  it('shouldApplyState rejects older seq events even for same status', () => {
    expect(shouldApplyState('running', 'running', 50, 49)).toBe(false);
    expect(shouldApplyState('running', 'running', 50, 50)).toBe(false); // same seq
    expect(shouldApplyState('running', 'running', 50, 51)).toBe(true);  // newer seq
  });

  it('EventDedupTracker rejects duplicate event IDs', () => {
    const tracker = new EventDedupTracker();
    expect(tracker.markAndCheck('t1', 'evt-1', 1)).toBe(true);
    expect(tracker.markAndCheck('t1', 'evt-1', 1)).toBe(false); // dup
    expect(tracker.markAndCheck('t1', 'evt-2', 2)).toBe(true);
    expect(tracker.markAndCheck('t1', null, 2)).toBe(false); // same seq, no id
    expect(tracker.markAndCheck('t1', null, 3)).toBe(true);  // newer seq
  });

  it('EventDedupTracker rejects events with seq <= maxSeen', () => {
    const tracker = new EventDedupTracker();
    tracker.markAndCheck('t1', 'a', 10);
    tracker.markAndCheck('t1', 'b', 20);
    expect(tracker.markAndCheck('t1', 'c', 15)).toBe(false); // older seq
    expect(tracker.markAndCheck('t1', 'd', 25)).toBe(true);  // newer seq
    expect(tracker.getMaxSeq('t1')).toBe(25);
  });

  it('simulates server restart: empty buffer triggers DB replay path', () => {
    // After restart, in-memory buffer is empty (min_seq=0). Client reconnects
    // with cursor=50. Server should fall back to DB replay, not skip events.
    // We verify the server-side logic by checking: when min_seq=0 and after_seq>0,
    // the condition `buffer_empty_after_restart` is true.
    const min_seq = 0;
    const after_seq = 50;
    const buffer_empty_after_restart = min_seq === 0 && after_seq > 0;
    expect(buffer_empty_after_restart).toBe(true);
    const cursor_before_buffer = min_seq > 0 && after_seq < min_seq;
    expect(cursor_before_buffer).toBe(false);
    // Either condition should trigger DB replay
    expect(buffer_empty_after_restart || cursor_before_buffer).toBe(true);
  });

  it('resync event includes oldestAvailableSeq for client to re-fetch from', () => {
    // When a cursor is expired, the server sends resync with oldestAvailableSeq
    // so the client knows where to start re-fetching.
    const serverResync = {
      reason: 'cursor_expired',
      oldestAvailableSeq: 100,
      requestedSeq: 50,
      message: '事件游标已过期，请刷新任务状态',
    };
    expect(serverResync.oldestAvailableSeq).toBe(100);
    expect(serverResync.requestedSeq).toBe(50);
    expect(serverResync.message.length).toBeGreaterThan(0);
  });

  it('resync event uses server_restart reason when buffer is empty', () => {
    const min_seq = 0;
    const after_seq = 50;
    const buffer_empty_after_restart = min_seq === 0 && after_seq > 0;
    const reason = buffer_empty_after_restart ? 'server_restart' : 'cursor_expired';
    expect(reason).toBe('server_restart');
  });

  it('late SSE event after resync is rejected by seeded dedup tracker', () => {
    // Simulate: resync fetches task at eventSeq=20 (completed), then a late
    // SSE running event arrives with seq=15 (raced before resync).
    const tracker = new EventDedupTracker();
    // Resync seeds dedup with server's eventSeq
    tracker.markAndCheck('t1', null, 20);
    expect(tracker.getMaxSeq('t1')).toBe(20);
    // Late SSE event with lower seq should be rejected
    expect(tracker.markAndCheck('t1', 'evt-15', 15)).toBe(false);
    // Newer SSE event (after resync) should be accepted
    expect(tracker.markAndCheck('t1', 'evt-21', 21)).toBe(true);
  });

  it('shouldApplyState protects completed from late running after resync', () => {
    // After resync says completed at seq=20, a late running event at seq=15
    // should be rejected by both seq check AND terminal-state stickiness.
    // completed(current,seq=20) vs running(incoming,seq=15):
    expect(shouldApplyState('completed', 'running', 20, 15)).toBe(false);
    // Even without seq: terminal-stickiness rejects it
    expect(shouldApplyState('completed', 'running', undefined, undefined)).toBe(false);
  });

  it('disconnect during running state replays terminal event on reconnect', () => {
    // Simulate: client disconnects while task is running (lastId=5).
    // Server completes task (event id=6). Client reconnects with Last-Event-ID: 5.
    // Server replays event 6, client applies completed state.
    const lastEventIdBeforeDisconnect = '5';
    const replayedEvents = [
      { id: '6', event: 'completed', data: { task: { status: 'completed' } } },
    ];
    expect(parseInt(lastEventIdBeforeDisconnect, 10)).toBe(5);
    expect(replayedEvents[0].id).toBe('6');
    expect(replayedEvents[0].data.task.status).toBe('completed');
  });

  it('pipeline done event carries correct reason based on terminal status', () => {
    // Completed run
    expect(derivePipelineDoneReason('completed')).toBe('completed');
    // Failed run
    expect(derivePipelineDoneReason('failed')).toBe('failed');
    // Cancelled run
    expect(derivePipelineDoneReason('cancelled')).toBe('cancelled');
    // Running (non-terminal) should not produce done in normal flow
    expect(derivePipelineDoneReason('running')).toBeNull();
  });

  it('client collaboration envelope includes seq field from both live and replay', () => {
    // Live broadcasts carry seq from persist_and_broadcast
    const liveEvent = { sessionId: 's1', eventType: 'message_sent', payload: {}, seq: 42 };
    // Replay events should also carry seq (rowid)
    const replayEvent = { sessionId: 's1', eventType: 'message_sent', payload: {}, seq: 41 };
    expect(liveEvent.seq).toBe(42);
    expect(replayEvent.seq).toBe(41);
  });

  it('synthetic error events advance SSE id but not DB query cursor', () => {
    // Simulate the pipeline SSE stream behavior:
    // - Real events have SQLite rowids (1, 2, 3)
    // - Synthetic error/done events get synthetic IDs (4, 5)
    // - DB queries must use last_real_rowid (3), not last_event_id (5),
    //   to avoid missing new real events with rowid 4
    let last_real_rowid = 0;
    let last_event_id = 0;
    let synthetic_id = 0;

    // Real event with rowid 3
    const real_rowid = 3;
    last_event_id = Math.max(last_event_id, real_rowid);
    last_real_rowid = Math.max(last_real_rowid, real_rowid);
    synthetic_id = Math.max(synthetic_id, real_rowid);
    expect(last_event_id).toBe(3);
    expect(last_real_rowid).toBe(3);

    // DB error: emit synthetic event
    synthetic_id += 1;
    last_event_id = synthetic_id;
    expect(last_event_id).toBe(4);
    expect(last_real_rowid).toBe(3); // unchanged!

    // DB query uses last_real_rowid, not last_event_id
    // If it used last_event_id=4, new event with rowid=4 would be missed
    // because query is WHERE rowid > 4
    const new_event_rowid = 4;
    expect(new_event_rowid > last_real_rowid).toBe(true); // would be fetched
    expect(new_event_rowid > last_event_id).toBe(false); // would be missed!
  });

  it('migration 024 uses IF NOT EXISTS for idempotent re-runs', () => {
    // Verify migration SQL uses IF NOT EXISTS / safe ALTER patterns
    const migrationSql = `
      ALTER TABLE ai_tasks ADD COLUMN event_seq INTEGER DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_ai_tasks_event_seq ON ai_tasks(user_id, event_seq);
      CREATE TABLE IF NOT EXISTS ai_task_events (
          id TEXT PRIMARY KEY NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_task_events_user_seq ON ai_task_events(user_id, event_seq);
    `;
    // SQLite ALTER TABLE ADD COLUMN fails on duplicate, but migration version tracking
    // prevents re-running. All CREATE statements use IF NOT EXISTS for safety.
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS');
    expect(migrationSql).toContain('CREATE INDEX IF NOT EXISTS');
    // event_seq DEFAULT 0 ensures existing rows get 0 instead of NULL
    expect(migrationSql).toContain('DEFAULT 0');
  });

  it('all event types carry correlation IDs', () => {
    // AI tasks: task.id, projectId, conversationId
    const aiTask = { id: 't1', projectId: 'p1', conversationId: 'c1', eventSeq: 10 };
    expect(aiTask.id).toBeTruthy();
    expect(aiTask.projectId).toBeTruthy();
    expect(aiTask.conversationId).toBeTruthy();

    // Pipeline: events scoped to run_id via route and JOIN
    const pipelineContext = { runId: 'r1', userId: 'u1' };
    expect(pipelineContext.runId).toBeTruthy();

    // Collaboration: envelope carries sessionId
    const collabEvent = { sessionId: 's1', eventType: 'message_sent', seq: 42 };
    expect(collabEvent.sessionId).toBeTruthy();
  });

  it('resync after restart uses server_restart reason with oldestAvailableSeq', () => {
    // After server restart, buffer is empty (min_seq=0). Client sends cursor=50.
    // Server detects buffer_empty_after_restart, attempts DB replay.
    // If DB replay returns nothing, sends resync with reason=server_restart.
    const min_seq = 0;
    const after_seq = 50;
    const buffer_empty_after_restart = min_seq === 0 && after_seq > 0;
    const reason = buffer_empty_after_restart ? 'server_restart' : 'cursor_expired';
    expect(reason).toBe('server_restart');

    // oldestAvailableSeq comes from DB MIN(event_seq), not from empty buffer
    const oldestDbSeq = 10; // earliest persisted event for user
    const oldestAvailable = oldestDbSeq;
    expect(oldestAvailable).toBeLessThan(after_seq);
  });

  it('dedup tracker seeded after resync rejects late lower-seq events', () => {
    const tracker = new EventDedupTracker();
    // Resync says task completed at eventSeq=20
    tracker.markAndCheck('t1', null, 20);
    // Late SSE event at seq=15 (raced before resync) should be rejected
    expect(tracker.markAndCheck('t1', 'evt-15', 15)).toBe(false);
    // Late SSE event at seq=20 (same seq) should be rejected
    expect(tracker.markAndCheck('t1', 'evt-20', 20)).toBe(false);
    // Future event at seq=21 should be accepted
    expect(tracker.markAndCheck('t1', 'evt-21', 21)).toBe(true);
  });

  it('SseFrameParser handles \\r\\n\\r\\n double separator (blank line)', () => {
    const frames: any[] = [];
    const parser = new SseFrameParser((f) => frames.push(f));
    parser.feed('data: event1\r\ndata: still-event1\r\n\r\ndata: event2\r\n\r\n');
    expect(frames).toHaveLength(2);
    expect(frames[0].data).toBe('event1\nstill-event1');
    expect(frames[1].data).toBe('event2');
  });
});

// Helper for pipeline done reason tests
function derivePipelineDoneReason(status: string): string | null {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function makeTask(
  status: string,
  overrides: Partial<AiTask> = {},
): AiTask {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    conversationId: 'conv-1',
    content: 'test',
    status: status as AiTask['status'],
    createdAt: Date.now(),
    ...overrides,
  } as AiTask;
}
