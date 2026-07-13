import { describe, expect, it } from 'vitest';
import {
  isTerminalStatus,
  shouldApplyTaskEvent,
  formatTerminalTaskContent,
  isTerminalMetaTaskStatus,
  SeenEventTracker,
  makeTaskEventKey,
  STATUS_PRECEDENCE,
  TERMINAL_TASK_STATUSES,
  TASK_STATE_MESSAGES,
} from './taskStateSemantics';
import type { AiTask } from './serverApi';

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'task-1',
    projectId: 'project-1',
    conversationId: 'conv-1',
    content: 'test',
    status: 'queued',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('isTerminalStatus', () => {
  it('identifies terminal statuses correctly', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('blocked')).toBe(true);
  });

  it('identifies non-terminal statuses', () => {
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
  });
});

describe('shouldApplyTaskEvent', () => {
  it('always applies when no current status exists', () => {
    expect(shouldApplyTaskEvent(undefined, 'queued', null, null)).toBe(true);
  });

  it('allows queued -> running transition', () => {
    expect(shouldApplyTaskEvent('queued', 'running', null, null)).toBe(true);
  });

  it('allows running -> completed transition', () => {
    expect(shouldApplyTaskEvent('running', 'completed', null, 1000)).toBe(true);
  });

  it('rejects completed being overwritten by queued', () => {
    expect(shouldApplyTaskEvent('completed', 'queued', 1000, null)).toBe(false);
  });

  it('rejects completed being overwritten by running', () => {
    expect(shouldApplyTaskEvent('completed', 'running', 1000, null)).toBe(false);
  });

  it('rejects failed being overwritten by queued', () => {
    expect(shouldApplyTaskEvent('failed', 'queued', 1000, null)).toBe(false);
  });

  it('allows terminal after terminal with later finishedAt', () => {
    expect(shouldApplyTaskEvent('failed', 'completed', 1000, 2000)).toBe(true);
  });

  it('rejects terminal after terminal with earlier finishedAt', () => {
    expect(shouldApplyTaskEvent('completed', 'failed', 2000, 1000)).toBe(false);
  });

  it('allows cancelled over running', () => {
    expect(shouldApplyTaskEvent('running', 'cancelled', null, 1000)).toBe(true);
  });

  it('allows blocked over running', () => {
    expect(shouldApplyTaskEvent('running', 'blocked', null, 1000)).toBe(true);
  });

  it('rejects queued after cancelled', () => {
    expect(shouldApplyTaskEvent('cancelled', 'queued', 1000, null)).toBe(false);
  });
});

describe('formatTerminalTaskContent', () => {
  it('formats completed with result', () => {
    const task = makeTask({ status: 'completed', result: 'Hello world' });
    const { content, role } = formatTerminalTaskContent(task);
    expect(content).toBe('Hello world');
    expect(role).toBe('ai');
  });

  it('formats completed with empty result', () => {
    const task = makeTask({ status: 'completed', result: '' });
    const { content } = formatTerminalTaskContent(task);
    expect(content).toContain('已完成');
  });

  it('formats failed with error', () => {
    const task = makeTask({ status: 'failed', error: 'API error' });
    const { content, role } = formatTerminalTaskContent(task);
    expect(content).toContain('任务失败');
    expect(content).toContain('API error');
    expect(role).toBe('system');
  });

  it('formats cancelled with reason', () => {
    const task = makeTask({ status: 'cancelled', error: '用户取消' });
    const { content, role } = formatTerminalTaskContent(task);
    expect(content).toContain('任务已取消');
    expect(content).toContain('用户取消');
    expect(role).toBe('system');
  });

  it('formats blocked with reason', () => {
    const task = makeTask({ status: 'blocked', error: '依赖未满足' });
    const { content, role } = formatTerminalTaskContent(task);
    expect(content).toContain('任务被阻塞');
    expect(content).toContain('依赖未满足');
    expect(role).toBe('system');
  });

  it('handles failed with no error message', () => {
    const task = makeTask({ status: 'failed', error: null });
    const { content } = formatTerminalTaskContent(task);
    expect(content).toContain('未知错误');
  });
});

