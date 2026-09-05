import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  Menu,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import {
  AiUsageBreakdownItem,
  AiUsageBucket,
  AiUsageRecord,
  AiUsageSeriesPoint,
  AiUsageSummary,
  getUsageSummary,
  listImageCreditTransactions,
  listServerAiEndpoints,
} from '../../lib/serverApi';
import type { CreditTransaction } from '../../lib/serverApi';
import { useToast } from '../../context/useToast';
import { useAppStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { formatCreditsFromTokens } from '../../lib/credits';

import {
  Activity,
  BarChart2,
  Clock3,
  Layers3,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Tags,
  Plus,
  X,
  Search,
  ChevronRight,
  Zap,
} from 'lucide-react';
import styles from './UsageDashboard.module.css';

const { Text } = Typography;

type UsageFilters = {
  days: number;
  bucket: AiUsageBucket;
  projectId?: string;
  agentId?: string;
  endpointId?: string;
  apiKeyFingerprint?: string;
  resourceKind?: string;
  operation?: string;
  status?: string;
  model?: string;
};

type OptionalFilterKey = keyof Omit<UsageFilters, 'days' | 'bucket'>;

const OPTIONAL_FILTERS: Array<{ key: OptionalFilterKey; label: string }> = [
  { key: 'projectId', label: '项目' },
  { key: 'agentId', label: '智能体' },
  { key: 'endpointId', label: '端点' },
  { key: 'resourceKind', label: '产出类型' },
  { key: 'operation', label: '调用通道' },
  { key: 'status', label: '状态' },
  { key: 'model', label: '模型筛选' },
  { key: 'apiKeyFingerprint', label: 'API Key' },
];

const DAY_OPTIONS = [
  { label: '近 24 小时', value: 1 },
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '全部', value: 0 },
];

const BUCKET_OPTIONS: Array<{ label: string; value: AiUsageBucket }> = [
  { label: '小时', value: 'hour' },
  { label: '天', value: 'day' },
  { label: '周', value: 'week' },
  { label: '月', value: 'month' },
];

const RESOURCE_KIND_OPTIONS = [
  { label: '全部产出', value: '' },
  { label: '文本', value: 'text' },
  { label: '图片', value: 'image' },
  { label: '视频', value: 'video' },
  { label: '音频', value: 'audio' },
  { label: '文档', value: 'document' },
  { label: '其他', value: 'other' },
];

const OPERATION_OPTIONS = [
  { label: '全部通道', value: '' },
  { label: '同步聊天', value: 'chat' },
  { label: '流式聊天', value: 'stream' },
  { label: '异步任务', value: 'task' },
  { label: '连通性测试', value: 'test' },
];

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
];

const USAGE_SUMMARY_CACHE_TTL_MS = 10_000;
const USAGE_ERROR_TOAST_COOLDOWN_MS = 15_000;

/** 过滤掉 undefined 和空字符串的筛选条件 */
function normalizeFilters(filters: UsageFilters) {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== ''),
  ) as UsageFilters;
}

function createUsageRequestKey(filters: UsageFilters) {
  const query = normalizeFilters(filters);
  return JSON.stringify(
    Object.keys(query)
      .sort()
      .map((key) => [key, query[key as keyof UsageFilters]]),
  );
}

