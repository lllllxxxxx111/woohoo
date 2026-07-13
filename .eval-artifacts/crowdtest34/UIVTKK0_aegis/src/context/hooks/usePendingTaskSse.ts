import { useEffect, type MutableRefObject } from 'react';
import {
  type AiTask,
  ensureServerSession,
  getServerBaseUrl,
  listCollaborationMessages,
} from '../../lib/serverApi';
import { createSseConsumer, parseSseJson, type SseFrame } from '../../lib/sseConsumer';
import {
  EventDedupTracker,
  shouldApplyState,
  normalizeUiStatus,
  STATE_USER_MESSAGES,
  type UiTaskStatus,
} from '../../lib/taskEventOrdering';
import { logger } from '../../lib/logger';
import { useAppStore } from '../../store';
import type { Message, MessageMeta } from '../../types';

const QUEUED_TASK_PLACEHOLDER = '任务已提交，排队中...';
const RUNNING_TASK_PLACEHOLDER = 'AI 正在处理中...';
const THINKING_TASK_PLACEHOLDER = 'AI 正在思考中...';

/** Threshold after which a task with no events is considered potentially missing. */
const MISSING_TASK_TIMEOUT_MS = 120000;
/** How long to wait after a disconnect + resync failure before marking missing. */
const MISSING_RESYNC_GRACE_MS = 30000;

export type PendingAiTask = {
  projectId: string;
  chatId: string;
  conversationId: string;
  placeholderMessageId: string;
  requestedModel: string;
  provider: string;
};

type TaskMessageMetaSource = {
  id: string;
  status: string;
  outputKind?: string | null;
  outputItems?: number | null;
  attemptIndex?: number | null;
  previousAttempts?: number | null;
  previousFailures?: number | null;
  previousSuccesses?: number | null;
  isRedo?: boolean;
  lastError?: string | null;
  agentStatus?: string | null;
  activeTasks?: number | null;
  queuedTasks?: number | null;
};

export function mergeTaskMessageMeta(
  currentMeta: MessageMeta | undefined,
  task: TaskMessageMetaSource,
  provider: string,
  uiStatus?: UiTaskStatus,
): MessageMeta {
  return {
    ...(currentMeta ?? {}),
    provider,
    taskId: task.id,
    taskStatus: (uiStatus ?? task.status) as MessageMeta['taskStatus'],
    outputKind: task.outputKind ?? currentMeta?.outputKind,
    outputItems: task.outputItems ?? currentMeta?.outputItems,
    attemptIndex: task.attemptIndex ?? currentMeta?.attemptIndex,
    previousAttempts: task.previousAttempts ?? currentMeta?.previousAttempts,
    previousFailures: task.previousFailures ?? currentMeta?.previousFailures,
    previousSuccesses: task.previousSuccesses ?? currentMeta?.previousSuccesses,
    isRedo: task.isRedo ?? currentMeta?.isRedo,
    lastError: task.lastError ?? currentMeta?.lastError ?? null,
    agentStatus: task.agentStatus ?? currentMeta?.agentStatus,
    activeTasks: task.activeTasks ?? currentMeta?.activeTasks,
    queuedTasks: task.queuedTasks ?? currentMeta?.queuedTasks,
  };
}

type UsePendingTaskSseOptions = {
  isServerWorkspaceReady: boolean;
  isAuthenticated: boolean;
  pendingTaskCount: number;
  pendingTaskMapRef: MutableRefObject<Map<string, PendingAiTask>>;
  syncPendingTaskCount: () => void;
  updateMessageLocally: (
    projectId: string,
    chatId: string,
    messageId: string,
    updater: (message: Message) => Message,
  ) => void;
  refreshWorkspaceAfterTaskCompletion: () => Promise<void>;
  markUnauthenticated: () => void;
};

function isGenericTaskPlaceholder(content: string) {
  return [QUEUED_TASK_PLACEHOLDER, RUNNING_TASK_PLACEHOLDER, THINKING_TASK_PLACEHOLDER].includes(
    content.trim(),
  );
}

/**
 * Collect pending tasks that haven't received events within the timeout.
 * Only called after a resync attempt has also failed to confirm state.
 */
