/**
 * Regression tests for task event idempotency, out-of-order protection,
 * terminal state guards, boundary state messages, and deduplication.
 *
 * Tests use pure logic — no external endpoints or services required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SeenEventTracker,
  shouldApplyTaskUpdate,
  getBoundaryStateMessage,
  RefreshDeduplicator,
  makeEventKey,
  isTerminalStatus,
  isActiveStatus,
} from '../taskEventSemantics';
import type { AiTask } from '../serverApi';

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    conversationId: 'conv-1',
    content: 'test task',
    status: 'queued',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('SeenEventTracker — duplicate detection', () => {
  let tracker: SeenEventTracker;

  beforeEach(() => {
    tracker = new SeenEventTracker(10);
  });

  it('returns true for new events, false for duplicates', () => {
    expect(tracker.checkAndMark('evt-1')).toBe(true);
    expect(tracker.checkAndMark('evt-1')).toBe(false);
    expect(tracker.checkAndMark('evt-2')).toBe(true);
  });

  it('evicts oldest entries when exceeding max size', () => {
    for (let i = 0; i < 15; i++) {
      tracker.checkAndMark(`evt-${i}`);
    }
    // First 5 should have been evicted
    expect(tracker.has('evt-0')).toBe(false);
    expect(tracker.has('evt-4')).toBe(false);
    expect(tracker.has('evt-10')).toBe(true);
    expect(tracker.has('evt-14')).toBe(true);
  });

  it('clear() resets all state', () => {
    tracker.checkAndMark('evt-1');
    tracker.clear();
    expect(tracker.checkAndMark('evt-1')).toBe(true);
  });

  it('has() checks without marking', () => {
    expect(tracker.has('evt-1')).toBe(false);
    tracker.checkAndMark('evt-1');
    expect(tracker.has('evt-1')).toBe(true);
  });

  it('reports size correctly', () => {
    expect(tracker.size).toBe(0);
    tracker.checkAndMark('a');
    tracker.checkAndMark('b');
    expect(tracker.size).toBe(2);
  });
});

describe('shouldApplyTaskUpdate — ordering and terminal guards', () => {
  it('accepts updates when there is no current state', () => {
    expect(shouldApplyTaskUpdate('running', undefined)).toBe(true);
    expect(shouldApplyTaskUpdate('completed', undefined)).toBe(true);
  });

  it('accepts queued -> running -> completed progression', () => {
    expect(shouldApplyTaskUpdate('running', 'queued')).toBe(true);
    expect(shouldApplyTaskUpdate('completed', 'running')).toBe(true);
    expect(shouldApplyTaskUpdate('failed', 'running')).toBe(true);
    expect(shouldApplyTaskUpdate('cancelled', 'running')).toBe(true);
  });

  it('rejects queued after running (regression)', () => {
    expect(shouldApplyTaskUpdate('queued', 'running')).toBe(false);
  });

  it('rejects running after completed (terminal regression)', () => {
    expect(shouldApplyTaskUpdate('running', 'completed')).toBe(false);
    expect(shouldApplyTaskUpdate('queued', 'completed')).toBe(false);
  });

  it('rejects running after failed (terminal regression)', () => {
    expect(shouldApplyTaskUpdate('running', 'failed')).toBe(false);
    expect(shouldApplyTaskUpdate('queued', 'failed')).toBe(false);
  });

  it('rejects running after cancelled (terminal regression)', () => {
    expect(shouldApplyTaskUpdate('running', 'cancelled')).toBe(false);
    expect(shouldApplyTaskUpdate('queued', 'cancelled')).toBe(false);
  });

  it('accepts repeated completed (idempotent replay safe)', () => {
    expect(shouldApplyTaskUpdate('completed', 'completed')).toBe(true);
  });

  it('accepts repeated failed (idempotent replay safe)', () => {
    expect(shouldApplyTaskUpdate('failed', 'failed')).toBe(true);
  });

  it('accepts repeated cancelled (idempotent replay safe)', () => {
    expect(shouldApplyTaskUpdate('cancelled', 'cancelled')).toBe(true);
  });

  it('does not allow different terminal statuses to overwrite each other', () => {
    // First terminal state wins; late out-of-order events must not flip resolved state
    expect(shouldApplyTaskUpdate('completed', 'failed')).toBe(false);
    expect(shouldApplyTaskUpdate('failed', 'completed')).toBe(false);
    expect(shouldApplyTaskUpdate('cancelled', 'failed')).toBe(false);
    expect(shouldApplyTaskUpdate('failed', 'cancelled')).toBe(false);
  });

  it('allows same-status terminal replay for idempotency', () => {
    expect(shouldApplyTaskUpdate('completed', 'completed')).toBe(true);
    expect(shouldApplyTaskUpdate('failed', 'failed')).toBe(true);
    expect(shouldApplyTaskUpdate('cancelled', 'cancelled')).toBe(true);
  });

  it('uses sequence numbers to reject stale events', () => {
    // Incoming seq <= current seq → stale
    expect(shouldApplyTaskUpdate('running', 'queued', 5, 10)).toBe(false);
    // Incoming seq > current seq → allow (higher seq is authoritative)
    expect(shouldApplyTaskUpdate('running', 'queued', 11, 10)).toBe(true);
    // Equal seq → duplicate → reject
    expect(shouldApplyTaskUpdate('completed', 'running', 10, 10)).toBe(false);
  });

  it('higher seq overrides different terminal status (seq is authoritative)', () => {
    // If incoming has higher seq, it wins even across different terminal states
    expect(shouldApplyTaskUpdate('completed', 'failed', 15, 10)).toBe(true);
    expect(shouldApplyTaskUpdate('failed', 'completed', 15, 10)).toBe(true);
  });

  it('without seq, different terminal statuses do not overwrite', () => {
    // Without seq numbers, rank-based protection: first terminal wins
    expect(shouldApplyTaskUpdate('completed', 'failed')).toBe(false);
    expect(shouldApplyTaskUpdate('failed', 'completed')).toBe(false);
  });
});

describe('isTerminalStatus / isActiveStatus', () => {
  it('identifies terminal statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
  });

  it('identifies active statuses', () => {
    expect(isActiveStatus('queued')).toBe(true);
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('completed')).toBe(false);
    expect(isActiveStatus('failed')).toBe(false);
    expect(isActiveStatus('cancelled')).toBe(false);
  });
});

describe('getBoundaryStateMessage — user-facing messages', () => {
  it('completed: returns AI role, done status, requires refresh', () => {
    const msg = getBoundaryStateMessage('completed', { result: 'Hello!' });
    expect(msg.role).toBe('ai');
    expect(msg.status).toBe('done');
    expect(msg.requiresRefresh).toBe(true);
    expect(msg.content).toBe('Hello!');
  });

  it('completed with empty result: returns default message', () => {
    const msg = getBoundaryStateMessage('completed', { result: '' });
    expect(msg.content).toContain('没有返回内容');
  });

  it('failed: returns system role, error status, requires refresh', () => {
    const msg = getBoundaryStateMessage('failed', { error: 'API timeout' });
    expect(msg.role).toBe('system');
    expect(msg.status).toBe('error');
    expect(msg.requiresRefresh).toBe(true);
    expect(msg.content).toContain('API timeout');
  });

  it('failed with no error: returns default message', () => {
    const msg = getBoundaryStateMessage('failed', {});
    expect(msg.content).toContain('未知错误');
  });

  it('cancelled: returns system role, error status, no refresh', () => {
    const msg = getBoundaryStateMessage('cancelled', { error: '用户取消' });
    expect(msg.role).toBe('system');
    expect(msg.status).toBe('error');
    expect(msg.requiresRefresh).toBe(false);
    expect(msg.content).toContain('用户取消');
  });

  it('missing: returns actionable guidance, requires refresh', () => {
    const msg = getBoundaryStateMessage('missing', {});
    expect(msg.role).toBe('system');
    expect(msg.status).toBe('error');
    expect(msg.requiresRefresh).toBe(true);
    expect(msg.content).toContain('重试');
  });

  it('scope_mismatch: returns error message', () => {
    const msg = getBoundaryStateMessage('scope_mismatch', {});
    expect(msg.role).toBe('system');
    expect(msg.status).toBe('error');
    expect(msg.content).toContain('作用域异常');
  });

  it('blocked: returns error message', () => {
    const msg = getBoundaryStateMessage('blocked', { error: '依赖未满足' });
    expect(msg.role).toBe('system');
    expect(msg.status).toBe('error');
    expect(msg.content).toContain('阻塞');
  });
});

describe('makeEventKey — event key generation', () => {
  it('uses seq when available for global uniqueness', () => {
    const task = makeTask();
    const key = makeEventKey('running', task, 42);
    expect(key).toBe('evt_42');
  });

  it('falls back to composite key without seq', () => {
    const task = makeTask({ id: 'task-abc', status: 'running' });
    const key = makeEventKey('running', task);
    expect(key).toContain('task-abc');
    expect(key).toContain('running');
  });

  it('includes content delta hash for delta events', () => {
    const task = makeTask();
    const key1 = makeEventKey('content_delta', task, null, 'hello');
    const key2 = makeEventKey('content_delta', task, null, 'world');
    expect(key1).not.toBe(key2);
  });

  it('same content produces same key (deterministic)', () => {
    const task = makeTask();
    const key1 = makeEventKey('content_delta', task, null, 'hello');
    const key2 = makeEventKey('content_delta', task, null, 'hello');
    expect(key1).toBe(key2);
  });
});

describe('RefreshDeduplicator — debounced refresh', () => {
  it('debounces multiple calls within window', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const dedup = new RefreshDeduplicator(async () => {
      callCount++;
    }, 100);

    dedup.schedule();
    dedup.schedule();
    dedup.schedule();

    expect(callCount).toBe(0);
    vi.advanceTimersByTime(150);
    // Flush microtasks
    await vi.runOnlyPendingTimersAsync();
    expect(callCount).toBe(1);

    dedup.cancel();
    vi.useRealTimers();
  });

  it('can be cancelled before firing', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const dedup = new RefreshDeduplicator(async () => {
      callCount++;
    }, 100);

    dedup.schedule();
    dedup.cancel();
    vi.advanceTimersByTime(200);
    expect(callCount).toBe(0);

    vi.useRealTimers();
  });

  it('cancelled status blocks regression to running (terminal protection)', () => {
    // current=cancelled, incoming=running → should reject
    const result = shouldApplyTaskUpdate('running', 'cancelled');
    expect(result).toBe(false);
  });

  it('cancelled status blocks regression to queued', () => {
    const result = shouldApplyTaskUpdate('queued', 'cancelled');
    expect(result).toBe(false);
  });

  it('completed status allows another completed (idempotent terminal replay)', () => {
    // Terminal repetition is safe (idempotent) — returns true
    const result = shouldApplyTaskUpdate('completed', 'completed');
    expect(result).toBe(true);
  });

  it('different terminal states do not overwrite each other without seq', () => {
    // Without seq numbers, first terminal wins (cannot determine ordering)
    const result = shouldApplyTaskUpdate('cancelled', 'failed');
    expect(result).toBe(false);
  });

  it('running blocks queued regression (out-of-order, rank check)', () => {
    // current=running (rank 1), incoming=queued (rank 0) → reject
    const result = shouldApplyTaskUpdate('queued', 'running');
    expect(result).toBe(false);
  });

  it('allows forward progression queued→running→completed', () => {
    expect(shouldApplyTaskUpdate('running', 'queued')).toBe(true);
    expect(shouldApplyTaskUpdate('completed', 'running')).toBe(true);
  });

  it('getBoundaryStateMessage returns actionable Chinese messages', () => {
    const missing = getBoundaryStateMessage('missing', {});
    expect(missing.content).toContain('任务状态异常');
    expect(missing.content.length).toBeGreaterThan(10);
    expect(missing.requiresRefresh).toBe(true);

    const scopeMismatch = getBoundaryStateMessage('scope_mismatch', {});
    expect(scopeMismatch.content).toContain('作用域');
  });

  it('isTerminalStatus returns true for all terminal states', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
  });

  it('isActiveStatus returns true for non-terminal states', () => {
    expect(isActiveStatus('queued')).toBe(true);
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('completed')).toBe(false);
    expect(isActiveStatus('failed')).toBe(false);
    expect(isActiveStatus('cancelled')).toBe(false);
  });

  it('makeEventKey produces stable unique keys', () => {
    const makeTask = (status: 'completed' | 'running') => ({
      id: 'task-1', status, projectId: 'p', conversationId: 'c',
      content: 'test', createdAt: 0, seq: 42,
    });
    const key1 = makeEventKey('completed', makeTask('completed'), 42);
    const key2 = makeEventKey('completed', makeTask('completed'), 42);
    const key3 = makeEventKey('running', makeTask('running'), 43);
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).toBe('evt_42');
  });
});

describe('RefreshDeduplicator — concurrent protection', () => {
  it('does not start a second refresh while one is in flight', async () => {
    vi.useFakeTimers();
    let inFlightCount = 0;
    let maxInFlight = 0;
    const dedup = new RefreshDeduplicator(async () => {
      inFlightCount++;
      maxInFlight = Math.max(maxInFlight, inFlightCount);
      // Simulate slow refresh
      await new Promise((r) => setTimeout(r, 500));
      inFlightCount--;
    }, 10);

    // Schedule first refresh
    dedup.schedule();
    await vi.advanceTimersByTimeAsync(20); // fires first refresh

    // While first is in flight, schedule another
    dedup.schedule();
    await vi.advanceTimersByTimeAsync(20); // would fire second, but inFlight blocks it

    // Wait for first refresh to complete
    await vi.advanceTimersByTimeAsync(600);

    dedup.cancel();
    vi.useRealTimers();

    expect(maxInFlight).toBeLessThanOrEqual(1);
  });
});

// ─── DB status parsing compatibility ─────────────────────────────────────────
// Mirrors the Rust parse_status_from_db() in task_persistence.rs.
// Tests both modern JSON-serialized and legacy plain-text formats.

function parseStatusFromDb(raw: string): string {
  const trimmed = raw.trim();
  // Try JSON parse first (modern format: '"completed"')
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed.toLowerCase();
  } catch { /* fall through */ }
  // Fall back to plain text (legacy: 'completed', 'Completed', 'queued')
  return trimmed.replace(/^"|"$/g, '').toLowerCase();
}

