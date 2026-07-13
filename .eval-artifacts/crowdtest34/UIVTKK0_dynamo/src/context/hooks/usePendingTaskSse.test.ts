import { describe, expect, it } from 'vitest';
import { collectStalePendingTaskIds, type PendingAiTask } from './usePendingTaskSse';

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
    const lastEventTimes = new Map<string, { lastEventAt: number; resyncAttempts: number }>();

    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, 1000, 500)).toEqual([]);
    expect(lastEventTimes.get('task-1')?.lastEventAt).toBe(1000);
    expect(lastEventTimes.get('task-1')?.resyncAttempts).toBe(0);
  });

  it('marks tasks stale after the missing-task timeout', () => {
    const pendingTasks = new Map([['task-1', makePendingTask()]]);
    const lastEventTimes = new Map<string, { lastEventAt: number; resyncAttempts: number }>([
      ['task-1', { lastEventAt: 1000, resyncAttempts: 0 }],
    ]);

    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, 1601, 600)).toEqual([
      'task-1',
    ]);
  });

  it('ignores tasks that have recent events and tasks no longer pending', () => {
    const pendingTasks = new Map([['task-1', makePendingTask()]]);
    const lastEventTimes = new Map<string, { lastEventAt: number; resyncAttempts: number }>([
      ['task-1', { lastEventAt: 1300, resyncAttempts: 0 }],
      ['removed-task', { lastEventAt: 1, resyncAttempts: 0 }],
    ]);

    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, 1600, 600)).toEqual([]);
  });
});
