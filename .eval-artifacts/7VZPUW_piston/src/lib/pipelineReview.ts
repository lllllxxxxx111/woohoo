/**
 * Pipeline manual review utility functions.
 * Pure functions for data mapping, validation, and state derivation.
 */
import type {
  PipelineRunStep,
  PipelineStepStatus,
  ReviewDecisionType,
  ReviewQueueItem,
} from './serverApi';

/** Allowed step statuses that appear in the review queue */
export const REVIEW_QUEUE_STEP_STATUSES: ReadonlySet<PipelineStepStatus> = new Set([
  'failed',
  'blocked',
]);

/** Run error codes that trigger manual review */
export const MANUAL_REVIEW_ERROR_CODES: ReadonlySet<string> = new Set([
  'MANUAL_REVIEW_REQUIRED',
]);

/** All valid review decision types */
export const VALID_REVIEW_DECISIONS: ReadonlySet<ReviewDecisionType> = new Set([
  'retry',
  'cancel',
  'acknowledge',
]);

/** Terminal run statuses where only acknowledge is valid */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
]);

/** Step statuses that allow retry */
export const RETRYABLE_STEP_STATUSES: ReadonlySet<PipelineStepStatus> = new Set([
  'failed',
  'blocked',
]);

/** Run statuses that allow retry-step */
export const RETRYABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'paused',
  'failed',
]);

/**
 * Check if a review decision string is valid.
 */
export function isValidReviewDecision(value: unknown): value is ReviewDecisionType {
  return typeof value === 'string' && VALID_REVIEW_DECISIONS.has(value as ReviewDecisionType);
}

/**
 * Check if a step is eligible for retry from its current status.
 */
export function isStepRetryable(stepStatus: string | undefined | null): boolean {
  if (!stepStatus) return false;
  return RETRYABLE_STEP_STATUSES.has(stepStatus as PipelineStepStatus);
}

/**
 * Check if a run allows step retry from its current status.
 */
export function isRunRetryable(runStatus: string | undefined | null): boolean {
  if (!runStatus) return false;
  return RETRYABLE_RUN_STATUSES.has(runStatus);
}

/**
 * Check if a run is in a terminal state.
 */
export function isRunTerminal(runStatus: string | undefined | null): boolean {
  if (!runStatus) return false;
  return TERMINAL_RUN_STATUSES.has(runStatus);
}

/**
 * Check if a queue item needs attention (has failed/blocked step or manual review required).
 */
export function doesItemNeedAttention(item: Pick<ReviewQueueItem, 'step' | 'run'>): boolean {
  if (isStepRetryable(item.step.status)) return true;
  if (item.run.errorCode && MANUAL_REVIEW_ERROR_CODES.has(item.run.errorCode)) return true;
  return false;
}

/**
 * Derive which decisions are available for a given queue item.
 * Returns a map of decision -> enabled boolean.
 */
export function getAvailableDecisions(item: Pick<ReviewQueueItem, 'step' | 'run'>): Record<ReviewDecisionType, boolean> {
  const runTerminal = isRunTerminal(item.run.status);
  const stepRetryable = isStepRetryable(item.step.status);
  const runRetryable = isRunRetryable(item.run.status);

  return {
    retry: !runTerminal && stepRetryable && runRetryable,
    cancel: !runTerminal,
    acknowledge: true,
  };
}

/**
 * Build a human-readable reason string from a review note (truncated).
 */
export function formatReviewNote(note: string | null | undefined, maxLength = 80): string {
  if (!note) return '(无意见)';
  const trimmed = note.trim();
  if (!trimmed) return '(无意见)';
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + '...' : trimmed;
}

/**
 * Map a step status to a severity level for UI display.
 */
export function getStepSeverity(status: string): 'critical' | 'warning' | 'info' | 'success' {
  switch (status) {
    case 'failed':
      return 'critical';
    case 'blocked':
      return 'warning';
    case 'retrying':
      return 'info';
    case 'completed':
      return 'success';
    default:
      return 'info';
  }
}

/**
 * Filter review queue items by search text (matches step name, error, project name).
 */
export function filterReviewItems(
  items: ReviewQueueItem[],
  searchText: string | undefined | null,
): ReviewQueueItem[] {
  if (!searchText) return items;
  const query = searchText.toLowerCase().trim();
  if (!query) return items;

  return items.filter((item) => {
    const searchable = [
      item.step.stepName,
      item.step.stepKey,
      item.step.errorMessage ?? '',
      item.projectName ?? '',
      item.conversationTitle ?? '',
      item.run.pipelineType,
      item.run.errorCode ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return searchable.includes(query);
  });
}

/**
 * Build the query string for the review queue API from params.
 * Exported for testing the parameter mapping.
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
  if (typeof params.limit === 'number') query.set('limit', String(params.limit));
  if (typeof params.offset === 'number') query.set('offset', String(params.offset));
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Validate the submit review decision payload.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateReviewDecision(
  decision: unknown,
  note: string | null | undefined,
  runStatus: string | undefined | null,
  stepStatus: string | undefined | null,
): string | null {
  if (!isValidReviewDecision(decision)) {
    return `不支持的复核决定: ${String(decision)}`;
  }

  if (decision === 'retry') {
    if (isRunTerminal(runStatus)) {
      return `流程已处于终态 (${runStatus ?? 'unknown'})，无法重试`;
    }
    if (!isStepRetryable(stepStatus)) {
      return `步骤当前状态 (${stepStatus ?? 'unknown'}) 不允许重试`;
    }
    if (!isRunRetryable(runStatus)) {
      return `流程当前状态 (${runStatus ?? 'unknown'}) 不允许重试步骤`;
    }
  }

  if (decision === 'cancel' && isRunTerminal(runStatus)) {
    return `流程已处于终态 (${runStatus ?? 'unknown'})，无需取消`;
  }

  if (note !== null && note !== undefined && typeof note !== 'string') {
    return 'note 必须是字符串';
  }

  return null;
}