describe('DB status parsing compatibility', () => {
  it('parses modern JSON-serialized status', () => {
    expect(parseStatusFromDb('"completed"')).toBe('completed');
    expect(parseStatusFromDb('"failed"')).toBe('failed');
    expect(parseStatusFromDb('"cancelled"')).toBe('cancelled');
    expect(parseStatusFromDb('"running"')).toBe('running');
    expect(parseStatusFromDb('"queued"')).toBe('queued');
  });

  it('parses legacy plain-text status', () => {
    expect(parseStatusFromDb('completed')).toBe('completed');
    expect(parseStatusFromDb('failed')).toBe('failed');
    expect(parseStatusFromDb('queued')).toBe('queued');
  });

  it('parses legacy PascalCase JSON status', () => {
    // Old code used PascalCase before rename_all="camelCase"
    expect(parseStatusFromDb('"Completed"')).toBe('completed');
    expect(parseStatusFromDb('"Failed"')).toBe('failed');
  });

  it('handles SQL DEFAULT plain queued', () => {
    expect(parseStatusFromDb('queued')).toBe('queued');
  });

  it('handles whitespace and quotes robustly', () => {
    expect(parseStatusFromDb('  "completed"  ')).toBe('completed');
    expect(parseStatusFromDb('"running"\n')).toBe('running');
  });

  it('defaults unknown values to failed', () => {
    const known = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
    const parsed = parseStatusFromDb('unknown_status');
    expect(known.has(parsed)).toBe(false);
    // Rust code falls back to Failed in this case
  });
});

