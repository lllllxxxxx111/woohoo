import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  RotateCw,
  CheckCircle,
  XCircle,
  Eye,
  RefreshCw,
  Loader2,
  ListX,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../../store';
import {
  getReviewQueue,
  getStepReviewDetail,
  submitReviewDecision,
} from '../../../../lib/serverApi';
import type {
  ReviewQueueItem,
  StepReviewDetail,
  ReviewDecisionType,
} from '../../../../lib/serverApi.pipeline';
import {
  PIPELINE_TYPE_LABELS,
  STEP_STATUS_LABELS,
  formatTime,
  isStepRetryable,
  isRunTerminal,
} from '../../../../lib/pipelineReviewUtils';
import styles from './ReviewQueueWorkbench.module.css';

interface ReviewQueueWorkbenchProps {
  projectId?: string;
}

function getStepStatusClass(status: string): string {
  if (status === 'failed') return styles.badgeFailed;
  if (status === 'blocked') return styles.badgeBlocked;
  return '';
}

function getStepDotClass(status: string): string {
  if (status === 'failed') return styles.statusDotFailed;
  if (status === 'blocked') return styles.statusDotBlocked;
  return '';
}

export const ReviewQueueWorkbench: React.FC<ReviewQueueWorkbenchProps> = ({ projectId }) => {
  const { isAuthenticated, isServerWorkspaceReady } = useAppStore(
    useShallow((state) => ({
      isAuthenticated: state.isAuthenticated,
      isServerWorkspaceReady: state.isServerWorkspaceReady,
    })),
  );

  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<StepReviewDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<ReviewDecisionType | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');

  const loadQueue = useCallback(async () => {
    if (!isAuthenticated || !isServerWorkspaceReady) return;
    setLoading(true);
    setError(null);
    try {
      const items = await getReviewQueue({
        projectId: projectId || undefined,
        status: statusFilter || undefined,
        pipelineType: typeFilter || undefined,
        limit: 100,
      });
      setQueue(items);
      // If selected item is no longer in queue, clear it
      if (selectedKey && !items.find((i) => `${i.runId}:${i.stepId}` === selectedKey)) {
        setSelectedKey(null);
        setDetail(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, isServerWorkspaceReady, projectId, statusFilter, typeFilter, selectedKey]);

  const loadDetail = useCallback(
    async (runId: string, stepId: string) => {
      setDetailLoading(true);
      try {
        const d = await getStepReviewDetail(runId, stepId);
        setDetail(d);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDetailLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Auto-refresh every 15s as a fallback when SSE is not connected
  useEffect(() => {
    if (!isAuthenticated || !isServerWorkspaceReady) return;
    const interval = setInterval(() => {
      void loadQueue();
    }, 15000);
    return () => clearInterval(interval);
  }, [isAuthenticated, isServerWorkspaceReady, loadQueue]);

  const handleSelect = (item: ReviewQueueItem) => {
    const key = `${item.runId}:${item.stepId}`;
    setSelectedKey(key);
    setDetail(null);
    setNote('');
    void loadDetail(item.runId, item.stepId);
  };

  const handleDecision = async (decision: ReviewDecisionType) => {
    if (!selectedKey || !detail) return;
    setSubmitting(decision);
    try {
      await submitReviewDecision(
        detail.run.id,
        detail.step.id,
        decision,
        note.trim() || undefined,
      );
      setNote('');
      // Refresh queue and detail
      await loadQueue();
      await loadDetail(detail.run.id, detail.step.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  };

  // Auth / readiness empty states
  if (!isAuthenticated) {
    return (
      <div className={styles.workbench}>
        <div className={styles.emptyDetail}>
          <AlertTriangle size={32} />
          <div>请先登录后查看人工复核队列</div>
        </div>
      </div>
    );
  }

  if (!isServerWorkspaceReady) {
    return (
      <div className={styles.workbench}>
        <div className={styles.emptyDetail}>
          <AlertTriangle size={32} />
          <div>本地后端未就绪，请先启动后端服务</div>
        </div>
      </div>
    );
  }

  const selectedItem = queue.find((i) => `${i.runId}:${i.stepId}` === selectedKey);

  return (
    <div className={styles.workbench}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarTitle}>
          <AlertTriangle size={16} style={{ color: 'var(--color-danger-light-4)' }} />
          人工复核队列
          <span className={styles.toolbarCount}>{queue.length}</span>
        </div>
        <div className={styles.toolbarFilters}>
          <select
            className={styles.filterSelect}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="按步骤状态筛选"
          >
            <option value="">全部状态</option>
            <option value="failed">失败</option>
            <option value="blocked">阻塞</option>
          </select>
          <select
            className={styles.filterSelect}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="按流程类型筛选"
          >
            <option value="">全部流程</option>
            <option value="outline">大纲</option>
            <option value="script">剧本</option>
            <option value="storyboard">分镜</option>
            <option value="one_click">一键生成</option>
            <option value="review">审核</option>
            <option value="custom">自定义</option>
          </select>
          <button
            className={styles.refreshBtn}
            onClick={() => void loadQueue()}
            disabled={loading}
            title="刷新队列"
          >
            <RefreshCw size={14} className={loading ? styles.spin : ''} />
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.errorDisplay} style={{ margin: '12px 20px 0' }}>
          {error}
        </div>
      )}

      <div className={styles.body}>
        {/* Queue list */}
        <div className={styles.listPanel}>
          {loading && queue.length === 0 ? (
            <div className={styles.loading}>
              <Loader2 size={18} className={styles.spin} style={{ marginRight: 8 }} />
              加载中...
            </div>
          ) : queue.length === 0 ? (
            <div className={styles.emptyList}>
              <ListX size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
              <div>当前没有需要人工复核的步骤</div>
              <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                失败或阻塞的步骤会自动出现在这里
              </div>
            </div>
          ) : (
            queue.map((item) => {
              const key = `${item.runId}:${item.stepId}`;
              const isSelected = key === selectedKey;
              return (
                <div
                  key={key}
                  className={`${styles.queueItem} ${isSelected ? styles.queueItemSelected : ''}`}
                  onClick={() => handleSelect(item)}
                >
                  <div className={styles.itemHeader}>
                    <span className={`${styles.statusDot} ${getStepDotClass(item.stepStatus)}`} />
                    <span className={styles.itemStepName}>{item.stepName}</span>
                    <span className={styles.itemProject}>
                      {item.projectName || item.projectId.slice(0, 8)}
                    </span>
                  </div>
                  <div className={styles.itemMeta}>
                    <span className={`${styles.badge} ${getStepStatusClass(item.stepStatus)}`}>
                      {STEP_STATUS_LABELS[item.stepStatus] || item.stepStatus}
                    </span>
                    <span className={styles.badge} style={{ opacity: 0.7 }}>
                      {PIPELINE_TYPE_LABELS[item.pipelineType] || item.pipelineType}
                    </span>
                    {item.attemptCount > 0 && (
                      <span className={styles.badge} style={{ opacity: 0.6 }}>
                        尝试 {item.attemptCount}/{item.maxRetries}
                      </span>
                    )}
                    {item.optimizationCount > 0 && (
                      <span className={`${styles.badge} ${styles.badgeOptimization}`}>
                        {item.optimizationCount} 优化建议
                      </span>
                    )}
                    {item.reviewCount > 0 && (
                      <span className={styles.badge} style={{ opacity: 0.7 }}>
                        {item.reviewCount} 次复核
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto' }}>{formatTime(item.updatedAt)}</span>
                  </div>
                  {item.errorMessage && (
                    <div className={styles.itemError}>{item.errorMessage}</div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Detail panel */}
        <div className={styles.detailPanel}>
          {!selectedItem ? (
            <div className={styles.emptyDetail}>
              <Eye size={32} style={{ opacity: 0.4 }} />
              <div>从左侧选择一个失败/阻塞步骤查看详情</div>
            </div>
          ) : detailLoading && !detail ? (
            <div className={styles.loading}>
              <Loader2 size={18} className={styles.spin} style={{ marginRight: 8 }} />
              加载详情...
            </div>
          ) : detail ? (
            <div>
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.detailTitle}>{detail.step.stepName}</div>
                  <div className={styles.detailSubtitle}>
                    {PIPELINE_TYPE_LABELS[detail.run.pipelineType] || detail.run.pipelineType} ·{' '}
                    {STEP_STATUS_LABELS[detail.step.status] || detail.step.status} · Run{' '}
                    {detail.run.id.slice(0, 8)}
                  </div>
                </div>
              </div>

              {detail.step.errorMessage && (
                <div className={styles.errorDisplay}>
                  <strong>错误信息：</strong>
                  <br />
                  {detail.step.errorMessage}
                </div>
              )}

              <div className={styles.detailGrid}>
                <div className={styles.detailCard}>
                  <div className={styles.cardTitle}>步骤信息</div>
                  <div style={{ fontSize: '0.8rem', lineHeight: 1.8 }}>
                    <div>步骤Key: {detail.step.stepKey}</div>
                    <div>步骤类型: {detail.step.stepType || 'design'}</div>
                    <div>
                      尝试次数: {detail.step.attemptCount} / {detail.step.maxRetries}
                    </div>
                    <div>Run状态: {detail.run.status}</div>
                    {detail.run.errorCode && <div>错误码: {detail.run.errorCode}</div>}
                    <div>创建时间: {formatTime(detail.step.createdAt)}</div>
                    <div>更新时间: {formatTime(detail.step.updatedAt)}</div>
                  </div>
                </div>
                <div className={styles.detailCard}>
                  <div className={styles.cardTitle}>流程信息</div>
                  <div style={{ fontSize: '0.8rem', lineHeight: 1.8 }}>
                    <div>流程类型: {PIPELINE_TYPE_LABELS[detail.run.pipelineType] || detail.run.pipelineType}</div>
                    <div>触发来源: {detail.run.triggerSource}</div>
                    <div>总步骤: {detail.run.totalSteps}</div>
                    <div>已完成: {detail.run.completedSteps}</div>
                    <div>失败: {detail.run.failedSteps}</div>
                    <div>项目ID: {detail.run.projectId.slice(0, 12)}...</div>
                  </div>
                </div>
              </div>

              {/* Events */}
              <div className={styles.sectionDivider}>最近事件 ({detail.recentEvents.length})</div>
              {detail.recentEvents.length === 0 ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>暂无事件</div>
              ) : (
                <div className={styles.eventList}>
                  {detail.recentEvents.slice(0, 10).map((evt) => (
                    <div key={evt.id} className={styles.eventItem}>
                      <span className={styles.eventTime}>{formatTime(evt.createdAt)}</span>
                      <span className={styles.eventType}>{evt.eventType}</span>
                      <span className={styles.eventPayload}>
                        {evt.payloadJson ? (() => {
                          try {
                            const parsed = JSON.parse(evt.payloadJson);
                            return JSON.stringify(parsed).slice(0, 120);
                          } catch {
                            return evt.payloadJson.slice(0, 120);
                          }
                        })() : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Optimizations */}
              {detail.optimizations.length > 0 && (
                <>
                  <div className={styles.sectionDivider}>
                    Prompt 优化建议 ({detail.optimizations.length})
                  </div>
                  {detail.optimizations.map((opt) => (
                    <div key={opt.id} className={styles.optimizationItem}>
                      <div className={styles.optDecision}>
                        决策: {opt.decision} · 来源: {opt.source}
                      </div>
                      {opt.designPromptPatch && (
                        <div className={styles.optPatch}>
                          <strong>设计提示修补：</strong>
                          <br />
                          {opt.designPromptPatch}
                        </div>
                      )}
                      {opt.reviewPromptPatch && (
                        <div className={styles.optPatch}>
                          <strong>审核提示修补：</strong>
                          <br />
                          {opt.reviewPromptPatch}
                        </div>
                      )}
                      {opt.rationaleJson && (
                        <div className={styles.optPatch}>
                          <strong>理由：</strong>
                          <br />
                          {opt.rationaleJson}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}

              {/* Review history */}
              {detail.reviews.length > 0 && (
                <>
                  <div className={styles.sectionDivider}>
                    历史复核记录 ({detail.reviews.length})
                  </div>
                  {detail.reviews.map((rev) => (
                    <div key={rev.id} className={styles.reviewItem} data-decision={rev.decision}>
                      <span className={styles.reviewDecision}>{rev.decision}</span>
                      <div style={{ flex: 1 }}>
                        <div className={styles.reviewNote}>{rev.note || '(无备注)'}</div>
                        <div className={styles.reviewTime}>{formatTime(rev.createdAt)}</div>
                      </div>
                    </div>
                  ))}
                </>
              )}

              {/* Action area */}
              <div className={styles.actionArea}>
                <div className={styles.actionLabel}>执行复核操作</div>
                <textarea
                  className={styles.noteInput}
                  placeholder="输入复核备注（可选）..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={submitting !== null}
                />
                <div className={styles.actionButtons}>
                  <button
                    className={`${styles.actionBtn} ${styles.btnRetry}`}
                    onClick={() => void handleDecision('retry')}
                    disabled={submitting !== null || !isStepRetryable(detail.step.status)}
                    title={
                      !isStepRetryable(detail.step.status)
                        ? '仅失败或阻塞步骤可重试'
                        : '重试该步骤'
                    }
                  >
                    {submitting === 'retry' ? (
                      <Loader2 size={14} className={styles.spin} />
                    ) : (
                      <RotateCw size={14} />
                    )}
                    重试步骤
                  </button>
                  <button
                    className={`${styles.actionBtn} ${styles.btnCancel}`}
                    onClick={() => void handleDecision('cancel')}
                    disabled={submitting !== null || isRunTerminal(detail.run.status)}
                    title={
                      isRunTerminal(detail.run.status)
                        ? '流程已处于终态'
                        : '取消整个流程'
                    }
                  >
                    {submitting === 'cancel' ? (
                      <Loader2 size={14} className={styles.spin} />
                    ) : (
                      <XCircle size={14} />
                    )}
                    取消流程
                  </button>
                  <button
                    className={`${styles.actionBtn} ${styles.btnAck}`}
                    onClick={() => void handleDecision('acknowledge')}
                    disabled={submitting !== null}
                    title="标记已知晓（不改变运行状态）"
                  >
                    {submitting === 'acknowledge' ? (
                      <Loader2 size={14} className={styles.spin} />
                    ) : (
                      <CheckCircle size={14} />
                    )}
                    已知晓
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default ReviewQueueWorkbench;
