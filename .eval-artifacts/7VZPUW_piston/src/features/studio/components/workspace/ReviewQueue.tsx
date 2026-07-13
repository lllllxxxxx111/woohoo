import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  XCircle,
  Lightbulb,
  MessageSquare,
} from 'lucide-react';
import {
  Button,
  Input,
  Select,
  Space,
  Tag,
  Message,
} from '@arco-design/web-react';
import type {
  ReviewQueueItem,
  ReviewQueueResponse,
  PipelineManualReview,
  ReviewDecisionType,
} from '../../../../lib/serverApi';
import { getReviewQueue, submitReviewDecision, listStepReviews } from '../../../../lib/serverApi';
import {
  getAvailableDecisions,
  formatReviewNote,
} from '../../../../lib/pipelineReview';
import styles from './ReviewQueue.module.css';

const Option = Select.Option;
const { TextArea } = Input;

/** Status label mapping */
const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  failed: { label: '失败', color: 'red' },
  blocked: { label: '阻塞', color: 'orange' },
  retrying: { label: '重试中', color: 'blue' },
  running: { label: '执行中', color: 'arcoblue' },
  queued: { label: '排队', color: 'gray' },
  completed: { label: '完成', color: 'green' },
  skipped: { label: '跳过', color: 'gray' },
};

/** Decision label mapping */
const DECISION_META: Record<ReviewDecisionType, { label: string; cls: string }> = {
  retry: { label: '重试', cls: styles.decisionRetry },
  cancel: { label: '取消', cls: styles.decisionCancel },
  acknowledge: { label: '已知晓', cls: styles.decisionAcknowledge },
};

/**
 * Format a timestamp to a short readable time
 */
function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
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
 * Truncate error message for display
 */
function truncateError(msg: string | null | undefined, max = 150): string {
  if (!msg) return '';
  return msg.length > max ? msg.slice(0, max) + '...' : msg;
}

export interface ReviewQueueProps {
  /** Optional project ID filter */
  projectId?: string | null;
  /** Callback when a review action is taken (for parent refresh) */
  onAction?: () => void;
}

