import { getServerBaseUrl } from './serverApi';
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
   * 返回 AbortController 供调用方取消订阅
   *
   * Uses robust SSE parsing with proper chunk boundary handling,
   * auto-reconnect, and event ID tracking.
   */
  const streamEvents = (
    onEvent: (event: CollaborationSseEvent) => void,
    onError?: (error: Error) => void,
    initialCursor?: string | null,
  ): AbortController => {
    const controller = new AbortController();

    const rawSession = window.localStorage.getItem('woohoo-server-session-v1');
    const token = rawSession ? (JSON.parse(rawSession) as { token?: string }).token : undefined;

    void (async () => {
      try {
        const baseUrl = await getServerBaseUrl();
        const url = `${baseUrl}/api/collaboration/events/stream`;

        const { createSseConsumer } = await import('./sseConsumer');

        const consumer = createSseConsumer({
          url,
          token: token ?? null,
          initialLastEventId: initialCursor ?? null,
          autoReconnect: true,
          maxReconnectDelayMs: 15000,
          onEvent: (event) => {
            onEvent({ event: event.event, data: event.data });
          },
          onError: (err) => {
            if (!controller.signal.aborted) {
              onError?.(err);
            }
          },
          shouldReconnect: () => !controller.signal.aborted,
        });

        controller.signal.addEventListener('abort', () => {
          consumer.stop();
        });

        void consumer.connect();
      } catch (error) {
        if (!controller.signal.aborted) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
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