/** 计算百分比字符串，分母为零时返回 '0%' */
function percentage(numerator: number, denominator: number) {
  if (!denominator) {
    return '0%';
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** 缓存命中率展示：供应商未上报数据（null）时返回 '—'，与“命中率为 0”区分 */
function formatHitRatio(ratio: number | null | undefined) {
  if (ratio === null || ratio === undefined) {
    return '—';
  }
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 根据筛选条件创建一个全零的空汇总对象 */
function createEmptySummary(filters: UsageFilters): AiUsageSummary {
  return {
    window: {
      from: null,
      to: new Date().toISOString(),
      days: filters.days > 0 ? filters.days : null,
      bucket: filters.bucket,
      projectId: filters.projectId || null,
      conversationId: null,
      agentId: filters.agentId || null,
      endpointId: filters.endpointId || null,
      apiKeyFingerprint: filters.apiKeyFingerprint || null,
      resourceKind: filters.resourceKind || null,
      model: filters.model || null,
      operation: filters.operation || null,
      status: filters.status || null,
    },
    totals: {
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      avgLatencyMs: 0,
      maxLatencyMs: 0,
      inputChars: 0,
      outputChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      actualTokenRecords: 0,
      estimatedTokenRecords: 0,
      unavailableTokenRecords: 0,
      outputItems: 0,
      attemptGroupCount: 0,
      redoRequestCount: 0,
      redoTotalTokens: 0,
      firstPassSuccessCount: 0,
      firstPassSuccessTokens: 0,
      retrySuccessCount: 0,
      retrySuccessTokens: 0,
      projectCount: 0,
      conversationCount: 0,
      cachedPromptTokens: 0,
      cachedTokenRecords: 0,
    },
    series: [],
    byConversation: [],
    byEndpoint: [],
    byApiKey: [],
    byModel: [],
    byAgent: [],
    byProject: [],
    byOperation: [],
    byResourceKind: [],
    recent: [],
  };
}

const StatCard: React.FC<{
  title: string;
  value: string | number;
  icon: React.ReactNode;
  footer?: React.ReactNode;
  color?: string;
}> = ({ title, value, icon, footer, color }) => (
  <div className={styles.statCard} style={{ borderColor: color ? `${color}33` : undefined }}>
    <div
      className={styles.statCardOverlay}
      style={{ background: color ? `linear-gradient(135deg, ${color}11, transparent)` : undefined }}
    />
    <div className={styles.statHeader}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {title}
      </Text>
      <div
        className={styles.statIcon}
        style={{ background: color ? `${color}1a` : undefined, color }}
      >
        {icon}
      </div>
    </div>
    <div className={styles.statValue}>{value}</div>
    {footer && <div className={styles.statFooter}>{footer}</div>}
  </div>
);

const BreakdownSection: React.FC<{
  title: string;
  items: AiUsageBreakdownItem[];
  icon: React.ReactNode;
  emptyLabel: string;
}> = ({ title, items, icon, emptyLabel }) => {
  const [expanded, setExpanded] = useState(false);
  const totalRequestCount = useMemo(
    () => items.reduce((acc, cur) => acc + cur.requestCount, 0),
    [items],
  );
  const visibleItems = expanded ? items : items.slice(0, 5);

  return (
    <div className={styles.breakdownCard}>
      <div className={styles.breakdownHeader}>
        {icon} {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.length ? (
          visibleItems.map((item) => (
            <div key={item.key} className={styles.breakdownItem}>
              <div className={styles.breakdownLabel}>
                <span>{item.label}</span>
                <span style={{ color: 'var(--bg-accent)' }}>
                  {percentage(item.requestCount, totalRequestCount)}
                </span>
              </div>
              <div className={styles.breakdownValue}>{item.requestCount.toLocaleString()}</div>
              <div className={styles.breakdownMeta}>
                <span>积分: {formatCreditsFromTokens(item.totalTokens)}</span>
                <span>•</span>
                <span>产出: {item.outputItems}</span>
                {item.cacheHitRatio !== null && (
                  <>
                    <span>•</span>
                    <span>缓存命中率: {formatHitRatio(item.cacheHitRatio)}</span>
                  </>
                )}
              </div>
            </div>
          ))
        ) : (
          <Empty description={emptyLabel} style={{ padding: '20px 0' }} />
        )}
        {items.length > 5 && (
          <Button
            type="text"
            size="small"
            icon={
              <ChevronRight
                size={12}
                style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
              />
            }
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? '收起' : `查看更多共 ${items.length} 项`}
          </Button>
        )}
      </div>
    </div>
  );
};

/** 会话维度缓存命中率面板：每行以命中率为核心指标，无供应商上报时显示 '—' */
const ConversationCacheSection: React.FC<{ items: AiUsageBreakdownItem[] }> = ({ items }) => {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, 5);

  return (
    <div className={styles.breakdownCard}>
      <div className={styles.breakdownHeader}>
        <MessageSquare size={16} /> 会话缓存命中率
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.length ? (
          visibleItems.map((item) => (
            <div key={item.key} className={styles.breakdownItem}>
              <div className={styles.breakdownLabel}>
                <span>{item.label}</span>
                <span style={{ color: 'var(--bg-accent)' }}>
                  {formatHitRatio(item.cacheHitRatio)}
                </span>
              </div>
              <div className={styles.breakdownValue}>{item.requestCount.toLocaleString()}</div>
              <div className={styles.breakdownMeta}>
                <span>缓存命中: {item.cachedPromptTokens.toLocaleString()} tokens</span>
                <span>•</span>
                <span>积分: {formatCreditsFromTokens(item.totalTokens)}</span>
                <span>•</span>
                <span>上报: {item.cachedTokenRecords} 次</span>
              </div>
            </div>
          ))
        ) : (
          <Empty description="暂无会话数据" style={{ padding: '20px 0' }} />
        )}
        {items.length > 5 && (
          <Button
            type="text"
            size="small"
            icon={
              <ChevronRight
                size={12}
                style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
              />
            }
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? '收起' : `查看更多共 ${items.length} 项`}
          </Button>
        )}
      </div>
    </div>
  );
};

