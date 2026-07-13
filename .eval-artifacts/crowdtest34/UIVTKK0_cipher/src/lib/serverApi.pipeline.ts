import { getServerBaseUrl, ensureServerSession } from './serverApi';
import type { AiTask, AiUsageBucket, AiUsageRecord, AiUsageSummary } from './serverApi';
import { createSseClient, type SseEvent } from './sse-client';

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

type UsageQueryParams = {
  days?: number;
  bucket?: AiUsageBucket;
  projectId?: string;
  conversationId?: string;
  agentId?: string;
  endpointId?: string;
  apiKeyFingerprint?: string;
  resourceKind?: string;
  model?: string;
  operation?: string;
  status?: string;
  limit?: number;
};

type TaskListParams = {
  projectId?: string;
  conversationId?: string;
  limit?: number;
};

export type PipelineRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PipelineStepStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'retrying';

export interface PipelineRun {
  id: string;
  userId: string;
  projectId: string;
  conversationId: string;
  pipelineType: string;
  triggerSource: string;
  status: PipelineRunStatus;
  idempotencyKey: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  errorMessage: string | null;
  errorCode: string | null;
}

export interface PipelineRunStep {
  id: string;
  runId: string;
  stepKey: string;
  stepName: string;
  stepOrder: number;
  aiTaskId: string | null;
  status: PipelineStepStatus;
  attemptCount: number;
  maxRetries: number;
  durationMs: number;
  inputSummary: string | null;
  outputRef: string | null;
  errorMessage: string | null;
  lastErrorAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineRunSummary {
  run: PipelineRun;
  steps: PipelineRunStep[];
  recentEvents: PipelineRunEvent[];
  outputs: PipelineStepOutput[];
  reviews: PipelineManualReview[];
}

export interface PipelineRunEvent {
  id: string;
  runId: string;
  stepId: string | null;
  eventType: string;
  payloadJson: string | null;
  source: string;
  createdAt: string;
}

export interface PipelineStepOutput {
  id: string;
  runId: string;
  stepId: string;
  taskId?: string | null;
  outputType: string;
  outputJson?: string | null;
  rawContent?: string | null;
  reviewDecision?: string | null;
  reviewScore?: number | null;
  reviewIssuesJson?: string | null;
  retryHintsJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PipelinePromptOptimization {
  id: string;
  runId: string;
  stepId: string;
  projectId: string;
  conversationId: string;
  decision: string;
  designPromptPatch: string | null;
  reviewPromptPatch: string | null;
  rationaleJson: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewDecisionType = 'retry' | 'cancel' | 'acknowledge';

export interface PipelineManualReview {
  id: string;
  userId: string;
  runId: string;
  stepId: string;
  decision: ReviewDecisionType;
  note: string | null;
  createdAt: string;
}

export interface ReviewQueueItem {
  run: PipelineRun;
  step: PipelineRunStep;
  latestEvent: PipelineRunEvent | null;
  latestErrorEvent: PipelineRunEvent | null;
  optimizationCount: number;
  reviewCount: number;
  latestReview: PipelineManualReview | null;
  projectName: string | null;
  conversationTitle: string | null;
}

export interface ReviewQueueResponse {
  items: ReviewQueueItem[];
  total: number;
  limit: number;
  offset: number;
}

export type ReviewQueueParams = {
  projectId?: string;
  status?: PipelineStepStatus | string;
  pipelineType?: string;
  limit?: number;
  offset?: number;
};

export type SubmitReviewDecisionInput = {
  decision: ReviewDecisionType;
  note?: string;
};

export type SubmitReviewDecisionResult = {
  success: boolean;
  reviewId: string;
  decision: ReviewDecisionType;
  run: PipelineRun | null;
  step: PipelineRunStep | null;
};

export interface CreatePipelineRunInput {
  projectId: string;
  conversationId: string;
  pipelineType?: string;
  triggerSource?: string;
  betaEnabled?: boolean;
  idempotencyKey?: string;
  steps: Array<{
    stepKey: string;
    stepName: string;
    stepOrder: number;
    stepType?: 'design' | 'review' | 'system';
    dependsOn?: string[];
    reviewPolicy?: Record<string, unknown>;
    maxRetries?: number;
    promptTemplate?: string;
  }>;
}

type ListPipelineRunsParams = {
  projectId?: string;
  conversationId?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

function appendDefinedQuery(query: URLSearchParams, params: Record<string, unknown>) {
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      query.append(key, value.toString());
    }
  });
}

export type PipelineSseEvent = {
  event: string;
  data: string;
};

export function createUsageTaskPipelineApi(requestApi: RequestApi) {
  const getUsageSummary = async (params?: UsageQueryParams): Promise<AiUsageSummary> => {
    const query = new URLSearchParams();
    if (params) {
      appendDefinedQuery(query, params);
    }
    return requestApi<AiUsageSummary>(`/api/ai/usage/summary?${query.toString()}`);
  };

  const getUsageRecords = async (params?: UsageQueryParams): Promise<AiUsageRecord[]> => {
    const query = new URLSearchParams();
    if (params) {
      appendDefinedQuery(query, params);
    }
    return requestApi<AiUsageRecord[]>(`/api/ai/usage/records?${query.toString()}`);
  };

  const listAiTasks = async (params?: TaskListParams): Promise<AiTask[]> => {
    const query = new URLSearchParams();
    if (params) {
      appendDefinedQuery(query, params);
    }
    return requestApi<AiTask[]>(`/api/ai/tasks?${query.toString()}`);
  };

  const getAiTask = async (id: string): Promise<AiTask> => {
    return requestApi<AiTask>(`/api/ai/tasks/${id}`);
  };

  const createPipelineRun = async (input: CreatePipelineRunInput): Promise<PipelineRun> => {
    return requestApi<PipelineRun>('/api/pipelines/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  };

  const getPipelineRun = async (id: string): Promise<PipelineRunSummary> => {
    return requestApi<PipelineRunSummary>(`/api/pipelines/runs/${id}`);
  };

  const getPipelineOptimizations = async (id: string): Promise<PipelinePromptOptimization[]> => {
    return requestApi<PipelinePromptOptimization[]>(`/api/pipelines/runs/${id}/optimizations`);
  };

  const listPipelineRuns = async (params?: ListPipelineRunsParams): Promise<PipelineRun[]> => {
    const query = new URLSearchParams();
    if (params?.projectId) query.set('project_id', params.projectId);
    if (params?.conversationId) query.set('conversation_id', params.conversationId);
    if (params?.status) query.set('status', params.status);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return requestApi<PipelineRun[]>(`/api/pipelines/runs${qs ? `?${qs}` : ''}`);
  };

  const pausePipelineRun = async (id: string, reason?: string): Promise<PipelineRun> => {
    return requestApi<PipelineRun>(`/api/pipelines/runs/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  };

  const resumePipelineRun = async (id: string): Promise<PipelineRun> => {
    return requestApi<PipelineRun>(`/api/pipelines/runs/${id}/resume`, {
      method: 'POST',
    });
  };

  const cancelPipelineRun = async (id: string, reason?: string): Promise<PipelineRun> => {
    return requestApi<PipelineRun>(`/api/pipelines/runs/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  };

  const retryPipelineStep = async (
    runId: string,
    stepId: string,
    reason?: string,
  ): Promise<PipelineRunStep> => {
    return requestApi<PipelineRunStep>(`/api/pipelines/runs/${runId}/retry-step`, {
      method: 'POST',
      body: JSON.stringify({ stepId, reason }),
    });
  };

  const getReviewQueue = async (params?: ReviewQueueParams): Promise<ReviewQueueResponse> => {
    const query = new URLSearchParams();
    if (params?.projectId) query.set('projectId', params.projectId);
    if (params?.status) query.set('status', params.status);
    if (params?.pipelineType) query.set('pipelineType', params.pipelineType);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return requestApi<ReviewQueueResponse>(`/api/pipelines/review-queue${qs ? `?${qs}` : ''}`);
  };

  const submitReviewDecision = async (
    runId: string,
    stepId: string,
    input: SubmitReviewDecisionInput,
  ): Promise<SubmitReviewDecisionResult> => {
    return requestApi<SubmitReviewDecisionResult>(
      `/api/pipelines/runs/${runId}/steps/${stepId}/review-decision`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  };

  const listStepReviews = async (
    runId: string,
    stepId: string,
  ): Promise<PipelineManualReview[]> => {
    return requestApi<PipelineManualReview[]>(
      `/api/pipelines/runs/${runId}/steps/${stepId}/reviews`,
    );
  };

  /**
   * 订阅 Pipeline Run 的 SSE 事件流
   * 返回一个 AbortController 供调用方取消订阅
   *
   * 使用健壮 SSE 客户端：支持 chunk 安全帧解析、Last-Event-ID 断点续传、
   * 401 刷新 token、指数退避重连、事件去重、resync 信号处理。
   * 收到 done 事件或流结束后自动停止（不无限重连）。
   */
  const streamPipelineRun = (
    runId: string,
    onEvent: (event: PipelineSseEvent) => void,
    onError?: (error: Error) => void,
    onDone?: () => void,
  ): AbortController => {
    const controller = new AbortController();

    // Async initialize: get token, then connect
    void (async () => {
      try {
        const session = await ensureServerSession();
        const baseUrl = await getServerBaseUrl();

        if (controller.signal.aborted) return;

        const client = createSseClient({
          url: `/api/pipelines/runs/${runId}/stream`,
          getBaseUrl: () => Promise.resolve(baseUrl),
          token: session.token,
          refreshToken: async () => {
            const refreshed = await ensureServerSession(true);
            return refreshed.token;
          },
          minReconnectDelay: 500,
          maxReconnectDelay: 15_000,
          maxRetries: 20,
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
          shouldReconnect: () => {
            // Pipeline runs terminate — don't reconnect after receiving terminal events
            // The server will send 'done' when the run completes, which closes the connection.
            // If we get disconnected mid-run (network blip), reconnect with cursor.
            return !controller.signal.aborted;
          },
          onEvent: (event: SseEvent) => {
            // Translate SseEvent to legacy PipelineSseEvent shape for backward compat
            onEvent({ event: event.event, data: event.data });
          },
          onDone: () => {
            onDone?.();
          },
          onClose: () => {
            // Stream closed — if not aborted and not done, this was likely a network disconnect
            // The SSE client handles reconnect internally; onDone is called on terminal done.
          },
          onError: (error) => {
            if (error.message === 'UNAUTHORIZED') return;
            onError?.(error);
          },
        });

        // Wire up abort to close client
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
    getUsageSummary,
    getUsageRecords,
    listAiTasks,
    getAiTask,
    createPipelineRun,
    getPipelineRun,
    getPipelineOptimizations,
    listPipelineRuns,
    pausePipelineRun,
    resumePipelineRun,
    cancelPipelineRun,
    retryPipelineStep,
    getReviewQueue,
    submitReviewDecision,
    listStepReviews,
    streamPipelineRun,
  };
}
