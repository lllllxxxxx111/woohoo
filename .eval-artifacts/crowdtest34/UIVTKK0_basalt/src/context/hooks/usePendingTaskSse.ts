import { useEffect, type MutableRefObject } from 'react';
import {
  type AiTask,
  ensureServerSession,
  fetchServer,
  getServerBaseUrl,
  listCollaborationMessages,
  streamCollaborationEvents,
} from '../../lib/serverApi';
import { logger } from '../../lib/logger';
import { useAppStore } from '../../store';
import type { Message, MessageMeta } from '../../types';
import { createSseConsumer, type SseEvent } from '../../lib/sseConsumer';
import {
  SeenEventTracker,
  formatTerminalTaskContent,
  isTerminalStatus,
  makeTaskEventKey,
  MISSING_TASK_GRACE_PERIOD_MS,
  MISSING_TASK_TIMEOUT_MS,
  shouldApplyTaskEvent,
  TASK_STATE_MESSAGES,
} from '../../lib/taskStateSemantics';

const QUEUED_TASK_PLACEHOLDER = '任务已提交，排队中...';
const RUNNING_TASK_PLACEHOLDER = 'AI 正在处理中...';
const THINKING_TASK_PLACEHOLDER = 'AI 正在思考中...';

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
  finishedAt?: number | null;
};

