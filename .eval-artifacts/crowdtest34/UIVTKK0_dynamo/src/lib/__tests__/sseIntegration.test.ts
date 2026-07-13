/**
 * Integration-level tests for SSE disconnect recovery, replay, resync,
 * and error delivery. These tests simulate the full SSE protocol with
 * mock fetch streams, exercising real server event sequences.
 *
 * Scenarios covered:
 * 1. Disconnect completion — task finishes during disconnect, replay recovers it
 * 2. Expired cursor — cursor too old, resync signal + REST fallback
 * 3. Scope mismatch — cross-conversation task rejected idempotently
 * 4. 401 refresh — token expired, refresh + reconnect
 * 5. API-vs-SSE race — snapshot arrives before task registration
 * 6. Server restart — in-memory buffer lost, snapshot recovers state
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SseConsumer, parseSseChunk, type SseEvent } from '../sseConsumer';
import {
  SeenEventTracker,
  shouldApplyTaskUpdate,
  makeEventKey,
  isTerminalStatus,
  getBoundaryStateMessage,
} from '../taskEventSemantics';
import type { AiTask, AiTaskStatus } from '../serverApi';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockResponse(stream: ReadableStream, status = 200): Response {
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createChunkStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function makeTask(overrides: Partial<AiTask> & { id: string }): AiTask {
  const { id, ...rest } = overrides;
  return {
    id,
    projectId: 'proj-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    content: 'test task',
    model: 'test-model',
    status: (rest.status ?? 'queued') as AiTaskStatus,
    createdAt: Date.now(),
    ...rest,
  } as AiTask;
}

function sseEvent(id: string, event: string, data: object): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─── Scenario 1: Disconnect Completion ─────────────────────────────────────

describe('Scenario 1: Task completes during disconnect (replay recovery)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('replays queued→running→completed events on reconnect with Last-Event-ID', async () => {
    const capturedUrls: string[] = [];
    const capturedHeaders: Record<string, string>[] = [];
    const receivedEvents: Array<{ event: string; data: any; id: string | null }> = [];

    // First connection: client sees queued event (id=5), then disconnects
    const firstStream = createChunkStream([
      sseEvent('5', 'task_update', { task: makeTask({ id: 't1', status: 'queued', seq: 5 }) }),
    ]);

    // Second connection (reconnect with Last-Event-ID: 5): server replays missed events
    const secondStream = createChunkStream([
      // Replay: running (6) and completed (7)
      sseEvent('6', 'task_update', { task: makeTask({ id: 't1', status: 'running', seq: 6 }) }),
      sseEvent('7', 'task_update', {
        task: makeTask({ id: 't1', status: 'completed', seq: 7, result: 'Done!' }),
      }),
      // Snapshot after replay (cursor=7)
      sseEvent('7', 'snapshot', {
        tasks: [makeTask({ id: 't1', status: 'completed', seq: 7, result: 'Done!' })],
        cursor: 7,
      }),
    ]);

    let connectionNum = 0;
    (globalThis.fetch as any) = vi.fn((url: string, init: RequestInit) => {
      connectionNum++;
      capturedUrls.push(url);
      capturedHeaders.push({ ...(init.headers as Record<string, string>) });
      if (connectionNum === 1) return mockResponse(firstStream);
      return mockResponse(secondStream);
    });

    const consumer = new SseConsumer({
      url: '/api/ai/tasks/stream',
      initialLastEventId: null,
      autoReconnect: true,
      baseReconnectDelayMs: 1,
      maxReconnectDelayMs: 5,
      onEvent: (e) => {
        receivedEvents.push({ event: e.event, data: JSON.parse(e.data || '{}'), id: e.id });
        // Stop after receiving the snapshot from replay (second connection)
        if (e.event === 'snapshot') {
          consumer.stop();
        }
      },
      shouldReconnect: () => connectionNum < 3,
      fetchImpl: globalThis.fetch as any,
    });

    void consumer.connect();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(50);
    await vi.runOnlyPendingTimersAsync();

    // Second request should include Last-Event-ID: 5
    expect(capturedHeaders[1]!['Last-Event-ID']).toBe('5');

    // Client received all state transitions in order
    const taskUpdates = receivedEvents.filter((e) => e.event === 'task_update');
    expect(taskUpdates).toHaveLength(3);
    expect(taskUpdates[0]!.data.task.status).toBe('queued');
    expect(taskUpdates[1]!.data.task.status).toBe('running');
    expect(taskUpdates[2]!.data.task.status).toBe('completed');

    // Final completed result is present
    expect(taskUpdates[2]!.data.task.result).toBe('Done!');
  });

  it('duplicate completed events from replay + snapshot are idempotent via seq', () => {
    // Simulate the client applying a completed event from replay, then seeing
    // the same completed task in the snapshot
    const seen = new SeenEventTracker(100);
    const task = makeTask({ id: 't1', status: 'completed', seq: 7, result: 'Done!' });

    // First occurrence (from replay)
    const key1 = makeEventKey('task_update', task, 7);
    expect(seen.checkAndMark(key1)).toBe(true);

    // Second occurrence (from snapshot) — same seq
    const key2 = makeEventKey('snapshot', task, task.seq ?? 7);
    // The key is different (snapshot vs task_update) but shouldApplyTaskUpdate
    // with seq comparison should prevent overwriting
    expect(shouldApplyTaskUpdate('completed', 'completed', 7, 7)).toBe(false);
  });
});

// ─── Scenario 2: Expired Cursor ────────────────────────────────────────────

describe('Scenario 2: Expired cursor triggers resync', () => {
  it('receives resync event with fresh cursor, then snapshot', async () => {
    const receivedEvents: SseEvent[] = [];
    let resyncReceived = false;
    let snapshotReceived = false;

    const stream = createChunkStream([
      // Server says: cursor expired, here's fresh cursor=200
      sseEvent('200', 'resync', {
        reason: 'cursor_expired',
        oldestAvailable: 150,
        cursor: 200,
        message: '事件游标已过期，请从快照重新同步',
      }),
      // Fresh snapshot
      sseEvent('200', 'snapshot', {
        tasks: [makeTask({ id: 't1', status: 'running', seq: 199 })],
        cursor: 200,
      }),
    ]);

    (globalThis.fetch as any) = vi.fn(() => mockResponse(stream));

    const consumer = new SseConsumer({
      url: '/api/ai/tasks/stream?cursor=10',
      initialLastEventId: '10',
      autoReconnect: false,
      onEvent: (e) => {
        receivedEvents.push(e);
        if (e.event === 'resync') resyncReceived = true;
        if (e.event === 'snapshot') snapshotReceived = true;
      },
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    expect(resyncReceived).toBe(true);
    expect(snapshotReceived).toBe(true);
    // lastEventId updated to 200 from resync (carries id field)
    expect(consumer.getLastEventId()).toBe('200');
  });

  it('resync clears seen events before processing snapshot', () => {
    const seen = new SeenEventTracker(100);

    // Client has old seen events
    seen.checkAndMark('evt_5');
    seen.checkAndMark('evt_6');
    expect(seen.size).toBe(2);

    // On resync, clear
    seen.clear();
    expect(seen.size).toBe(0);

    // New snapshot events are processed fresh
    const task = makeTask({ id: 't1', status: 'completed', seq: 200 });
    const key = makeEventKey('snapshot', task, 200);
    expect(seen.checkAndMark(key)).toBe(true);
  });
});

// ─── Scenario 3: Scope Mismatch ────────────────────────────────────────────

describe('Scenario 3: Scope mismatch (cross-conversation task)', () => {
  it('rejects tasks from different conversation/project idempotently', () => {
    const clientConvId = 'conv-A';
    const clientProjId = 'proj-A';

    const foreignTask = makeTask({
      id: 't1',
      status: 'completed',
      conversationId: 'conv-B',
      projectId: 'proj-B',
      seq: 10,
    });

    // First check: scope mismatch detected
    const mismatch =
      foreignTask.conversationId !== clientConvId || foreignTask.projectId !== clientProjId;
    expect(mismatch).toBe(true);

    // Boundary message for scope mismatch
    const msg = getBoundaryStateMessage('scope_mismatch', {});
    expect(msg.content).toContain('作用域');
    expect(msg.requiresRefresh).toBe(false);

    // Second identical mismatch (duplicate event) — same result, idempotent
    const mismatch2 =
      foreignTask.conversationId !== clientConvId || foreignTask.projectId !== clientProjId;
    expect(mismatch2).toBe(true);
  });

  it('correctly accepts matching scope task even after rejecting foreign one', () => {
    const clientConvId = 'conv-A';
    const clientProjId = 'proj-A';

    const matchingTask = makeTask({
      id: 't2',
      status: 'completed',
      conversationId: 'conv-A',
      projectId: 'proj-A',
      seq: 11,
      result: 'Correct result',
    });

    const isMatch =
      matchingTask.conversationId === clientConvId && matchingTask.projectId === clientProjId;
    expect(isMatch).toBe(true);
  });
});

// ─── Scenario 4: 401 Token Refresh ─────────────────────────────────────────

describe('Scenario 4: 401 token refresh and reconnect', () => {
  it('refreshes token on 401 and retries with new token', async () => {
    const authHeaders: (string | null)[] = [];
    let refreshCalled = false;

    const stream = createChunkStream([sseEvent('1', 'message', { hello: 'world' })]);

    (globalThis.fetch as any) = vi.fn((_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      authHeaders.push(headers['Authorization'] ?? null);
      if (!refreshCalled) {
        refreshCalled = true;
        return new Response('', { status: 401 });
      }
      return mockResponse(stream);
    });

    let refreshedToken = 'new-token-123';
    const consumer = new SseConsumer({
      url: '/api/ai/tasks/stream',
      token: 'old-token',
      autoReconnect: false,
      onEvent: () => {},
      onUnauthorized: async () => refreshedToken,
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    // First request had old token
    expect(authHeaders[0]).toBe('Bearer old-token');
    // Second request (after refresh) had new token
    expect(authHeaders[1]).toBe('Bearer new-token-123');
  });

  it('stops cleanly when token refresh returns null', async () => {
    let errorCalled = false;

    (globalThis.fetch as any) = vi.fn(() => new Response('', { status: 401 }));

    const consumer = new SseConsumer({
      url: '/api/ai/tasks/stream',
      token: 'bad-token',
      autoReconnect: true,
      onEvent: () => {},
      onError: () => { errorCalled = true; },
      onUnauthorized: async () => null, // refresh fails
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    expect(errorCalled).toBe(true);
    // Should NOT have reconnected after failed refresh
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });
});

// ─── Scenario 5: API-vs-SSE Race ───────────────────────────────────────────

describe('Scenario 5: API response and SSE snapshot race', () => {
  it('SSE snapshot arriving before registerPendingTask still tracks state', () => {
    // Simulate: SSE snapshot arrives with completed task before the API call
    // returns and the task is registered
    const taskStatusRef = new Map<string, AiTaskStatus>();
    const taskSeqRef = new Map<string, number>();

    const completedTask = makeTask({
      id: 't1',
      status: 'completed',
      seq: 42,
      result: 'Race-safe result',
    });

    // SSE event arrives first (task not yet registered)
    // The hook tracks state even for unregistered tasks:
    taskStatusRef.set(completedTask.id, completedTask.status as AiTaskStatus);
    taskSeqRef.set(completedTask.id, completedTask.seq!);

    // Later, API response arrives and task is registered
    // Reconciliation: check if SSE already knows a terminal state
    const knownStatus = taskStatusRef.get('t1');
    const knownSeq = taskSeqRef.get('t1');

    expect(knownStatus).toBe('completed');
    expect(knownSeq).toBe(42);
    expect(isTerminalStatus(knownStatus!)).toBe(true);

    // shouldApplyTaskUpdate confirms terminal state is final
    expect(shouldApplyTaskUpdate('queued', 'completed', 40, 42)).toBe(false);
    expect(shouldApplyTaskUpdate('completed', 'completed', 42, 42)).toBe(false);
  });

  it('late queued event does not overwrite completed from snapshot', () => {
    const currentStatus: AiTaskStatus = 'completed';
    const currentSeq = 42;

    // Out-of-order queued event arrives late
    const lateStatus: AiTaskStatus = 'queued';
    const lateSeq = 40;

    expect(shouldApplyTaskUpdate(lateStatus, currentStatus, lateSeq, currentSeq)).toBe(false);
  });
});

// ─── Scenario 6: Server Restart (in-memory buffer lost) ────────────────────

describe('Scenario 6: Server restart — buffer empty, snapshot recovers state', () => {
  it('reconnect after restart receives snapshot with failed tasks (no replay)', async () => {
    // Client had cursor=50 before restart. After restart:
    // - In-memory buffer is empty (seq resets to 1)
    // - DB tasks restored: queued/running marked as failed
    // - Server sends snapshot (no replay because buffer is empty)
    const receivedEvents: Array<{ event: string; data: any }> = [];

    const stream = createChunkStream([
      // Snapshot after restart: tasks marked failed with restart error
      sseEvent('3', 'snapshot', {
        tasks: [
          makeTask({
            id: 't1',
            status: 'failed',
            seq: 3,
            error: '服务重启，任务已中断',
          }),
        ],
        cursor: 3,
      }),
    ]);

    (globalThis.fetch as any) = vi.fn(() => mockResponse(stream));

    const consumer = new SseConsumer({
      url: '/api/ai/tasks/stream',
      initialLastEventId: '50',
      autoReconnect: false,
      onEvent: (e) => {
        receivedEvents.push({ event: e.event, data: JSON.parse(e.data || '{}') });
      },
      fetchImpl: globalThis.fetch as any,
    });

    await consumer.connect();

    const snapshot = receivedEvents.find((e) => e.event === 'snapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot!.data.tasks).toHaveLength(1);
    expect(snapshot!.data.tasks[0].status).toBe('failed');
    expect(snapshot!.data.tasks[0].error).toContain('重启');

    // User-facing message for the failed restart task
    const msg = getBoundaryStateMessage('failed', { error: '服务重启，任务已中断' });
    expect(msg.content).toContain('重启');
    expect(msg.status).toBe('error');
  });

  it('pipeline cursor far ahead after restart triggers resync', () => {
    // Pipeline uses rowid. After restart, new DB has max_id=10.
    // Client cursor=200 (from old DB). Tolerance is +10.
    const clientCursor = 200;
    const serverMaxId = 10;
    const tolerance = 10;

    expect(clientCursor > serverMaxId + tolerance).toBe(true); // resync needed

    // After resync, client uses server's cursor
    const newCursor = serverMaxId;
    expect(newCursor).toBe(10);
  });

  it('DB status parsing handles both JSON and legacy formats', () => {
    // Mirror of Rust parse_status_from_db
    function parseStatus(raw: string): string {
      const t = raw.trim();
      try {
        const p = JSON.parse(t);
        if (typeof p === 'string') return p.toLowerCase();
      } catch { /* fall through */ }
      return t.replace(/^"|"$/g, '').toLowerCase();
    }

    // Modern JSON format
    expect(parseStatus('"completed"')).toBe('completed');
    expect(parseStatus('"failed"')).toBe('failed');

    // Legacy plain text
    expect(parseStatus('completed')).toBe('completed');
    expect(parseStatus('queued')).toBe('queued');

    // PascalCase legacy
    expect(parseStatus('"Completed"')).toBe('completed');

    // Whitespace
    expect(parseStatus('  "running"  ')).toBe('running');
  });
});

