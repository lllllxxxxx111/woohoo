import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  type AiTask,
  type AiTaskStatus,
  ensureServerSession,
  listCollaborationMessages,
  streamCollaborationEvents,
  listAiTasks,
} from '../../lib/serverApi';
import { logger } from '../../lib/logger';
import { useAppStore } from '../../store';
import type { Message, MessageMeta } from '../../types';
import {
  SeenEventTracker,
  shouldApplyTaskUpdate,
  getBoundaryStateMessage,
  RefreshDeduplicator,
  makeEventKey,
  isTerminalStatus,
  type BoundaryStateMessage,
} from '../../lib/taskEventSemantics';
import {
  createSseConsumer,
  type SseConsumer,
  type SseEvent,
} from '../../lib/sseConsumer';

const QUEUED_TASK_PLACEHOLDER = '任务已提交，排队中...';
const RUNNING_TASK_PLACEHOLDER = 'AI 正在处理中...';
const THINKING_TASK_PLACEHOLDER = 'AI 正在思考中...';

// ─── Types ───────────────────────────────────────────────────────────────────

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
  seq?: number | null;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function isGenericTaskPlaceholder(content: string) {
  return [QUEUED_TASK_PLACEHOLDER, RUNNING_TASK_PLACEHOLDER, THINKING_TASK_PLACEHOLDER].includes(
    content.trim(),
  );
}

// ─── Stale task detection ────────────────────────────────────────────────────

const MISSING_TASK_TIMEOUT_MS = 120_000; // 2 minutes without any event
const MISSING_RESYNC_ATTEMPTS = 2; // Try resync this many times before declaring missing

interface PendingTaskTiming {
  lastEventAt: number;
  resyncAttempts: number;
}

export function collectStalePendingTaskIds(
  pendingTasks: Map<string, PendingAiTask>,
  timings: Map<string, PendingTaskTiming>,
  now: number,
  timeoutMs: number,
) {
  const staleIds: string[] = [];

  pendingTasks.forEach((_pendingTask, taskId) => {
    const timing = timings.get(taskId);
    if (!timing) {
      timings.set(taskId, { lastEventAt: now, resyncAttempts: 0 });
      return;
    }

    if (now - timing.lastEventAt > timeoutMs) {
      staleIds.push(taskId);
    }
  });

  return staleIds;
}