export const ReviewQueue: React.FC<ReviewQueueProps> = ({ projectId, onAction }) => {
  const [queueData, setQueueData] = useState<ReviewQueueResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [selectedItem, setSelectedItem] = useState<ReviewQueueItem | null>(null);
  const [stepReviews, setStepReviews] = useState<PipelineManualReview[]>([]);
  const [reviewNote, setReviewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getReviewQueue({
        projectId: projectId ?? undefined,
        status: statusFilter,
        limit: 50,
      });
      setQueueData(data);
      // Clear selection if item no longer in queue
      if (selectedItem) {
        const stillExists = data.items.some(
          (item) => item.step.id === selectedItem.step.id,
        );
        if (!stillExists) {
          setSelectedItem(null);
          setStepReviews([]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载复核队列失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter, selectedItem]);

  const loadStepReviews = useCallback(async (runId: string, stepId: string) => {
    try {
      const reviews = await listStepReviews(runId, stepId);
      setStepReviews(reviews);
    } catch {
      setStepReviews([]);
    }
  }, []);

  // Initial load and auto-refresh
  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Poll every 10 seconds as fallback (when SSE is not available)
  useEffect(() => {
    const interval = setInterval(() => {
      void loadQueue();
    }, 10000);
    return () => clearInterval(interval);
  }, [loadQueue]);

  const handleSelectItem = useCallback(
    (item: ReviewQueueItem) => {
      setSelectedItem(item);
      setReviewNote('');
      void loadStepReviews(item.run.id, item.step.id);
    },
    [loadStepReviews],
  );

  const handleDecision = useCallback(
    async (decision: ReviewDecisionType) => {
      if (!selectedItem) return;
      setSubmitting(true);
      try {
        await submitReviewDecision(selectedItem.run.id, selectedItem.step.id, {
          decision,
          note: reviewNote.trim() || undefined,
        });
        Message.success(
          decision === 'retry'
            ? '已提交重试，编排器将自动处理'
            : decision === 'cancel'
              ? '已取消流程'
              : '已记录已知晓',
        );
        setReviewNote('');
        void loadQueue();
        void loadStepReviews(selectedItem.run.id, selectedItem.step.id);
        onAction?.();
      } catch (err) {
        Message.error(err instanceof Error ? err.message : '操作失败');
      } finally {
        setSubmitting(false);
      }
    },
    [selectedItem, reviewNote, loadQueue, loadStepReviews, onAction],
  );

  const renderStatusIcon = (status: string) => {
    switch (status) {
      case 'failed':
        return <XCircle size={16} style={{ color: '#ef4444' }} />;
      case 'blocked':
        return <ShieldAlert size={16} style={{ color: '#f59e0b' }} />;
      case 'retrying':
        return <RotateCw size={16} style={{ color: '#3b82f6' }} className={styles.spin} />;
      case 'running':
        return <RefreshCw size={16} style={{ color: '#3b82f6' }} className={styles.spin} />;
      case 'completed':
        return <CheckCircle size={16} style={{ color: '#10b981' }} />;
      default:
        return <Clock size={16} style={{ color: '#9ca3af' }} />;
    }
  };

  const totalCount = queueData?.total ?? 0;

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <AlertCircle size={18} style={{ color: '#f59e0b' }} />
          <span style={{ fontWeight: 600 }}>人工复核工作台</span>
          {totalCount > 0 && <span className={styles.queueCount}>{totalCount}</span>}
        </div>
        <div className={styles.toolbarRight}>
          <Select
            placeholder="筛选状态"
            allowClear
            size="small"
            style={{ width: 120 }}
            value={statusFilter}
            onChange={(val) => setStatusFilter(val)}
          >
            <Option value="failed">失败</Option>
            <Option value="blocked">阻塞</Option>
          </Select>
          <Button
            size="small"
            icon={<RefreshCw size={14} />}
            loading={loading}
            onClick={() => void loadQueue()}
          >
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, color: '#ef4444', fontSize: 13 }}>
          加载失败: {error}
        </div>
      )}

      <div className={styles.listContainer}>
        {loading && !queueData ? (
          <div className={styles.loadingState}>
            <RefreshCw size={20} className={styles.spin} />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : queueData && queueData.items.length === 0 ? (
          <div className={styles.emptyState}>
            <CheckCircle size={32} style={{ color: '#10b981' }} />
            <strong>暂无待复核步骤</strong>
            <span>所有流程步骤运行正常，没有失败或阻塞需要人工处理。</span>
          </div>
        ) : (
          queueData?.items.map((item) => {
            const isSelected = selectedItem?.step.id === item.step.id;
            const statusMeta = STATUS_LABELS[item.step.status] ?? { label: item.step.status, color: 'gray' };
            const runStatusMeta = STATUS_LABELS[item.run.status] ?? { label: item.run.status, color: 'gray' };

            return (
              <div
                key={item.step.id}
                className={`${styles.queueItem} ${isSelected ? styles.queueItemSelected : ''}`}
                onClick={() => handleSelectItem(item)}
              >
                <div className={styles.itemHeader}>
                  <div className={styles.itemStepInfo}>
                    {renderStatusIcon(item.step.status)}
                    <span className={styles.stepName}>{item.step.stepName}</span>
                    <span className={styles.stepKey}>{item.step.stepKey}</span>
                  </div>
                  <Space size={4}>
                    <Tag size="small" color={statusMeta.color}>
                      步骤: {statusMeta.label}
                    </Tag>
                    <Tag size="small" color={runStatusMeta.color}>
                      流程: {runStatusMeta.label}
                    </Tag>
                  </Space>
                </div>

                <div className={styles.itemMeta}>
                  {item.projectName && (
                    <span className={styles.projectTag}>{item.projectName}</span>
                  )}
                  <span className={styles.pipelineTypeTag}>{item.run.pipelineType}</span>
                  <span>更新于 {formatTime(item.step.updatedAt)}</span>
                  {item.step.attemptCount > 0 && (
                    <span>尝试 {item.step.attemptCount + 1}/{item.step.maxRetries + 1}</span>
                  )}
                </div>

                {item.step.errorMessage && (
                  <div className={styles.itemError}>
                    {truncateError(item.step.errorMessage)}
                  </div>
                )}

                {!item.step.errorMessage && item.run.errorCode === 'MANUAL_REVIEW_REQUIRED' && (
                  <div className={styles.itemError}>
                    需要人工复核（{item.run.errorMessage || 'MANUAL_REVIEW_REQUIRED'}）
                  </div>
                )}

                <div className={styles.itemIndicators}>
                  {item.optimizationCount > 0 && (
                    <span className={`${styles.indicator} ${styles.indicatorWarn}`}>
                      <Lightbulb size={12} />
                      {item.optimizationCount} 条优化建议
                    </span>
                  )}
                  {item.reviewCount > 0 && (
                    <span className={`${styles.indicator} ${styles.indicatorInfo}`}>
                      <MessageSquare size={12} />
                      {item.reviewCount} 条复核记录
                    </span>
                  )}
                  {item.latestReview && (
                    <span className={`${styles.indicator}`}>
                      最近处理: {DECISION_META[item.latestReview.decision]?.label ?? item.latestReview.decision}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {selectedItem && (
        <div className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <span className={styles.detailTitle}>
              复核详情: {selectedItem.step.stepName}
            </span>
            <Button
              type="text"
              size="mini"
              icon={<XCircle size={14} />}
              onClick={() => {
                setSelectedItem(null);
                setStepReviews([]);
              }}
            />
          </div>

          {/* Events section */}
          {selectedItem.latestEvent && (
            <div className={styles.detailSection}>
              <div className={styles.sectionLabel}>最近事件</div>
              <div className={styles.eventList}>
                {selectedItem.latestErrorEvent && (
                  <div className={styles.eventItem} style={{ color: '#ef4444' }}>
                    <span className={styles.eventType}>{selectedItem.latestErrorEvent.eventType}</span>
                    {truncateError(
                      selectedItem.latestErrorEvent.payloadJson
                        ? JSON.parse(selectedItem.latestErrorEvent.payloadJson).error ||
                            selectedItem.latestErrorEvent.payloadJson
                        : selectedItem.step.errorMessage,
                      200,
                    )}
                    <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 11 }}>
                      {formatTime(selectedItem.latestErrorEvent.createdAt)}
                    </span>
                  </div>
                )}
                <div className={styles.eventItem}>
                  <span className={styles.eventType}>{selectedItem.latestEvent.eventType}</span>
                  <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 11 }}>
                    {formatTime(selectedItem.latestEvent.createdAt)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Review history */}
          {stepReviews.length > 0 && (
            <div className={styles.detailSection}>
              <div className={styles.sectionLabel}>复核历史 ({stepReviews.length})</div>
              <div className={styles.reviewHistoryList}>
                {stepReviews.slice(0, 5).map((review) => {
                  const meta = DECISION_META[review.decision];
                  return (
                    <div key={review.id} className={styles.reviewHistoryItem}>
                      <span className={`${styles.reviewDecision} ${meta?.cls ?? ''}`}>
                        {meta?.label ?? review.decision}
                      </span>
                      {review.note && <span>{review.note}</span>}
                      <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
                        {formatTime(review.createdAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action area */}
          {(() => {
            const available = selectedItem ? getAvailableDecisions(selectedItem) : { retry: false, cancel: false, acknowledge: true };
            const isTerminal = ['completed', 'cancelled'].includes(selectedItem?.run.status ?? '');

            if (isTerminal) {
              return (
                <div className={styles.detailSection}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    该流程已处于终态 ({selectedItem?.run.status})，仅可记录"已知晓"。
                  </div>
                  <div className={styles.actionButtons}>
                    <Button
                      icon={<CheckCircle size={14} />}
                      loading={submitting}
                      onClick={() => void handleDecision('acknowledge')}
                    >
                      已知晓
                    </Button>
                  </div>
                </div>
              );
            }

            return (
              <div className={styles.detailSection}>
                <div className={styles.sectionLabel}>提交复核决定</div>
                <TextArea
                  className={styles.reviewNoteInput}
                  placeholder="输入复核意见（可选）..."
                  value={reviewNote}
                  onChange={setReviewNote}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
                <div className={styles.actionButtons}>
                  <Button
                    type="primary"
                    icon={<RotateCw size={14} />}
                    loading={submitting}
                    disabled={!available.retry}
                    onClick={() => void handleDecision('retry')}
                  >
                    重试步骤
                  </Button>
                  <Button
                    status="danger"
                    icon={<XCircle size={14} />}
                    loading={submitting}
                    disabled={!available.cancel}
                    onClick={() => void handleDecision('cancel')}
                  >
                    取消流程
                  </Button>
                  <Button
                    icon={<CheckCircle size={14} />}
                    loading={submitting}
                    onClick={() => void handleDecision('acknowledge')}
                  >
                    已知晓
                  </Button>
                </div>
                {!available.retry && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    重试仅对 failed/blocked 状态的步骤可用
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};
