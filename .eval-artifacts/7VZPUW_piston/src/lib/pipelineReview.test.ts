import { describe, it, expect } from 'vitest';
import {
  buildReviewQueueQuery,
  doesItemNeedAttention,
  filterReviewItems,
  formatReviewNote,
  getAvailableDecisions,
  getStepSeverity,
  isRunRetryable,
  isRunTerminal,
  isStepRetryable,
  isValidReviewDecision,
  validateReviewDecision,
} from './pipelineReview';
import type {
  PipelineRun,
  PipelineRunStep,
  ReviewQueueItem,
} from './serverApi';

function makeStep(overrides: Partial<PipelineRunStep> = {}): PipelineRunStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    stepKey: 'outline_design',
    stepName: '大纲设计',
    stepOrder: 1,
    aiTaskId: null,
    status: 'failed',
    attemptCount: 1,
    maxRetries: 3,
    durationMs: 0,
    inputSummary: null,
    outputRef: null,
    errorMessage: 'AI endpoint returned error',
    lastErrorAt: '2026-04-14T10:00:00Z',
    startedAt: null,
    completedAt: null,
    createdAt: '2026-04-14T09:00:00Z',
    updatedAt: '2026-04-14T10:00:00Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-1',
    userId: 'user-1',
    projectId: 'proj-1',
    conversationId: 'conv-1',
    pipelineType: 'outline',
    triggerSource: 'manual',
    status: 'failed',
    idempotencyKey: 'idem-1',
    totalSteps: 2,
    completedSteps: 1,
    failedSteps: 1,
    createdAt: '2026-04-14T09:00:00Z',
    startedAt: '2026-04-14T09:01:00Z',
    finishedAt: '2026-04-14T10:00:00Z',
    updatedAt: '2026-04-14T10:00:00Z',
    errorMessage: null,
    errorCode: null,
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    run: makeRun(),
    step: makeStep(),
    latestEvent: null,
    latestErrorEvent: null,
    optimizationCount: 0,
    reviewCount: 0,
    latestReview: null,
    projectName: '测试项目',
    conversationTitle: '测试会话',
    ...overrides,
  };
}

// ==================== isValidReviewDecision ====================

describe('isValidReviewDecision', () => {
  it('accepts retry', () => {
    expect(isValidReviewDecision('retry')).toBe(true);
  });
  it('accepts cancel', () => {
    expect(isValidReviewDecision('cancel')).toBe(true);
  });
  it('accepts acknowledge', () => {
    expect(isValidReviewDecision('acknowledge')).toBe(true);
  });
  it('rejects skip', () => {
    expect(isValidReviewDecision('skip')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isValidReviewDecision('')).toBe(false);
  });
  it('rejects non-string values', () => {
    expect(isValidReviewDecision(null)).toBe(false);
    expect(isValidReviewDecision(undefined)).toBe(false);
    expect(isValidReviewDecision(123)).toBe(false);
    expect(isValidReviewDecision({})).toBe(false);
  });
});

// ==================== isStepRetryable / isRunRetryable / isRunTerminal ====================

describe('isStepRetryable', () => {
  it('returns true for failed steps', () => {
    expect(isStepRetryable('failed')).toBe(true);
  });
  it('returns true for blocked steps', () => {
    expect(isStepRetryable('blocked')).toBe(true);
  });
  it('returns false for completed steps', () => {
    expect(isStepRetryable('completed')).toBe(false);
  });
  it('returns false for running steps', () => {
    expect(isStepRetryable('running')).toBe(false);
  });
  it('returns false for null/undefined', () => {
    expect(isStepRetryable(null)).toBe(false);
    expect(isStepRetryable(undefined)).toBe(false);
  });
});

describe('isRunRetryable', () => {
  it('returns true for running/paused/failed', () => {
    expect(isRunRetryable('running')).toBe(true);
    expect(isRunRetryable('paused')).toBe(true);
    expect(isRunRetryable('failed')).toBe(true);
  });
  it('returns false for completed/cancelled/queued', () => {
    expect(isRunRetryable('completed')).toBe(false);
    expect(isRunRetryable('cancelled')).toBe(false);
    expect(isRunRetryable('queued')).toBe(false);
  });
});

