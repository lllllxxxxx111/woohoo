import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import {
  AlertTriangle,
  Ban,
  RefreshCw,
  Save,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { useToast } from '../../context/useToast';
import { formatCreditAmount } from '../../lib/credits';
import {
  updateBudgetSettings,
  type BudgetEvent,
  type BudgetSnapshot,
  type UpsertBudgetSettingsInput,
} from '../../lib/serverApi';
import { notifyBudgetChanged, useBudget } from '../../hooks/useBudget';
import sectionStyles from './SettingsSection.module.css';
import modalStyles from './SettingsModal.module.css';

const { Title, Text } = Typography;

const OVERLIMIT_OPTIONS = [
  { value: 'block', label: '拦截高成本任务' },
  { value: 'warn_only', label: '仅警告，不拦截' },
];

function formatPct(value: number | null): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function renderProgressBar(usedPct: number | null, exceeded: boolean, warning: boolean) {
  if (usedPct == null) return null;
  const percent = Math.min(Math.max(usedPct, 0), 200);
  const status = exceeded ? 'error' : warning ? 'warning' : 'normal';
  return <Progress percent={percent} showText={false} status={status} style={{ flex: 1 }} />;
}

const EVENT_KIND_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  warning: { label: '预警', color: 'orange', icon: <AlertTriangle size={12} /> },
  blocked: { label: '拦截', color: 'red', icon: <Ban size={12} /> },
};

const WINDOW_LABEL: Record<string, string> = {
  daily: '日预算',
  monthly: '月预算',
};

const RESOURCE_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  text: '对话',
  task: '任务',
};