export function collectStalePendingTaskIds(
  pendingTasks: Map<string, PendingAiTask>,
  lastEventTimes: Map<string, number>,
  resyncAttemptedAt: Map<string, number>,
  now: number,
  timeoutMs: number,
): string[] {
  const staleIds: string[] = [];

  pendingTasks.forEach((_pendingTask, taskId) => {
    const lastEventTime = lastEventTimes.get(taskId);
    if (lastEventTime === undefined) {
      lastEventTimes.set(taskId, now);
      return;
    }

    if (now - lastEventTime > timeoutMs) {
      // Only mark as stale if we've also attempted resync and it didn't resolve
      const resyncAttempt = resyncAttemptedAt.get(taskId);
      if (resyncAttempt !== undefined && now - resyncAttempt > MISSING_RESYNC_GRACE_MS) {
        staleIds.push(taskId);
      }
    }
  });

  return staleIds;
}

export function usePendingTaskSse({
  isServerWorkspaceReady,
  isAuthenticated,
  pendingTaskCount,
  pendingTaskMapRef,
  syncPendingTaskCount,
  updateMessageLocally,
  refreshWorkspaceAfterTaskCompletion,
  markUnauthenticated,
}: UsePendingTaskSseOptions) {
  useEffect(() => {
    // SSE only connects when there are pending tasks — no infinite reconnection when idle
    if (!isServerWorkspaceReady || !isAuthenticated || pendingTaskCount <= 0) {
      useAppStore.getState().setSseConnected(false);
      useAppStore.getState().setAiTasks([]);
      return;
    }

    let cancelled = false;

    // Track event deduplication and ordering
    const dedupTracker = new EventDedupTracker();
    // Track last event time per task for stale detection
    const lastEventTimeRef = new Map<string, number>();
    // Track when a resync was attempted after detecting staleness
    const resyncAttemptedAt = new Map<string, number>();
    // Track per-task current UI status for ordering decisions
    const taskStatusRef = new Map<string, UiTaskStatus>();
    // Debounce workspace refresh
    let workspaceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    // Store aiTasks for the pipeline preview
    const aiTasksMap = new Map<string, AiTask>();
    // Resync dedup: track the last resync time and in-flight resync to prevent
    // cascading resyncs when many lagged/error/resync events arrive in quick succession.
    let lastResyncAt = 0;
    let resyncInFlight = false;
    const RESYNC_COOLDOWN_MS = 5000; // max one resync every 5s

    const scheduleWorkspaceRefresh = () => {
      if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer);
      workspaceRefreshTimer = setTimeout(async () => {
        if (cancelled) return;
        try {
          await refreshWorkspaceAfterTaskCompletion();
        } catch (error) {
          logger.error('[SSE] Failed to refresh workspace after task completion', error);
        }
      }, 300);
    };

    const syncAiTasksToStore = () => {
      const tasks = Array.from(aiTasksMap.values());
      useAppStore.getState().setAiTasks(tasks);
    };

    /**
     * Perform a controlled resync: fetch current task state from GET /api/ai/tasks
     * to correct UI after a disconnect or cursor expiration.
     */
    const performResync = async (reason: string): Promise<void> => {
      logger.info(`[SSE] Performing resync: ${reason}`);
      try {
        const session = await ensureServerSession(false);
        const baseUrl = await getServerBaseUrl();
        const response = await fetch(`${baseUrl}/api/ai/tasks?limit=200`, {
          headers: {
            Authorization: `Bearer ${session.token}`,
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`Resync HTTP ${response.status}`);
        }
        const tasks: AiTask[] = await response.json();
        if (cancelled) return;

        // Update our tracked tasks and fix UI state
        const store = useAppStore.getState();
        aiTasksMap.clear();
        for (const task of tasks) {
          aiTasksMap.set(task.id, task);
        }
        store.setAiTasks(tasks);

        // For each pending task, apply the server's current state
        for (const [taskId, pendingTask] of pendingTaskMapRef.current) {
          const serverTask = tasks.find((t) => t.id === taskId);
          if (serverTask) {
            applyTaskFromResync(serverTask, pendingTask);
            resyncAttemptedAt.delete(taskId);
          } else {
            // Server doesn't know about this task anymore — it may have been evicted
            // Mark resync attempted; if still missing after grace, mark as missing
            if (!resyncAttemptedAt.has(taskId)) {
              resyncAttemptedAt.set(taskId, Date.now());
            }
          }
        }
        syncPendingTaskCount();
      } catch (error) {
        logger.error('[SSE] Resync failed:', error);
        // Mark all pending tasks as having attempted resync
        for (const taskId of pendingTaskMapRef.current.keys()) {
          if (!resyncAttemptedAt.has(taskId)) {
            resyncAttemptedAt.set(taskId, Date.now());
          }
        }
      }
    };

    /**
     * Debounced resync: at most one resync every RESYNC_COOLDOWN_MS, and
     * concurrent resyncs are coalesced into a single fetch.
     */
    const scheduleResync = (reason: string): void => {
      const now = Date.now();
      if (resyncInFlight) return;
      if (now - lastResyncAt < RESYNC_COOLDOWN_MS) {
        logger.info(`[SSE] Resync suppressed (cooldown): ${reason}`);
        return;
      }
      lastResyncAt = now;
      resyncInFlight = true;
      void performResync(reason).finally(() => {
        resyncInFlight = false;
      });
    };

    /**
     * Apply a task state received during resync (GET response, not SSE event).
     * This handles the case where a task completed while we were disconnected.
     */
    const applyTaskFromResync = (task: AiTask, pendingTask: PendingAiTask) => {
      const uiStatus = normalizeUiStatus(task);
      const currentStatus = taskStatusRef.get(task.id);

      if (!shouldApplyState(currentStatus, uiStatus)) {
        return;
      }

      taskStatusRef.set(task.id, uiStatus);
      lastEventTimeRef.set(task.id, Date.now());
      // Reset dedup and seed it with the server's eventSeq so any late SSE events
      // with lower seq (raced before the resync snapshot arrived) are rejected.
      dedupTracker.clearTask(task.id);
      if (typeof task.eventSeq === 'number' && task.eventSeq > 0) {
        dedupTracker.markAndCheck(task.id, null, task.eventSeq);
      }

      applyTaskToMessage(task, pendingTask, uiStatus, true);
    };

    /**
     * Apply a task event to the message placeholder.
     * Returns true if a workspace refresh should be triggered.
     */
    const applyTaskToMessage = (
      task: AiTask,
      pendingTask: PendingAiTask,
      uiStatus: UiTaskStatus,
      fromResync = false,
      contentDelta?: string,
    ): boolean => {
      let requiresRefresh = false;

      // Scope validation
      if (
        task.projectId !== pendingTask.projectId ||
        task.conversationId !== pendingTask.conversationId
      ) {
        pendingTaskMapRef.current.delete(task.id);
        updateMessageLocally(
          pendingTask.projectId,
          pendingTask.chatId,
          pendingTask.placeholderMessageId,
          (message) => ({
            ...message,
            role: 'system',
            content: STATE_USER_MESSAGES.scope_mismatch.message,
            status: 'error',
            model: undefined,
            meta: mergeTaskMessageMeta(
              message.meta,
              task,
              pendingTask.provider,
              'scope_mismatch',
            ),
          }),
        );
        return false;
      }

      switch (uiStatus) {
        case 'queued':
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              content:
                message.content.trim() && !isGenericTaskPlaceholder(message.content)
                  ? message.content
                  : QUEUED_TASK_PLACEHOLDER,
              status: 'pending',
              model: task.model || pendingTask.requestedModel,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider, 'queued'),
            }),
          );
          break;

        case 'running':
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => {
              const hasContent = contentDelta
                ? true
                : message.content.trim() && !isGenericTaskPlaceholder(message.content);
              return {
                ...message,
                content: contentDelta
                  ? (message.content.trim() && !isGenericTaskPlaceholder(message.content)
                      ? message.content
                      : '') + contentDelta
                  : hasContent
                    ? message.content
                    : RUNNING_TASK_PLACEHOLDER,
                status: 'pending',
                model: task.model || pendingTask.requestedModel,
                meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider, 'running'),
              };
            },
          );
          break;

        case 'completed':
          requiresRefresh = true;
          pendingTaskMapRef.current.delete(task.id);
          taskStatusRef.set(task.id, 'completed');
          dedupTracker.clearTask(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              content: task.result?.trim() || (fromResync ? '(任务已完成，通过状态恢复获取结果)' : '任务已完成，但没有返回内容。'),
              status: 'done',
              model: task.model || pendingTask.requestedModel,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider, 'completed'),
            }),
          );
          break;

        case 'failed':
          requiresRefresh = true;
          pendingTaskMapRef.current.delete(task.id);
          taskStatusRef.set(task.id, 'failed');
          dedupTracker.clearTask(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role: 'system',
              content: `任务失败：${task.error || STATE_USER_MESSAGES.failed.message}`,
              status: 'error',
              model: undefined,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider, 'failed'),
            }),
          );
          break;

        case 'cancelled':
          requiresRefresh = true;
          pendingTaskMapRef.current.delete(task.id);
          taskStatusRef.set(task.id, 'cancelled');
          dedupTracker.clearTask(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role: 'system',
              content: STATE_USER_MESSAGES.cancelled.message,
              status: 'error',
              model: undefined,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider, 'cancelled'),
            }),
          );
          break;

        default:
          break;
      }

      return requiresRefresh;
    };

    /**
     * Handle a parsed SSE event frame.
     */
    const handleSseFrame = (frame: SseFrame): void => {
      if (cancelled) return;

      const eventType = frame.event;
      const data = parseSseJson<any>(frame.data);
      if (!data) return;

      // Extract sequence number from event id for ordering
      const eventSeq = frame.id ? parseInt(frame.id, 10) : undefined;

      switch (eventType) {
        case 'snapshot': {
          if (Array.isArray(data.tasks)) {
            for (const task of data.tasks as AiTask[]) {
              aiTasksMap.set(task.id, task);
              const pendingTask = pendingTaskMapRef.current.get(task.id);
              if (pendingTask) {
                const uiStatus = normalizeUiStatus(task);
                const currentStatus = taskStatusRef.get(task.id);
                if (shouldApplyState(currentStatus, uiStatus, undefined, eventSeq)) {
                  taskStatusRef.set(task.id, uiStatus);
                  lastEventTimeRef.set(task.id, Date.now());
                  applyTaskToMessage(task, pendingTask, uiStatus);
                }
              }
            }
            syncAiTasksToStore();
            syncPendingTaskCount();
          }
          break;
        }

        case 'queued':
        case 'running':
        case 'completed':
        case 'failed':
        case 'cancelled': {
          const task: AiTask | undefined = data.task;
          if (!task) break;

          aiTasksMap.set(task.id, task);

          const pendingTask = pendingTaskMapRef.current.get(task.id);
          if (!pendingTask) {
            // Task not tracked locally — still update the store for pipeline preview
            syncAiTasksToStore();
            break;
          }

          // Use event_type for cancelled (since backend sends event_type=cancelled but status=failed)
          const uiStatus: UiTaskStatus =
            eventType === 'cancelled' ? 'cancelled' : normalizeUiStatus(task);
          const currentStatus = taskStatusRef.get(task.id);
          // Capture previous max seq BEFORE markAndCheck updates it so shouldApplyState
          // sees the real "current" seq, not the one we're about to record.
          const prevMaxSeq = dedupTracker.getMaxSeq(task.id);

          // Deduplicate by event ID
          if (frame.id && !dedupTracker.markAndCheck(task.id, frame.id, eventSeq)) {
            // Duplicate event — skip
            break;
          }

          // Check state ordering using the seq we had BEFORE this event
          if (!shouldApplyState(currentStatus, uiStatus, prevMaxSeq, eventSeq)) {
            // Old event attempting to overwrite new state — skip
            break;
          }

          taskStatusRef.set(task.id, uiStatus);
          lastEventTimeRef.set(task.id, Date.now());
          resyncAttemptedAt.delete(task.id);

          const requiresRefresh = applyTaskToMessage(task, pendingTask, uiStatus);
          syncAiTasksToStore();
          syncPendingTaskCount();

          if (requiresRefresh) {
            scheduleWorkspaceRefresh();
          }
          break;
        }

        case 'content_delta': {
          const task: AiTask | undefined = data.task;
          const delta: string | undefined = data.contentDelta;
          if (!task || !delta) break;

          const pendingTask = pendingTaskMapRef.current.get(task.id);
          if (!pendingTask) break;

          // Deduplicate (content deltas don't carry unique IDs but come after
          // a running event which already set the dedup baseline)
          if (frame.id && !dedupTracker.markAndCheck(task.id, frame.id, eventSeq)) {
            break;
          }

          lastEventTimeRef.set(task.id, Date.now());
          applyTaskToMessage(task, pendingTask, 'running', false, delta);
          aiTasksMap.set(task.id, task);
          break;
        }

        case 'context': {
          const task: AiTask | undefined = data.task;
          if (!task) break;
          aiTasksMap.set(task.id, task);

          const pendingTask = pendingTaskMapRef.current.get(task.id);
          if (pendingTask) {
            const currentStatus = taskStatusRef.get(task.id);
            const uiStatus = normalizeUiStatus(task);
            if (shouldApplyState(currentStatus, uiStatus)) {
              taskStatusRef.set(task.id, uiStatus);
              lastEventTimeRef.set(task.id, Date.now());
              updateMessageLocally(
                pendingTask.projectId,
                pendingTask.chatId,
                pendingTask.placeholderMessageId,
                (message) => ({
                  ...message,
                  meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider, uiStatus),
                }),
              );
            }
          }
          syncAiTasksToStore();
          break;
        }

        case 'lagged': {
          logger.warn(`[SSE] Lagged behind, skipped ${data.skipped} events, scheduling resync`);
          scheduleResync('lagged');
          break;
        }

        case 'resync': {
          logger.warn(`[SSE] Resync requested by server: ${data.reason}`);
          scheduleResync(data.reason || 'server_requested');
          break;
        }

        case 'error': {
          // Server-side error surfaced via SSE (e.g. DB query failures).
          // Trigger a debounced resync to recover state.
          logger.error(`[SSE] Server error event: ${data.message || 'unknown'}`, data.detail);
          scheduleResync('server_error');
          break;
        }

        default:
          // Unknown event types are safely ignored
          break;
      }
    };

    // Stale task detection interval
    // Only marks tasks as missing after timeout AND a resync attempt has failed
    const missingCheckInterval = setInterval(() => {
      if (cancelled || pendingTaskMapRef.current.size === 0) return;

      const now = Date.now();
      const staleIds = collectStalePendingTaskIds(
        pendingTaskMapRef.current,
        lastEventTimeRef,
        resyncAttemptedAt,
        now,
        MISSING_TASK_TIMEOUT_MS,
      );

      if (staleIds.length > 0) {
        // First try a resync before marking as missing (debounced)
        scheduleResync('stale_detection');

        // After marking resync attempt, wait for grace period (handled by collectStalePendingTaskIds)
        for (const id of staleIds) {
          const pendingTask = pendingTaskMapRef.current.get(id);
          if (!pendingTask) continue;

          pendingTaskMapRef.current.delete(id);
          lastEventTimeRef.delete(id);
          resyncAttemptedAt.delete(id);
          taskStatusRef.set(id, 'missing');
          dedupTracker.clearTask(id);

          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role: 'system',
              content: STATE_USER_MESSAGES.missing.message,
              status: 'error',
              model: undefined,
              meta: {
                ...(message.meta ?? {}),
                taskId: id,
                taskStatus: 'missing',
                lastError: STATE_USER_MESSAGES.missing.message,
              },
            }),
          );
        }
        syncPendingTaskCount();
      }
    }, 30000);

    // Cleanup ref
    const cleanupRef: { consumer?: ReturnType<typeof createSseConsumer> } = {};

    // Create and start the SSE consumer
    const getToken = async (): Promise<string | null> => {
      try {
        const session = await ensureServerSession(false);
        return session.token;
      } catch {
        return null;
      }
    };

    getToken().then((initialToken) => {
      if (cancelled || !initialToken) return;

      const url = `/api/ai/tasks/stream?limit=200`;

      const consumer = createSseConsumer({
        url,
        token: initialToken,
        onFrame: handleSseFrame,
        onOpen: () => {
          useAppStore.getState().setSseConnected(true);
          useAppStore.getState().setSseError(null);
        },
        onError: (error, statusCode) => {
          useAppStore.getState().setSseConnected(false);

          if (statusCode === 401) {
            markUnauthenticated();
            return false; // Stop reconnecting
          }

          // Don't log AbortError or network errors during normal operation
          if (
            error.name === 'AbortError' ||
            error.message.includes('Failed to fetch') ||
            error.message.includes('NetworkError')
          ) {
            return true; // Allow reconnect
          }

          logger.error('[SSE] Connection error:', error);
          useAppStore.getState().setSseError(error.message);
          return true; // Allow reconnect with backoff
        },
        onAuthRefresh: async () => {
          try {
            const session = await ensureServerSession(true);
            return session.token;
          } catch {
            markUnauthenticated();
            return null;
          }
        },
        shouldReconnect: () => {
          // Don't reconnect if there are no pending tasks or we're cancelled
          if (cancelled) return false;
          return pendingTaskMapRef.current.size > 0;
        },
        maxBackoffMs: 15000,
        baseBackoffMs: 500,
      });

      cleanupRef.consumer = consumer;
    });

    return () => {
      cancelled = true;
      if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer);
      clearInterval(missingCheckInterval);
      if (cleanupRef.consumer) {
        cleanupRef.consumer.close();
      }
      lastEventTimeRef.clear();
      resyncAttemptedAt.clear();
      taskStatusRef.clear();
      dedupTracker.clear();
      aiTasksMap.clear();
      useAppStore.getState().setSseConnected(false);
    };
  }, [
    isServerWorkspaceReady,
    isAuthenticated,
    pendingTaskCount,
    pendingTaskMapRef,
    syncPendingTaskCount,
    updateMessageLocally,
    refreshWorkspaceAfterTaskCompletion,
    markUnauthenticated,
  ]);

  // ──────────────────────────────────────────────────────────────────────────
  // Collaboration SSE (separate connection, uses same consumer infrastructure)
  // ──────────────────────────────────────────────────────────────────────────
  const activeCollaborationSession = useAppStore((state) => state.activeCollaborationSession);

  useEffect(() => {
    if (!activeCollaborationSession || !isServerWorkspaceReady || !isAuthenticated) {
      return;
    }

    let cancelled = false;

    ensureServerSession(false)
      .then((session) => {
        if (cancelled) return;

        const consumer = createSseConsumer({
          url: '/api/collaboration/events/stream',
          token: session.token,
          onFrame: (frame) => {
            if (cancelled) return;
            if (frame.event !== 'collaboration') return;

            try {
              const envelope = JSON.parse(frame.data);
              const eventType = envelope.eventType as string | undefined;
              const payload = envelope.payload ?? {};
              const sessionId = envelope.sessionId as string | undefined;

              if (!eventType) return;

              switch (eventType) {
                case 'collaboration_session_created':
                  if (sessionId) {
                    useAppStore.getState().setCollaborationSession({
                      id: sessionId,
                      userId: '',
                      projectId: payload.projectId || '',
                      conversationId: '',
                      state: payload.state || 'discovery',
                      roundCount: 0,
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    });
                  }
                  break;

                case 'collaboration_assignment_updated':
                  if (payload.assignmentId) {
                    const store = useAppStore.getState();
                    const existing = store.activeCollaborationAssignments;
                    const updated = existing.map((a) =>
                      a.id === payload.assignmentId
                        ? {
                            ...a,
                            status: payload.newStatus || a.status,
                            aiTaskId: payload.aiTaskId || a.aiTaskId,
                          }
                        : a,
                    );
                    if (!existing.some((a) => a.id === payload.assignmentId)) {
                      updated.push({
                        id: payload.assignmentId,
                        sessionId: '',
                        agentId: payload.agentId || '',
                        taskType: '',
                        goal: '',
                        status: payload.newStatus || 'assigned',
                        aiTaskId: payload.aiTaskId,
                        blockingQuestionCount: 0,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                      });
                    }
                    store.setCollaborationAssignments(updated);
                  }
                  break;

                case 'collaboration_queue_updated':
                  if (sessionId) {
                    const session = useAppStore.getState().activeCollaborationSession;
                    if (session && session.id === sessionId) {
                      useAppStore.getState().setCollaborationSession({
                        ...session,
                        replyQueueJson: JSON.stringify(payload.replyQueue || []),
                      });
                    }
                  }
                  break;

                case 'collaboration_question_asked': {
                  const existing = useAppStore.getState().collaborationPendingQuestions;
                  const fingerprint = `${payload.agentId || ''}-${payload.question || ''}`;
                  if (!existing.some((q) => q.fingerprint === fingerprint)) {
                    useAppStore.getState().setCollaborationPendingQuestions([
                      ...existing,
                      {
                        agentId: payload.agentId || '',
                        question: payload.question || '',
                        fingerprint,
                      },
                    ]);
                  }
                  break;
                }

                case 'collaboration_question_answered': {
                  const prev = useAppStore.getState().collaborationPendingQuestions;
                  const answeredFingerprint = `${payload.agentId || ''}-${payload.question || ''}`;
                  useAppStore
                    .getState()
                    .setCollaborationPendingQuestions(
                      prev.filter((q) => q.fingerprint !== answeredFingerprint),
                    );
                  break;
                }

                case 'collaboration_loop_warning':
                  if (payload.level !== undefined) {
                    useAppStore.getState().setCollaborationLoopCheckResult({
                      loopDetected: true,
                      signals: payload.signals || [],
                      level: payload.level,
                      action: payload.action || '',
                      message: payload.message || '',
                    });
                  }
                  break;

                case 'collaboration_admission_changed':
                  if (sessionId) {
                    const session = useAppStore.getState().activeCollaborationSession;
                    if (session && session.id === sessionId) {
                      useAppStore.getState().setCollaborationSession({
                        ...session,
                        state: payload.admitted ? 'workspace_admission' : session.state,
                      });
                    }
                  }
                  break;

                case 'collaboration_workspace_started':
                  if (sessionId) {
                    const session = useAppStore.getState().activeCollaborationSession;
                    if (session && session.id === sessionId) {
                      useAppStore.getState().setCollaborationSession({
                        ...session,
                        state: 'workspace_execution',
                        pipelineRunId: payload.pipelineRunId || session.pipelineRunId,
                      });
                      useAppStore.getState().switchTab('pipeline');
                    }
                  }
                  break;

                case 'collaboration_session_halted':
                  if (sessionId) {
                    const session = useAppStore.getState().activeCollaborationSession;
                    if (session && session.id === sessionId) {
                      useAppStore.getState().setCollaborationSession({
                        ...session,
                        state: 'halted',
                      });
                    }
                  }
                  break;

                case 'collaboration_dispatched':
                  if (sessionId) {
                    const session = useAppStore.getState().activeCollaborationSession;
                    if (session && session.id === sessionId) {
                      useAppStore.getState().setCollaborationSession({
                        ...session,
                        state: payload.state || 'resolving_questions',
                      });
                    }
                  }
                  break;

                case 'collaboration_message_sent':
                  if (sessionId) {
                    void listCollaborationMessages(sessionId)
                      .then((messages) => {
                        const active = useAppStore.getState().activeCollaborationSession;
                        if (active?.id === sessionId) {
                          useAppStore.getState().setCollaborationMessages(messages);
                        }
                      })
                      .catch((error) => {
                        logger.warn('[Collaboration-SSE] Failed to refresh messages', error);
                      });
                  }
                  break;
              }
            } catch {
              logger.error('[Collaboration-SSE] Failed to parse event data');
            }
          },
          onError: (error) => {
            if (!cancelled) {
              logger.error('[Collaboration-SSE] Connection error:', error);
            }
            return true;
          },
          onAuthRefresh: async () => {
            try {
              const refreshed = await ensureServerSession(true);
              return refreshed.token;
            } catch {
              return null;
            }
          },
          shouldReconnect: () => !cancelled && !!useAppStore.getState().activeCollaborationSession,
          maxBackoffMs: 15000,
          baseBackoffMs: 1000,
        });

        return () => {
          cancelled = true;
          consumer.close();
        };
      })
      .catch((error) => {
        logger.error('[Collaboration-SSE] Failed to initialize:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCollaborationSession, isServerWorkspaceReady, isAuthenticated]);
}
