import { getServerBaseUrl } from './serverApi';
import type { AiTask, AiUsageBucket, AiUsageRecord, AiUsageSummary } from './serverApi';
import { createSseConsumer, type SseController, type SseEvent } from './sseConsumer';
import { SeenEventTracker } from './taskStateSemantics';

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
   * Subscribe to Pipeline Run SSE events.
   * Returns an AbortController for cancellation.
   * Uses robust SSE consumer with Last-Event-ID cursor replay,
   * exponential backoff reconnection, and idempotent event deduplication.
   * On resync_required (cursor expired / server restart), performs an HTTP
   * GET of the run summary and emits a synthetic "snapshot" event before
   * reconnecting so the UI is consistent without waiting for the next event.
   */
  const streamPipelineRun = (
    runId: string,
    onEvent: (event: PipelineSseEvent) => void,
    onError?: (error: Error) => void,
    onDone?: () => void,
  ): AbortController => {
    const controller = new AbortController();
    const seenEvents = new SeenEventTracker();
    let consumer: SseController | null = null;
    let terminated = false;

    const rawSession = window.localStorage.getItem('woohoo-server-session-v1');
    const token = rawSession ? (JSON.parse(rawSession) as { token?: string }).token : undefined;

    const emitSynthetic = (eventType: string, payload: unknown) => {
      if (terminated) return;
      onEvent({ event: eventType, data: JSON.stringify(payload) });
    };

    const performPipelineResync = async (reason: string) => {
      try {
        const summary = await getPipelineRun(runId);
        emitSynthetic('snapshot', { reason, run: summary.run, steps: summary.steps });
        return true;
      } catch (err) {
        emitSynthetic('resync_failed', { reason, error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    };

    void (async () => {
      try {
        const baseUrl = await getServerBaseUrl();
        const url = `${baseUrl}/api/pipelines/runs/${runId}/stream`;

        consumer = createSseConsumer({
          url,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
          onEvent: (event: SseEvent) => {
            if (terminated) return;

            // Idempotency check using event ID. Skip ID-less events
            // (snapshot/synthetic events) but they still get delivered once.
            if (event.id) {
              const key = `pipe:${runId}:${event.id}`;
              if (!seenEvents.checkAndAdd(key)) return;
            }

            const sseEvent: PipelineSseEvent = { event: event.event, data: event.data };
            onEvent(sseEvent);

            if (event.event === 'done') {
              terminated = true;
              onDone?.();
              consumer?.close();
            }
          },
          onError: (error: Error) => {
            if (controller.signal.aborted || terminated) return false;
            onError?.(error);
            return true; // Keep reconnecting
          },
          onResyncRequired: (reason: string) => {
            // Kick off an HTTP resync to recover current run state
            // without waiting for the next real event; reconnect is
            // scheduled by the consumer after we return true.
            void performPipelineResync(reason);
            return true;
          },
          shouldReconnect: () => !terminated && !controller.signal.aborted,
          initialRetryMs: 2000,
          maxRetryMs: 30000,
        });
      } catch (error) {
        if (!controller.signal.aborted && !terminated) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
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
