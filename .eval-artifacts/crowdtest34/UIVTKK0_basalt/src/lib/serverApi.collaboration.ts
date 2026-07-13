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
import { createSseConsumer, type SseEvent } from './sseConsumer';
import { SeenEventTracker } from './taskStateSemantics';

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
   * Subscribe to collaboration SSE events.
   * Returns AbortController for cancellation.
   * Uses robust SSE consumer with Last-Event-ID replay,
   * exponential backoff, and idempotent deduplication.
   */
  const streamEvents = (
    onEvent: (event: CollaborationSseEvent) => void,
    onError?: (error: Error) => void,
  ): AbortController => {
    const controller = new AbortController();
    const seenEvents = new SeenEventTracker();
    let stopped = false;

    const rawSession = window.localStorage.getItem('woohoo-server-session-v1');
    const token = rawSession ? (JSON.parse(rawSession) as { token?: string }).token : undefined;

    void (async () => {
      try {
        const baseUrl = await getServerBaseUrl();
        const url = `${baseUrl}/api/collaboration/events/stream`;

        createSseConsumer({
          url,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
          onEvent: (event: SseEvent) => {
            if (stopped) return;

            // Idempotency via event ID
            if (event.id) {
              const key = `collab:${event.id}`;
              if (!seenEvents.checkAndAdd(key)) return;
            }

            onEvent({ event: event.event, data: event.data });
          },
          onError: (error: Error) => {
            if (controller.signal.aborted || stopped) return false;
            onError?.(error);
            return true; // Keep reconnecting
          },
          onResyncRequired: () => true,
          shouldReconnect: () => !stopped && !controller.signal.aborted,
          initialRetryMs: 2000,
          maxRetryMs: 30000,
        });
      } catch (error) {
        if (!controller.signal.aborted && !stopped) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    // Patch abort to also set stopped flag
    const originalAbort = controller.abort.bind(controller);
    controller.abort = () => {
      stopped = true;
      originalAbort();
    };

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
