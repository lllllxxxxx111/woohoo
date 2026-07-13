import { getServerBaseUrl } from './serverApi';
import { createSseConsumer, type SseController } from './sseConsumer';
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
   * 返回 SseController 供调用方取消订阅
   *
   * Uses the robust SSE consumer with cursor-based resume, 401 refresh,
   * proper frame parsing, and automatic reconnection.
   */
  const streamEvents = (
    onEvent: (event: CollaborationSseEvent) => void,
    onError?: (error: Error) => void,
    options?: { lastEventId?: string | null },
  ): SseController => {
    const rawSession = window.localStorage.getItem('woohoo-server-session-v1');
    const token = rawSession ? (JSON.parse(rawSession) as { token?: string }).token : undefined;

    let consumer: SseController | null = null;
    let closed = false;

    void getServerBaseUrl().then((baseUrl) => {
      if (closed) return;
      consumer = createSseConsumer({
        url: `${baseUrl}/api/collaboration/events/stream`,
        token,
        lastEventId: options?.lastEventId,
        onFrame: (frame) => {
          onEvent({ event: frame.event, data: frame.data });
          return true;
        },
        onError: (error, statusCode) => {
          if (statusCode === 401) {
            onError?.(new Error('Unauthorized'));
            return false;
          }
          onError?.(error);
          return true;
        },
        shouldReconnect: () => !closed,
        maxBackoffMs: 15000,
        baseBackoffMs: 1000,
      });
    });

    return {
      close: () => {
        closed = true;
        consumer?.close();
      },
      getLastEventId: () => consumer?.getLastEventId() ?? options?.lastEventId ?? null,
      isConnected: () => consumer?.isConnected() ?? false,
    };
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
