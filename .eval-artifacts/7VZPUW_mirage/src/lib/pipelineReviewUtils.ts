/**
 * Pure utility functions for the pipeline manual review workbench.
 * Separated from the React component for testability.
 */
import type { ReviewQueueItem, PipelineStepStatus, PipelineRunStatus } from './serverApi.pipeline';

export const PIPELINE_TYPE_LABELS: Record<string, string> = {
  one_click: '一键生成',
  outline: '大纲',
  script: '剧本',
  storyboard: '分镜',
  review: '审核',
  custom: '自定义',
};

export const STEP_STATUS_LABELS: Record<string, string> = {
  failed: '失败',
  blocked: '阻塞',
  retrying: '重试中',
  queued: '排队',
  running: '运行中',
  completed: '完成',
  skipped: '跳过',
};

export const VALID_REVIEW_DECISIONS = ['retry', 'cancel', 'acknowledge'] as const;
export type ReviewDecision = (typeof VALID_REVIEW_DECISIONS)[number];

/**
 * Validate a review decision string. Returns the normalized decision
 * (lowercase, trimmed) or null if invalid.
 */
export function validateReviewDecision(raw: unknown): ReviewDecision | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if ((VALID_REVIEW_DECISIONS as readonly string[]).includes(normalized)) {
    return normalized as ReviewDecision;
  }
  return null;
}

/**
 * Returns true if a step is eligible for retry based on its status.
 * Only failed and blocked steps can be retried.
 */
export function isStepRetryable(stepStatus: string): boolean {
  return stepStatus === 'failed' || stepStatus === 'blocked';
}

/**
 * Returns true if a run is in a terminal state where no review action
 * (other than acknowledge) is valid.
 */
export function isRunTerminal(runStatus: string): boolean {
  return runStatus === 'completed' || runStatus === 'cancelled';
}

/**
 * Returns true if a cancel action is valid for the given run status.
 * Cancel works on queued/running/paused/failed runs.
 */
export function isCancelValidForRun(runStatus: string): boolean {
  return ['queued', 'running', 'paused', 'failed'].includes(runStatus);
}

/**
 * Returns true if a retry action is valid for the given run + step status.
 */
export function isRetryValid(runStatus: string, stepStatus: string): boolean {
  return ['running', 'paused', 'failed'].includes(runStatus) && isStepRetryable(stepStatus);
}

/**
 * Filter a queue of review items by the given criteria. This is a client-side
 * helper used for instant filtering when the server-side queue has already
 * been fetched; server filtering remains authoritative.
 */
export function filterReviewQueue(
  queue: ReviewQueueItem[],
  filters: {
    projectId?: string;
    status?: PipelineStepStatus | '';
    pipelineType?: string;
  },
): ReviewQueueItem[] {
  return queue.filter((item) => {
    if (filters.projectId && item.projectId !== filters.projectId) return false;
    if (filters.status && item.stepStatus !== filters.status) return false;
    if (filters.pipelineType && item.pipelineType !== filters.pipelineType) return false;
    return true;
  });
}

/**
 * Build a URLSearchParams object for the review queue API,
 * only including defined parameters.
 */
export function buildReviewQueueQuery(params: {
  projectId?: string;
  status?: string;
  pipelineType?: string;
  limit?: number;
  offset?: number;
}): string {
  const query = new URLSearchParams();
  if (params.projectId) query.set('projectId', params.projectId);
  if (params.status) query.set('status', params.status);
  if (params.pipelineType) query.set('pipelineType', params.pipelineType);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Format an ISO timestamp for display (zh-CN locale, short form).
 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Summarize the counts of failed/blocked/acknowledged items for a summary badge.
 */
export function summarizeQueue(queue: ReviewQueueItem[]): {
  total: number;
  failed: number;
  blocked: number;
  withOptimizations: number;
  withReviews: number;
} {
  return queue.reduce(
    (acc, item) => {
      acc.total++;
      if (item.stepStatus === 'failed') acc.failed++;
      if (item.stepStatus === 'blocked') acc.blocked++;
      if (item.optimizationCount > 0) acc.withOptimizations++;
      if (item.reviewCount > 0) acc.withReviews++;
      return acc;
    },
    { total: 0, failed: 0, blocked: 0, withOptimizations: 0, withReviews: 0 },
  );
}
