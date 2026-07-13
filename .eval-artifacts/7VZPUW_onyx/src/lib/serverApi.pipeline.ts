import { getServerBaseUrl } from './serverApi';
import type { AiTask, AiUsageBucket, AiUsageRecord, AiUsageSummary } from './serverApi';
import {
  PIPELINE_MANUAL_REVIEW_DECISIONS,
  type PipelineManualReview,
  type PipelineReviewDecision,
  type PipelineReviewDecisionInput,
  type PipelineReviewDecisionResponse,
  type PipelineReviewQueueItem,
  type PipelineReviewQueueParams,
} from './pipelineReviewTypes';

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

/**
 * 复核决策响应
 */
// PipelineReviewDecisionResponse 在 pipelineReviewTypes.ts 中定义为宽松类型 (run/step 为 unknown)
// 此处再做一次窄化，供 serverApi.pipeline.ts 内部使用。不对外暴露，对外统一通过 pipelineReviewTypes.ts 导出。
type PipelineReviewDecisionResponseNarrow = {
  review: PipelineManualReview;
  run: PipelineRun;
  step: PipelineRunStep;
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

  /**
   * 订阅 Pipeline Run 的 SSE 事件流
   * 返回一个 AbortController 供调用方取消订阅
   */
  const streamPipelineRun = (
    runId: string,
    onEvent: (event: PipelineSseEvent) => void,
    onError?: (error: Error) => void,
    onDone?: () => void,
  ): AbortController => {
    const controller = new AbortController();

    const rawSession = window.localStorage.getItem('woohoo-server-session-v1');
    const token = rawSession ? (JSON.parse(rawSession) as { token?: string }).token : undefined;

    void (async () => {
      try {
        const baseUrl = await getServerBaseUrl();
        const url = `${baseUrl}/api/pipelines/runs/${runId}/stream`;

        const response = await fetch(url, {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              onEvent({ event: currentEvent || 'message', data });

              if (currentEvent === 'done') {
                onDone?.();
                controller.abort();
                return;
              }
            }
          }
        }

        onDone?.();
      } catch (error) {
        if (!controller.signal.aborted) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    return controller;
  };

  // ------ 人工复核队列 / 决策 ------

  /**
   * 列出当前用户需要人工关注的复核队列
   */
  const listReviewQueue = async (
    params?: PipelineReviewQueueParams,
  ): Promise<PipelineReviewQueueItem[]> => {
    const query = new URLSearchParams();
    if (params?.projectId) query.set('projectId', params.projectId);
    if (params?.pipelineType) query.set('pipelineType', params.pipelineType);
    if (params?.status) query.set('status', params.status);
    if (typeof params?.limit === 'number') query.set('limit', String(params.limit));
    if (typeof params?.offset === 'number') query.set('offset', String(params.offset));
    const qs = query.toString();
    return requestApi<PipelineReviewQueueItem[]>(
      `/api/pipelines/review-queue${qs ? `?${qs}` : ''}`,
    );
  };

  /**
   * 列出某个 run 的人工复核历史
   */
  const listRunManualReviews = async (runId: string): Promise<PipelineManualReview[]> => {
    return requestApi<PipelineManualReview[]>(`/api/pipelines/runs/${runId}/reviews`);
  };

  /**
   * 提交步骤级复核决策
   *
   * decision:
   *   - retry: 触发步骤重试
   *   - cancel: 终止整个 run
   *   - acknowledge: 仅记录已知晓，不改变状态
   */
  const submitReviewDecision = async (
    runId: string,
    stepId: string,
    input: PipelineReviewDecisionInput,
  ): Promise<PipelineReviewDecisionResponseNarrow> => {
    return requestApi<PipelineReviewDecisionResponseNarrow>(
      `/api/pipelines/runs/${runId}/steps/${stepId}/review-decision`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
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
    streamPipelineRun,
    listReviewQueue,
    listRunManualReviews,
    submitReviewDecision,
  };
}
