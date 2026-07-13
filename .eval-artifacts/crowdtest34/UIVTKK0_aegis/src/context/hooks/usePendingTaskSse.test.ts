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
    const resyncAttemptedAt = new Map<string, number>();

    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, resyncAttemptedAt, 1000, 500)).toEqual([]);
    expect(lastEventTimes.get('task-1')).toBe(1000);
  });

  it('does NOT mark tasks stale before resync grace period expires', () => {
    const pendingTasks = new Map([['task-1', makePendingTask()]]);
    const lastEventTimes = new Map<string, number>([['task-1', 1000]]);
    // Resync was attempted but grace period hasn't passed
    const resyncAttemptedAt = new Map<string, number>([['task-1', 1500]]);

    // Timeout exceeded (1600 - 1000 = 600 > 500) but grace period not expired
    // (1600 - 1500 = 100 < 30000 MISSING_RESYNC_GRACE_MS)
    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, resyncAttemptedAt, 1601, 500)).toEqual([]);
  });

  it('marks tasks stale after timeout AND resync grace period', () => {
    const pendingTasks = new Map([['task-1', makePendingTask()]]);
    const lastEventTimes = new Map<string, number>([['task-1', 1000]]);
    const resyncAttemptedAt = new Map<string, number>([['task-1', 1000]]);

    // Both timeout and grace period exceeded (now=100000, timeout=500, grace=30000)
    const stale = collectStalePendingTaskIds(pendingTasks, lastEventTimes, resyncAttemptedAt, 100000, 500);
    expect(stale).toEqual(['task-1']);
  });

  it('ignores tasks that have recent events', () => {
    const pendingTasks = new Map([['task-1', makePendingTask()]]);
    const lastEventTimes = new Map<string, number>([['task-1', 1300]]);
    const resyncAttemptedAt = new Map<string, number>();

    expect(collectStalePendingTaskIds(pendingTasks, lastEventTimes, resyncAttemptedAt, 1600, 600)).toEqual([]);
  });
});
