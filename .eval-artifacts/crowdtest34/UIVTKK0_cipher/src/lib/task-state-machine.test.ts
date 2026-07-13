import { describe, expect, it } from 'vitest';
import {
  canTransition,
  EventDeduplicator,
  isActiveStatus,
  isTerminalStatus,
  mapTaskStatusToLabel,
  mapTaskStatusToMessageStatus,
  normalizeTaskStatus,
  stateOrder,
  STATE_MESSAGES,
} from './task-state-machine';

describe('stateOrder', () => {
  it('orders active states lower than terminal states', () => {
    expect(stateOrder('queued')).toBe(1);
    expect(stateOrder('running')).toBe(2);
    expect(stateOrder('blocked')).toBe(2); // blocked is same level as running (active-paused)
    expect(stateOrder('completed')).toBe(5);
    expect(stateOrder('failed')).toBe(5);
    expect(stateOrder('cancelled')).toBe(5);
    expect(stateOrder('missing')).toBe(6);
    expect(stateOrder('scope_mismatch')).toBe(6);
  });

  it('ranks running and blocked at same level (both active)', () => {
    expect(stateOrder('running')).toBe(stateOrder('blocked'));
  });

  it('ranks all terminal states at same level', () => {
    expect(stateOrder('completed')).toBe(stateOrder('failed'));
    expect(stateOrder('failed')).toBe(stateOrder('cancelled'));
  });
});

describe('isTerminalStatus', () => {
  it('returns true for terminal states (server-final + client-error)', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('missing')).toBe(true);
    expect(isTerminalStatus('scope_mismatch')).toBe(true);
  });

  it('returns false for active states', () => {
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('blocked')).toBe(false);
  });
});

describe('isActiveStatus', () => {
  it('returns true for active (non-terminal) states', () => {
    expect(isActiveStatus('queued')).toBe(true);
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('blocked')).toBe(true);
  });
});

describe('canTransition', () => {
  it('allows forward transitions to terminal', () => {
    expect(canTransition(undefined, 'queued')).toBe(true);
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('queued', 'completed')).toBe(true); // queued can jump to completed (if task already done when SSE connects)
  });

  it('allows running↔blocked transitions (pause/resume for human review)', () => {
    expect(canTransition('running', 'blocked')).toBe(true);  // pause for review
    expect(canTransition('blocked', 'running')).toBe(true);  // resume after approval
    expect(canTransition('queued', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'queued')).toBe(true);
  });

  it('prevents active states from rolling back server-terminal states', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('completed', 'blocked')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
  });

  it('allows server-terminal corrections (server is authoritative)', () => {
    // A later event correcting status: completed→failed (e.g., post-completion error)
    expect(canTransition('completed', 'failed')).toBe(true);
    expect(canTransition('failed', 'completed')).toBe(true);
    expect(canTransition('completed', 'cancelled')).toBe(true);
    expect(canTransition('cancelled', 'failed')).toBe(true);
  });

  it('allows same state (idempotent repeat)', () => {
    expect(canTransition('running', 'running')).toBe(true);
    expect(canTransition('completed', 'completed')).toBe(true);
    expect(canTransition('failed', 'failed')).toBe(true);
    expect(canTransition('blocked', 'blocked')).toBe(true);
  });

  it('allows blocked to transition to any terminal state', () => {
    expect(canTransition('blocked', 'completed')).toBe(true);
    expect(canTransition('blocked', 'failed')).toBe(true);
    expect(canTransition('blocked', 'cancelled')).toBe(true);
  });

  it('corrects missing/scope_mismatch when server sends authoritative state', () => {
    // If task was marked missing (client-side), a subsequent completed event fixes it
    expect(canTransition('missing', 'running')).toBe(true);
    expect(canTransition('missing', 'completed')).toBe(true);
    expect(canTransition('missing', 'failed')).toBe(true);
    expect(canTransition('scope_mismatch', 'running')).toBe(true);
    expect(canTransition('scope_mismatch', 'completed')).toBe(true);
  });

  it('prevents running/queued from overwriting each other (same-level active, allowed)', () => {
    // Running → queued is unusual but allowed (re-queue); eventSeq dedup prevents replay issues
    expect(canTransition('running', 'queued')).toBe(true);
  });
});

describe('normalizeTaskStatus', () => {
  it('normalizes known statuses', () => {
    expect(normalizeTaskStatus('queued')).toBe('queued');
    expect(normalizeTaskStatus('running')).toBe('running');
    expect(normalizeTaskStatus('completed')).toBe('completed');
    expect(normalizeTaskStatus('failed')).toBe('failed');
    expect(normalizeTaskStatus('cancelled')).toBe('cancelled');
    expect(normalizeTaskStatus('blocked')).toBe('blocked');
  });

  it('handles American spelling "canceled"', () => {
    expect(normalizeTaskStatus('canceled')).toBe('cancelled');
  });

  it('defaults unknown to failed for safety', () => {
    expect(normalizeTaskStatus('unknown_status')).toBe('failed');
    expect(normalizeTaskStatus(undefined)).toBe('queued');
    expect(normalizeTaskStatus(null)).toBe('queued');
  });
});

