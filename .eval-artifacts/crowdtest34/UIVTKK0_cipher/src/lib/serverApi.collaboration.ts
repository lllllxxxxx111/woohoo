import { getServerBaseUrl, ensureServerSession } from './serverApi';
import type {
  CollaborationSession,
  CollaborationSessionSummary,
  CreateCollaborationSessionReq,
  DispatchReq,
  DispatchResponse,
  SendCollaborationMessageReq,
  CollaborationMessage,
  LoopCheckResponse,
  AdmitResponse,
  HaltReq,
  CollaborationReadiness,
} from '../types';
import { createSseClient, type SseEvent } from './sse-client';

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

export type CollaborationSseEvent = {
  event: string;
  data: string;
};

type CreateCollaborationApiInput = {
  requestApi: RequestApi;
};

export function createCollaborationApi({ requestApi }: CreateCollaborationApiInput) {
  const createSession = async (req: CreateCollaborationSessionReq) => {
    return requestApi<CollaborationSession>('/api/collaboration/sessions', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  };

  const getSession = async (sessionId: string) => {
    return requestApi<CollaborationSessionSummary>(`/api/collaboration/sessions/${sessionId}`);
  };

  const dispatch = async (sessionId: string, req: DispatchReq) => {
    return requestApi<DispatchResponse>(`/api/collaboration/sessions/${sessionId}/dispatch`, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  };

  const sendMessage = async (sessionId: string, req: SendCollaborationMessageReq) => {
    return requestApi<CollaborationMessage>(`/api/collaboration/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  };

  /** 获取协同会话的消息列表 */
  const listMessages = async (sessionId: string) => {
    return requestApi<CollaborationMessage[]>(`/api/collaboration/sessions/${sessionId}/messages`);
  };

  /** 获取项目当前活跃的协同会话 */
  const getActiveSession = async (projectId: string, conversationId?: string) => {
    const query = new URLSearchParams({ projectId });
    if (conversationId) query.set('conversationId', conversationId);
    return requestApi<CollaborationSessionSummary | null>(
      `/api/collaboration/sessions/active?${query.toString()}`,
    );
  };

  const getReadiness = async (conversationId: string) => {
    const query = new URLSearchParams({ conversationId });
    return requestApi<CollaborationReadiness>(`/api/collaboration/readiness?${query.toString()}`);
  };

  const loopCheck = async (sessionId: string) => {
    return requestApi<LoopCheckResponse>(`/api/collaboration/sessions/${sessionId}/loop-check`, {
      method: 'POST',
    });
  };

  const admit = async (sessionId: string) => {
    return requestApi<AdmitResponse>(`/api/collaboration/sessions/${sessionId}/admit`, {
      method: 'POST',
    });
  };

  const halt = async (sessionId: string, req: HaltReq) => {
    return requestApi<CollaborationSession>(`/api/collaboration/sessions/${sessionId}/halt`, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  };

  /**
   * 订阅协作事件的 SSE 流
   * 返回 AbortController 供调用方取消订阅
   *
   * 使用健壮 SSE 客户端：支持 chunk 安全帧解析、Last-Event-ID 断点续传、
   * 401 刷新 token、指数退避重连、事件去重。协作流是长连接，断线后持续重连。
   */
  const streamEvents = (
    onEvent: (event: CollaborationSseEvent) => void,
    onError?: (error: Error) => void,
  ): AbortController => {
    const controller = new AbortController();

    void (async () => {
      try {
        const session = await ensureServerSession();
        const baseUrl = await getServerBaseUrl();

        if (controller.signal.aborted) return;

        const client = createSseClient({
          url: '/api/collaboration/events/stream',
          getBaseUrl: () => Promise.resolve(baseUrl),
          token: session.token,
          refreshToken: async () => {
            const refreshed = await ensureServerSession(true);
            return refreshed.token;
          },
          minReconnectDelay: 500,
          maxReconnectDelay: 15_000,
          maxRetries: 50,
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
          shouldReconnect: () => !controller.signal.aborted,
          onEvent: (event: SseEvent) => {
            onEvent({ event: event.event, data: event.data });
          },
          onError: (error) => {
            if (error.message === 'UNAUTHORIZED') return;
            onError?.(error);
          },
        });

        controller.signal.addEventListener('abort', () => {
          client.close();
        }, { once: true });
      } catch (err) {
        if (!controller.signal.aborted) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    })();

    return controller;
  };

  return {
    createSession,
    getSession,
    getActiveSession,
    getReadiness,
    dispatch,
    sendMessage,
    listMessages,
    loopCheck,
    admit,
    halt,
    streamEvents,
  };
}
