import { useCallback, useRef, type MutableRefObject, type SetStateAction } from 'react';
import type { Project } from '../../types';
import type { PendingAiTask } from './usePendingTaskSse';

type UsePendingTaskRegistryOptions = {
  setPendingTaskCount: (updater: SetStateAction<number>) => void;
};

type UsePendingTaskRegistryResult = {
  pendingTaskMapRef: MutableRefObject<Map<string, PendingAiTask>>;
  registerPendingTask: (taskId: string, task: PendingAiTask) => void;
  clearPendingTasksByConversation: (conversationId: string) => number;
  clearPendingTasksByPlaceholderIds: (
    conversationId: string,
    placeholderIds: Set<string>,
  ) => number;
  recoverPendingTasksFromProjects: (projects: Project[]) => number;
  syncPendingTaskCount: () => void;
};

export function usePendingTaskRegistry({
  setPendingTaskCount,
}: UsePendingTaskRegistryOptions): UsePendingTaskRegistryResult {
  const pendingTaskMapRef = useRef<Map<string, PendingAiTask>>(new Map());
  const lastSyncedCountRef = useRef<number>(0);

  const syncPendingTaskCount = useCallback(() => {
    const nextCount = pendingTaskMapRef.current.size;
    if (nextCount === lastSyncedCountRef.current) {
      return;
    }

    lastSyncedCountRef.current = nextCount;
    setPendingTaskCount(nextCount);
  }, [setPendingTaskCount]);

  const registerPendingTask = useCallback(
    (taskId: string, task: PendingAiTask) => {
      pendingTaskMapRef.current.set(taskId, task);
      syncPendingTaskCount();
    },
    [syncPendingTaskCount],
  );

  const clearPendingTasksByConversation = useCallback(
    (conversationId: string) => {
      let removedCount = 0;
      for (const [taskId, pendingTask] of pendingTaskMapRef.current.entries()) {
        if (pendingTask.conversationId === conversationId) {
          pendingTaskMapRef.current.delete(taskId);
          removedCount += 1;
        }
      }

      if (removedCount > 0) {
        syncPendingTaskCount();
      }

      return removedCount;
    },
    [syncPendingTaskCount],
  );

  const clearPendingTasksByPlaceholderIds = useCallback(
    (conversationId: string, placeholderIds: Set<string>) => {
      if (placeholderIds.size === 0) {
        return 0;
      }

      let removedCount = 0;
      for (const [taskId, pendingTask] of pendingTaskMapRef.current.entries()) {
        if (
          pendingTask.conversationId === conversationId &&
          placeholderIds.has(pendingTask.placeholderMessageId)
        ) {
          pendingTaskMapRef.current.delete(taskId);
          removedCount += 1;
        }
      }

      if (removedCount > 0) {
        syncPendingTaskCount();
      }

      return removedCount;
    },
    [syncPendingTaskCount],
  );

  const recoverPendingTasksFromProjects = useCallback(
    (projects: Project[]) => {
      const nextPendingTaskMap = new Map<string, PendingAiTask>();
      projects.forEach((project) => {
        project.chatSessions.forEach((chat) => {
          chat.messages.forEach((message) => {
            const taskId =
              typeof message.meta?.taskId === 'string' ? message.meta.taskId.trim() : '';
            if (!taskId || message.status !== 'pending') {
              return;
            }

            nextPendingTaskMap.set(taskId, {
              projectId: project.id,
              chatId: chat.id,
              conversationId: chat.id,
              placeholderMessageId: message.id,
              requestedModel: message.model || '',
              provider:
                (typeof message.meta?.provider === 'string' ? message.meta.provider : '') || '',
            });
          });
        });
      });

      pendingTaskMapRef.current = nextPendingTaskMap;
      syncPendingTaskCount();

      return nextPendingTaskMap.size;
    },
    [syncPendingTaskCount],
  );

  return {
    pendingTaskMapRef,
    registerPendingTask,
    clearPendingTasksByConversation,
    clearPendingTasksByPlaceholderIds,
    recoverPendingTasksFromProjects,
    syncPendingTaskCount,
  };
}
