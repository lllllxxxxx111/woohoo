import { useEffect, type MutableRefObject, useRef } from 'react';
import type { AiTask } from '../../lib/serverApi';
import {
  ensureServerSession,
  listCollaborationMessages,
  streamCollaborationEvents,
} from '../../lib/serverApi';
import { createSseClient, type SseClientController, type SseEvent } from '../../lib/sse-client';
import { logger } from '../../lib/logger';
import {
  canTransition,
  EventDeduplicator,
  isTerminalStatus,
  mapTaskStatusToMessageStatus,
  normalizeTaskStatus,
  stateOrder,
  STATE_MESSAGES,
  type TaskLifecycleStatus,
} from '../../lib/task-state-machine';
import { useAppStore } from '../../store';
import type { Message, MessageMeta } from '../../types';

const QUEUED_TASK_PLACEHOLDER = STATE_MESSAGES.queued.title;
const RUNNING_TASK_PLACEHOLDER = STATE_MESSAGES.running.title;
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
  eventSeq?: number;
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
    taskStatus: normalizeTaskStatus(task.status) as MessageMeta['taskStatus'],
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
 * stale task detection: only marks tasks as missing after sustained lack of events,
 * NOT immediately on disconnect. Threshold is generous (2 minutes).
 */
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
 * Maximum time (ms) without any event before we consider a task "missing".
 * This is a generous threshold — normal disconnect/reconnect cycles should
 * recover within seconds via cursor replay, so we only flag missing after
 * sustained failure.
 */
const MISSING_TASK_TIMEOUT_MS = 120_000; // 2 minutes
/**
 * Debounce window for batching multiple terminal events into one refresh.
 */
const WORKSPACE_REFRESH_DEBOUNCE_MS = 300;

/**
 * Minimum interval between workspace refreshes (throttle).
 * Prevents refresh storms when many tasks complete rapidly.
 */
const WORKSPACE_REFRESH_MIN_INTERVAL_MS = 2000;

/**
 * Stale-check interval: how often to check for tasks that haven't received events.
 */
const STALE_CHECK_INTERVAL_MS = 10_000;

/**
 * A task with no events for this long during an active connection is considered
 * stale and may be marked missing. During normal operation the server sends
 * keepalives every 15s; we use 45s to tolerate a couple of missed keepalives
 * before alerting the user.
 */
