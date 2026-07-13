import { describe, expect, it } from 'vitest';
import type { ReviewQueueItem } from './serverApi.pipeline';
import {
  buildReviewQueueQuery,
  filterReviewQueue,
  formatTime,
  isCancelValidForRun,
  isRetryValid,
  isRunTerminal,
  isStepRetryable,
  summarizeQueue,
  validateReviewDecision,
  PIPELINE_TYPE_LABELS,
  STEP_STATUS_LABELS,
} from './pipelineReviewUtils';

function makeItem(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    projectId: 'proj-1',
    conversationId: 'conv-1',
    projectName: '测试项目',
    pipelineType: 'outline',
    runStatus: 'failed',
    stepKey: 'outline_design',
    stepName: '大纲设计',
    stepType: 'design',
    stepStatus: 'failed',
    attemptCount: 2,
    maxRetries: 3,
    errorMessage: 'AI request failed: timeout',
    lastEventType: 'step_failed',
    lastEventPayload: null,
    lastEventAt: '2026-04-14T10:00:00Z',
    optimizationCount: 0,
    reviewCount: 0,
    lastReviewDecision: null,
    lastReviewAt: null,
    createdAt: '2026-04-14T09:00:00Z',
    updatedAt: '2026-04-14T10:00:00Z',
    ...overrides,
  };
}

describe('validateReviewDecision', () => {
  it('accepts valid decisions (case-insensitive, trimmed)', () => {
    expect(validateReviewDecision('retry')).toBe('retry');
    expect(validateReviewDecision('RETRY')).toBe('retry');
    expect(validateReviewDecision('  Cancel  ')).toBe('cancel');
    expect(validateReviewDecision('acknowledge')).toBe('acknowledge');
  });

  it('rejects invalid decisions', () => {
    expect(validateReviewDecision('skip')).toBeNull();
    expect(validateReviewDecision('')).toBeNull();
    expect(validateReviewDecision('RESTART')).toBeNull();
    expect(validateReviewDecision(null)).toBeNull();
    expect(validateReviewDecision(undefined)).toBeNull();
    expect(validateReviewDecision(123)).toBeNull();
    expect(validateReviewDecision({})).toBeNull();
  });
});

describe('isStepRetryable', () => {
  it('returns true for failed and blocked', () => {
    expect(isStepRetryable('failed')).toBe(true);
    expect(isStepRetryable('blocked')).toBe(true);
  });

  it('returns false for other statuses', () => {
    expect(isStepRetryable('queued')).toBe(false);
    expect(isStepRetryable('running')).toBe(false);
    expect(isStepRetryable('completed')).toBe(false);
    expect(isStepRetryable('skipped')).toBe(false);
    expect(isStepRetryable('retrying')).toBe(false);
  });
});

describe('isRunTerminal', () => {
  it('returns true for completed and cancelled', () => {
    expect(isRunTerminal('completed')).toBe(true);
    expect(isRunTerminal('cancelled')).toBe(true);
  });

  it('returns false for active statuses', () => {
    expect(isRunTerminal('queued')).toBe(false);
    expect(isRunTerminal('running')).toBe(false);
    expect(isRunTerminal('paused')).toBe(false);
    expect(isRunTerminal('failed')).toBe(false);
  });
});

describe('isCancelValidForRun', () => {
  it('allows cancel on active or failed runs', () => {
    expect(isCancelValidForRun('queued')).toBe(true);
    expect(isCancelValidForRun('running')).toBe(true);
    expect(isCancelValidForRun('paused')).toBe(true);
    expect(isCancelValidForRun('failed')).toBe(true);
  });

  it('rejects cancel on terminal runs', () => {
    expect(isCancelValidForRun('completed')).toBe(false);
    expect(isCancelValidForRun('cancelled')).toBe(false);
  });
});

describe('isRetryValid', () => {
  it('allows retry on running/paused/failed runs with failed/blocked steps', () => {
    expect(isRetryValid('running', 'failed')).toBe(true);
    expect(isRetryValid('paused', 'blocked')).toBe(true);
    expect(isRetryValid('failed', 'failed')).toBe(true);
  });

  it('rejects retry when step is not failed/blocked', () => {
    expect(isRetryValid('running', 'completed')).toBe(false);
    expect(isRetryValid('running', 'queued')).toBe(false);
  });

  it('rejects retry when run is queued (not yet dispatched)', () => {
    expect(isRetryValid('queued', 'failed')).toBe(false);
  });

  it('rejects retry on terminal runs', () => {
    expect(isRetryValid('completed', 'failed')).toBe(false);
    expect(isRetryValid('cancelled', 'blocked')).toBe(false);
  });
});

