import { useEffect, type MutableRefObject } from 'react';
import { type AiTask, ensureServerSession, fetchServer, streamCollaborationEvents } from '../../lib/serverApi';
import { logger } from '../../lib/logger';
import { useAppStore } from '../../store';
import type { Message, MessageMeta } from '../../types';

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
    // SSE 仅用于跟踪 pending 任务状态；无任务时不占用连接，避免无意义重连噪音
    if (!isServerWorkspaceReady || !isAuthenticated || pendingTaskCount <= 0) {
      useAppStore.getState().setSseConnected(false);
      useAppStore.getState().setAiTasks([]);
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    let workspaceRefreshScheduled = false;

    /**
     * 记录每个 pending 任务最后收到事件的时间戳
     * 用于超时检测：若长时间未收到任何事件，才判定为可能丢失
     */
    const lastEventTimeRef = new Map<string, number>();
    const MISSING_TASK_TIMEOUT_MS = 120000;

    /**
     * 防抖刷新 workspace（多个终端态任务合并为一次刷新）
     */
    const scheduleWorkspaceRefresh = () => {
      setTimeout(async () => {
        if (cancelled) {
          workspaceRefreshScheduled = false;
          return;
        }

        try {
          await refreshWorkspaceAfterTaskCompletion();
        } catch (error) {
          logger.error('[AppContext-SSE] Failed to refresh workspace after task completion', error);
        }
        workspaceRefreshScheduled = false;
      }, 300);
    };

    /**
     * 定期扫描超时未更新的 pending 任务，标记为可能丢失
     * 解决 snapshot 截断（limit=200 按创建时间排序）导致老任务被误判的问题
     */
    const missingCheckInterval = setInterval(() => {
      if (cancelled || pendingTaskMapRef.current.size === 0) {
        return;
      }

      const now = Date.now();
      const staleIds: string[] = [];

      lastEventTimeRef.forEach((lastTime, id) => {
        if (now - lastTime > MISSING_TASK_TIMEOUT_MS && pendingTaskMapRef.current.has(id)) {
          staleIds.push(id);
        }
      });

      if (staleIds.length === 0) {
        return;
      }

      staleIds.forEach((id) => {
        const pendingTask = pendingTaskMapRef.current.get(id);
        if (!pendingTask) {
          return;
        }

        pendingTaskMapRef.current.delete(id);
        lastEventTimeRef.delete(id);
        updateMessageLocally(
          pendingTask.projectId,
          pendingTask.chatId,
          pendingTask.placeholderMessageId,
          (message) => ({
            ...message,
            role: 'system',
            content: '任务异常中止：长时间未收到服务端状态更新，请发起重试。',
            status: 'error',
            model: undefined,
            meta: {
              ...(message.meta ?? {}),
              taskId: id,
              taskStatus: 'missing',
              lastError: '长时间未收到服务端状态更新',
            },
          }),
        );
      });

      syncPendingTaskCount();
    }, 30000);

    /**
     * 处理单个任务的聊天消息更新
     */
    const handleTaskUpdate = (task: AiTask) => {
      if (cancelled) {
        return;
      }

      const pendingTask = pendingTaskMapRef.current.get(task.id);
      if (!pendingTask) {
        return;
      }

      lastEventTimeRef.set(task.id, Date.now());

      let requiresWorkspaceRefresh = false;

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
            content: '任务返回的会话作用域异常，已拒绝回写到当前对话。',
            status: 'error',
            model: undefined,
            meta: {
              ...(message.meta ?? {}),
              taskId: task.id,
              taskStatus: 'scope_mismatch',
              lastError: '任务返回的会话作用域异常',
            },
          }),
        );
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

        case 'completed':
          requiresWorkspaceRefresh = true;
          pendingTaskMapRef.current.delete(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              content: task.result?.trim() || '任务已完成，但没有返回内容。',
              status: 'done',
              model: task.model || pendingTask.requestedModel,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
            }),
          );
          break;

        case 'failed':
          requiresWorkspaceRefresh = true;
          pendingTaskMapRef.current.delete(task.id);
          updateMessageLocally(
            pendingTask.projectId,
            pendingTask.chatId,
            pendingTask.placeholderMessageId,
            (message) => ({
              ...message,
              role: 'system',
              content: `任务失败：${task.error || '未知错误'}`,
              status: 'error',
              model: undefined,
              meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
            }),
          );
          break;

        default:
          break;
      }

      syncPendingTaskCount();

      if (requiresWorkspaceRefresh && !workspaceRefreshScheduled) {
        workspaceRefreshScheduled = true;
        scheduleWorkspaceRefresh();
      }
    };

    const handleTaskContentDelta = (task: AiTask, contentDelta: string) => {
      if (cancelled || !contentDelta) {
        return;
      }

      const pendingTask = pendingTaskMapRef.current.get(task.id);
      if (!pendingTask) {
        return;
      }

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
            content: `${baseContent}${contentDelta}`,
            status: 'pending',
            model: task.model || pendingTask.requestedModel,
            meta: mergeTaskMessageMeta(message.meta, task, pendingTask.provider),
          };
        },
      );
    };

    /**
     * 用 snapshot 更新所有已知任务的最后事件时间戳（不做缺失判定）
     * 缺失判定由 10s 间隔的定时器基于超时机制完成，避免 snapshot 截断误判
     */
    const syncSnapshotTimestamps = (snapshotTasks: AiTask[]) => {
      if (cancelled) {
        return;
      }

      snapshotTasks.forEach((task) => {
        if (pendingTaskMapRef.current.has(task.id)) {
          lastEventTimeRef.set(task.id, Date.now());
        }
      });
    };

    /**
     * 处理ReadableStream读取SSE数据流
     */
    async function processStream(body: ReadableStream<Uint8Array>) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEventType: string | null = null;

      try {
        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            const parsed = parseSSELine(trimmed);
            if (!parsed) {
              continue;
            }

            if (parsed.eventType !== null) {
              currentEventType = parsed.eventType;
            }

            if (parsed.data) {
              handleSSEEvent(currentEventType, parsed.data);
              currentEventType = null;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    /**
     * 分发SSE事件到对应的处理函数
     */
    function handleSSEEvent(eventType: string | null, dataStr: string) {
      try {
        const data = JSON.parse(dataStr);

        switch (eventType || 'message') {
          case 'snapshot':
            if (Array.isArray(data.tasks)) {
              syncSnapshotTimestamps(data.tasks);
              useAppStore.getState().setAiTasks(data.tasks);
              data.tasks.forEach((task: AiTask) => handleTaskUpdate(task));
            }
            break;

          case 'queued':
          case 'running':
          case 'completed':
          case 'failed':
          case 'cancelled':
            if (data.task) {
              handleTaskUpdate(data.task);
              const store = useAppStore.getState();
              store.setAiTasks(store.aiTasks.map((t) => (t.id === data.task.id ? data.task : t)));
            }
            break;

          case 'content_delta':
            if (data.task && typeof data.contentDelta === 'string') {
              handleTaskContentDelta(data.task, data.contentDelta);
            }
            break;

          case 'lagged':
            logger.warn(
              `[AppContext-SSE] Lagged behind, skipped ${data.skipped} events, forcing re-sync`,
            );
            if (!cancelled && !abortController.signal.aborted) {
              abortController.abort();
              setTimeout(connectSSE, 500);
            }
            break;

          case 'collaboration_session_created':
            if (data.sessionId) {
              useAppStore.getState().setCollaborationSession({
                id: data.sessionId,
                userId: '',
                projectId: data.projectId || '',
                conversationId: '',
                state: data.state || 'discovery',
                roundCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
            }
            break;

          case 'collaboration_assignment_updated':
            if (data.assignmentId) {
              const store = useAppStore.getState();
              const existing = store.activeCollaborationAssignments;
              const updated = existing.map((a) =>
                a.id === data.assignmentId
                  ? { ...a, status: data.newStatus || a.status }
                  : a,
              );
              if (!existing.some((a) => a.id === data.assignmentId)) {
                updated.push({
                  id: data.assignmentId,
                  sessionId: '',
                  agentId: data.agentId || '',
                  taskType: '',
                  goal: '',
                  status: data.newStatus || 'assigned',
                  blockingQuestionCount: 0,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                });
              }
              store.setCollaborationAssignments(updated);
            }
            break;

          case 'collaboration_queue_updated':
            if (data.sessionId) {
              const session = useAppStore.getState().activeCollaborationSession;
              if (session && session.id === data.sessionId) {
                useAppStore.getState().setCollaborationSession({
                  ...session,
                  replyQueueJson: JSON.stringify(data.replyQueue || []),
                });
              }
            }
            break;

          case 'collaboration_question_asked':
          case 'collaboration_question_answered':
            break;

          case 'collaboration_loop_warning':
            if (data.level !== undefined) {
              useAppStore.getState().setCollaborationLoopCheckResult({
                loopDetected: true,
                signals: data.signals || [],
                level: data.level,
                action: data.action || '',
                message: data.message || '',
              });
            }
            break;

          case 'collaboration_admission_changed':
            if (data.admitted && data.sessionId) {
              const session = useAppStore.getState().activeCollaborationSession;
              if (session && session.id === data.sessionId) {
                useAppStore.getState().setCollaborationSession({
                  ...session,
                  state: 'workspace_admission',
                });
              }
            }
            break;

          case 'collaboration_workspace_started':
            if (data.sessionId) {
              const session = useAppStore.getState().activeCollaborationSession;
              if (session && session.id === data.sessionId) {
                useAppStore.getState().setCollaborationSession({
                  ...session,
                  state: 'workspace_execution',
                });
              }
            }
            break;

          default:
            break;
        }
      } catch (err) {
        logger.error('[AppContext-SSE] Failed to parse event:', err);
      }
    }

    /**
     * 建立基于fetch的SSE连接，替代原有的1.5s轮询
     */
    const connectSSE = async () => {
      try {
        const session = await ensureServerSession(false);
        const url = '/api/ai/tasks/stream?limit=200';

        const response = await fetchServer(url, {
          headers: {
            Authorization: `Bearer ${session.token}`,
            Accept: 'text/event-stream',
          },
          signal: abortController.signal,
        });

        if (!response.ok) {
          if (response.status === 401 && !cancelled) {
            const refreshed = await ensureServerSession(true);
            const retryResponse = await fetchServer(url, {
              headers: {
                Authorization: `Bearer ${refreshed.token}`,
                Accept: 'text/event-stream',
              },
              signal: abortController.signal,
            });
            if (!retryResponse.ok) {
              throw new Error(`SSE 401重试失败 (${retryResponse.status})`);
            }
            if (retryResponse.body) {
              await processStream(retryResponse.body);
            }
          } else {
            throw new Error(`SSE连接失败 (${response.status})`);
          }
        } else if (response.body) {
          useAppStore.getState().setSseConnected(true);
          useAppStore.getState().setSseError(null);
          await processStream(response.body);
        }

        /**
         * 服务端正常断流（done）或处理完毕后，若未取消则自动重连
         */
        if (!cancelled && !abortController.signal.aborted) {
          useAppStore.getState().setSseConnected(false);
          logger.info('[AppContext-SSE] Stream ended, reconnecting in 3s...');
          setTimeout(connectSSE, 3000);
        }
      } catch (err) {
        useAppStore.getState().setSseConnected(false);

        // 优雅处理所有类型的连接中断（不输出控制台错误）
        if (err instanceof DOMException && err.name === 'AbortError') {
          return; // 用户主动取消或组件卸载，静默返回
        }
        // 处理网络层中断（ERR_ABORTED、NetworkError 等）
        if (
          cancelled ||
          abortController.signal.aborted ||
          (err instanceof TypeError && (
            err.message.includes('Failed to fetch') ||
            err.message.includes('NetworkError') ||
            err.message.includes('aborted')
          ))
        ) {
          return; // 连接被正常中断，静默返回
        }
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          markUnauthenticated();
          return;
        }

        // 只有真正的异常才输出日志并重试
        logger.error('[AppContext-SSE] Connection error:', err);
        useAppStore.getState().setSseError(err instanceof Error ? err.message : String(err));

        if (!cancelled) {
          setTimeout(connectSSE, 3000);
        }
      }
    };

    void connectSSE();

    return () => {
      cancelled = true;
      abortController.abort();
      clearInterval(missingCheckInterval);
      lastEventTimeRef.clear();
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
   * 独立协作 SSE 连接：当存在活跃协作会话时自动建立，
   * 直接消费 /api/collaboration/events/stream 端点
   */
  const activeCollaborationSession = useAppStore(
    (state) => state.activeCollaborationSession,
  );

  useEffect(() => {
    if (!activeCollaborationSession || !isServerWorkspaceReady || !isAuthenticated) {
      return;
    }

    const controller = streamCollaborationEvents(
      (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (event.event) {
            case 'collaboration_session_created':
              if (data.sessionId) {
                useAppStore.getState().setCollaborationSession({
                  id: data.sessionId,
                  userId: '',
                  projectId: data.projectId || '',
                  conversationId: '',
                  state: data.state || 'discovery',
                  roundCount: 0,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                });
              }
              break;

            case 'collaboration_assignment_updated':
              if (data.assignmentId) {
                const store = useAppStore.getState();
                const existing = store.activeCollaborationAssignments;
                const updated = existing.map((a) =>
                  a.id === data.assignmentId
                    ? { ...a, status: data.newStatus || a.status }
                    : a,
                );
                if (!existing.some((a) => a.id === data.assignmentId)) {
                  updated.push({
                    id: data.assignmentId,
                    sessionId: '',
                    agentId: data.agentId || '',
                    taskType: '',
                    goal: '',
                    status: data.newStatus || 'assigned',
                    blockingQuestionCount: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  });
                }
                store.setCollaborationAssignments(updated);
              }
              break;

            case 'collaboration_queue_updated':
              if (data.sessionId) {
                const session = useAppStore.getState().activeCollaborationSession;
                if (session && session.id === data.sessionId) {
                  useAppStore.getState().setCollaborationSession({
                    ...session,
                    replyQueueJson: JSON.stringify(data.replyQueue || []),
                  });
                }
              }
              break;

            case 'collaboration_loop_warning':
              if (data.level !== undefined) {
                useAppStore.getState().setCollaborationLoopCheckResult({
                  loopDetected: true,
                  signals: data.signals || [],
                  level: data.level,
                  action: data.action || '',
                  message: data.message || '',
                });
              }
              break;

            case 'collaboration_admission_changed':
              if (data.admitted && data.sessionId) {
                const session = useAppStore.getState().activeCollaborationSession;
                if (session && session.id === data.sessionId) {
                  useAppStore.getState().setCollaborationSession({
                    ...session,
                    state: 'workspace_admission',
                  });
                }
              }
              break;

            case 'collaboration_workspace_started':
              if (data.sessionId) {
                const session = useAppStore.getState().activeCollaborationSession;
                if (session && session.id === data.sessionId) {
                  useAppStore.getState().setCollaborationSession({
                    ...session,
                    state: 'workspace_execution',
                  });
                }
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