describe('SeenEventTracker', () => {
  it('returns true for new keys, false for duplicates', () => {
    const tracker = new SeenEventTracker();
    expect(tracker.checkAndAdd('key-1')).toBe(true);
    expect(tracker.checkAndAdd('key-1')).toBe(false);
    expect(tracker.checkAndAdd('key-2')).toBe(true);
  });

  it('tracks size correctly', () => {
    const tracker = new SeenEventTracker();
    tracker.checkAndAdd('a');
    tracker.checkAndAdd('b');
    tracker.checkAndAdd('a'); // duplicate
    expect(tracker.size).toBe(2);
  });

  it('clears all keys for a task', () => {
    const tracker = new SeenEventTracker();
    tracker.checkAndAdd(makeTaskEventKey('t1', 'completed', '100'));
    tracker.checkAndAdd(makeTaskEventKey('t1', 'running', '99'));
    tracker.checkAndAdd(makeTaskEventKey('t2', 'completed', '101'));
    expect(tracker.size).toBe(3);

    tracker.clearTask('t1');
    expect(tracker.size).toBe(1);
    expect(tracker.has(makeTaskEventKey('t2', 'completed', '101'))).toBe(true);
  });
});

describe('STATUS_PRECEDENCE', () => {
  it('has correct ordering', () => {
    expect(STATUS_PRECEDENCE.queued).toBeLessThan(STATUS_PRECEDENCE.running);
    expect(STATUS_PRECEDENCE.running).toBeLessThan(STATUS_PRECEDENCE.completed);
    expect(STATUS_PRECEDENCE.completed).toBe(STATUS_PRECEDENCE.failed);
    expect(STATUS_PRECEDENCE.failed).toBe(STATUS_PRECEDENCE.cancelled);
    expect(STATUS_PRECEDENCE.cancelled).toBe(STATUS_PRECEDENCE.blocked);
  });
});

describe('isTerminalMetaTaskStatus', () => {
  it('identifies terminal meta statuses', () => {
    expect(isTerminalMetaTaskStatus({ taskStatus: 'completed' })).toBe(true);
    expect(isTerminalMetaTaskStatus({ taskStatus: 'failed' })).toBe(true);
    expect(isTerminalMetaTaskStatus({ taskStatus: 'cancelled' })).toBe(true);
    expect(isTerminalMetaTaskStatus({ taskStatus: 'blocked' })).toBe(true);
    expect(isTerminalMetaTaskStatus({ taskStatus: 'missing' })).toBe(true);
    expect(isTerminalMetaTaskStatus({ taskStatus: 'scope_mismatch' })).toBe(true);
  });

  it('identifies non-terminal meta statuses', () => {
    expect(isTerminalMetaTaskStatus({ taskStatus: 'queued' })).toBe(false);
    expect(isTerminalMetaTaskStatus({ taskStatus: 'running' })).toBe(false);
    expect(isTerminalMetaTaskStatus(undefined)).toBe(false);
    expect(isTerminalMetaTaskStatus({})).toBe(false);
  });
});

describe('TERMINAL_TASK_STATUSES', () => {
  it('contains all terminal states', () => {
    expect(TERMINAL_TASK_STATUSES.size).toBe(4);
    expect(TERMINAL_TASK_STATUSES.has('completed')).toBe(true);
    expect(TERMINAL_TASK_STATUSES.has('failed')).toBe(true);
    expect(TERMINAL_TASK_STATUSES.has('cancelled')).toBe(true);
    expect(TERMINAL_TASK_STATUSES.has('blocked')).toBe(true);
  });
});

describe('formatTerminalTaskContent blocked state', () => {
  it('renders blocked with reason in system role', () => {
    const task = makeTask({ status: 'blocked', error: '额度不足' });
    const { content, role } = formatTerminalTaskContent(task);
    expect(role).toBe('system');
    expect(content).toContain('阻塞');
    expect(content).toContain('额度不足');
  });

  it('renders cancelled with default reason', () => {
    const task = makeTask({ status: 'cancelled', error: null });
    const { content } = formatTerminalTaskContent(task);
    expect(content).toContain('取消');
  });

  it('renders missing grace message (via TASK_STATE_MESSAGES)', () => {
    expect(TASK_STATE_MESSAGES.missing.role).toBe('system');
    expect(TASK_STATE_MESSAGES.missing.prefix).toContain('丢失');
    expect(TASK_STATE_MESSAGES.resync_failed.prefix).toContain('同步失败');
    expect(TASK_STATE_MESSAGES.scope_mismatch.prefix).toContain('作用域');
  });
});
