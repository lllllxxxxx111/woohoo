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
  AiUsageSummary,
  getUsageSummary,
  listServerAiEndpoints,
} from '../../lib/serverApi';
import { useToast } from '../../context/useToast';
import { useAppStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';

import {
  Activity,
  BarChart2,
  Clock3,
  Layers3,
  RefreshCw,
  RotateCcw,
  Tags,
  Plus,
  X,
  Search,
  ChevronRight,
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

/** 过滤掉 undefined 和空字符串的筛选条件 */
function normalizeFilters(filters: UsageFilters) {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== ''),
  ) as UsageFilters;
}

/** 计算百分比字符串，分母为零时返回 '0%' */
function percentage(numerator: number, denominator: number) {
  if (!denominator) {
    return '0%';
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
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
    },
    series: [],
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
                <span>Tokens: {item.totalTokens.toLocaleString()}</span>
                <span>•</span>
                <span>产出: {item.outputItems}</span>
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
  const requestIdRef = useRef(0);

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
    async (nextFilters: UsageFilters) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      try {
        const query = normalizeFilters(nextFilters);
        const nextSummary = await getUsageSummary({ ...query, limit: 50 });
        if (requestId !== requestIdRef.current) return;
        setSummary(nextSummary);
        setRecords(nextSummary.recent);
        setLoadError(null);
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setSummary((prev) => prev ?? createEmptySummary(nextFilters));
        setRecords([]);
        setLoadError(message);
        showToast({ type: 'error', title: '加载监控数据失败', message });
      } finally {
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
    void listServerAiEndpoints().then((next) => {
      if (isActive) setEndpointOptions(next.map((e) => ({ id: e.id, name: e.name })));
    });
    return () => {
      isActive = false;
    };
  }, []);

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
      title: 'Token 消耗',
      dataIndex: 'totalTokens',
      width: 150,
      render: (v: number) => <Text bold>{v.toLocaleString()}</Text>,
    },
    {
      title: '耗时',
      dataIndex: 'latencyMs',
      width: 100,
      render: (v: number) => <Tag size="small">{v}ms</Tag>,
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
          <p>基于服务器端点日志的实时深度分析，记录每一次 AI 调用背后的资源消耗与分发路径。</p>
        </div>
        <Button
          type="primary"
          status="success"
          icon={<RefreshCw size={14} />}
          onClick={() => void fetchData(filters)}
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
          title="Token 消耗"
          value={currentSummary.totals.totalTokens.toLocaleString()}
          icon={<Layers3 size={18} />}
          color="#10b981"
          footer={`平均 ${Math.round(currentSummary.totals.totalTokens / (currentSummary.totals.requestCount || 1))} / call`}
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
          value={currentSummary.totals.redoTotalTokens.toLocaleString()}
          icon={<RotateCcw size={18} />}
          color="#ef4444"
          footer={`重试 ${currentSummary.totals.redoRequestCount} 次`}
        />
      </div>

      <div className={styles.breakdownGrid}>
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
          scroll={{ x: 740, y: 320 }}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
};
