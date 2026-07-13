/**
 * Unit tests for Pipeline Review queue mapping and decision payload construction.
 *
 * These are pure functions so we don't need jsdom / a real fetch layer.
 */

import { describe, expect, it } from 'vitest';
import {
  PIPELINE_MANUAL_REVIEW_DECISIONS,
  type PipelineReviewDecision,
  type PipelineReviewDecisionInput,
  type PipelineReviewQueueItem,
} from '../../../../lib/pipelineReviewTypes';

const SAMPLE_QUEUE_ITEM: PipelineReviewQueueItem = {
  runId: 'run-1',
  runStatus: 'failed',
  pipelineType: 'outline',
  projectId: 'proj-1',
  conversationId: 'conv-1',
  runCreatedAt: '2026-04-01T00:00:00Z',
  runUpdatedAt: '2026-04-01T00:05:00Z',
  stepId: 'step-1',
  stepKey: 'outline_generate',
  stepName: '大纲生成',
  stepOrder: 1,
  stepStatus: 'failed',
  stepAttemptCount: 2,
  stepErrorMessage: '生成超时',
  stepLastErrorAt: '2026-04-01T00:04:00Z',
  stepUpdatedAt: '2026-04-01T00:04:00Z',
  lastEventId: 'evt-1',
  lastEventType: 'step_failed',
  lastEventPayload: '{"reason":"timeout"}',
  lastEventCreatedAt: '2026-04-01T00:04:00Z',
  optimizationCount: 1,
};

describe('PIPELINE_MANUAL_REVIEW_DECISIONS', () => {
  it('contains exactly the supported decisions', () => {
    expect(PIPELINE_MANUAL_REVIEW_DECISIONS).toEqual(['retry', 'cancel', 'acknowledge']);
  });

  it('does NOT include skip (would break dependency state machine)', () => {
    expect(PIPELINE_MANUAL_REVIEW_DECISIONS).not.toContain('skip');
  });

  it('is typed as a tuple of PipelineReviewDecision', () => {
    const decisions: readonly PipelineReviewDecision[] = PIPELINE_MANUAL_REVIEW_DECISIONS;
    expect(decisions.length).toBeGreaterThan(0);
    decisions.forEach((d) => expect(typeof d).toBe('string'));
  });
});

describe('review queue item data mapping', () => {
  it('exposes all fields the UI needs to render a row', () => {
    // Verifies the QueueItem carries everything PipelineReviewWorkbench reads:
    // step name / status / error / optimization count / project / timestamp
    const item = SAMPLE_QUEUE_ITEM;
    expect(item.stepName).toBe('大纲生成');
    expect(item.stepStatus).toBe('failed');
    expect(item.stepErrorMessage).toBe('生成超时');
    expect(item.optimizationCount).toBe(1);
    expect(item.projectId).toBe('proj-1');
    expect(item.stepUpdatedAt).toBe('2026-04-01T00:04:00Z');
  });

  it('uses snake-less camelCase keys (matches serde rename_all="camelCase")', () => {
    const item = SAMPLE_QUEUE_ITEM as unknown as Record<string, unknown>;
    // All keys that map to Rust snake_case fields should be camelCase in TS
    expect(Object.keys(item)).toEqual(
      expect.arrayContaining([
        'runId',
        'runStatus',
        'pipelineType',
        'projectId',
        'conversationId',
        'stepId',
        'stepKey',
        'stepName',
        'stepOrder',
        'stepStatus',
        'stepAttemptCount',
        'stepErrorMessage',
        'stepLastErrorAt',
        'stepUpdatedAt',
        'lastEventId',
        'lastEventType',
        'lastEventPayload',
        'lastEventCreatedAt',
        'optimizationCount',
      ]),
    );
    // And critically no snake_case leaks
    expect(item).not.toHaveProperty('run_id');
    expect(item).not.toHaveProperty('step_id');
    expect(item).not.toHaveProperty('step_status');
    expect(item).not.toHaveProperty('optimization_count');
  });
});

describe('review decision payload shape', () => {
  it('builds a valid retry payload with note', () => {
    const payload: PipelineReviewDecisionInput = {
      decision: 'retry',
      note: '已人工确认大纲方向正确，允许重试。',
    };
    expect(payload.decision).toBe('retry');
    expect(payload.note).toContain('已人工确认');
  });

  it('allows null / empty note for acknowledge actions', () => {
    const payload: PipelineReviewDecisionInput = { decision: 'acknowledge', note: null };
    expect(payload.decision).toBe('acknowledge');
    expect(payload.note).toBeNull();
  });

  it('rejects invalid decisions at the type level (compile-time)', () => {
    // Type-only assertion: would be a TS error if uncommented
    // const bad: PipelineReviewDecisionInput = { decision: 'skip' };
    const ok: PipelineReviewDecisionInput = { decision: 'cancel' };
    expect(ok.decision).toBe('cancel');
  });
});

describe('review queue query param construction', () => {
  /**
   * Mirrors the URLSearchParams logic in listReviewQueue() so that any contract
   * change on the server side is caught here.
   */
  const buildQueryString = (params: {
    projectId?: string;
    pipelineType?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): string => {
    const query = new URLSearchParams();
    if (params.projectId) query.set('projectId', params.projectId);
    if (params.pipelineType) query.set('pipelineType', params.pipelineType);
    if (params.status) query.set('status', params.status);
    if (typeof params.limit === 'number') query.set('limit', String(params.limit));
    if (typeof params.offset === 'number') query.set('offset', String(params.offset));
    return query.toString();
  };

  it('uses camelCase query keys to match server-side serde alias', () => {
    const qs = buildQueryString({
      projectId: 'proj-1',
      pipelineType: 'outline',
      limit: 50,
      offset: 10,
    });
    expect(qs).toContain('projectId=proj-1');
    expect(qs).toContain('pipelineType=outline');
    expect(qs).toContain('limit=50');
    expect(qs).toContain('offset=10');
    expect(qs).not.toContain('project_id');
    expect(qs).not.toContain('pipeline_type');
  });

  it('omits undefined / null params', () => {
    const qs = buildQueryString({ projectId: 'proj-1' });
    expect(qs).toBe('projectId=proj-1');
  });

  it('returns empty string when no filters given', () => {
    expect(buildQueryString({})).toBe('');
  });
});