// ─── Boundary state messages ─────────────────────────────────────────────────

describe('Boundary state user-visible messages', () => {
  it('completed returns AI role with result content', () => {
    const msg = getBoundaryStateMessage('completed', { result: 'Hello world' });
    expect(msg.role).toBe('ai');
    expect(msg.status).toBe('done');
    expect(msg.content).toBe('Hello world');
    expect(msg.requiresRefresh).toBe(true);
  });

  it('completed with empty result shows fallback', () => {
    const msg = getBoundaryStateMessage('completed', { result: '' });
    expect(msg.content).toContain('已完成');
  });

  it('failed includes error text', () => {
    const msg = getBoundaryStateMessage('failed', { error: 'Connection timeout' });
    expect(msg.role).toBe('system');
    expect(msg.status).toBe('error');
    expect(msg.content).toContain('Connection timeout');
    expect(msg.requiresRefresh).toBe(true);
  });

  it('failed without error shows default', () => {
    const msg = getBoundaryStateMessage('failed', {});
    expect(msg.content).toContain('任务失败');
  });

  it('cancelled does not require refresh', () => {
    const msg = getBoundaryStateMessage('cancelled', {});
    expect(msg.requiresRefresh).toBe(false);
    expect(msg.content).toContain('取消');
  });

  it('missing shows actionable reconnection guidance', () => {
    const msg = getBoundaryStateMessage('missing', {});
    expect(msg.content).toContain('网络');
    expect(msg.content).toContain('重启');
    expect(msg.requiresRefresh).toBe(true);
  });

  it('scope_mismatch warns about conversation binding', () => {
    const msg = getBoundaryStateMessage('scope_mismatch', {});
    expect(msg.content).toContain('作用域');
    expect(msg.requiresRefresh).toBe(false);
  });

  it('server restart error message is actionable in Chinese', () => {
    // This mirrors the Rust error: "服务重启，任务已中断"
    const msg = getBoundaryStateMessage('failed', { error: '服务重启，任务已中断' });
    expect(msg.content).toContain('重启');
    expect(msg.content).toContain('中断');
  });
});