describe('filterReviewQueue', () => {
  const queue: ReviewQueueItem[] = [
    makeItem({ runId: 'r1', stepId: 's1', projectId: 'p1', stepStatus: 'failed', pipelineType: 'outline' }),
    makeItem({ runId: 'r2', stepId: 's2', projectId: 'p2', stepStatus: 'blocked', pipelineType: 'script' }),
    makeItem({ runId: 'r3', stepId: 's3', projectId: 'p1', stepStatus: 'blocked', pipelineType: 'outline' }),
  ];

  it('returns all items when no filters', () => {
    expect(filterReviewQueue(queue, {})).toHaveLength(3);
  });

  it('filters by projectId', () => {
    const result = filterReviewQueue(queue, { projectId: 'p1' });
    expect(result).toHaveLength(2);
    expect(result.every((i) => i.projectId === 'p1')).toBe(true);
  });

  it('filters by step status', () => {
    const result = filterReviewQueue(queue, { status: 'failed' });
    expect(result).toHaveLength(1);
    expect(result[0].stepStatus).toBe('failed');
  });

  it('filters by pipeline type', () => {
    const result = filterReviewQueue(queue, { pipelineType: 'outline' });
    expect(result).toHaveLength(2);
    expect(result.every((i) => i.pipelineType === 'outline')).toBe(true);
  });

  it('combines multiple filters', () => {
    const result = filterReviewQueue(queue, { projectId: 'p1', status: 'blocked' });
    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe('r3');
  });
});

describe('buildReviewQueueQuery', () => {
  it('returns empty string when no params', () => {
    expect(buildReviewQueueQuery({})).toBe('');
  });

  it('includes only defined params', () => {
    const qs = buildReviewQueueQuery({ projectId: 'p1', limit: 50 });
    expect(qs).toContain('projectId=p1');
    expect(qs).toContain('limit=50');
    expect(qs).not.toContain('status');
    expect(qs).not.toContain('offset');
  });

  it('includes all params when provided', () => {
    const qs = buildReviewQueueQuery({
      projectId: 'p1',
      status: 'failed',
      pipelineType: 'outline',
      limit: 20,
      offset: 40,
    });
    expect(qs).toContain('projectId=p1');
    expect(qs).toContain('status=failed');
    expect(qs).toContain('pipelineType=outline');
    expect(qs).toContain('limit=20');
    expect(qs).toContain('offset=40');
  });
});

describe('formatTime', () => {
  it('returns dash for null/undefined/empty', () => {
    expect(formatTime(null)).toBe('-');
    expect(formatTime(undefined)).toBe('-');
    expect(formatTime('')).toBe('-');
  });

  it('formats valid ISO date', () => {
    const result = formatTime('2026-04-14T10:30:00Z');
    // Should contain date/month parts regardless of locale
    expect(typeof result).toBe('string');
    expect(result).not.toBe('-');
    expect(result.length).toBeGreaterThan(4);
  });

  it('returns raw string on invalid date', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date');
  });
});

describe('summarizeQueue', () => {
  it('counts correctly', () => {
    const queue: ReviewQueueItem[] = [
      makeItem({ stepStatus: 'failed', optimizationCount: 2, reviewCount: 1 }),
      makeItem({ stepStatus: 'failed', optimizationCount: 0, reviewCount: 0 }),
      makeItem({ stepStatus: 'blocked', optimizationCount: 1, reviewCount: 0 }),
    ];
    const summary = summarizeQueue(queue);
    expect(summary.total).toBe(3);
    expect(summary.failed).toBe(2);
    expect(summary.blocked).toBe(1);
    expect(summary.withOptimizations).toBe(2);
    expect(summary.withReviews).toBe(1);
  });

  it('returns zeros for empty queue', () => {
    const summary = summarizeQueue([]);
    expect(summary.total).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.blocked).toBe(0);
    expect(summary.withOptimizations).toBe(0);
    expect(summary.withReviews).toBe(0);
  });
});

describe('Labels', () => {
  it('has labels for all known pipeline types', () => {
    expect(PIPELINE_TYPE_LABELS.outline).toBe('大纲');
    expect(PIPELINE_TYPE_LABELS.script).toBe('剧本');
    expect(PIPELINE_TYPE_LABELS.storyboard).toBe('分镜');
    expect(PIPELINE_TYPE_LABELS.one_click).toBe('一键生成');
  });

  it('has labels for all step statuses', () => {
    expect(STEP_STATUS_LABELS.failed).toBe('失败');
    expect(STEP_STATUS_LABELS.blocked).toBe('阻塞');
    expect(STEP_STATUS_LABELS.retrying).toBe('重试中');
  });
});
