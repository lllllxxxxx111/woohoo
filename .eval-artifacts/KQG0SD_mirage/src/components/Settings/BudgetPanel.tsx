import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Progress,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Tooltip,
} from '@arco-design/web-react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Gauge,
  Info,
  Lock,
  RefreshCw,
  Save,
  ShieldAlert,
  TrendingDown,
  Wallet2,
} from 'lucide-react';
import { formatCreditAmount } from '../../lib/credits';
import {
  BudgetBlockEvent,
  BudgetPeriodStatus,
  BudgetStatus,
  UpdateBudgetSettingsInput,
  UserBudgetSettings,
  getBudgetStatus,
  listBudgetBlockEvents,
  updateBudgetSettings,
} from '../../lib/serverApi';
import { useToast } from '../../context/useToast';
import styles from './BudgetPanel.module.css';

const { Title, Text } = Typography;

const OPERATION_LABELS: Record<string, string> = {
  chat: '同步聊天',
  stream: '流式聊天',
  task: '异步任务',
  image: '图片生成',
  video: '视频生成',
};

const RESOURCE_LABELS: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  document: '文档',
  other: '其他',
};

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes(),
    ).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

function usageColor(ratio: number): string {
  if (ratio >= 1) return '#f53f3f';
  if (ratio >= 0.8) return '#ff7d00';
  if (ratio >= 0.5) return '#ffb400';
  return '#00b42a';
}

function PeriodBar({
  label,
  status,
}: {
  label: string;
  status: BudgetPeriodStatus;
}) {
  const ratio = status.usageRatio ?? 0;
  const percent = Math.min(ratio * 100, 100);
  const color = usageColor(ratio);
  const limitText = status.limit != null ? formatCreditAmount(status.limit) : '未设限';
  const spentText = formatCreditAmount(status.spent);
  const remainingText =
    status.remaining != null ? formatCreditAmount(status.remaining) : '—';

  return (
    <div className={styles.periodRow}>
      <div className={styles.periodHeader}>
        <Text className={styles.periodLabel}>{label}</Text>
        <Text className={styles.periodKey}>{status.periodKey}</Text>
      </div>
      <Progress
        percent={Number(percent.toFixed(1))}
        color={color}
        showText={false}
        strokeWidth={10}
        style={{ margin: '6px 0' }}
      />
      <div className={styles.periodStats}>
        <Text type="secondary" className={styles.statItem}>
          已消耗 <strong style={{ color }}>{spentText}</strong>
        </Text>
        <Text type="secondary" className={styles.statItem}>
          限额 {limitText}
        </Text>
        <Text type="secondary" className={styles.statItem}>
          剩余 {remainingText}
        </Text>
        {status.isOverBudget && (
          <Tag color="red" icon={<Ban size={12} />}>
            已超限
          </Tag>
        )}
        {status.isWarning && !status.isOverBudget && (
          <Tag color="orange" icon={<AlertTriangle size={12} />}>
            即将耗尽
          </Tag>
        )}
        {!status.isWarning && !status.isOverBudget && status.limit != null && (
          <Tag color="green" icon={<CheckCircle2 size={12} />}>
            正常
          </Tag>
        )}
        {status.limit == null && (
          <Tag color="gray" icon={<Info size={12} />}>
            未设限
          </Tag>
        )}
      </div>
    </div>
  );
}

