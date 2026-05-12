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
} from '../types';

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

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
    return requestApi<CollaborationSessionSummary>(
      `/api/collaboration/sessions/${sessionId}`,
    );
  };

  const dispatch = async (sessionId: string, req: DispatchReq) => {
    return requestApi<DispatchResponse>(
      `/api/collaboration/sessions/${sessionId}/dispatch`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    );
  };

  const sendMessage = async (
    sessionId: string,
    req: SendCollaborationMessageReq,
  ) => {
    return requestApi<CollaborationMessage>(
      `/api/collaboration/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    );
  };

  const loopCheck = async (sessionId: string) => {
    return requestApi<LoopCheckResponse>(
      `/api/collaboration/sessions/${sessionId}/loop-check`,
      {
        method: 'POST',
      },
    );
  };

  const admit = async (sessionId: string) => {
    return requestApi<AdmitResponse>(
      `/api/collaboration/sessions/${sessionId}/admit`,
      {
        method: 'POST',
      },
    );
  };

  const halt = async (sessionId: string, req: HaltReq) => {
    return requestApi<CollaborationSession>(
      `/api/collaboration/sessions/${sessionId}/halt`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    );
  };

  return {
    createSession,
    getSession,
    dispatch,
    sendMessage,
    loopCheck,
    admit,
    halt,
  };
}
