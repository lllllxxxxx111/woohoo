import { describe, expect, it } from 'vitest';
import {
  collectStalePendingTaskIds,
  resolveTerminalTaskOutcome,
  TASK_CANCELLED_ERROR_TEXT,
  type PendingAiTask,
} from './usePendingTaskSse';

function makePendingTask(overrides: Partial<PendingAiTask> = {}): PendingAiTask {
  return {
    projectId: 'project-1',
    chatId: 'chat-1',
    conversationId: 'chat-1',
    placeholderMessageId: 'message-1',
    requestedModel: 'model-1',
    provider: 'openai',
    ...overrides,
  };
}

describe('collectStalePendingTaskIds', () => {
  it('seeds newly recovered pending tasks without marking them stale immediately', () => {
    const pendingTasks = new Map([['task-1', makePendingTask()]]);
    const lastEventTimes = new Map<string, number>();

    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, 1000, 500)).toEqual([]);
    expect(lastEventTimes.get('task-1')).toBe(1000);
  });

  it('marks tasks stale after the missing-task timeout', () => {
    const pendingTasks = new Map([['task-1', makePendingTask()]]);
    const lastEventTimes = new Map<string, number>([['task-1', 1000]]);

    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, 1601, 600)).toEqual([
      'task-1',
    ]);
  });

  it('ignores tasks that have recent events and tasks no longer pending', () => {
    const pendingTasks = new Map([['task-1', makePendingTask()]]);
    const lastEventTimes = new Map<string, number>([
      ['task-1', 1300],
      ['removed-task', 1],
    ]);

    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, 1600, 600)).toEqual([]);
  });
});

describe('resolveTerminalTaskOutcome', () => {
  it('treats the cancelled SSE event as a user cancel, not a failure', () => {
    const outcome = resolveTerminalTaskOutcome({ error: TASK_CANCELLED_ERROR_TEXT }, 'cancelled');

    expect(outcome).toEqual({
      content: '任务已取消。',
      status: 'done',
      taskStatus: 'cancelled',
      lastError: null,
    });
  });

  it('recognizes user-cancelled tasks replayed from snapshots by the fixed error text', () => {
    const outcome = resolveTerminalTaskOutcome(
      { error: TASK_CANCELLED_ERROR_TEXT },
      'snapshot',
    );

    expect(outcome.taskStatus).toBe('cancelled');
    expect(outcome.status).toBe('done');
    expect(outcome.content).toBe('任务已取消。');
  });

  it('keeps genuine failures as errors with the server error message', () => {
    const outcome = resolveTerminalTaskOutcome({ error: '上游 500' }, 'failed');

    expect(outcome).toEqual({
      content: '任务失败：上游 500',
      status: 'error',
      taskStatus: 'failed',
      lastError: '上游 500',
    });
  });

  it('falls back to a generic message when a failure carries no error text', () => {
    const outcome = resolveTerminalTaskOutcome({ error: null }, 'failed');

    expect(outcome.content).toBe('任务失败：未知错误');
    expect(outcome.lastError).toBe('未知错误');
  });
});