export const BudgetPanel: React.FC = () => {
  const { showToast } = useToast();
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [blockEvents, setBlockEvents] = useState<BudgetBlockEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Draft settings
  const [enabled, setEnabled] = useState(false);
  const [dailyLimit, setDailyLimit] = useState<number | null>(null);
  const [monthlyLimit, setMonthlyLimit] = useState<number | null>(null);
  const [warningThreshold, setWarningThreshold] = useState(0.8);
  const [blockHighCost, setBlockHighCost] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [budgetStatus, events] = await Promise.all([
        getBudgetStatus(),
        listBudgetBlockEvents(10),
      ]);
      setStatus(budgetStatus);
      setBlockEvents(events);

      // Sync draft from server settings
      const s = budgetStatus.settings;
      setEnabled(s.enabled);
      setDailyLimit(s.dailyLimit ?? null);
      setMonthlyLimit(s.monthlyLimit ?? null);
      setWarningThreshold(s.warningThreshold);
      setBlockHighCost(s.blockHighCostOverBudget);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '加载预算数据失败';
      showToast({ type: 'error', title: '加载失败', message: msg });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const input: UpdateBudgetSettingsInput = {
        enabled,
        dailyLimit: dailyLimit ?? null,
        monthlyLimit: monthlyLimit ?? null,
        warningThreshold,
        blockHighCostOverBudget: blockHighCost,
      };
      await updateBudgetSettings(input);
      showToast({ type: 'success', title: '预算设置已保存' });
      await load();
    } catch (error) {
      const msg = error instanceof Error ? error.message : '保存失败';
      showToast({ type: 'error', title: '保存失败', message: msg });
    } finally {
      setSaving(false);
    }
  };

  const hasOverBudget = status && (status.daily.isOverBudget || status.monthly.isOverBudget);
  const hasWarning = status && status.warningMessage;

  const blockColumns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 120,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{formatDate(v)}</Text>,
    },
    {
      title: '操作',
      dataIndex: 'blockedOperation',
      width: 90,
      render: (v: string) => (
        <Tag size="small" color="red">
          {OPERATION_LABELS[v] || v}
        </Tag>
      ),
    },
    {
      title: '类型',
      dataIndex: 'blockedResourceKind',
      width: 70,
      render: (v: string | null) => (v ? RESOURCE_LABELS[v] || v : '—'),
    },
    {
      title: '原因',
      dataIndex: 'reason',
      render: (v: string, record: BudgetBlockEvent) => (
        <Tooltip content={
          <div style={{ fontSize: 12 }}>
            已消耗 {formatCreditAmount(record.currentSpent)} / 限额 {formatCreditAmount(record.limitAmount)}
            <br />
            预估本次消耗 {formatCreditAmount(record.estimatedCost)}
            {record.model ? <><br />模型: {record.model}</> : null}
          </div>
        }>
          <Text style={{ fontSize: 13 }}>{v}</Text>
        </Tooltip>
      ),
    },
  ];

  return (
    <div className={styles.container}>
      {/* 预算状态总览 */}
      {hasOverBudget && (
        <Alert
          type="error"
          icon={<ShieldAlert size={18} />}
          title="预算已超限，高成本 AI 任务已被拦截"
          content={status?.blockReason || undefined}
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}
      {hasWarning && !hasOverBudget && (
        <Alert
          type="warning"
          icon={<AlertTriangle size={18} />}
          title="预算即将耗尽"
          content={status?.warningMessage || undefined}
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      {status && (
        <Card className={styles.statusCard} bordered={false}>
          <div className={styles.cardTitle}>
            <Gauge size={16} />
            <Text bold>当前消耗概览</Text>
            <Button
              type="text"
              size="mini"
              icon={<RefreshCw size={14} />}
              loading={loading}
              onClick={() => void load()}
            >
              刷新
            </Button>
          </div>
          <PeriodBar label="今日预算" status={status.daily} />
          <div className={styles.divider} />
          <PeriodBar label="本月预算" status={status.monthly} />
        </Card>
      )}

      {/* 预算设置 */}
      <Card className={styles.settingsCard} bordered={false} style={{ marginTop: 16 }}>
        <div className={styles.cardTitle}>
          <Wallet2 size={16} />
          <Text bold>预算设置</Text>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingLabel}>
            <Lock size={14} />
            <Text>启用预算控制</Text>
            <Tooltip content="关闭后所有 AI 操作不受预算限制">
              <Info size={13} className={styles.infoIcon} />
            </Tooltip>
          </div>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>

        <div className={enabled ? '' : styles.disabledSection}>
          <div className={styles.settingRow}>
            <div className={styles.settingLabel}>
              <TrendingDown size={14} />
              <Text>日预算（积分）</Text>
              <Tooltip content="每日 00:00 UTC 重置，留空表示不限制">
                <Info size={13} className={styles.infoIcon} />
              </Tooltip>
            </div>
            <InputNumber
              value={dailyLimit ?? undefined}
              onChange={(v) => setDailyLimit(typeof v === 'number' ? v : null)}
              placeholder="不限制"
              min={0}
              step={1}
              style={{ width: 140 }}
              disabled={!enabled}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingLabel}>
              <TrendingDown size={14} />
              <Text>月预算（积分）</Text>
              <Tooltip content="每月 1 日 00:00 UTC 重置，留空表示不限制">
                <Info size={13} className={styles.infoIcon} />
              </Tooltip>
            </div>
            <InputNumber
              value={monthlyLimit ?? undefined}
              onChange={(v) => setMonthlyLimit(typeof v === 'number' ? v : null)}
              placeholder="不限制"
              min={0}
              step={10}
              style={{ width: 140 }}
              disabled={!enabled}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingLabel}>
              <AlertTriangle size={14} />
              <Text>预警阈值</Text>
              <Tooltip content="消耗达到此比例时在界面展示预警提示">
                <Info size={13} className={styles.infoIcon} />
              </Tooltip>
            </div>
            <Space>
              <InputNumber
                value={Math.round(warningThreshold * 100)}
                onChange={(v) => {
                  if (typeof v === 'number') {
                    setWarningThreshold(Math.max(10, Math.min(100, v)) / 100);
                  }
                }}
                min={10}
                max={100}
                step={5}
                suffix="%"
                style={{ width: 120 }}
                disabled={!enabled}
              />
            </Space>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingLabel}>
              <Ban size={14} />
              <Text>超预算后拦截高成本任务</Text>
              <Tooltip content="超限后拦截图片/视频/长文本等高消耗任务；关闭则仅预警不拦截">
                <Info size={13} className={styles.infoIcon} />
              </Tooltip>
            </div>
            <Switch checked={blockHighCost} onChange={setBlockHighCost} disabled={!enabled} />
          </div>
        </div>

        <div className={styles.saveRow}>
          <Button
            type="primary"
            icon={<Save size={14} />}
            loading={saving}
            onClick={() => void handleSave()}
          >
            保存预算设置
          </Button>
        </div>
      </Card>

      {/* 最近拦截记录 */}
      <Card className={styles.blocksCard} bordered={false} style={{ marginTop: 16 }}>
        <div className={styles.cardTitle}>
          <ShieldAlert size={16} />
          <Text bold>最近拦截记录</Text>
        </div>
        <Table
          data={blockEvents}
          columns={blockColumns}
          rowKey="id"
          pagination={false}
          size="small"
          loading={loading}
          noDataElement={
            <div className={styles.emptyBlocks}>
              <CheckCircle2 size={24} style={{ color: '#00b42a', opacity: 0.5 }} />
              <Text type="secondary">暂无拦截记录，预算状态良好</Text>
            </div>
          }
        />
      </Card>
    </div>
  );
};