export const BudgetSettings: React.FC = () => {
  const { snapshot, events, loading, reload } = useBudget();
  const { showToast } = useToast();

  const [dailyLimit, setDailyLimit] = useState<number | null>(null);
  const [monthlyLimit, setMonthlyLimit] = useState<number | null>(null);
  const [warningThresholdPct, setWarningThresholdPct] = useState<number>(80);
  const [overlimitAction, setOverlimitAction] = useState<'block' | 'warn_only'>('block');
  const [enabled, setEnabled] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 同步 snapshot 到本地草稿
  useEffect(() => {
    if (!snapshot) return;
    setDailyLimit(snapshot.settings.dailyLimit ?? null);
    setMonthlyLimit(snapshot.settings.monthlyLimit ?? null);
    setWarningThresholdPct(snapshot.settings.warningThresholdPct);
    setOverlimitAction(
      (snapshot.settings.overlimitAction === 'warn_only' ? 'warn_only' : 'block') as
        | 'block'
        | 'warn_only',
    );
    setEnabled(snapshot.settings.enabled);
    setDirty(false);
  }, [snapshot]);

  const markDirty = () => setDirty(true);

  const handleSave = async () => {
    setSaving(true);
    try {
      const input: UpsertBudgetSettingsInput = {
        dailyLimit: dailyLimit ?? null,
        monthlyLimit: monthlyLimit ?? null,
        warningThresholdPct,
        overlimitAction,
        enabled,
      };
      await updateBudgetSettings(input);
      notifyBudgetChanged();
      await reload();
      showToast({ type: 'success', title: '预算已保存', message: '预算配置已更新' });
      setDirty(false);
    } catch (error) {
      showToast({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '请稍后重试',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setDailyLimit(null);
    setMonthlyLimit(null);
    setWarningThresholdPct(80);
    setOverlimitAction('block');
    setEnabled(true);
    setDirty(true);
  };

  const topAlert = (() => {
    if (!snapshot) return null;
    if (snapshot.dailyExceeded) {
      return (
        <Alert
          type="error"
          icon={<Ban size={16} />}
          title="今日预算已超限"
          content={`已消耗 ${formatCreditAmount(snapshot.dailySpent)} / ${formatCreditAmount(
            snapshot.settings.dailyLimit ?? 0,
          )}，高成本任务将被拦截`}
        />
      );
    }
    if (snapshot.monthlyExceeded) {
      return (
        <Alert
          type="error"
          icon={<Ban size={16} />}
          title="本月预算已超限"
          content={`已消耗 ${formatCreditAmount(snapshot.monthlySpent)} / ${formatCreditAmount(
            snapshot.settings.monthlyLimit ?? 0,
          )}，高成本任务将被拦截`}
        />
      );
    }
    if (snapshot.dailyWarning) {
      return (
        <Alert
          type="warning"
          icon={<AlertTriangle size={16} />}
          title="今日预算预警"
          content={`已使用 ${formatPct(snapshot.dailyUsedPct)}（${formatCreditAmount(
            snapshot.dailySpent,
          )} / ${formatCreditAmount(snapshot.settings.dailyLimit ?? 0)}）`}
        />
      );
    }
    if (snapshot.monthlyWarning) {
      return (
        <Alert
          type="warning"
          icon={<AlertTriangle size={16} />}
          title="本月预算预警"
          content={`已使用 ${formatPct(snapshot.monthlyUsedPct)}（${formatCreditAmount(
            snapshot.monthlySpent,
          )} / ${formatCreditAmount(snapshot.settings.monthlyLimit ?? 0)}）`}
        />
      );
    }
    return null;
  })();

  const eventColumns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 80,
      render: (kind: string) => {
        const meta = EVENT_KIND_META[kind] || { label: kind, color: 'default', icon: null };
        return (
          <Tag color={meta.color} size="small">
            {meta.icon} {meta.label}
          </Tag>
        );
      },
    },
    {
      title: '窗口',
      dataIndex: 'window',
      width: 80,
      render: (w: string) => WINDOW_LABEL[w] || w,
    },
    {
      title: '资源',
      dataIndex: 'resourceKind',
      width: 80,
      render: (r: string | null) => (r ? RESOURCE_LABEL[r] || r : '—'),
    },
    {
      title: '已用 / 上限',
      dataIndex: 'spentAmount',
      width: 160,
      render: (v: number, row: BudgetEvent) =>
        `${formatCreditAmount(v)} / ${
          row.limitAmount ? formatCreditAmount(row.limitAmount) : '—'
        }`,
    },
    {
      title: '原因',
      dataIndex: 'reason',
      render: (r: string | null) => <Text type="secondary">{r || '—'}</Text>,
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {topAlert}

      <Card bordered={false} title="当前消耗与使用率" className={sectionStyles.sectionCard}>
        {snapshot ? (
          <Space direction="vertical" size="medium" style={{ width: '100%' }}>
            <div className={modalStyles.settingRow}>
              <span>今日消耗</span>
              <Space>
                <strong>{formatCreditAmount(snapshot.dailySpent)}</strong>
                {snapshot.settings.dailyLimit ? (
                  <Text type="secondary">
                    / {formatCreditAmount(snapshot.settings.dailyLimit)}
                  </Text>
                ) : (
                  <Text type="secondary">未设置日预算</Text>
                )}
              </Space>
              {renderProgressBar(
                snapshot.dailyUsedPct,
                snapshot.dailyExceeded,
                snapshot.dailyWarning,
              )}
            </div>
            <div className={modalStyles.settingRow}>
              <span>本月消耗</span>
              <Space>
                <strong>{formatCreditAmount(snapshot.monthlySpent)}</strong>
                {snapshot.settings.monthlyLimit ? (
                  <Text type="secondary">
                    / {formatCreditAmount(snapshot.settings.monthlyLimit)}
                  </Text>
                ) : (
                  <Text type="secondary">未设置月预算</Text>
                )}
              </Space>
              {renderProgressBar(
                snapshot.monthlyUsedPct,
                snapshot.monthlyExceeded,
                snapshot.monthlyWarning,
              )}
            </div>
          </Space>
        ) : (
          <Text type="secondary">{loading ? '加载中…' : '暂无数据'}</Text>
        )}
      </Card>

      <Card bordered={false} title="预算配置" className={sectionStyles.sectionCard}>
        <Space direction="vertical" size="medium" style={{ width: '100%' }}>
          <div className={modalStyles.settingRow}>
            <span>启用预算检查</span>
            <Switch
              checked={enabled}
              onChange={(value) => {
                setEnabled(value);
                markDirty();
              }}
            />
          </div>
          <div className={modalStyles.settingRow}>
            <span>日预算（积分）</span>
            <InputNumber
              value={dailyLimit ?? undefined}
              placeholder="留空表示不设日预算"
              min={0}
              step={10}
              onChange={(value) => {
                setDailyLimit(typeof value === 'number' ? value : null);
                markDirty();
              }}
              style={{ width: 220 }}
            />
          </div>
          <div className={modalStyles.settingRow}>
            <span>月预算（积分）</span>
            <InputNumber
              value={monthlyLimit ?? undefined}
              placeholder="留空表示不设月预算"
              min={0}
              step={100}
              onChange={(value) => {
                setMonthlyLimit(typeof value === 'number' ? value : null);
                markDirty();
              }}
              style={{ width: 220 }}
            />
          </div>
          <div className={modalStyles.settingRow}>
            <span>预警阈值（%）</span>
            <InputNumber
              value={warningThresholdPct}
              min={1}
              max={100}
              step={5}
              onChange={(value) => {
                setWarningThresholdPct(typeof value === 'number' ? value : 80);
                markDirty();
              }}
              style={{ width: 220 }}
            />
          </div>
          <div className={modalStyles.settingRow}>
            <span>超限后行为</span>
            <Select
              value={overlimitAction}
              options={OVERLIMIT_OPTIONS}
              onChange={(value) => {
                setOverlimitAction(value as 'block' | 'warn_only');
                markDirty();
              }}
              style={{ width: 220 }}
            />
          </div>
          <Space>
            <Button
              type="primary"
              icon={<Save size={16} />}
              loading={saving}
              disabled={!dirty}
              onClick={() => void handleSave()}
            >
              保存预算
            </Button>
            <Button icon={<RefreshCw size={16} />} onClick={() => void reload()}>
              刷新
            </Button>
            <Button onClick={() => void handleReset()}>恢复默认</Button>
          </Space>
        </Space>
      </Card>

      <Card
        bordered={false}
        title={
          <Space>
            <TrendingUp size={16} />
            <span>最近预算事件</span>
            <Text type="secondary" style={{ fontSize: 12 }}>
              预警与拦截记录
            </Text>
          </Space>
        }
        className={sectionStyles.sectionCard}
      >
        <Table
          rowKey="id"
          columns={eventColumns}
          data={events}
          pagination={false}
          size="small"
          loading={loading}
          noDataElement={<Text type="secondary">暂无预算事件</Text>}
        />
      </Card>

      <Card bordered={false} title="工作原理" className={sectionStyles.sectionCard}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Text type="secondary">
            <ShieldCheck size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
            后端在创建 AI 任务（图片 / 视频 / 流式对话）前会先检查预算。
          </Text>
          <Text type="secondary">
            <Ban size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
            若本次任务预计会超出日/月预算，将直接拦截并返回 402 错误（错误码
            <code style={{ margin: '0 4px' }}>BUDGET_EXCEEDED</code>）。
          </Text>
          <Text type="secondary">
            <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
            达到预警阈值但未超限会记录一次 warning 事件，前端可据此提醒用户。
          </Text>
        </Space>
      </Card>
    </Space>
  );
};