// ─── Main Hook ───────────────────────────────────────────────────────────────

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
  const consumerRef = useRef<SseConsumer | null>(null);
  const seenEventsRef = useRef(new SeenEventTracker(2000));
  const taskStatusRef = useRef(new Map<string, AiTaskStatus>());
  const taskSeqRef = useRef(new Map<string, number>());
  const taskTimingsRef = useRef(new Map<string, PendingTaskTiming>());
  const refreshDedupRef = useRef(new RefreshDeduplicator(refreshWorkspaceAfterTaskCompletion, 300));
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    // SSE only needed when there are pending tasks; avoid idle connections
    if (!isServerWorkspaceReady || !isAuthenticated || pendingTaskCount <= 0) {
      if (consumerRef.current) {
        consumerRef.current.stop();
        consumerRef.current = null;
      }
      useAppStore.getState().setSseConnected(false);
      useAppStore.getState().setAiTasks([]);
      seenEventsRef.current.clear();
      taskStatusRef.current.clear();
      taskSeqRef.current.clear();
      taskTimingsRef.current.clear();
      return;
    }

    let cancelled = false;

    /**
     * Apply a boundary state (failed/cancelled/missing/scope_mismatch) to a message.
     */
    const applyBoundaryState = (
      taskId: string,
      pendingTask: PendingAiTask,
      state: BoundaryStateMessage,
      task: Partial<AiTask>,
    ) => {
      updateMessageLocally(
        pendingTask.projectId,
        pendingTask.chatId,
        pendingTask.placeholderMessageId,
        (message) => ({
          ...message,
          role: state.role,
          content: state.content,
          status: state.status,
          model: state.status === 'done' ? (task.model || pendingTask.requestedModel) : undefined,
          meta: mergeTaskMessageMeta(
            message.meta,
            {
              id: taskId,
              status:
                state.status === 'done'
                  ? 'completed'
                  : (task.status as string) || 'failed',
              ...task,
            },
            pendingTask.provider,
          ),
        }),
      );
    };

    /**
     * Process a single task update with idempotency and order protection.
     */
    const handleTaskUpdate = (task: AiTask, eventSeq?: number | null) => {
      if (cancelled) return;

      // Track status and seq for ALL tasks (even unregistered ones) so that
      // when a task is registered later (after API response), we can immediately
      // reconcile against the latest known state from snapshot/live events.
      const currentStatus = taskStatusRef.current.get(task.id);
      const currentSeq = taskSeqRef.current.get(task.id) ?? null;
      if (shouldApplyTaskUpdate(task.status, currentStatus, eventSeq ?? null, currentSeq)) {
        taskStatusRef.current.set(task.id, task.status);
        if (eventSeq != null) {
          taskSeqRef.current.set(task.id, eventSeq);
        }
      } else {
        // Stale/duplicate event — ignore even for unregistered tasks
        return;
      }

      const pendingTask = pendingTaskMapRef.current.get(task.id);
      if (!pendingTask) {
        // Task not registered yet (API response hasn't arrived). We tracked
        // state above; the registration flow will reconcile.
        return;
      }

      const now = Date.now();
      const timing = taskTimingsRef.current.get(task.id);
      if (timing) {
        timing.lastEventAt = now;
        timing.resyncAttempts = 0;
      } else {
        taskTimingsRef.current.set(task.id, { lastEventAt: now, resyncAttempts: 0 });
      }

      // Scope mismatch check — server task belongs to different project/chat
      if (
        task.projectId !== pendingTask.projectId ||
        task.conversationId !== pendingTask.conversationId
      ) {
        pendingTaskMapRef.current.delete(task.id);
        taskTimingsRef.current.delete(task.id);
        taskSeqRef.current.delete(task.id);
        const boundary = getBoundaryStateMessage('scope_mismatch', task);
        applyBoundaryState(task.id, pendingTask, boundary, task);
        taskStatusRef.current.set(task.id, 'failed');
        syncPendingTaskCount();
        return;
      }

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

        case 'completed': {
          pendingTaskMapRef.current.delete(task.id);
          taskTimingsRef.current.delete(task.id);
          taskSeqRef.current.delete(task.id);
          const boundary = getBoundaryStateMessage('completed', task);
          applyBoundaryState(task.id, pendingTask, boundary, task);
          refreshDedupRef.current.schedule();
          break;
        }

        case 'failed': {
          pendingTaskMapRef.current.delete(task.id);
          taskTimingsRef.current.delete(task.id);
          taskSeqRef.current.delete(task.id);
          const boundary = getBoundaryStateMessage('failed', task);
          applyBoundaryState(task.id, pendingTask, boundary, task);
          refreshDedupRef.current.schedule();
          break;
        }

        case 'cancelled': {
          pendingTaskMapRef.current.delete(task.id);
          taskTimingsRef.current.delete(task.id);
          taskSeqRef.current.delete(task.id);
          const boundary = getBoundaryStateMessage('cancelled', task);
          applyBoundaryState(task.id, pendingTask, boundary, task);
          break;
        }

        default:
          break;
      }

      syncPendingTaskCount();
    };

    /**
     * Handle streaming content deltas.
     */
    const handleTaskContentDelta = (task: AiTask, contentDelta: string, eventSeq?: number | null) => {
      if (cancelled || !contentDelta) return;

      const pendingTask = pendingTaskMapRef.current.get(task.id);
      if (!pendingTask) return;

      // Don't apply deltas to terminal tasks
      const currentStatus = taskStatusRef.current.get(task.id);
      if (currentStatus && isTerminalStatus(currentStatus)) return;

      // Seq-based stale check
      if (eventSeq != null) {
        const currentSeq = taskSeqRef.current.get(task.id);
        if (currentSeq != null && eventSeq <= currentSeq) return;
        taskSeqRef.current.set(task.id, eventSeq);
      }

      taskStatusRef.current.set(task.id, task.status);
      const timing = taskTimingsRef.current.get(task.id);
      if (timing) {
        timing.lastEventAt = Date.now();
      } else {
        taskTimingsRef.current.set(task.id, { lastEventAt: Date.now(), resyncAttempts: 0 });
      }

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
            content: `${baseContent}${contentDelta}`,
            status: 'pending',
            model: task.model || pendingTask.requestedModel,
            meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
          };
        },
      );
    };

    /**
     * Perform a resync: fetch current task state from REST API and reconcile.
     * Called after a resync signal or when detecting stale tasks.
     */
    const performResync = async (reason: string) => {
      logger.info(`[SSE] Performing resync: ${reason}`);

      // Update store's aiTasks with fresh data
      try {
        const tasks = await listAiTasks({ limit: 200 });
        useAppStore.getState().setAiTasks(tasks);

        // Process each pending task from the resync data
        const pendingIds = new Set(pendingTaskMapRef.current.keys());
        for (const task of tasks) {
          if (pendingIds.has(task.id)) {
            handleTaskUpdate(task, task.seq ?? null);
          }
        }

        // Check for tasks that are still pending on the client but not in the server list
        // These may have completed and been cleaned up
        const serverTaskIds = new Set(tasks.map((t) => t.id));
        for (const taskId of Array.from(pendingIds)) {
          if (!serverTaskIds.has(taskId)) {
            // Task is gone from server; it likely completed and was evicted after retention
            const pendingTask = pendingTaskMapRef.current.get(taskId);
            if (pendingTask) {
              const timing = taskTimingsRef.current.get(taskId);
              if (timing) {
                timing.resyncAttempts++;
                if (timing.resyncAttempts >= MISSING_RESYNC_ATTEMPTS) {
                  // Mark as missing after failed resync attempts
                  pendingTaskMapRef.current.delete(taskId);
                  taskTimingsRef.current.delete(taskId);
                  taskSeqRef.current.delete(taskId);
                  const boundary = getBoundaryStateMessage('missing', {
                    error: '任务在服务端已不存在，可能已过期或被清理',
                  });
                  applyBoundaryState(taskId, pendingTask, boundary, {
                    status: 'failed',
                    error: '任务在服务端已不存在',
                  });
                  syncPendingTaskCount();
                }
              }
            }
          }
        }
      } catch (err) {
        logger.warn('[SSE] Resync failed:', err);
      }
    };

    /**
     * Handle a parsed SSE event from the task stream.
     */
    const handleSseEvent = (event: SseEvent) => {
      const { event: eventType, data: dataStr, id: eventId } = event;

      // Update last event ID for reconnection
      if (eventId) {
        lastEventIdRef.current = eventId;
      }

      if (eventType === 'keepalive') return;

      try {
        const data = JSON.parse(dataStr);

        switch (eventType) {
          case 'snapshot': {
            if (Array.isArray(data.tasks)) {
              // Reset seen events for snapshot
              useAppStore.getState().setAiTasks(data.tasks);
              for (const task of data.tasks) {
                // Check idempotency for snapshot tasks
                const key = makeEventKey('snapshot', task, task.seq ?? data.cursor ?? null);
                if (seenEventsRef.current.checkAndMark(key)) {
                  handleTaskUpdate(task, task.seq ?? data.cursor ?? null);
                }
              }
              // Update timings for all known pending tasks from snapshot
              const now = Date.now();
              pendingTaskMapRef.current.forEach((_task, taskId) => {
                const timing = taskTimingsRef.current.get(taskId);
                if (timing) {
                  timing.lastEventAt = now;
                } else {
                  taskTimingsRef.current.set(taskId, { lastEventAt: now, resyncAttempts: 0 });
                }
              });
            }
            break;
          }

          case 'queued':
          case 'running':
          case 'completed':
          case 'failed':
          case 'cancelled': {
            if (data.task) {
              const seq = data.task.seq ?? data.seq ?? null;
              const key = makeEventKey(eventType, data.task, seq);
              // Update store
              const store = useAppStore.getState();
              store.setAiTasks(
                store.aiTasks.map((t) => (t.id === data.task.id ? data.task : t)),
              );

              // Only process if not a duplicate
              if (seenEventsRef.current.checkAndMark(key)) {
                handleTaskUpdate(data.task, seq);
              }
            }
            break;
          }

          case 'content_delta': {
            if (data.task && typeof data.contentDelta === 'string') {
              const seq = data.task.seq ?? data.seq ?? null;
              const key = makeEventKey('content_delta', data.task, seq, data.contentDelta);
              if (seenEventsRef.current.checkAndMark(key)) {
                handleTaskContentDelta(data.task, data.contentDelta, seq);
              }
            }
            break;
          }

          case 'resync': {
            logger.warn(
              `[SSE] Resync signal received: ${data.reason || 'unknown'} - ${data.message || ''}`,
            );
            // Clear seen events and force resync.
            // Server sends resync for: cursor_expired, lagged, cursor_invalid.
            seenEventsRef.current.clear();
            performResync(data.reason || 'server_signal');
            break;
          }

          // Collaboration events are handled by separate stream
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
            break;

          default:
            logger.debug(`[SSE] Unhandled event type: ${eventType}`);
            break;
        }
      } catch (err) {
        logger.error('[SSE] Failed to parse event data:', err, dataStr);
      }
    };

    // ─── Stale task detection interval ─────────────────────────────────────
    const missingCheckInterval = setInterval(() => {
      if (cancelled || pendingTaskMapRef.current.size === 0) return;

      const now = Date.now();
      const staleIds = collectStalePendingTaskIds(
        pendingTaskMapRef.current,
        taskTimingsRef.current,
        now,
        MISSING_TASK_TIMEOUT_MS,
      );

      if (staleIds.length === 0) return;

      for (const id of staleIds) {
        const pendingTask = pendingTaskMapRef.current.get(id);
        if (!pendingTask) continue;

        const timing = taskTimingsRef.current.get(id);
        if (!timing) continue;

        // Try resync first before declaring missing
        void performResync(`stale_task_${id}`);
      }
    }, 30_000);

    // ─── Create SSE Consumer ───────────────────────────────────────────────
    const ssePath = '/api/ai/tasks/stream?limit=200';

    // Resolve base URL and token first, then create a single consumer
    // to avoid the race of a premature unauthenticated request.
    const initializeConnection = async () => {
      if (cancelled) return;

      try {
        const session = await ensureServerSession(false);

        // Import getServerBaseUrl and resolve full URL
        const { getServerBaseUrl } = await import('../../lib/serverApi');
        const baseUrl = await getServerBaseUrl();
        const fullUrl = `${baseUrl}${ssePath}`;

        if (cancelled) return;

        const sseConsumer = createSseConsumer({
          url: fullUrl,
          initialLastEventId: lastEventIdRef.current,
          token: session.token,
          onEvent: handleSseEvent,
          onStateChange: (state) => {
            useAppStore.getState().setSseConnected(state === 'open');
            if (state === 'error') {
              useAppStore.getState().setSseError('SSE connection error');
            } else if (state === 'open') {
              useAppStore.getState().setSseError(null);
            }
          },
          onError: (err) => {
            logger.error('[SSE] Consumer error:', err);
          },
          shouldReconnect: () => {
            return !cancelled && pendingTaskMapRef.current.size > 0;
          },
          onUnauthorized: async () => {
            try {
              const refreshed = await ensureServerSession(true);
              return refreshed.token;
            } catch {
              markUnauthenticated();
              return null;
            }
          },
          maxReconnectDelayMs: 30_000,
          baseReconnectDelayMs: 1_000,
        });

        if (cancelled) {
          sseConsumer.stop();
          return;
        }

        consumerRef.current = sseConsumer;
        void sseConsumer.connect();
      } catch (err) {
        logger.warn('[SSE] Failed to initialize connection:', err);
        markUnauthenticated();
      }
    };

    void initializeConnection();

    return () => {
      cancelled = true;
      consumerRef.current?.stop();
      consumerRef.current = null;
      clearInterval(missingCheckInterval);
      refreshDedupRef.current.cancel();
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

  // ─── Reconciliation for newly registered tasks ────────────────────────────
  // When a task is registered via API response, SSE may have already seen a
  // terminal state for it. Check and apply if so.
  const prevPendingCountRef = useRef(0);
  useEffect(() => {
    if (pendingTaskCount <= prevPendingCountRef.current) {
      prevPendingCountRef.current = pendingTaskCount;
      return;
    }
    prevPendingCountRef.current = pendingTaskCount;

    pendingTaskMapRef.current.forEach((pendingTask, taskId) => {
      const knownStatus = taskStatusRef.current.get(taskId);
      if (!knownStatus || !isTerminalStatus(knownStatus)) return;

      const storeTask = useAppStore.getState().aiTasks.find((t) => t.id === taskId);
      if (!storeTask) return;

      // Clear refs to avoid double-processing
      taskStatusRef.current.delete(taskId);
      taskSeqRef.current.delete(taskId);
      taskTimingsRef.current.delete(taskId);
      pendingTaskMapRef.current.delete(taskId);

      const boundaryType = knownStatus === 'completed'
        ? 'completed'
        : knownStatus === 'cancelled'
          ? 'cancelled'
          : 'failed';
      const boundary = getBoundaryStateMessage(boundaryType, storeTask);

      updateMessageLocally(
        pendingTask.projectId,
        pendingTask.chatId,
        pendingTask.placeholderMessageId,
        (message) => ({
          ...message,
          role: boundary.role,
          content: boundary.content,
          status: boundary.status,
          meta: {
            ...message.meta,
            taskId,
            taskStatus: boundaryType,
          },
        }),
      );

      if (boundary.requiresRefresh) {
        refreshDedupRef.current.schedule();
      }
      syncPendingTaskCount();
    });
  }, [pendingTaskCount, pendingTaskMapRef, syncPendingTaskCount, updateMessageLocally]);

  // ─── Collaboration SSE (separate stream) ──────────────────────────────────

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