export function mergeTaskMessageMeta(
  currentMeta: MessageMeta | undefined,
  task: TaskMessageMetaSource,
  provider: string,
): MessageMeta {
  return {
    ...(currentMeta ?? {}),
    provider,
    taskId: task.id,
    taskStatus: task.status as MessageMeta['taskStatus'],
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

function parseSSELine(line: string): { eventType: string | null; data: string } | null {
  if (line.startsWith('event: ')) {
    return { eventType: line.slice(7).trim(), data: '' };
  }
  if (line.startsWith('data: ')) {
    return { eventType: null, data: line.slice(6).trim() };
  }
  return null;
}

function isGenericTaskPlaceholder(content: string) {
  return [QUEUED_TASK_PLACEHOLDER, RUNNING_TASK_PLACEHOLDER, THINKING_TASK_PLACEHOLDER].includes(
    content.trim(),
  );
}

export function collectStalePendingTaskIds(
  pendingTasks: Map<string, PendingAiTask>,
  lastEventTimes: Map<string, number>,
  now: number,
  timeoutMs: number,
) {
  const staleIds: string[] = [];

  pendingTasks.forEach((_pendingTask, taskId) => {
    const lastEventTime = lastEventTimes.get(taskId);
    if (lastEventTime === undefined) {
      lastEventTimes.set(taskId, now);
      return;
    }

    if (now - lastEventTime > timeoutMs) {
      staleIds.push(taskId);
    }
  });

  return staleIds;
}

/**
 * Track the current known status for each task (for idempotency/ordering).
 */
interface TaskRuntimeState {
  status: string;
  finishedAt: number | null;
  lastEventSeq: number;
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
    // SSE only tracks pending tasks; no tasks = no connection to avoid reconnect noise
    if (!isServerWorkspaceReady || !isAuthenticated || pendingTaskCount <= 0) {
      useAppStore.getState().setSseConnected(false);
      useAppStore.getState().setAiTasks([]);
      return;
    }

    let cancelled = false;
    let workspaceRefreshScheduled = false;
    let resyncInFlight: Promise<boolean> | null = null;
    let lastResyncAt = 0;
    const RESYNC_COOLDOWN_MS = 2000;
    const seenEvents = new SeenEventTracker();
    const taskRuntimeState = new Map<string, TaskRuntimeState>();
    const lastEventTimeRef = new Map<string, number>();
    let disconnectStartTime: number | null = null;
    let resyncAttemptedAfterDisconnect = false;

    /**
     * Debounced workspace refresh (coalesce multiple terminal tasks)
     */
    const scheduleWorkspaceRefresh = () => {
      if (workspaceRefreshScheduled) return;
      workspaceRefreshScheduled = true;
      setTimeout(async () => {
        if (cancelled) {
          workspaceRefreshScheduled = false;
          return;
        }
        try {
          await refreshWorkspaceAfterTaskCompletion();
        } catch (error) {
          logger.error('[SSE] Failed to refresh workspace after task completion', error);
        }
        workspaceRefreshScheduled = false;
      }, 300);
    };

    /**
     * Perform an explicit resync via REST API when cursor expires or lagged.
     * Deduplicates concurrent/rapid-fire calls via in-flight promise + cooldown.
     * Returns true on success, false on failure (caller may surface to user).
     */
    const performResync = async (reason: string): Promise<boolean> => {
      // Coalesce concurrent resync calls
      if (resyncInFlight) return resyncInFlight;
      // Cooldown: don't spam HTTP resyncs
      const now = Date.now();
      if (now - lastResyncAt < RESYNC_COOLDOWN_MS) return true;
      lastResyncAt = now;

      resyncInFlight = (async () => {
        try {
          const session = await ensureServerSession(false);
          const response = await fetchServer('/api/ai/tasks?limit=200', {
            headers: {
              Authorization: `Bearer ${session.token}`,
            },
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const tasks: AiTask[] = await response.json();
          useAppStore.getState().setAiTasks(tasks);
          useAppStore.getState().setSseError(null);

          // Apply current state for each pending task - these are authoritative (server state),
          // so bypass ordering guards to correct any stale UI after reconnect.
          for (const task of tasks) {
            if (pendingTaskMapRef.current.has(task.id)) {
              applyTaskUpdate(task, null, { authoritative: true });
            }
          }

          // Tasks that were pending locally but no longer exist in server state
          // (e.g. cleaned up after TTL) should be surfaced as resync_failed.
          const serverTaskIds = new Set(tasks.map((t) => t.id));
          for (const [taskId, pending] of Array.from(pendingTaskMapRef.current.entries())) {
            if (!serverTaskIds.has(taskId)) {
              // Only mark missing if we've had grace period; otherwise leave for
              // next event or subsequent resync.
              if (disconnectStartTime && Date.now() - disconnectStartTime > MISSING_TASK_GRACE_PERIOD_MS) {
                markTaskMissing(taskId);
              }
            }
          }

          logger.info(`[SSE] Resync complete (${reason}): ${tasks.length} tasks`);
          return true;
        } catch (error) {
          logger.warn(`[SSE] Resync failed (${reason}):`, error);
          useAppStore.getState().setSseError(TASK_STATE_MESSAGES.resync_failed.prefix);
          return false;
        } finally {
          resyncInFlight = null;
        }
      })();

      return resyncInFlight;
    };

    /**
     * Mark a task as missing after threshold exceeded.
     */
    const markTaskMissing = (taskId: string, reason?: string) => {
      const pendingTask = pendingTaskMapRef.current.get(taskId);
      if (!pendingTask) return;

      pendingTaskMapRef.current.delete(taskId);
      lastEventTimeRef.delete(taskId);
      taskRuntimeState.delete(taskId);
      seenEvents.clearTask(taskId);

      const message = reason ?? TASK_STATE_MESSAGES.missing.prefix;

      updateMessageLocally(
        pendingTask.projectId,
        pendingTask.chatId,
        pendingTask.placeholderMessageId,
        (msg) => ({
          ...msg,
          role: 'system',
          content: message,
          status: 'error',
          model: undefined,
          meta: {
            ...(msg.meta ?? {}),
            taskId,
            taskStatus: 'missing',
            lastError: message,
          },
        }),
      );
      syncPendingTaskCount();
    };

    /**
     * Periodic check for stale/missing tasks.
     * Only marks missing after MISSING_TASK_GRACE_PERIOD_MS of disconnect,
     * or after MISSING_TASK_TIMEOUT_MS total without events.
     */
    const missingCheckInterval = setInterval(() => {
      if (cancelled || pendingTaskMapRef.current.size === 0) return;

      const now = Date.now();
      const staleIds = collectStalePendingTaskIds(
        pendingTaskMapRef.current,
        lastEventTimeRef,
        now,
        MISSING_TASK_TIMEOUT_MS,
      );

      for (const id of staleIds) {
        // Only mark missing if we've had a chance to resync after disconnect
        if (disconnectStartTime && now - disconnectStartTime < MISSING_TASK_GRACE_PERIOD_MS) {
          continue;
        }
        markTaskMissing(id);
      }

      // Periodically evict old seen events
      seenEvents.evictStale();
    }, 30_000);

    /**
     * Apply a task update to the message, respecting idempotency and ordering.
     * When `authoritative` is true (resync/snapshot), ordering guards are bypassed
     * because the server state is the source of truth.
     */
    const applyTaskUpdate = (
      task: AiTask,
      contentDelta: string | null,
      opts: { authoritative?: boolean } = {},
    ) => {
      if (cancelled) return;

      const pendingTask = pendingTaskMapRef.current.get(task.id);
      if (!pendingTask) return;

      lastEventTimeRef.set(task.id, Date.now());

      // Scope mismatch guard
      if (
        task.projectId !== pendingTask.projectId ||
        task.conversationId !== pendingTask.conversationId
      ) {
        pendingTaskMapRef.current.delete(task.id);
        const msg = TASK_STATE_MESSAGES.scope_mismatch.prefix;
        updateMessageLocally(
          pendingTask.projectId,
          pendingTask.chatId,
          pendingTask.placeholderMessageId,
          (message) => ({
            ...message,
            role: 'system',
            content: msg,
            status: 'error',
            model: undefined,
            meta: {
              ...(message.meta ?? {}),
              taskId: task.id,
              taskStatus: 'scope_mismatch',
              lastError: msg,
            },
          }),
        );
        syncPendingTaskCount();
        return;
      }

      // Get current runtime state for ordering check
      const current = taskRuntimeState.get(task.id);
      const currentStatus = current?.status;
      const currentFinishedAt = current?.finishedAt ?? null;

      // Ordering/idempotency check: skip if this event is older than current state.
      // Bypass when `authoritative` (resync/snapshot from server).
      if (
        !opts.authoritative &&
        contentDelta === null &&
        !shouldApplyTaskEvent(currentStatus, task.status, currentFinishedAt, task.finishedAt ?? null)
      ) {
        // Still update the store task list but don't modify the message
        const store = useAppStore.getState();
        store.setAiTasks(store.aiTasks.map((t) => (t.id === task.id ? task : t)));
        return;
      }

      let requiresWorkspaceRefresh = false;
      const isTerminal = isTerminalStatus(task.status);

      // Update runtime state tracker
      taskRuntimeState.set(task.id, {
        status: task.status,
        finishedAt: task.finishedAt ?? null,
        lastEventSeq: current?.lastEventSeq ?? 0,
      });

      switch (task.status) {
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
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
            }),
          );
          break;

        case 'running':
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              content:
                message.content.trim() && !isGenericTaskPlaceholder(message.content)
                  ? message.content
                  : RUNNING_TASK_PLACEHOLDER,
              status: 'pending',
              model: task.model || pendingTask.requestedModel,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
            }),
          );
          break;

        case 'blocked': {
          requiresWorkspaceRefresh = true;
          const { content, role } = formatTerminalTaskContent(task);
          pendingTaskMapRef.current.delete(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role,
              content,
              status: 'error',
              model: undefined,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
            }),
          );
          break;
        }

        case 'completed': {
          requiresWorkspaceRefresh = true;
          const { content, role } = formatTerminalTaskContent(task);
          pendingTaskMapRef.current.delete(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role,
              content,
              status: 'done',
              model: task.model || pendingTask.requestedModel,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
            }),
          );
          break;
        }

        case 'failed':
        case 'cancelled': {
          requiresWorkspaceRefresh = true;
          const { content, role } = formatTerminalTaskContent(task);
          pendingTaskMapRef.current.delete(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role,
              content,
              status: 'error',
              model: undefined,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
            }),
          );
          break;
        }

        default:
          break;
      }

      syncPendingTaskCount();

      if (requiresWorkspaceRefresh) {
        scheduleWorkspaceRefresh();
      }

      // Update store
      const store = useAppStore.getState();
      store.setAiTasks(
        store.aiTasks.map((t) => (t.id === task.id ? { ...t, ...task } : t)),
      );

      // Clean up tracker for removed tasks
      if (isTerminal) {
        seenEvents.clearTask(task.id);
        taskRuntimeState.delete(task.id);
      }
    };

    /**
     * Apply a content delta (idempotent: uses seq to prevent double-apply).
     * Rejects deltas after terminal state (final content already replaced placeholder).
     */
    const applyContentDelta = (task: AiTask, delta: string, seq?: string) => {
      if (cancelled || !delta) return;

      const pendingTask = pendingTaskMapRef.current.get(task.id);
      if (!pendingTask) return;

      // Block deltas after terminal state: final content is set by completed/failed/etc,
      // so any late streaming delta must not append to (or overwrite) the final message.
      const current = taskRuntimeState.get(task.id);
      if (current && isTerminalStatus(current.status)) {
        return;
      }

      // Idempotency check for delta
      const deltaKey = makeTaskEventKey(task.id, 'content_delta', seq);
      if (!seenEvents.checkAndAdd(deltaKey)) return;

      lastEventTimeRef.set(task.id, Date.now());

      updateMessageLocally(
        pendingTask.projectId,
        pendingTask.chatId,
        pendingTask.placeholderMessageId,
        (message) => {
          const baseContent =
            message.content.trim() && !isGenericTaskPlaceholder(message.content)
              ? message.content
              : '';

          return {
            ...message,
            content: `${baseContent}${delta}`,
            status: 'pending',
            model: task.model || pendingTask.requestedModel,
            meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
          };
        },
      );
    };

    /**
     * Process a parsed SSE event.
     */
    const handleSSEEvent = (event: SseEvent) => {
      if (cancelled) return;

      disconnectStartTime = null; // We received an event, connection is alive

      try {
        switch (event.event) {
          case 'snapshot': {
            const data = JSON.parse(event.data);
            if (Array.isArray(data.tasks)) {
              useAppStore.getState().setAiTasks(data.tasks);
              // Snapshot events carry authoritative server state (e.g. after reconnect/lag),
              // so apply them bypassing ordering guards to correct any stale UI.
              for (const task of data.tasks) {
                const pendingTask = pendingTaskMapRef.current.get(task.id);
                if (pendingTask) {
                  lastEventTimeRef.set(task.id, Date.now());
                  applyTaskUpdate(task, null, { authoritative: true });
                }
              }
            }
            break;
          }

          case 'queued':
          case 'running':
          case 'completed':
          case 'failed':
          case 'cancelled':
          case 'blocked': {
            const data = JSON.parse(event.data);
            if (data.task) {
              // Idempotency check for lifecycle events
              const eventKey = makeTaskEventKey(
                data.task.id,
                event.event,
                data.task.finishedAt ?? data.task.startedAt,
              );
              if (seenEvents.checkAndAdd(eventKey)) {
                applyTaskUpdate(data.task, null);
              } else {
                // Duplicate event - still update store but skip message effects
                const store = useAppStore.getState();
                store.setAiTasks(
                  store.aiTasks.map((t) => (t.id === data.task.id ? data.task : t)),
                );
              }
            }
            break;
          }

          case 'content_delta': {
            const data = JSON.parse(event.data);
            if (data.task && typeof data.contentDelta === 'string') {
              applyContentDelta(data.task, data.contentDelta, event.id ?? undefined);
            }
            break;
          }

          case 'context': {
            const data = JSON.parse(event.data);
            if (data.task) {
              const pendingTask = pendingTaskMapRef.current.get(data.task.id);
              if (pendingTask) {
                lastEventTimeRef.set(data.task.id, Date.now());
                updateMessageLocally(
                  pendingTask.projectId,
                  pendingTask.chatId,
                  pendingTask.placeholderMessageId,
                  (message) => ({
                    ...message,
                    meta: mergeTaskMessageMeta(message.meta, data.task, pendingTask.provider),
                  }),
                );
              }
            }
            break;
          }

          case 'resync_required': {
            const data = JSON.parse(event.data);
            logger.warn(`[SSE] Resync required: ${data.reason} - ${data.message}`);
            // Trigger async resync without blocking
            void performResync(data.reason || 'unknown');
            break;
          }

          // Collaboration events handled by separate stream
          case 'collaboration_session_created':
          case 'collaboration_assignment_updated':
          case 'collaboration_queue_updated':
          case 'collaboration_question_asked':
          case 'collaboration_question_answered':
          case 'collaboration_loop_warning':
          case 'collaboration_admission_changed':
          case 'collaboration_workspace_started':
          case 'collaboration_session_halted':
          case 'collaboration_dispatched':
          case 'collaboration_message_sent':
            break;

          default:
            break;
        }
      } catch (err) {
        logger.error('[SSE] Failed to parse event:', err);
      }
    };

    // Create the SSE consumer
    const sseController = createSseConsumer({
      url: '/api/ai/tasks/stream?limit=200',
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const baseUrl = await getServerBaseUrl();
        const fullUrl = `${baseUrl}${url}`;
        const reqHeaders = new Headers(init?.headers);
        if (!reqHeaders.has('Authorization')) {
          const session = await ensureServerSession(false);
          reqHeaders.set('Authorization', `Bearer ${session.token}`);
        }
        reqHeaders.set('Accept', 'text/event-stream');
        return fetch(fullUrl, {
          ...init,
          headers: reqHeaders,
          cache: 'no-store',
        });
      },
      onEvent: handleSSEEvent,
      onOpen: () => {
        useAppStore.getState().setSseConnected(true);
        useAppStore.getState().setSseError(null);
        disconnectStartTime = null;
        resyncAttemptedAfterDisconnect = false;
      },
      onReconnect: (attempt, delayMs) => {
        useAppStore.getState().setSseConnected(false);
        if (!disconnectStartTime) {
          disconnectStartTime = Date.now();
        }
        logger.info(`[SSE] Reconnecting (attempt ${attempt}, delay ${delayMs}ms)...`);
      },
      onResyncRequired: (reason, _data) => {
        logger.warn(`[SSE] Server requested resync: ${reason}`);
        void performResync(reason);
        resyncAttemptedAfterDisconnect = true;
        return true; // Reconnect after resync
      },
      onError: (error) => {
        useAppStore.getState().setSseConnected(false);

        if (error.message.includes('UNAUTHORIZED') || error.message.includes('401')) {
          markUnauthenticated();
          return false; // Stop reconnecting
        }

        // Max reconnect attempts reached — surface to user and stop.
        if (error.message.includes('max attempts')) {
          useAppStore.getState().setSseError(TASK_STATE_MESSAGES.resync_failed.prefix);
          // Mark all pending tasks as missing after exhausting retries
          for (const [taskId] of Array.from(pendingTaskMapRef.current.entries())) {
            markTaskMissing(taskId);
          }
          return false;
        }

        // Network errors are expected during disconnects; don't log as errors
        if (
          error.message.includes('Failed to fetch') ||
          error.message.includes('NetworkError') ||
          error.message.includes('aborted') ||
          error.name === 'AbortError'
        ) {
          if (!disconnectStartTime) {
            disconnectStartTime = Date.now();
          }
          return true; // Keep reconnecting
        }

        logger.error('[SSE] Connection error:', error);
        useAppStore.getState().setSseError(error.message);
        if (!disconnectStartTime) {
          disconnectStartTime = Date.now();
        }
        return true; // Keep reconnecting with backoff
      },
      refreshToken: async () => {
        const session = await ensureServerSession(true);
        return session.token;
      },
      shouldReconnect: () => {
        // Don't reconnect if no pending tasks or component is unmounting
        if (cancelled) return false;
        if (pendingTaskMapRef.current.size === 0) return false;
        return true;
      },
      initialRetryMs: 1000,
      maxRetryMs: 30000,
    });

    return () => {
      cancelled = true;
      sseController.close();
      clearInterval(missingCheckInterval);
      lastEventTimeRef.clear();
      taskRuntimeState.clear();
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

  /**
   * Independent collaboration SSE connection (preserved from existing code).
   */
  const activeCollaborationSession = useAppStore((state) => state.activeCollaborationSession);

  useEffect(() => {
    if (!activeCollaborationSession || !isServerWorkspaceReady || !isAuthenticated) {
      return;
    }

    const controller = streamCollaborationEvents(
      (event) => {
        try {
          const envelope = JSON.parse(event.data);
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
      (error) => {
        logger.error('[Collaboration-SSE] Connection error:', error);
      },
    );

    return () => controller.abort();
  }, [activeCollaborationSession, isServerWorkspaceReady, isAuthenticated]);
}