describe('mapTaskStatusToMessageStatus', () => {
  it('maps queued/running/blocked to pending', () => {
    expect(mapTaskStatusToMessageStatus('queued')).toBe('pending');
    expect(mapTaskStatusToMessageStatus('running')).toBe('pending');
    expect(mapTaskStatusToMessageStatus('blocked')).toBe('pending');
  });

  it('maps completed to done', () => {
    expect(mapTaskStatusToMessageStatus('completed')).toBe('done');
  });

  it('maps failed/cancelled/missing/scope_mismatch to error', () => {
    expect(mapTaskStatusToMessageStatus('failed')).toBe('error');
    expect(mapTaskStatusToMessageStatus('cancelled')).toBe('error');
    expect(mapTaskStatusToMessageStatus('missing')).toBe('error');
    expect(mapTaskStatusToMessageStatus('scope_mismatch')).toBe('error');
  });
});

describe('mapTaskStatusToLabel', () => {
  it('returns Chinese labels for all statuses', () => {
    expect(mapTaskStatusToLabel('queued')).toBe('排队中');
    expect(mapTaskStatusToLabel('running')).toBe('执行中');
    expect(mapTaskStatusToLabel('completed')).toBe('已完成');
    expect(mapTaskStatusToLabel('failed')).toBe('失败');
    expect(mapTaskStatusToLabel('cancelled')).toBe('已取消');
    expect(mapTaskStatusToLabel('blocked')).toBe('等待中');
    expect(mapTaskStatusToLabel('missing')).toBe('状态丢失');
    expect(mapTaskStatusToLabel('scope_mismatch')).toBe('作用域异常');
  });
});

describe('STATE_MESSAGES', () => {
  it('has user-facing messages for all states', () => {
    for (const status of [
      'queued', 'running', 'completed', 'failed',
      'cancelled', 'blocked', 'missing', 'scope_mismatch',
    ] as const) {
      expect(STATE_MESSAGES[status]).toBeDefined();
      expect(STATE_MESSAGES[status].title).toBeTruthy();
    }
  });
});

describe('EventDeduplicator', () => {
  it('allows first event for a key', () => {
    const dedup = new EventDeduplicator();
    expect(dedup.check('task-1', 1)).toBe(true);
  });

  it('deduplicates events with same or lower seq', () => {
    const dedup = new EventDeduplicator();
    expect(dedup.check('task-1', 1)).toBe(true);
    expect(dedup.check('task-1', 1)).toBe(false); // duplicate
    expect(dedup.check('task-1', 0)).toBe(false); // older
  });

  it('allows events with higher seq (new events)', () => {
    const dedup = new EventDeduplicator();
    expect(dedup.check('task-1', 1)).toBe(true);
    expect(dedup.check('task-1', 2)).toBe(true);
    expect(dedup.check('task-1', 3)).toBe(true);
  });

  it('tracks different keys independently', () => {
    const dedup = new EventDeduplicator();
    expect(dedup.check('task-1', 1)).toBe(true);
    expect(dedup.check('task-2', 1)).toBe(true);
  });

  it('prunes old entries when exceeding maxSize', () => {
    const dedup = new EventDeduplicator(5);
    for (let i = 1; i <= 10; i++) {
      dedup.check(`task-${i}`, i);
    }
    // Oldest entries should have been pruned
    expect(dedup.hasSeen('task-1', 1)).toBe(false); // pruned
    expect(dedup.hasSeen('task-10', 10)).toBe(true); // kept
  });

  it('supports remove to clear tracking for a key', () => {
    const dedup = new EventDeduplicator();
    dedup.check('task-1', 1);
    dedup.remove('task-1');
    expect(dedup.check('task-1', 1)).toBe(true); // allows re-processing
  });

  it('supports clear to reset all tracking (used on resync)', () => {
    const dedup = new EventDeduplicator();
    dedup.check('task-1', 1);
    dedup.check('task-2', 2);
    dedup.clear();
    expect(dedup.check('task-1', 1)).toBe(true); // allowed after clear
    expect(dedup.check('task-2', 2)).toBe(true);
  });
});

describe('STATE_MESSAGES coverage', () => {
  it('has user-visible messages for every lifecycle status', () => {
    const statuses = ['queued', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'missing', 'scope_mismatch'] as const;
    for (const s of statuses) {
      const msg = STATE_MESSAGES[s];
      expect(msg).toBeDefined();
      expect(typeof msg.title).toBe('string');
      expect(msg.title.length).toBeGreaterThan(0);
      expect(typeof msg.detail).toBe('string');
    }
  });

  it('error boundary states include an actionable suggestion', () => {
    expect(STATE_MESSAGES.missing.action).toBe('重试');
    expect(STATE_MESSAGES.scope_mismatch.action).toBe('刷新页面');
    expect(STATE_MESSAGES.failed.action).toBe('重新发送');
  });
});