const STALE_TASK_THRESHOLD_MS = 45_000;

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
  const sseClientRef = useRef<SseClientController | null>(null);
  const missingCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastEventTimeRef = useRef<Map<string, number>>(new Map());
  const eventDedupRef = useRef<EventDeduplicator>(new EventDeduplicator(1000));
  /**
   * Tracks the highest known status per task for out-of-order protection.
   * Keyed by taskId -> { status: TaskLifecycleStatus, order: number }.
   */
  const taskStateRef = useRef<Map<string, { status: TaskLifecycleStatus; order: number }>>(new Map());
  const workspaceRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTaskCountRef = useRef(pendingTaskCount);
  pendingTaskCountRef.current = pendingTaskCount;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sseClientRef.current?.close();
      if (missingCheckRef.current) clearInterval(missingCheckRef.current);
      if (workspaceRefreshTimerRef.current) clearTimeout(workspaceRefreshTimerRef.current);
    };
  }, []);

  // Connect/disconnect based on pending tasks and readiness
  useEffect(() => {
    const shouldConnect = isServerWorkspaceReady && isAuthenticated && pendingTaskCount > 0;

    if (!shouldConnect) {
      sseClientRef.current?.close();
      sseClientRef.current = null;
      if (missingCheckRef.current) {
        clearInterval(missingCheckRef.current);
        missingCheckRef.current = null;
      }
      useAppStore.getState().setSseConnected(false);
      return;
    }

    // Already connected?
    if (sseClientRef.current) return;

    let cancelled = false;
    let workspaceRefreshScheduled = false;
    let lastWorkspaceRefreshAt = 0;

    const scheduleWorkspaceRefresh = () => {
      if (workspaceRefreshTimerRef.current) clearTimeout(workspaceRefreshTimerRef.current);
      const now = Date.now();
      const elapsed = now - lastWorkspaceRefreshAt;
      // Throttle: don't refresh more often than MIN_INTERVAL
      const delay = elapsed >= WORKSPACE_REFRESH_MIN_INTERVAL_MS
        ? WORKSPACE_REFRESH_DEBOUNCE_MS
        : Math.max(WORKSPACE_REFRESH_DEBOUNCE_MS, WORKSPACE_REFRESH_MIN_INTERVAL_MS - elapsed);
      workspaceRefreshTimerRef.current = setTimeout(async () => {
        if (cancelled) {
          workspaceRefreshScheduled = false;
          return;
        }
        try {
          await refreshWorkspaceAfterTaskCompletion();
          lastWorkspaceRefreshAt = Date.now();
        } catch (error) {
          logger.error('[AppContext-SSE] Failed to refresh workspace after task completion', error);
        }
        workspaceRefreshScheduled = false;
      }, delay);
      workspaceRefreshScheduled = true;
    };

    // Start stale task checker
    lastEventTimeRef.current = new Map();
    taskStateRef.current = new Map();
    // Re-seed event times for all currently pending tasks
    pendingTaskMapRef.current.forEach((_task, taskId) => {
      lastEventTimeRef.current.set(taskId, Date.now());
    });

    if (missingCheckRef.current) clearInterval(missingCheckRef.current);
    missingCheckRef.current = setInterval(() => {
      if (cancelled || pendingTaskMapRef.current.size === 0) return;

      const now = Date.now();
      const staleIds = collectStalePendingTaskIds(
        pendingTaskMapRef.current,
        lastEventTimeRef.current,
        now,
        MISSING_TASK_TIMEOUT_MS,
      );

      if (staleIds.length === 0) return;

      staleIds.forEach((id) => {
        const pendingTask = pendingTaskMapRef.current.get(id);
        if (!pendingTask) return;

        pendingTaskMapRef.current.delete(id);
        lastEventTimeRef.current.delete(id);
        taskStateRef.current.delete(id);
        eventDedupRef.current.remove(id);
        updateMessageLocally(
          pendingTask.projectId,
          pendingTask.chatId,
          pendingTask.placeholderMessageId,
          (message) => ({
            ...message,
            role: 'system',
            content: `任务异常：${STATE_MESSAGES.missing.detail}`,
            status: 'error',
            model: undefined,
            meta: {
              ...(message.meta ?? {}),
              taskId: id,
              taskStatus: 'missing',
              lastError: STATE_MESSAGES.missing.detail,
            },
          }),
        );
      });

      syncPendingTaskCount();
    }, STALE_CHECK_INTERVAL_MS);

    /**
     * Process a task update with out-of-order and idempotency protection.
     */
    const handleTaskUpdate = (task: AiTask, eventSeq?: number) => {
      if (cancelled) return;

      const pendingTask = pendingTaskMapRef.current.get(task.id);
      if (!pendingTask) return;

      const incomingStatus = normalizeTaskStatus(task.status);
      const incomingOrder = stateOrder(incomingStatus);
      const currentState = taskStateRef.current.get(task.id);

      // Out-of-order/terminal state guard
      if (currentState && !canTransition(currentState.status, incomingStatus)) {
        // Old event trying to overwrite newer/terminal state — ignore the state
        // transition but still update timestamps to prevent false missing detection.
        lastEventTimeRef.current.set(task.id, Date.now());
        return;
      }

      // Event-level deduplication by eventSeq
      if (eventSeq !== undefined && eventSeq > 0) {
        if (!eventDedupRef.current.check(task.id, eventSeq)) {
          // Already processed this event for this task
          lastEventTimeRef.current.set(task.id, Date.now());
          return;
        }
      }

      lastEventTimeRef.current.set(task.id, Date.now());
      taskStateRef.current.set(task.id, { status: incomingStatus, order: incomingOrder });

      let requiresWorkspaceRefresh = false;

      // Scope mismatch check
      if (
        task.projectId !== pendingTask.projectId ||
        task.conversationId !== pendingTask.conversationId
      ) {
        pendingTaskMapRef.current.delete(task.id);
        lastEventTimeRef.current.delete(task.id);
        taskStateRef.current.delete(task.id);
        updateMessageLocally(
          pendingTask.projectId,
          pendingTask.chatId,
          pendingTask.placeholderMessageId,
          (message) => ({
            ...message,
            role: 'system',
            content: `任务异常：${STATE_MESSAGES.scope_mismatch.detail}`,
            status: 'error',
            model: undefined,
            meta: {
              ...(message.meta ?? {}),
              taskId: task.id,
              taskStatus: 'scope_mismatch',
              lastError: STATE_MESSAGES.scope_mismatch.detail,
            },
          }),
        );
        syncPendingTaskCount();
        return;
      }

      const messageStatus = mapTaskStatusToMessageStatus(incomingStatus);
      const isTerminal = isTerminalStatus(incomingStatus);

      switch (incomingStatus) {
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
              meta: mergeTaskMessageMeta(message.meta, { ...task, status: incomingStatus }, pendingTask.provider),
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
              meta: mergeTaskMessageMeta(message.meta, { ...task, status: incomingStatus }, pendingTask.provider),
            }),
          );
          break;

        case 'blocked':
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              content:
                message.content.trim() && !isGenericTaskPlaceholder(message.content)
                  ? message.content
                  : STATE_MESSAGES.blocked.title,
              status: 'pending',
              model: task.model || pendingTask.requestedModel,
              meta: mergeTaskMessageMeta(message.meta, { ...task, status: incomingStatus }, pendingTask.provider),
            }),
          );
          break;

        case 'completed':
          requiresWorkspaceRefresh = true;
          pendingTaskMapRef.current.delete(task.id);
          lastEventTimeRef.current.delete(task.id);
          taskStateRef.current.delete(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              content: task.result?.trim() || STATE_MESSAGES.completed.detail || '任务已完成，但没有返回内容。',
              status: 'done',
              model: task.model || pendingTask.requestedModel,
              meta: mergeTaskMessageMeta(message.meta, { ...task, status: incomingStatus }, pendingTask.provider),
            }),
          );
          break;

        case 'failed':
          requiresWorkspaceRefresh = true;
          pendingTaskMapRef.current.delete(task.id);
          lastEventTimeRef.current.delete(task.id);
          taskStateRef.current.delete(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role: 'system',
              content: `${STATE_MESSAGES.failed.title}：${task.error || task.lastError || '未知错误'}`,
              status: 'error',
              model: undefined,
              meta: mergeTaskMessageMeta(message.meta, { ...task, status: incomingStatus }, pendingTask.provider),
            }),
          );
          break;

        case 'cancelled':
          requiresWorkspaceRefresh = true;
          pendingTaskMapRef.current.delete(task.id);
          lastEventTimeRef.current.delete(task.id);
          taskStateRef.current.delete(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role: 'system',
              content: `${STATE_MESSAGES.cancelled.title}：${task.error || task.lastError || '用户取消'}`,
              status: messageStatus,
              model: undefined,
              meta: mergeTaskMessageMeta(message.meta, { ...task, status: incomingStatus }, pendingTask.provider),
            }),
          );
          break;

        default:
          break;
      }

      syncPendingTaskCount();

      if (requiresWorkspaceRefresh && !workspaceRefreshScheduled) {
        scheduleWorkspaceRefresh();
      }
    };

    const handleContentDelta = (task: AiTask, contentDelta: string, eventSeq?: number) => {
      if (cancelled || !contentDelta) return;

      const pendingTask = pendingTaskMapRef.current.get(task.id);
      if (!pendingTask) return;

      // Don't append content if task is already in terminal state
      const currentState = taskStateRef.current.get(task.id);
      if (currentState && isTerminalStatus(currentState.status)) return;

      // Dedup content_delta by eventSeq
      if (eventSeq !== undefined && eventSeq > 0) {
        if (!eventDedupRef.current.check(task.id, eventSeq)) return;
      }

      lastEventTimeRef.current.set(task.id, Date.now());

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
            meta: mergeTaskMessageMeta(message.meta, { ...task, status: 'running' }, pendingTask.provider),
          };
        },
      );
    };

    const handleSseEvent = (event: SseEvent) => {
      try {
        const data = JSON.parse(event.data);

        switch (event.event) {
          case 'snapshot': {
            if (Array.isArray(data.tasks)) {
              // Snapshot is authoritative — reset client-side dedup and state so
              // that snapshot tasks establish a clean new baseline (post-resync recovery).
              eventDedupRef.current.clear();
              taskStateRef.current.clear();

              // Seed last-event timestamps for all snapshot tasks that we're tracking
              const now = Date.now();
              let snapshotRequiresRefresh = false;
              data.tasks.forEach((task: AiTask) => {
                if (pendingTaskMapRef.current.has(task.id)) {
                  lastEventTimeRef.current.set(task.id, now);
                  const status = normalizeTaskStatus(task.status);
                  const order = stateOrder(status);
                  taskStateRef.current.set(task.id, { status, order });
                  if (isTerminalStatus(status)) {
                    snapshotRequiresRefresh = true;
                  }
                }
              });

              useAppStore.getState().setAiTasks(data.tasks);
              // Clear any stale sseError after successful snapshot
              useAppStore.getState().setSseError(null);

              // Apply task updates from snapshot (state refs are reset, so canTransition allows from-scratch).
              // Don't pass snapshotSeq because snapshot is a bulk state (not per-event); live events
              // after snapshot will have their own eventSeq for dedup.
              data.tasks.forEach((task: AiTask) => handleTaskUpdate(task));

              // If snapshot already contains terminal tasks, schedule a single refresh
              if (snapshotRequiresRefresh && !workspaceRefreshScheduled) {
                scheduleWorkspaceRefresh();
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
            if (data.task) {
              const seq = typeof event.id === 'string' ? parseInt(event.id, 10) : data.task.eventSeq;
              handleTaskUpdate(data.task, isNaN(seq) ? undefined : seq);
              // Update Zustand store (latest state wins, no duplicate creation)
              const store = useAppStore.getState();
              const existing = store.aiTasks.find((t) => t.id === data.task.id);
              if (existing) {
                store.setAiTasks(store.aiTasks.map((t) => (t.id === data.task.id ? data.task : t)));
              } else {
                store.setAiTasks([...store.aiTasks, data.task]);
              }
            }
            break;
          }

          case 'context': {
            // Agent runtime state updates (attempt index, busy/idle, etc.)
            if (data.task) {
              const pendingTask = pendingTaskMapRef.current.get(data.task.id);
              if (pendingTask) {
                lastEventTimeRef.current.set(data.task.id, Date.now());
                updateMessageLocally(
                  pendingTask.projectId,
                  pendingTask.chatId,
                  pendingTask.placeholderMessageId,
                  (message) => ({
                    ...message,
                    meta: mergeTaskMessageMeta(
                      message.meta,
                      { ...data.task, status: data.task.status || 'running' },
                      pendingTask.provider,
                    ),
                  }),
                );
              }
            }
            break;
          }

          case 'content_delta': {
            if (data.task && typeof data.contentDelta === 'string') {
              const seq = typeof event.id === 'string' ? parseInt(event.id, 10) : data.task.eventSeq;
              handleContentDelta(data.task, data.contentDelta, isNaN(seq) ? undefined : seq);
            }
            break;
          }

          case 'resync': {
            logger.warn(
              `[AppContext-SSE] Resync requested: ${data.reason || 'unknown'} — ${data.message || ''}`,
            );
            // Server says our cursor is expired. The client will automatically
            // reconnect (the SSE client handles this), and the snapshot event
            // on reconnect will bring us up to date. Force a workspace refresh
            // as a safety net.
            if (!workspaceRefreshScheduled) {
              scheduleWorkspaceRefresh();
            }
            // Don't abort — let the SSE client's reconnect handle it
            break;
          }

          case 'lagged': {
            logger.warn(
              `[AppContext-SSE] Lagged behind, skipped ${data.skipped ?? '?'} events. Reconnecting for replay...`,
            );
            // SSE client will reconnect with Last-Event-ID for replay
            sseClientRef.current?.reconnect();
            break;
          }

          case 'done': {
            // Stream ended; SSE client handles reconnect
            break;
          }

          default:
            // Unknown event type, ignore
            break;
        }
      } catch (err) {
        logger.error('[AppContext-SSE] Failed to parse event:', err, event.data?.slice?.(0, 200));
      }
    };

    // Create SSE client
    const client = createSseClient({
      url: '/api/ai/tasks/stream',
      params: { limit: 200 },
      minReconnectDelay: 500,
      maxReconnectDelay: 15_000,
      maxRetries: 50,
      headers: { Accept: 'text/event-stream' },
      refreshToken: async () => {
        const refreshed = await ensureServerSession(true);
        return refreshed.token;
      },
      shouldReconnect: () => {
        // Don't reconnect if there are no pending tasks
        return pendingTaskCountRef.current > 0 && !cancelled;
      },
      onOpen: () => {
        useAppStore.getState().setSseConnected(true);
        useAppStore.getState().setSseError(null);
      },
      onEvent: handleSseEvent,
      onConnectionChange: (connected) => {
        useAppStore.getState().setSseConnected(connected);
        if (!connected) {
          // Don't immediately mark tasks as missing — disconnection is normal
          // during reconnect. The stale checker will catch genuine problems.
        }
      },
      onResync: (info) => {
        logger.warn(`[AppContext-SSE] Resync needed: ${info.reason} - ${info.message}`);
        useAppStore.getState().setSseError(
          `事件游标已过期，正在重新同步... (${info.reason})`,
        );
      },
      onError: (error) => {
        if (error.message === 'UNAUTHORIZED' || error.message.includes('认证') || error.message.includes('登录')) {
          markUnauthenticated();
          cancelled = true;
          return;
        }
        logger.error('[AppContext-SSE] Connection error:', error);
        useAppStore.getState().setSseError(error.message);
      },
    });

    sseClientRef.current = client;

    return () => {
      cancelled = true;
      client.close();
      sseClientRef.current = null;
      if (missingCheckRef.current) {
        clearInterval(missingCheckRef.current);
        missingCheckRef.current = null;
      }
      if (workspaceRefreshTimerRef.current) {
        clearTimeout(workspaceRefreshTimerRef.current);
        workspaceRefreshTimerRef.current = null;
      }
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

  // Collaboration SSE (separate connection)
  const activeCollaborationSession = useAppStore((state) => state.activeCollaborationSession);

  useEffect(() => {
    if (!activeCollaborationSession || !isServerWorkspaceReady || !isAuthenticated) {
      return;
    }

    const controller = streamCollaborationEvents(
      (event) => {
        try {
          // Handle SSE protocol-level events (resync)
          if (event.event === 'resync') {
            let reason = 'unknown';
            try {
              const info = JSON.parse(event.data);
              reason = info.reason || reason;
            } catch {}
            logger.warn(`[Collab-SSE] Resync needed: ${reason}`);
            // Reload collaboration state to recover from missed events
            const activeSession = useAppStore.getState().activeCollaborationSession;
            if (activeSession) {
              // Trigger a lightweight state refresh via store
              // The UI will pick up correct state from REST calls on next render
              useAppStore.getState().setSseError?.(
                `协作事件同步丢失 (${reason})，请刷新页面获取最新状态`,
              );
            }
            return;
          }

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
