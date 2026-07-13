import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  Button,
  Input,
  Message,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';

const { TextArea } = Input;

import {
  listReviewQueue,
  listRunManualReviews,
  submitReviewDecision,
  PIPELINE_MANUAL_REVIEW_DECISIONS,
  type PipelineManualReview,
  type PipelineReviewDecision,
  type PipelineReviewQueueItem,
} from '../../../../lib/serverApi';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { useToast } from '../../../../context/useToast';
import { logger } from '../../../../lib/logger';
import styles from './PipelineReviewWorkbench.module.css';

const { Title, Text, Paragraph } = Typography;

const STEP_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  blocked: '已阻塞',
  retrying: '重试中',
};

const STEP_STATUS_COLOR: Record<string, string> = {
  failed: 'red',
  blocked: 'orange',
  retrying: 'gold',
  queued: 'arcoblue',
  running: 'arcoblue',
  completed: 'green',
};

const DECISION_LABEL: Record<PipelineReviewDecision, string> = {
  retry: '重试该步骤',
  cancel: '终止整个流程',
  acknowledge: '已知晓（仅记录）',
};

const DECISION_COLOR: Record<PipelineReviewDecision, string> = {
  retry: 'arcoblue',
  cancel: 'red',
  acknowledge: 'gray',
};

const PIPELINE_TYPE_LABEL: Record<string, string> = {
  one_click: '一键启动',
  outline: '大纲生成',
  script: '剧本生成',
  storyboard: '分镜生成',
  review: '合规审核',
  custom: '自定义',
};

const formatTime = (value: string | null | undefined): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
};

const shortId = (id: string): string => id.slice(0, 8);