/** 趋势图最多渲染的桶数；超出时取最近 N 个并在标题注明，避免小时桶 × 长窗口撑爆 DOM */
const TREND_MAX_BUCKETS = 60;

/** 桶起始时间 → 短标签：day/week/month 显示 MM-DD，hour 显示 MM-DD HH时 */
function formatBucketLabel(bucketStart: string, isHourBucket: boolean) {
  if (bucketStart.length < 10) {
    return bucketStart;
  }
  if (isHourBucket && bucketStart.length >= 13) {
    return `${bucketStart.slice(5, 10)} ${bucketStart.slice(11, 13)}时`;
  }
  return bucketStart.slice(5, 10);
}

/** 会话缓存命中率趋势：纯 CSS 柱状图（无图表库依赖），无上报数据的桶显示灰色占位 */
const CacheHitTrendChart: React.FC<{ series: AiUsageSeriesPoint[]; hourBucket: boolean }> = ({
  series,
  hourBucket,
}) => {
  const visible = series.slice(-TREND_MAX_BUCKETS);
  const points = visible.map((point) => ({
    bucketStart: point.bucketStart,
    label: formatBucketLabel(point.bucketStart, hourBucket),
    ratio:
      point.cachedTokenRecords > 0 && point.promptTokens > 0
        ? point.cachedPromptTokens / point.promptTokens
        : null,
    requests: point.requestCount,
    cached: point.cachedPromptTokens,
    prompt: point.promptTokens,
    reported: point.cachedTokenRecords,
  }));
  // 标签过密时抽稀显示（首尾必留）
  const labelStep = Math.max(1, Math.ceil(points.length / 10));

  if (!points.length) {
    return <Empty description="暂无趋势数据" style={{ padding: '20px 0' }} />;
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 2,
          height: 160,
          borderBottom: '1px solid var(--border-soft)',
          padding: '0 2px',
        }}
      >
        {points.map((point) => {
          const heightPct = point.ratio === null ? 4 : Math.max(point.ratio * 100, 1.5);
          const title =
            point.ratio === null
              ? `${point.label}：无供应商缓存上报（${point.requests} 次请求）`
              : `${point.label}：命中率 ${(point.ratio * 100).toFixed(1)}%（命中 ${point.cached.toLocaleString()} / ${point.prompt.toLocaleString()} tokens，上报 ${point.reported} 次）`;
          return (
            <div
              key={point.bucketStart}
              title={title}
              style={{
                flex: 1,
                height: '100%',
                display: 'flex',
                alignItems: 'flex-end',
                minWidth: 3,
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: `${heightPct}%`,
                  background: point.ratio === null ? 'var(--border-soft)' : '#06b6d4',
                  borderRadius: '2px 2px 0 0',
                  opacity: point.ratio === null ? 0.8 : 0.85,
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 2, padding: '4px 2px 0' }}>
        {points.map((point, index) => (
          <div
            key={point.bucketStart}
            style={{
              flex: 1,
              textAlign: 'center',
              fontSize: 10,
              color: 'var(--text-muted)',
              minWidth: 0,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            {index % labelStep === 0 || index === points.length - 1 ? point.label : ''}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
        {series.length > TREND_MAX_BUCKETS
          ? `仅展示最近 ${TREND_MAX_BUCKETS} 个${hourBucket ? '小时' : '天'}桶（共 ${series.length} 个）；`
          : ''}
        灰色桶表示该时段无供应商缓存上报数据（≠ 命中率为 0）。
      </div>
    </div>
  );
};

export const UsageDashboard: React.FC = () => {
  const { projects, allAgentContacts } = useAppStore(
    useShallow((state) => ({ projects: state.projects, allAgentContacts: state.allAgentContacts })),
  );
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [records, setRecords] = useState<AiUsageRecord[]>([]);
  const [endpointOptions, setEndpointOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<UsageFilters>({ days: 30, bucket: 'day' });
  const [debouncedFilters, setDebouncedFilters] = useState<UsageFilters>({
    days: 30,
    bucket: 'day',
  });
  const [activeFilterKeys, setActiveFilterKeys] = useState<OptionalFilterKey[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const summaryCacheRef = useRef<{
    key: string;
    summary: AiUsageSummary;
    fetchedAt: number;
  } | null>(null);
  const pendingRequestRef = useRef<{
    key: string;
    promise: Promise<AiUsageSummary>;
  } | null>(null);
  const lastErrorToastAtRef = useRef(0);

  /** 添加一个可选筛选条件 */
  const addFilterCondition = (key: OptionalFilterKey) => {
    if (!activeFilterKeys.includes(key)) setActiveFilterKeys([...activeFilterKeys, key]);
  };

  /** 移除一个可选筛选条件并清空对应值 */
  const removeFilterCondition = (key: OptionalFilterKey) => {
    setActiveFilterKeys(activeFilterKeys.filter((k) => k !== key));
    setFilters((prev) => ({ ...prev, [key]: undefined }));
  };

  const unselectedFilters = OPTIONAL_FILTERS.filter((f) => !activeFilterKeys.includes(f.key));

  /** 从服务端获取用量汇总数据 */
  const fetchData = useCallback(
    async (nextFilters: UsageFilters, options?: { force?: boolean }) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const requestKey = createUsageRequestKey(nextFilters);
      const cached = summaryCacheRef.current;

      if (
        !options?.force &&
        cached?.key === requestKey &&
        Date.now() - cached.fetchedAt < USAGE_SUMMARY_CACHE_TTL_MS
      ) {
        setSummary(cached.summary);
        setRecords(cached.summary.recent);
        setLoadError(null);
        return;
      }

      setLoading(true);
      const query = normalizeFilters(nextFilters);
      let pending = pendingRequestRef.current;
      if (options?.force || pending?.key !== requestKey) {
        pending = {
          key: requestKey,
          promise: getUsageSummary({ ...query, limit: 50 }),
        };
        pendingRequestRef.current = pending;
      }

      try {
        const nextSummary = await pending.promise;
        if (requestId !== requestIdRef.current) return;
        summaryCacheRef.current = {
          key: requestKey,
          summary: nextSummary,
          fetchedAt: Date.now(),
        };
        setSummary(nextSummary);
        setRecords(nextSummary.recent);
        setLoadError(null);
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setSummary((prev) => prev ?? createEmptySummary(nextFilters));
        setRecords((prev) => prev);
        setLoadError(message);
        const now = Date.now();
        if (now - lastErrorToastAtRef.current > USAGE_ERROR_TOAST_COOLDOWN_MS) {
          lastErrorToastAtRef.current = now;
          showToast({ type: 'error', title: '加载监控数据失败', message });
        }
      } finally {
        if (pendingRequestRef.current?.promise === pending.promise) {
          pendingRequestRef.current = null;
        }
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedFilters(filters), 250);
    return () => window.clearTimeout(timeoutId);
  }, [filters]);

  useEffect(() => {
    void fetchData(debouncedFilters);
  }, [debouncedFilters, fetchData]);

  useEffect(() => {
    let isActive = true;
    listServerAiEndpoints()
      .then((next) => {
        if (isActive) setEndpointOptions(next.map((e) => ({ id: e.id, name: e.name })));
      })
      .catch((error) => {
        if (isActive) {
          showToast({
            type: 'error',
            title: '通道列表加载失败',
            message:
              error instanceof Error ? error.message : '无法读取 API 通道，通道筛选暂不可用',
          });
        }
      });
    return () => {
      isActive = false;
    };
  }, [showToast]);

  /** 加载积分交易历史 */
  const loadTransactions = useCallback(async () => {
    setTransactionsLoading(true);
    setTransactionsError(null);
    try {
      const result = await listImageCreditTransactions();
      setTransactions(result);
    } catch (error) {
      setTransactionsError(error instanceof Error ? error.message : '交易历史加载失败');
    } finally {
      setTransactionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTransactions();
  }, [loadTransactions]);

  const columns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 140,
      render: (v: string) => (
        <Text type="secondary" style={{ fontSize: 13 }}>
          {new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      ),
    },
    {
      title: '模型 & 通道',
      dataIndex: 'operation',
      width: 220,
      render: (_: string, r: AiUsageRecord) => (
        <Space direction="vertical" size={2}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Tag size="small" color="arcoblue" bordered>
              {r.operation}
            </Tag>
            <Tag size="small" color="cyan" bordered>
              {r.resourceKind}
            </Tag>
          </div>
          <Text style={{ fontSize: 13 }}>{r.model || 'Unknown'}</Text>
        </Space>
      ),
    },
    {
      title: '归属',
      dataIndex: 'projectName',
      width: 180,
      render: (_: string, r: AiUsageRecord) => (
        <Space direction="vertical" size={2}>
          <Text bold style={{ fontSize: 13 }}>
            {r.projectName || '独立会话'}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.agentName || '系统默认'}
          </Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'success' ? 'green' : 'red'} size="small">
          {v === 'success' ? '成功' : '失败'}
        </Tag>
      ),
    },
    {
      title: '积分消耗',
      dataIndex: 'totalTokens',
      width: 150,
      render: (v: number) => (
        <Space direction="vertical" size={0}>
          <Text bold>{formatCreditsFromTokens(v)}</Text>
        </Space>
      ),
    },
    {
      title: '耗时',
      dataIndex: 'latencyMs',
      width: 100,
      render: (v: number) => <Tag size="small">{v}ms</Tag>,
    },
    {
      title: '前缀命中',
      dataIndex: 'promptPrefixHitRatio',
      width: 100,
      render: (_: number | null | undefined, r: AiUsageRecord) => (
        <Tag size="small" color={r.promptPrefixHitRatio != null ? 'cyan' : 'gray'}>
          {r.promptPrefixHitRatio != null
            ? `${(r.promptPrefixHitRatio * 100).toFixed(0)}%`
            : '—'}
        </Tag>
      ),
    },
  ];

  /** 渲染指定可选筛选条件的控件（输入框或下拉选择） */
  const renderOptionalFilterControl = (key: OptionalFilterKey) => {
    if (key === 'model' || key === 'apiKeyFingerprint') {
      return (
        <Input
          allowClear
          placeholder={OPTIONAL_FILTERS.find((filter) => filter.key === key)?.label}
          style={{ width: 170 }}
          value={typeof filters[key] === 'string' ? filters[key] : ''}
          onChange={(value) =>
            setFilters((prev) => ({ ...prev, [key]: value.trim() || undefined }))
          }
        />
      );
    }

    return (
      <Select
        allowClear
        placeholder={OPTIONAL_FILTERS.find((filter) => filter.key === key)?.label}
        style={{ width: 150, border: 'none' }}
        value={filters[key]}
        onChange={(value) => setFilters((prev) => ({ ...prev, [key]: value || undefined }))}
        bordered={false}
      >
        {key === 'projectId' &&
          projects.map((project) => (
            <Select.Option key={project.id} value={project.id}>
              {project.name}
            </Select.Option>
          ))}
        {key === 'agentId' &&
          allAgentContacts.map((agent) => (
            <Select.Option key={agent.id} value={agent.id}>
              {agent.name}
            </Select.Option>
          ))}
        {key === 'endpointId' &&
          endpointOptions.map((endpoint) => (
            <Select.Option key={endpoint.id} value={endpoint.id}>
              {endpoint.name}
            </Select.Option>
          ))}
        {key === 'resourceKind' &&
          RESOURCE_KIND_OPTIONS.map((option) => (
            <Select.Option key={option.value} value={option.value}>
              {option.label}
            </Select.Option>
          ))}
        {key === 'operation' &&
          OPERATION_OPTIONS.map((option) => (
            <Select.Option key={option.value} value={option.value}>
              {option.label}
            </Select.Option>
          ))}
        {key === 'status' &&
          STATUS_OPTIONS.map((option) => (
            <Select.Option key={option.value} value={option.value}>
              {option.label}
            </Select.Option>
          ))}
      </Select>
    );
  };

  const currentSummary = summary ?? createEmptySummary(filters);
  const isEmpty = currentSummary.totals.requestCount === 0;
  const filteredRecords = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return records;
    }

    return records.filter((record) =>
      [
        record.operation,
        record.resourceKind,
        record.model,
        record.projectName,
        record.agentName,
        record.status,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }, [records, searchQuery]);

  return (
    <div className={styles.dashboard}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>
            <Activity size={24} style={{ color: 'var(--bg-accent)' }} /> 全站 API 用量统计与监控
          </h2>
          <p>统一展示为积分消耗，便于查看各项目、智能体和通道的使用情况。</p>
        </div>
        <Button
          type="primary"
          status="success"
          icon={<RefreshCw size={14} />}
          onClick={() => void fetchData(filters, { force: true })}
          loading={loading}
          shape="round"
        >
          同步最新数据
        </Button>
      </header>

      {loadError ? (
        <Alert
          type="warning"
          closable
          content={`最近一次加载失败：${loadError}`}
          onClose={() => setLoadError(null)}
        />
      ) : null}

      {!loadError && isEmpty ? (
        <Alert
          type="info"
          content="当前筛选条件下还没有用量数据。发起一次 AI 对话、任务或端点测试后，这里会自动显示统计。"
        />
      ) : null}

      <div className={styles.filterCard}>
        <Select
          style={{ width: 140 }}
          value={filters.days}
          onChange={(v) => setFilters((p) => ({ ...p, days: Number(v) }))}
          prefix={<Clock3 size={14} style={{ marginRight: 8 }} />}
        >
          {DAY_OPTIONS.map((o) => (
            <Select.Option key={o.value} value={o.value}>
              {o.label}
            </Select.Option>
          ))}
        </Select>

        <Select
          style={{ width: 110 }}
          value={filters.bucket}
          onChange={(v) => setFilters((p) => ({ ...p, bucket: v as AiUsageBucket }))}
        >
          {BUCKET_OPTIONS.map((o) => (
            <Select.Option key={o.value} value={o.value}>
              {o.label}
            </Select.Option>
          ))}
        </Select>

        {activeFilterKeys.map((key) => (
          <div
            key={key}
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'var(--bg-primary-soft)',
              padding: '2px 8px',
              borderRadius: 10,
              border: '1px solid var(--border-soft)',
            }}
          >
            {renderOptionalFilterControl(key)}
            <Button
              type="text"
              size="small"
              icon={<X size={14} />}
              onClick={() => removeFilterCondition(key)}
            />
          </div>
        ))}

        {unselectedFilters.length > 0 && (
          <Dropdown
            droplist={
              <Menu onClickMenuItem={(k) => addFilterCondition(k as OptionalFilterKey)}>
                {unselectedFilters.map((f) => (
                  <Menu.Item key={f.key}>{f.label}</Menu.Item>
                ))}
              </Menu>
            }
            trigger="click"
          >
            <Button type="dashed" shape="round" icon={<Plus size={14} />}>
              更多筛选
            </Button>
          </Dropdown>
        )}
      </div>

      <div className={styles.statsGrid}>
        <StatCard
          title="调用总数"
          value={currentSummary.totals.requestCount.toLocaleString()}
          icon={<BarChart2 size={18} />}
          color="#667eea"
          footer={`成功率 ${percentage(currentSummary.totals.successCount, currentSummary.totals.requestCount)}`}
        />
        <StatCard
          title="积分消耗"
          value={formatCreditsFromTokens(currentSummary.totals.totalTokens)}
          icon={<Layers3 size={18} />}
          color="#10b981"
          footer={`平均 ${formatCreditsFromTokens(currentSummary.totals.totalTokens / (currentSummary.totals.requestCount || 1))} 积分 / 次`}
        />
        <StatCard
          title="平均延迟"
          value={`${currentSummary.totals.avgLatencyMs}ms`}
          icon={<Clock3 size={18} />}
          color="#f59e0b"
          footer={`峰值 ${currentSummary.totals.maxLatencyMs}ms`}
        />
        <StatCard
          title="重做消耗"
          value={formatCreditsFromTokens(currentSummary.totals.redoTotalTokens)}
          icon={<RotateCcw size={18} />}
          color="#ef4444"
          footer={`重试 ${currentSummary.totals.redoRequestCount} 次`}
        />
        <StatCard
          title="缓存命中率"
          value={
            currentSummary.totals.cachedTokenRecords > 0
              ? percentage(
                  currentSummary.totals.cachedPromptTokens,
                  currentSummary.totals.promptTokens,
                )
              : '—'
          }
          icon={<Zap size={18} />}
          color="#06b6d4"
          footer={
            currentSummary.totals.cachedTokenRecords > 0
              ? `命中 ${currentSummary.totals.cachedPromptTokens.toLocaleString()} / ${currentSummary.totals.promptTokens.toLocaleString()} prompt tokens`
              : '供应商未上报缓存命中数据'
          }
        />
      </div>

      <div className={styles.mainTableCard}>
        <div className={styles.tableHeader}>
          <h3>
            缓存命中率趋势{' '}
            <span
              style={{ fontWeight: 400, fontSize: 13, color: 'var(--text-muted)', marginLeft: 12 }}
            >
              按当前时间桶聚合（供应商口径：缓存命中 / prompt tokens）
            </span>
          </h3>
        </div>
        <CacheHitTrendChart
          series={currentSummary.series}
          hourBucket={filters.bucket === 'hour'}
        />
      </div>

      <div className={styles.breakdownGrid}>
        <ConversationCacheSection items={currentSummary.byConversation} />
        <BreakdownSection
          title="项目归属分布"
          items={currentSummary.byProject}
          icon={<Plus size={16} />}
          emptyLabel="暂无项目数据"
        />
        <BreakdownSection
          title="智能体调用排行"
          items={currentSummary.byAgent}
          icon={<Tags size={16} />}
          emptyLabel="暂无智能体数据"
        />
        <BreakdownSection
          title="资源产出类型"
          items={currentSummary.byResourceKind}
          icon={<Activity size={16} />}
          emptyLabel="暂无产出数据"
        />
      </div>

      <div className={styles.mainTableCard}>
        <div className={styles.tableHeader}>
          <h3>
            近期调用流水{' '}
            <span
              style={{ fontWeight: 400, fontSize: 13, color: 'var(--text-muted)', marginLeft: 12 }}
            >
              最后 50 条记录
            </span>
          </h3>
          <Space>
            <Input
              allowClear
              placeholder="搜索流水..."
              prefix={<Search size={14} />}
              style={{ width: 220 }}
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </Space>
        </div>
        <Table
          columns={columns}
          data={filteredRecords}
          rowKey="id"
          pagination={false}
          border={false}
          loading={loading}
          scroll={{ x: 990, y: 320 }}
          style={{ width: '100%' }}
        />
      </div>

      <div className={styles.mainTableCard}>
        <div className={styles.tableHeader}>
          <h3>
            积分交易历史{' '}
            <span
              style={{ fontWeight: 400, fontSize: 13, color: 'var(--text-muted)', marginLeft: 12 }}
            >
              充值、消费与退款记录
            </span>
          </h3>
        </div>
        {transactionsError && (
          <Alert
            type="error"
            content={`交易历史加载失败：${transactionsError}`}
            action={
              <Button size="mini" type="outline" onClick={() => void loadTransactions()}>
                重试
              </Button>
            }
            style={{ marginBottom: 8 }}
          />
        )}
        <Table
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 160,
              render: (v: string) => (
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {new Date(v).toLocaleString()}
                </Text>
              ),
            },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 100,
              render: (v: string) => {
                const colorMap: Record<string, string> = {
                  earned: 'green',
                  spent: 'orange',
                  refund: 'blue',
                };
                const labelMap: Record<string, string> = {
                  earned: '充值',
                  spent: '消费',
                  refund: '退款',
                };
                return (
                  <Tag color={colorMap[v] || 'gray'} size="small">
                    {labelMap[v] || v}
                  </Tag>
                );
              },
            },
            {
              title: '金额',
              dataIndex: 'amount',
              width: 120,
              render: (v: number) => (
                <Text bold style={{ color: v >= 0 ? 'var(--color-success-6)' : 'var(--color-danger-6)' }}>
                  {v >= 0 ? '+' : ''}{v.toFixed(2)}
                </Text>
              ),
            },
            {
              title: '余额',
              dataIndex: 'balanceAfter',
              width: 120,
              render: (v: number) => <Text>{v.toFixed(2)}</Text>,
            },
            {
              title: '原因',
              dataIndex: 'reason',
              render: (v: string | null) => (
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {v || '-'}
                </Text>
              ),
            },
            {
              title: '关联',
              dataIndex: 'refType',
              width: 140,
              render: (_: string, r: CreditTransaction) =>
                r.refType && r.refId ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {r.refType} / {r.refId.slice(0, 8)}
                  </Text>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>-</Text>
                ),
            },
          ]}
          data={transactions}
          rowKey="id"
          pagination={{ pageSize: 20, showTotal: true }}
          border={false}
          loading={transactionsLoading}
          scroll={{ x: 680, y: 300 }}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
};