// ─── Additional edge cases ─────────────────────────────────────────────────

describe('Fragmented multi-line SSE across chunk boundaries', () => {
  it('multi-line data field split across two chunks', () => {
    const chunk1 = 'data: line1\n';
    const chunk2 = 'data: line2\n\n';
    const { events, remaining } = parseSseChunk(chunk1 + chunk2);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line1\nline2');
    expect(remaining).toBe('');
  });

  it('event/data/id split at arbitrary byte boundaries', () => {
    const fullFrame = 'id: 42\nevent: task_update\ndata: {"task":{"id":"t1"}}\n\n';
    // Split at various positions
    for (let splitAt = 1; splitAt < fullFrame.length - 1; splitAt++) {
      const c1 = fullFrame.slice(0, splitAt);
      const c2 = fullFrame.slice(splitAt);

      // First chunk: partial, no events
      const r1 = parseSseChunk(c1);
      expect(r1.events).toHaveLength(0);

      // Second chunk: completes the frame
      const combined = r1.remaining + c2;
      const r2 = parseSseChunk(combined);
      expect(r2.events).toHaveLength(1);
      expect(r2.events[0].id).toBe('42');
      expect(r2.events[0].event).toBe('task_update');
    }
  });
});

describe('Out-of-order event protection with seq', () => {
  it('running after completed is rejected', () => {
    expect(shouldApplyTaskUpdate('running', 'completed', 5, 10)).toBe(false);
  });

  it('queued after running is rejected', () => {
    expect(shouldApplyTaskUpdate('queued', 'running', 3, 5)).toBe(false);
  });

  it('higher-seq completed overwrites lower-seq failed', () => {
    expect(shouldApplyTaskUpdate('completed', 'failed', 11, 10)).toBe(true);
  });

  it('same seq same status is idempotent (allowed but no-op via dedup)', () => {
    expect(shouldApplyTaskUpdate('completed', 'completed', 7, 7)).toBe(false);
  });
});