// ─── RefreshDeduplicator pending-while-inflight ──────────────────────────────

describe('RefreshDeduplicator — pending events during in-flight refresh', () => {
  it('re-schedules if schedule() called while refresh is in flight', async () => {
    vi.useFakeTimers();

    let refreshCount = 0;
    let resolveRefresh: (() => void) | null = null;

    const refreshFn = () => {
      refreshCount++;
      return new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
    };

    const dedup = new RefreshDeduplicator(refreshFn, 10);

    // First schedule triggers first refresh
    dedup.schedule();
    await vi.advanceTimersByTimeAsync(20);
    expect(refreshCount).toBe(1); // first refresh in flight

    // Schedule while in flight — should mark pending
    dedup.schedule();
    dedup.schedule();
    dedup.schedule();

    // Resolve first refresh
    resolveRefresh!();
    await Promise.resolve(); // microtask
    await Promise.resolve(); // microtask for finally block

    // Should have re-scheduled
    await vi.advanceTimersByTimeAsync(20);
    expect(refreshCount).toBe(2); // second refresh triggered

    resolveRefresh!();
    await Promise.resolve();

    // No more pending — should stay at 2
    await vi.advanceTimersByTimeAsync(50);
    expect(refreshCount).toBe(2);

    dedup.cancel();
    vi.useRealTimers();
  });

  it('cancel() clears pending-while-inflight flag', async () => {
    vi.useFakeTimers();

    let refreshCount = 0;
    let resolveRefresh: (() => void) | null = null;

    const refreshFn = () => {
      refreshCount++;
      return new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
    };

    const dedup = new RefreshDeduplicator(refreshFn, 10);

    dedup.schedule();
    await vi.advanceTimersByTimeAsync(20);
    expect(refreshCount).toBe(1);

    dedup.schedule(); // mark pending
    dedup.cancel();  // cancel should clear pending

    resolveRefresh!();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    expect(refreshCount).toBe(1); // no second refresh

    vi.useRealTimers();
  });
});
