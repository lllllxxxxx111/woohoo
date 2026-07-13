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