describe('isRunTerminal', () => {
  it('returns true for completed/cancelled', () => {
    expect(isRunTerminal('completed')).toBe(true);
    expect(isRunTerminal('cancelled')).toBe(true);
  });
  it('returns false for active statuses', () => {
    expect(isRunTerminal('running')).toBe(false);
    expect(isRunTerminal('failed')).toBe(false);
    expect(isRunTerminal('paused')).toBe(false);
  });
});

// ==================== doesItemNeedAttention ====================

describe('doesItemNeedAttention', () => {
  it('returns true for failed steps', () => {
    const item = makeQueueItem({ step: makeStep({ status: 'failed' }) });
    expect(doesItemNeedAttention(item)).toBe(true);
  });
  it('returns true for blocked steps', () => {
    const item = makeQueueItem({ step: makeStep({ status: 'blocked' }) });
    expect(doesItemNeedAttention(item)).toBe(true);
  });
  it('returns true for MANUAL_REVIEW_REQUIRED error code', () => {
    const item = makeQueueItem({
      step: makeStep({ status: 'queued', errorMessage: null }),
      run: makeRun({ errorCode: 'MANUAL_REVIEW_REQUIRED', status: 'running' }),
    });
    expect(doesItemNeedAttention(item)).toBe(true);
  });
  it('returns false for completed steps with no error code', () => {
    const item = makeQueueItem({ step: makeStep({ status: 'completed' }) });
    expect(doesItemNeedAttention(item)).toBe(false);
  });
});

// ==================== getAvailableDecisions ====================

describe('getAvailableDecisions', () => {
  it('enables retry for failed steps on non-terminal runs', () => {
    const item = makeQueueItem({
      step: makeStep({ status: 'failed' }),
      run: makeRun({ status: 'running' }),
    });
    const decisions = getAvailableDecisions(item);
    expect(decisions.retry).toBe(true);
    expect(decisions.cancel).toBe(true);
    expect(decisions.acknowledge).toBe(true);
  });

  it('disables retry for completed steps', () => {
    const item = makeQueueItem({
      step: makeStep({ status: 'completed' }),
      run: makeRun({ status: 'running' }),
    });
    const decisions = getAvailableDecisions(item);
    expect(decisions.retry).toBe(false);
    expect(decisions.cancel).toBe(true);
    expect(decisions.acknowledge).toBe(true);
  });

  it('disables retry and cancel for terminal runs', () => {
    const item = makeQueueItem({
      step: makeStep({ status: 'failed' }),
      run: makeRun({ status: 'completed' }),
    });
    const decisions = getAvailableDecisions(item);
    expect(decisions.retry).toBe(false);
    expect(decisions.cancel).toBe(false);
    expect(decisions.acknowledge).toBe(true);
  });

  it('acknowledge is always available', () => {
    const statuses = ['queued', 'running', 'paused', 'failed', 'completed', 'cancelled'];
    for (const status of statuses) {
      const item = makeQueueItem({ run: makeRun({ status: status as PipelineRun['status'] }) });
      expect(getAvailableDecisions(item).acknowledge).toBe(true);
    }
  });
});

// ==================== formatReviewNote ====================

describe('formatReviewNote', () => {
  it('returns placeholder for null/undefined/empty', () => {
    expect(formatReviewNote(null)).toBe('(无意见)');
    expect(formatReviewNote(undefined)).toBe('(无意见)');
    expect(formatReviewNote('')).toBe('(无意见)');
    expect(formatReviewNote('   ')).toBe('(无意见)');
  });
  it('returns short notes as-is', () => {
    expect(formatReviewNote('需要调整角色设定')).toBe('需要调整角色设定');
  });
  it('truncates long notes', () => {
    const long = 'a'.repeat(100);
    const result = formatReviewNote(long);
    expect(result.length).toBeLessThanOrEqual(83); // 80 + '...'
    expect(result.endsWith('...')).toBe(true);
  });
  it('respects custom maxLength', () => {
    const result = formatReviewNote('hello world this is long', 5);
    expect(result).toBe('hello...');
  });
});

// ==================== getStepSeverity ====================

describe('getStepSeverity', () => {
  it('returns critical for failed', () => {
    expect(getStepSeverity('failed')).toBe('critical');
  });
  it('returns warning for blocked', () => {
    expect(getStepSeverity('blocked')).toBe('warning');
  });
  it('returns success for completed', () => {
    expect(getStepSeverity('completed')).toBe('success');
  });
  it('returns info for retrying/running/queued', () => {
    expect(getStepSeverity('retrying')).toBe('info');
    expect(getStepSeverity('running')).toBe('info');
    expect(getStepSeverity('queued')).toBe('info');
  });
});

