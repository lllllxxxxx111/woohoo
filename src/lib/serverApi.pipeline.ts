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
  };
}