export const PipelineReviewWorkbench: React.FC = () => {
  const { activeState, projects } = useAppStore(
    useShallow((state) => ({
      activeState: state.activeState,
      projects: state.projects,
    })),
  );
  const { showToast } = useToast();

  const [items, setItems] = useState<PipelineReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<PipelineManualReview[]>([]);
  const [decision, setDecision] = useState<PipelineReviewDecision>('retry');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 过滤条件
  const [filterProjectId, setFilterProjectId] = useState<string | undefined>(
    activeState.projectId ?? undefined,
  );
  const [filterPipelineType, setFilterPipelineType] = useState<string | undefined>(undefined);
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined);

  const projectNameMap = useMemo(() => {
    const map = new Map<string, string>();
    projects.forEach((p) => map.set(p.id, p.name));
    return map;
  }, [projects]);

  const selectedItem = useMemo(
    () => items.find((it) => it.stepId === selectedStepId) ?? null,
    [items, selectedStepId],
  );

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await listReviewQueue({
        projectId: filterProjectId,
        pipelineType: filterPipelineType,
        status: filterStatus,
        limit: 100,
      });
      setItems(data);
      // 如果当前选中项已不在列表中（比如已被处理），重置
      if (selectedStepId && !data.some((it) => it.stepId === selectedStepId)) {
        setSelectedStepId(data[0]?.stepId ?? null);
        setReviews([]);
      } else if (!selectedStepId && data.length > 0) {
        setSelectedStepId(data[0].stepId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMsg(`复核队列加载失败：${message}`);
      logger.error('Failed to load review queue:', error);
    } finally {
      setLoading(false);
    }
  }, [filterProjectId, filterPipelineType, filterStatus, selectedStepId]);

  const loadReviews = useCallback(
    async (runId: string) => {
      try {
        const data = await listRunManualReviews(runId);
        // 只展示与当前步骤相关的历史（后端按 run 维度返回）
        setReviews(data.filter((r) => r.stepId === selectedStepId || !selectedStepId));
      } catch (error) {
        logger.error('Failed to load reviews:', error);
      }
    },
    [selectedStepId],
  );

  // 初始加载 + 过滤条件变化时刷新
  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // 选中项变化时拉取该 run 的复核历史
  useEffect(() => {
    if (!selectedItem) {
      setReviews([]);
      return;
    }
    void loadReviews(selectedItem.runId);
  }, [selectedItem, loadReviews]);

  const handleSubmit = async () => {
    if (!selectedItem) return;
    setSubmitting(true);
    try {
      const trimmedNote = note.trim() || null;
      await submitReviewDecision(selectedItem.runId, selectedItem.stepId, {
        decision,
        note: trimmedNote,
      });
      showToast({
        type: 'success',
        title: '复核动作已提交',
        message: `已记录 ${DECISION_LABEL[decision]}。`,
      });
      setNote('');
      // 刷新队列和当前 run 详情
      await loadQueue();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast({
        type: 'error',
        title: '复核动作失败',
        message,
      });
      logger.error('Failed to submit review decision:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnProps<PipelineReviewQueueItem>[] = [
    {
      title: '步骤',
      dataIndex: 'stepName',
      width: 180,
      render: (_, item) => (
        <div className={styles.stepCell}>
          <strong>{item.stepName}</strong>
          <span className={styles.metaText}>
            {PIPELINE_TYPE_LABEL[item.pipelineType] ?? item.pipelineType} · #
            {item.stepOrder}
          </span>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'stepStatus',
      width: 110,
      render: (status: string) => (
        <Tag color={STEP_STATUS_COLOR[status] ?? 'gray'}>
          {STEP_STATUS_LABEL[status] ?? status}
        </Tag>
      ),
    },
    {
      title: '错误摘要',
      dataIndex: 'stepErrorMessage',
      render: (value: string | null) =>
        value ? (
          <Text ellipsis style={{ maxWidth: 320 }}>
            {value}
          </Text>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: '优化建议',
      dataIndex: 'optimizationCount',
      width: 100,
      align: 'center',
      render: (count: number) =>
        count > 0 ? (
          <Tag color="gold" icon={<MessageSquare size={12} />}>
            {count} 条
          </Tag>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: '项目',
      width: 180,
      render: (_, item) => (
        <div className={styles.projectCell}>
          <div>{projectNameMap.get(item.projectId) ?? shortId(item.projectId)}</div>
          <div className={styles.metaText}>会话 {shortId(item.conversationId)}</div>
        </div>
      ),
    },
    {
      title: '最近更新',
      dataIndex: 'stepUpdatedAt',
      width: 170,
      render: (value: string) => formatTime(value),
    },
  ];

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <Title heading={5} style={{ margin: 0 }}>
            <ShieldCheck size={18} style={{ marginRight: 8, verticalAlign: 'middle' }} />
            人工复核工作台
          </Title>
          <Text type="secondary" className={styles.subtitle}>
            聚合当前用户下失败 / 阻塞 / 带优化建议的步骤，支持重试、终止、已知晓三种动作
          </Text>
        </div>
        <Space>
          <Select
            placeholder="所有项目"
            allowClear
            style={{ width: 180 }}
            value={filterProjectId}
            onChange={setFilterProjectId}
            options={projects.map((p) => ({ label: p.name, value: p.id }))}
          />
          <Select
            placeholder="所有流程类型"
            allowClear
            style={{ width: 160 }}
            value={filterPipelineType}
            onChange={setFilterPipelineType}
            options={[
              { label: '大纲生成', value: 'outline' },
              { label: '剧本生成', value: 'script' },
              { label: '分镜生成', value: 'storyboard' },
              { label: '合规审核', value: 'review' },
              { label: '一键启动', value: 'one_click' },
            ]}
          />
          <Select
            placeholder="所有运行状态"
            allowClear
            style={{ width: 160 }}
            value={filterStatus}
            onChange={setFilterStatus}
            options={[
              { label: '排队中', value: 'queued' },
              { label: '执行中', value: 'running' },
              { label: '已暂停', value: 'paused' },
              { label: '失败', value: 'failed' },
            ]}
          />
          <Button
            icon={<RefreshCw size={14} />}
            onClick={() => void loadQueue()}
            loading={loading}
          >
            刷新
          </Button>
        </Space>
      </div>

      {errorMsg && (
        <div className={styles.errorBanner}>
          <AlertCircle size={16} />
          <span>{errorMsg}</span>
          <Button type="text" size="mini" onClick={() => void loadQueue()}>
            重试
          </Button>
        </div>
      )}

      <div className={styles.splitLayout}>
        <div className={styles.listPane}>
          <Table
            rowKey="stepId"
            loading={loading}
            columns={columns}
            data={items}
            pagination={{ pageSize: 20, sizeCanChange: true }}
            rowClassName={(record) =>
              record.stepId === selectedStepId ? styles.selectedRow : ''
            }
            onRow={(record) => ({
              onClick: () => {
                setSelectedStepId(record.stepId);
              },
              style: { cursor: 'pointer' },
            })}
            noDataElement={
              <div className={styles.emptyState}>
                <CheckCircle size={32} style={{ color: 'var(--color-success-light-4)' }} />
                <Text type="secondary">当前没有需要人工处理的失败步骤，辛苦了 ✨</Text>
              </div>
            }
          />
        </div>

        <div className={styles.detailPane}>
          {!selectedItem ? (
            <div className={styles.emptyDetail}>
              <Clock size={24} />
              <Text type="secondary">请在左侧选择一条待处理步骤</Text>
            </div>
          ) : (
            <>
              <div className={styles.detailHeader}>
                <Title heading={6} style={{ margin: 0 }}>
                  {selectedItem.stepName}
                </Title>
                <Space>
                  <Tag color={STEP_STATUS_COLOR[selectedItem.stepStatus]}>
                    {STEP_STATUS_LABEL[selectedItem.stepStatus] ?? selectedItem.stepStatus}
                  </Tag>
                  <Tag>{PIPELINE_TYPE_LABEL[selectedItem.pipelineType] ?? selectedItem.pipelineType}</Tag>
                </Space>
              </div>

              <div className={styles.detailMeta}>
                <div>
                  <span className={styles.metaLabel}>流程 ID</span>
                  <Text code>{shortId(selectedItem.runId)}</Text>
                </div>
                <div>
                  <span className={styles.metaLabel}>步骤 ID</span>
                  <Text code>{shortId(selectedItem.stepId)}</Text>
                </div>
                <div>
                  <span className={styles.metaLabel}>运行状态</span>
                  <Tag size="small">{selectedItem.runStatus}</Tag>
                </div>
                <div>
                  <span className={styles.metaLabel}>尝试次数</span>
                  <span>{selectedItem.stepAttemptCount}</span>
                </div>
                <div>
                  <span className={styles.metaLabel}>最近失败</span>
                  <span>{formatTime(selectedItem.stepLastErrorAt)}</span>
                </div>
              </div>

              {selectedItem.stepErrorMessage && (
                <div className={styles.errorBlock}>
                  <div className={styles.blockTitle}>
                    <AlertCircle size={14} /> 错误信息
                  </div>
                  <Paragraph className={styles.errorText}>
                    {selectedItem.stepErrorMessage}
                  </Paragraph>
                </div>
              )}

              {selectedItem.lastEventType && (
                <div className={styles.eventBlock}>
                  <div className={styles.blockTitle}>
                    <Clock size={14} /> 最近事件
                  </div>
                  <div className={styles.eventRow}>
                    <Tag size="small">{selectedItem.lastEventType}</Tag>
                    <Text type="secondary">{formatTime(selectedItem.lastEventCreatedAt)}</Text>
                  </div>
                  {selectedItem.lastEventPayload && (
                    <pre className={styles.eventPayload}>{selectedItem.lastEventPayload}</pre>
                  )}
                </div>
              )}

              {selectedItem.optimizationCount > 0 && (
                <div className={styles.hintBlock}>
                  <div className={styles.blockTitle}>
                    <MessageSquare size={14} /> Prompt 优化建议
                  </div>
                  <Text type="secondary">
                    该步骤已有 {selectedItem.optimizationCount} 条优化建议，可在流程详情页查看具体内容。
                  </Text>
                </div>
              )}

              {reviews.length > 0 && (
                <div className={styles.historyBlock}>
                  <div className={styles.blockTitle}>
                    <ShieldCheck size={14} /> 历史复核记录（{reviews.length}）
                  </div>
                  <div className={styles.reviewList}>
                    {reviews.map((review) => (
                      <div key={review.id} className={styles.reviewItem}>
                        <div className={styles.reviewHead}>
                          <Tag
                            size="small"
                            color={DECISION_COLOR[review.decision] ?? 'gray'}
                          >
                            {DECISION_LABEL[review.decision as PipelineReviewDecision] ?? review.decision}
                          </Tag>
                          <Text type="secondary" className={styles.metaText}>
                            {formatTime(review.createdAt)} · 处理人 {shortId(review.reviewerId)}
                          </Text>
                        </div>
                        {review.note && (
                          <Paragraph className={styles.reviewNote}>{review.note}</Paragraph>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className={styles.actionBlock}>
                <div className={styles.blockTitle}>提交复核动作</div>
                <div className={styles.actionForm}>
                  <div className={styles.actionRow}>
                    <span className={styles.metaLabel}>决策</span>
                    <Select
                      style={{ flex: 1 }}
                      value={decision}
                      onChange={(val) => setDecision(val as PipelineReviewDecision)}
                      options={PIPELINE_MANUAL_REVIEW_DECISIONS.map((d) => ({
                        label: DECISION_LABEL[d],
                        value: d,
                      }))}
                    />
                  </div>
                  <div className={styles.actionRow}>
                    <span className={styles.metaLabel}>备注</span>
                    <TextArea
                      style={{ flex: 1, minHeight: 72 }}
                      placeholder="请填写本次人工检查结论、修正判断或允许重试的依据（可选）。"
                      value={note}
                      onChange={setNote}
                      maxLength={500}
                      showWordLimit
                    />
                  </div>
                  <div className={styles.actionButtons}>
                    <Button
                      type="primary"
                      icon={
                        decision === 'retry' ? (
                          <RefreshCw size={14} />
                        ) : decision === 'cancel' ? (
                          <XCircle size={14} />
                        ) : (
                          <CheckCircle size={14} />
                        )
                      }
                      loading={submitting}
                      onClick={() => void handleSubmit()}
                    >
                      提交 {DECISION_LABEL[decision]}
                    </Button>
                    {decision === 'cancel' && (
                      <Message type="warning" size="small">
                        终止后流程将进入终态，无法再恢复。
                      </Message>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default PipelineReviewWorkbench;