// ==================== filterReviewItems ====================

describe('filterReviewItems', () => {
  const items = [
    makeQueueItem({
      step: makeStep({ stepName: '大纲设计', errorMessage: 'timeout error' }),
      projectName: '悬疑短剧',
      run: makeRun({ pipelineType: 'outline' }),
    }),
    makeQueueItem({
      step: makeStep({ stepKey: 'script_design', stepName: '脚本生成', errorMessage: 'bad request' }),
      projectName: '喜剧电影',
      run: makeRun({ pipelineType: 'script' }),
    }),
  ];

  it('returns all items when no search text', () => {
    expect(filterReviewItems(items, null)).toHaveLength(2);
    expect(filterReviewItems(items, '')).toHaveLength(2);
    expect(filterReviewItems(items, undefined)).toHaveLength(2);
  });
  it('filters by step name', () => {
    expect(filterReviewItems(items, '大纲')).toHaveLength(1);
    expect(filterReviewItems(items, '脚本')).toHaveLength(1);
  });
  it('filters by project name', () => {
    expect(filterReviewItems(items, '悬疑')).toHaveLength(1);
    expect(filterReviewItems(items, '喜剧')).toHaveLength(1);
  });
  it('filters by error message', () => {
    expect(filterReviewItems(items, 'timeout')).toHaveLength(1);
  });
  it('is case-insensitive', () => {
    expect(filterReviewItems(items, 'OUTLINE')).toHaveLength(1);
  });
  it('returns empty array when no match', () => {
    expect(filterReviewItems(items, '不存在的关键词')).toHaveLength(0);
  });
});

// ==================== buildReviewQueueQuery ====================

describe('buildReviewQueueQuery', () => {
  it('returns empty string for no params', () => {
    expect(buildReviewQueueQuery({})).toBe('');
  });
  it('builds query with all params', () => {
    const qs = buildReviewQueueQuery({
      projectId: 'proj-1',
      status: 'failed',
      pipelineType: 'outline',
      limit: 20,
      offset: 0,
    });
    expect(qs).toContain('projectId=proj-1');
    expect(qs).toContain('status=failed');
    expect(qs).toContain('pipelineType=outline');
    expect(qs).toContain('limit=20');
    expect(qs).toContain('offset=0');
    expect(qs.startsWith('?')).toBe(true);
  });
  it('omits undefined params', () => {
    const qs = buildReviewQueueQuery({ projectId: 'proj-1' });
    expect(qs).toBe('?projectId=proj-1');
    expect(qs).not.toContain('status');
  });
});

// ==================== validateReviewDecision ====================

describe('validateReviewDecision', () => {
  it('returns null for valid retry on failed step', () => {
    expect(validateReviewDecision('retry', 'retry note', 'running', 'failed')).toBeNull();
  });
  it('returns null for valid cancel on running run', () => {
    expect(validateReviewDecision('cancel', 'cancel reason', 'running', 'running')).toBeNull();
  });
  it('returns null for acknowledge on completed run', () => {
    expect(validateReviewDecision('acknowledge', 'noted', 'completed', 'completed')).toBeNull();
  });
  it('rejects invalid decision values', () => {
    expect(validateReviewDecision('skip', null, 'running', 'failed')).toContain('不支持');
    expect(validateReviewDecision('', null, 'running', 'failed')).toContain('不支持');
  });
  it('rejects retry on terminal run', () => {
    const err = validateReviewDecision('retry', null, 'completed', 'failed');
    expect(err).toContain('终态');
  });
  it('rejects retry on non-retryable step', () => {
    const err = validateReviewDecision('retry', null, 'running', 'completed');
    expect(err).toContain('不允许重试');
  });
  it('rejects retry on non-retryable run (queued)', () => {
    const err = validateReviewDecision('retry', null, 'queued', 'failed');
    expect(err).toContain('不允许重试步骤');
  });
  it('rejects cancel on terminal run', () => {
    const err = validateReviewDecision('cancel', null, 'cancelled', 'failed');
    expect(err).toContain('终态');
  });
  it('accepts null note', () => {
    expect(validateReviewDecision('acknowledge', null, 'running', 'failed')).toBeNull();
  });
});
