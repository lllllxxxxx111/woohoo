import { getServerBaseUrl } from './serverApi';
import type { AiTask, AiUsageBucket, AiUsageRecord, AiUsageSummary } from './serverApi';

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
  // 026 迁移新增字段：版本化与应用记录
  stepKey: string | null;
  version: number;
  strategy: string;
  operatorUserId: string | null;
  appliedAt: string | null;
  appliedRequestId: string | null;
  originalPrompt: string | null;
  optimizedPrompt: string | null;
  previousVersionId: string | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  rolledBackReason: string | null;
  rollbackRequestId: string | null;
}

/**
 * 应用优化建议请求
 */
export interface ApplyOptimizationInput {
  /** 应用范围：project（同项目同 stepKey 后续 run 生效）/ run（仅当前 run） */
  scope?: 'project' | 'run';
}

/**
 * 回滚优化建议请求
 */
export interface RollbackOptimizationInput {
  reason?: string;
}

/**
 * 版本差异视图
 */
export interface OptimizationVersionDiff {
  optimizationId: string;
  version: number;
  stepKey: string | null;
  originalPrompt: string | null;
  optimizedPrompt: string | null;
  designPromptPatch: string | null;
  reviewPromptPatch: string | null;
  rationaleJson: string | null;
  operatorUserId: string | null;
  appliedAt: string | null;
  previousVersionId: string | null;
}

/**
 * 效果对比指标分组
 */
export interface EffectMetricGroup {
  label: string;
  sampleCount: number;
  successCount: number;
  failedCount: number;
  avgDurationMs: number | null;
  avgReviewScore: number | null;
  manualReviewCount: number;
  totalTokens: number | null;
}

/**
 * 效果对比响应
 */
export interface OptimizationEffectComparison {
  optimizationId: string;
  version: number;
  stepKey: string | null;
  appliedAt: string | null;
  baseline: EffectMetricGroup;
  optimized: EffectMetricGroup;
  sampleSufficient: boolean;
  note: string;
}

/**
 * 回滚建议
 */
export interface RollbackRecommendation {
  optimizationId: string;
  version: number;
  stepKey: string | null;
  recommendRollback: boolean;
  reasons: string[];
  recentFailureCount: number;
  recentManualReviewCount: number;
}

/**
 * 自动应用优化开关配置
 */
export interface PipelinePromptAutoApplyConfig {
  id: string;
  userId: string;
  projectId: string;
  stepKey: string | null;
  enabled: boolean;
  riskAcknowledged: boolean;
  operatorUserId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 设置自动应用开关请求
 */
export interface SetAutoApplyConfigInput {
  enabled: boolean;
  /** 启用前必须确认风险，前端需展示风险提示后再传 true */
  riskAcknowledged?: boolean;
  /** 步骤级开关时传入 stepKey；不传则视为项目级开关 */
  stepKey?: string;
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
    stepType?: 'design' | 'review' | 'system' | 'image_gen' | 'video_gen';
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

  /**
   * 一键应用 Prompt 优化建议
   * POST /api/pipelines/runs/{runId}/optimizations/{optimizationId}/apply
   */
  const applyPipelineOptimization = async (
    runId: string,
    optimizationId: string,
    input?: ApplyOptimizationInput,
  ): Promise<PipelinePromptOptimization> => {
    return requestApi<PipelinePromptOptimization>(
      `/api/pipelines/runs/${runId}/optimizations/${optimizationId}/apply`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
  };

  /**
   * 回滚到应用前版本（保留历史记录）
   * POST /api/pipelines/runs/{runId}/optimizations/{optimizationId}/rollback
   */
  const rollbackPipelineOptimization = async (
    runId: string,
    optimizationId: string,
    input?: RollbackOptimizationInput,
  ): Promise<PipelinePromptOptimization> => {
    return requestApi<PipelinePromptOptimization>(
      `/api/pipelines/runs/${runId}/optimizations/${optimizationId}/rollback`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
  };

  /**
   * 查看版本差异（原 prompt vs 优化后 prompt）
   * GET /api/pipelines/runs/{runId}/optimizations/{optimizationId}/diff
   */
  const getOptimizationDiff = async (
    runId: string,
    optimizationId: string,
  ): Promise<OptimizationVersionDiff> => {
    return requestApi<OptimizationVersionDiff>(
      `/api/pipelines/runs/${runId}/optimizations/${optimizationId}/diff`,
    );
  };

  /**
   * 效果对比查询（baseline vs optimized 指标聚合）
   * GET /api/pipelines/runs/{runId}/optimizations/{optimizationId}/effect
   */
  const getOptimizationEffectComparison = async (
    runId: string,
    optimizationId: string,
  ): Promise<OptimizationEffectComparison> => {
    return requestApi<OptimizationEffectComparison>(
      `/api/pipelines/runs/${runId}/optimizations/${optimizationId}/effect`,
    );
  };

  /**
   * 回滚建议查询（基于失败率/manual_review/评分下降）
   * GET /api/pipelines/runs/{runId}/optimizations/{optimizationId}/rollback-recommendation
   */
  const getRollbackRecommendation = async (
    runId: string,
    optimizationId: string,
  ): Promise<RollbackRecommendation> => {
    return requestApi<RollbackRecommendation>(
      `/api/pipelines/runs/${runId}/optimizations/${optimizationId}/rollback-recommendation`,
    );
  };

  /**
   * 查询项目级/步骤级自动应用配置
   * GET /api/pipelines/projects/{projectId}/prompt-auto-apply?stepKey=...
   */
  const getPromptAutoApplyConfig = async (
    projectId: string,
    stepKey?: string,
  ): Promise<PipelinePromptAutoApplyConfig | null> => {
    const query = new URLSearchParams();
    if (stepKey) query.set('stepKey', stepKey);
    const qs = query.toString();
    return requestApi<PipelinePromptAutoApplyConfig | null>(
      `/api/pipelines/projects/${projectId}/prompt-auto-apply${qs ? `?${qs}` : ''}`,
    );
  };

  /**
   * 设置项目级/步骤级自动应用配置（启用前必须 riskAcknowledged=true）
   * PUT /api/pipelines/projects/{projectId}/prompt-auto-apply
   */
  const setPromptAutoApplyConfig = async (
    projectId: string,
    input: SetAutoApplyConfigInput,
  ): Promise<PipelinePromptAutoApplyConfig> => {
    return requestApi<PipelinePromptAutoApplyConfig>(
      `/api/pipelines/projects/${projectId}/prompt-auto-apply`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    );
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

  return {
    getUsageSummary,
    getUsageRecords,
    listAiTasks,
    getAiTask,
    createPipelineRun,
    getPipelineRun,
    getPipelineOptimizations,
    applyPipelineOptimization,
    rollbackPipelineOptimization,
    getOptimizationDiff,
    getOptimizationEffectComparison,
    getRollbackRecommendation,
    getPromptAutoApplyConfig,
    setPromptAutoApplyConfig,
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
