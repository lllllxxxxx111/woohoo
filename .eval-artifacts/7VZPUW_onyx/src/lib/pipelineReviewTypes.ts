/**
 * Shared pure types + constants for Pipeline manual review.
 *
 * Kept separate from serverApi.pipeline.ts so that unit tests (and other non-fetch code paths)
 * can import these without pulling in the full requestApi factory or its side effects.
 */

/**
 * 人工复核决策可选值集合（与后端 MANUAL_REVIEW_DECISIONS 保持一致）
 *
 * 故意不包含 skip：当前 pipeline 状态机中 skipped 仅由 orchestrator 在依赖失败时自动产生，
 * 人工跳过会破坏依赖完整性，避免制造伪功能。
 */
export const PIPELINE_MANUAL_REVIEW_DECISIONS = [
  'retry',
  'cancel',
  'acknowledge',
] as const;

export type PipelineReviewDecision =
  (typeof PIPELINE_MANUAL_REVIEW_DECISIONS)[number];

/**
 * 人工复核记录
 * 对应后端 pipeline_manual_reviews 表
 */
export interface PipelineManualReview {
  id: string;
  runId: string;
  stepId: string;
  reviewerId: string;
  decision: PipelineReviewDecision;
  note: string | null;
  createdAt: string;
}

/**
 * 复核队列条目
 * 一行聚合了 run/step/最近事件/优化建议数，供工作台列表直接渲染。
 */
export interface PipelineReviewQueueItem {
  runId: string;
  runStatus: string;
  pipelineType: string;
  projectId: string;
  conversationId: string;
  runCreatedAt: string;
  runUpdatedAt: string;
  stepId: string;
  stepKey: string;
  stepName: string;
  stepOrder: number;
  stepStatus: string;
  stepAttemptCount: number;
  stepErrorMessage: string | null;
  stepLastErrorAt: string | null;
  stepUpdatedAt: string;
  lastEventId: string | null;
  lastEventType: string | null;
  lastEventPayload: string | null;
  lastEventCreatedAt: string | null;
  optimizationCount: number;
}

/**
 * 复核队列查询参数
 */
export type PipelineReviewQueueParams = {
  projectId?: string;
  pipelineType?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

/**
 * 复核决策请求体
 */
export type PipelineReviewDecisionInput = {
  decision: PipelineReviewDecision;
  note?: string | null;
};

/**
 * 复核决策响应
 */
export interface PipelineReviewDecisionResponse {
  review: PipelineManualReview;
  run: unknown;
  step: unknown;
}
