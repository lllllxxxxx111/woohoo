import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, RefreshCw, RotateCw, XCircle } from 'lucide-react';
import {
  getReviewQueue,
  submitReviewDecision,
  type ReviewDecisionType,
  type ReviewQueueItem,
} from '../../../../lib/serverApi';
import { useToast } from '../../../../context/useToast';
import styles from './ReviewQueue.module.css';

type ReviewQueueProps = {
  projectId?: string | null;
};

const STEP_STATUS_LABEL: Record<string, string> = {
  failed: '失败',
  blocked: '阻塞',
  retrying: '重试中',
  running: '执行中',
  queued: '排队',
  completed: '完成',
};

function formatDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getEventMessage(item: ReviewQueueItem) {
  if (item.step.errorMessage) {
    return item.step.errorMessage;
  }
  const payload = item.latestErrorEvent?.payloadJson || item.latestEvent?.payloadJson;
  if (!payload) {
    return item.run.errorMessage || '需要人工复核后继续处理。';
  }
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const message = parsed.error || parsed.message || parsed.reason;
    return typeof message === 'string' && message.trim() ? message : payload;
  } catch {
    return payload;
  }
}

function canRetry(item: ReviewQueueItem) {
  return ['failed', 'blocked'].includes(item.step.status) &&
    ['running', 'paused', 'failed'].includes(item.run.status);
}

function canCancel(item: ReviewQueueItem) {
  return !['completed', 'cancelled'].includes(item.run.status);
}

export const ReviewQueue: React.FC<ReviewQueueProps> = ({ projectId }) => {
  const { showToast } = useToast();
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getReviewQueue({
        projectId: projectId || undefined,
        limit: 20,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : '复核队列加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadQueue();
    const timer = window.setInterval(() => {
      void loadQueue();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadQueue]);

  const visibleItems = useMemo(() => items.slice(0, 5), [items]);

  const handleDecision = async (item: ReviewQueueItem, decision: ReviewDecisionType) => {
    const key = `${item.run.id}:${item.step.id}:${decision}`;
    setSubmittingKey(key);
    try {
      await submitReviewDecision(item.run.id, item.step.id, { decision });
      showToast({
        type: 'success',
        title: decision === 'retry' ? '已提交重试' : decision === 'cancel' ? '已取消流程' : '已记录',
        message: `${item.step.stepName} 已处理。`,
      });
      await loadQueue();
    } catch (err) {
      showToast({
        type: 'error',
        title: '复核操作失败',
        message: err instanceof Error ? err.message : '请稍后重试',
      });
    } finally {
      setSubmittingKey(null);
    }
  };

  if (!loading && !error && total === 0) {
    return null;
  }

  return (
    <section className={styles.queuePanel} aria-label="人工复核队列">
      <div className={styles.queueHeader}>
        <div className={styles.queueTitle}>
          <AlertTriangle size={16} />
          <span>人工复核</span>
          {total > 0 && <strong>{total}</strong>}
        </div>
        <button type="button" className={styles.iconButton} onClick={() => void loadQueue()}>
          <RefreshCw size={15} className={loading ? styles.spin : undefined} />
        </button>
      </div>

      {error ? (
        <div className={styles.queueError}>{error}</div>
      ) : (
        <div className={styles.queueList}>
          {visibleItems.map((item) => {
            const retryKey = `${item.run.id}:${item.step.id}:retry`;
            const cancelKey = `${item.run.id}:${item.step.id}:cancel`;
            const ackKey = `${item.run.id}:${item.step.id}:acknowledge`;
            const message = getEventMessage(item);

            return (
              <article className={styles.queueItem} key={`${item.run.id}-${item.step.id}`}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTopline}>
                    <span className={styles.statusPill}>
                      {STEP_STATUS_LABEL[item.step.status] || item.step.status}
                    </span>
                    <strong title={item.step.stepName}>{item.step.stepName}</strong>
                    <span>{item.projectName || item.run.pipelineType}</span>
                  </div>
                  <p title={message}>{message}</p>
                  <div className={styles.itemMeta}>
                    <span>{item.step.stepKey}</span>
                    <span>{formatDate(item.step.updatedAt)}</span>
                    {item.reviewCount > 0 && <span>{item.reviewCount} 条记录</span>}
                  </div>
                </div>

                <div className={styles.itemActions}>
                  <button
                    type="button"
                    disabled={!canRetry(item) || submittingKey !== null}
                    onClick={() => void handleDecision(item, 'retry')}
                  >
                    <RotateCw size={14} className={submittingKey === retryKey ? styles.spin : undefined} />
                    重试
                  </button>
                  <button
                    type="button"
                    disabled={!canCancel(item) || submittingKey !== null}
                    onClick={() => void handleDecision(item, 'cancel')}
                  >
                    <XCircle size={14} className={submittingKey === cancelKey ? styles.spin : undefined} />
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={submittingKey !== null}
                    onClick={() => void handleDecision(item, 'acknowledge')}
                  >
                    <CheckCircle size={14} className={submittingKey === ackKey ? styles.spin : undefined} />
                    已知
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
