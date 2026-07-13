import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { getRecoverableTaskId } from './usePendingTaskRegistry';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'ai',
    content: 'pending',
    timestamp: 1,
    status: 'done',
    type: 'text',
    meta: {},
    ...overrides,
  };
}

describe('getRecoverableTaskId', () => {
  it('recovers a task from a pending placeholder message', () => {
    const message = makeMessage({
      status: 'pending',
      meta: { taskId: ' task-1 ' },
    });

    expect(getRecoverableTaskId(message)).toBe('task-1');
  });

  it('recovers a task when taskStatus is still active after bootstrap mapping', () => {
    const queued = makeMessage({
      status: 'done',
      meta: { taskId: 'task-queued', taskStatus: 'queued' },
    });
    const running = makeMessage({
      status: 'done',
      meta: { taskId: 'task-running', taskStatus: 'running' },
    });

    expect(getRecoverableTaskId(queued)).toBe('task-queued');
    expect(getRecoverableTaskId(running)).toBe('task-running');
  });

  it('does not recover terminal or malformed task metadata', () => {
    expect(
      getRecoverableTaskId(
        makeMessage({
          status: 'done',
          meta: { taskId: 'task-done', taskStatus: 'completed' },
        }),
      ),
    ).toBe('');
    expect(
      getRecoverableTaskId(
        makeMessage({
          status: 'error',
          meta: { taskId: 'task-failed', taskStatus: 'failed' },
        }),
      ),
    ).toBe('');
    expect(getRecoverableTaskId(makeMessage({ status: 'pending', meta: {} }))).toBe('');
  });
});
