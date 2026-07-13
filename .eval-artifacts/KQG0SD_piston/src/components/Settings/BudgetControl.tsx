import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Progress,
  Slider,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Message,
} from '@arco-design/web-react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Gauge,
  RefreshCw,
  Save,
  ShieldAlert,
  TrendingDown,
} from 'lucide-react';
import { formatCreditAmount } from '../../lib/credits';
import { updateBudgetSettings, type BudgetSettings, type BudgetStatus } from '../../lib/serverApi';
import { notifyBudgetChanged, useBudget } from '../../hooks/useBudget';
import sectionStyles from './SettingsSection.module.css';

const { Title, Text } = Typography;

const TASK_TYPE_LABELS: Record<string, string> = {
  chat: '对话',
  stream: '流式对话',
  task: '异步任务',
  image_generation: '图片生成',
  video_generation: '视频生成',
};

function formatTime(iso: string) {
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

function levelMeta(level: BudgetStatus['level']) {
  switch (level) {
    case 'blocked':
      return { color: 'red' as const, icon: <Ban size={18} />, text: '已超限' };
    case 'warning':
      return { color: 'orange' as const, icon: <AlertTriangle size={18} />, text: '接近上限' };
    default:
      return { color: 'green' as const, icon: <CheckCircle2 size={18} />, text: '正常' };
  }
}

function BudgetBar({
  label,
  spent,
  limit,
  hasLimit,
}: {
  label: string;
  spent: number;
  limit: number;
  hasLimit: boolean;
}) {
  if (!hasLimit) {
    return (
      <div className={sectionStyles.statusRow}>
        <span className={sectionStyles.statusLabel}>
          <TrendingDown size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          {label}
        </span>
        <span className={sectionStyles.statusValue}>
          <Text type="secondary">未设置上限 · 已消耗 {formatCreditAmount(spent)}</Text>
        </span>
      </div>
    );
  }

  const ratio = Math.min(spent / limit, 1.5);
  const percent = Math.round(Math.min(ratio * 100, 100));
  const color = ratio >= 1 ? '#f53f3f' : ratio >= 0.8 ? '#ff7d00' : '#00b42a';

  return (
    <div style={{ marginBottom: 14 }}>
      <div className={sectionStyles.statusRow} style={{ marginBottom: 6 }}>
        <span className={sectionStyles.statusLabel}>{label}</span>
        <span className={sectionStyles.statusValue}>
          <strong>{formatCreditAmount(spent)}</strong> / {formatCreditAmount(limit)} 积分
          {ratio >= 1 ? (
            <Tag color="red" size="small" style={{ marginLeft: 8 }}>已超限</Tag>
          ) : ratio >= 0.8 ? (
            <Tag color="orange" size="small" style={{ marginLeft: 8 }}>注意</Tag>
          ) : null}
        </span>
      </div>
      <Progress percent={percent} color={color} showText={false} strokeWidth={8} style={{ margin: 0 }} />
    </div>
  );
}

export const BudgetControl: React.FC = () => {
  const { status, loading, error, reload } = useBudget();
  const [saving, setSaving] = useState(false);

  // Draft form state
  const [enabled, setEnabled] = useState(true);
  const [dailyLimit, setDailyLimit] = useState<number | null>(0);
  const [monthlyLimit, setMonthlyLimit] = useState<number | null>(0);
  const [warnThreshold, setWarnThreshold] = useState(0.8);
  const [blockHighCostOnly, setBlockHighCostOnly] = useState(true);
  const [highCostThreshold, setHighCostThreshold] = useState(0.5);

  useEffect(() => {
    if (status?.settings) {
      const s = status.settings;
      setEnabled(s.enabled);
      setDailyLimit(s.dailyLimit);
      setMonthlyLimit(s.monthlyLimit);
      setWarnThreshold(s.warnThreshold);
      setBlockHighCostOnly(s.blockHighCostOnly);
      setHighCostThreshold(s.highCostThreshold);
    }
  }, [status?.settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateBudgetSettings({
        enabled,
        dailyLimit: dailyLimit ?? 0,
        monthlyLimit: monthlyLimit ?? 0,
        warnThreshold,
        blockHighCostOnly,
        highCostThreshold,
      });
      Message.success('预算设置已保存');
      notifyBudgetChanged();
      await reload();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !status) {
    return <Text type="secondary">加载预算状态中...</Text>;
  }

  if (error && !status) {
    return (
      <Alert type="error" content={error} action={<Button size="small" onClick={() => void reload()}>重试</Button>} />
    );
  }

  const meta = levelMeta(status!.level);

  const columns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 120,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{formatTime(v)}</Text>,
    },
    {
      title: '任务类型',
      dataIndex: 'taskType',
      width: 100,
      render: (v: string) => (
        <Tag size="small" color={v.includes('image') || v.includes('video') ? 'red' : 'orange'}>
          {TASK_TYPE_LABELS[v] || v}
        </Tag>
      ),
    },
    {
      title: '原因',
      dataIndex: 'reason',
      render: (v: string, record: { model?: string | null }) => (
        <div>
          <div>{v}</div>
          {record.model && (
            <Text type="secondary" style={{ fontSize: 12 }}>模型: {record.model}</Text>
          )}
        </div>
      ),
    },
    {
      title: '预估消耗',
      dataIndex: 'estimatedCost',
      width: 90,
      align: 'right' as const,
      render: (v: number) => <strong>{formatCreditAmount(v)}</strong>,
    },
  ];

  return (
    <div className={sectionStyles.page}>
      {/* 当前预算状态 */}
      <Card bordered={false} className={sectionStyles.heroCard} title={null}>
        <div className={sectionStyles.heroRow}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Gauge size={20} />
              <Title heading={6} style={{ margin: 0 }}>预算控制 {status!.settings.enabled ? '' : '(未启用)'}</Title>
              <Tag color={meta.color} icon={meta.icon} size="small">{meta.text}</Tag>
            </div>
            <p className={sectionStyles.heroDescription}>
              设置日/月积分消耗上限，接近阈值时预警，超限时自动拦截高成本 AI 任务（图片/视频/长文本），防止积分意外耗尽。
            </p>
          </div>
          <div className={sectionStyles.heroActions}>
            <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void reload()}>
              刷新
            </Button>
          </div>
        </div>

        {status!.warnings.length > 0 && (
          <Alert
            type={status!.level === 'blocked' ? 'error' : 'warning'}
            icon={status!.level === 'blocked' ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}
            content={
              <Space direction="vertical" size={2}>
                {status!.warnings.map((w, i) => <div key={i}>{w}</div>)}
              </Space>
            }
            style={{ marginTop: 14 }}
          />
        )}
      </Card>

      {/* 用量进度 */}
      <Card bordered={false} className={sectionStyles.sectionCard} title="当前消耗进度">
        <BudgetBar
          label="今日消耗"
          spent={status!.daily.spent}
          limit={status!.daily.limit}
          hasLimit={status!.daily.hasLimit}
        />
        <BudgetBar
          label="本月消耗"
          spent={status!.monthly.spent}
          limit={status!.monthly.limit}
          hasLimit={status!.monthly.hasLimit}
        />
      </Card>

      {/* 预算设置表单 */}
      <Card bordered={false} className={sectionStyles.sectionCard} title="预算设置">
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div className={sectionStyles.statusRow}>
            <div>
              <strong>启用预算控制</strong>
              <div className={sectionStyles.fieldNote}>关闭后将不进行预算检查和拦截</div>
            </div>
            <Switch checked={enabled} onChange={setEnabled} />
          </div>

          <div className={sectionStyles.formGrid}>
            <div>
              <div style={{ marginBottom: 6 }}><strong>每日预算上限（积分）</strong></div>
              <InputNumber
                value={dailyLimit ?? 0}
                onChange={(v) => setDailyLimit(typeof v === 'number' ? v : 0)}
                min={0}
                step={5}
                precision={2}
                placeholder="0 = 不限"
                style={{ width: '100%' }}
                disabled={!enabled}
              />
              <div className={sectionStyles.fieldNote}>设为 0 表示不限制每日消耗</div>
            </div>
            <div>
              <div style={{ marginBottom: 6 }}><strong>每月预算上限（积分）</strong></div>
              <InputNumber
                value={monthlyLimit ?? 0}
                onChange={(v) => setMonthlyLimit(typeof v === 'number' ? v : 0)}
                min={0}
                step={50}
                precision={2}
                placeholder="0 = 不限"
                style={{ width: '100%' }}
                disabled={!enabled}
              />
              <div className={sectionStyles.fieldNote}>设为 0 表示不限制每月消耗</div>
            </div>
          </div>

          <div>
            <div style={{ marginBottom: 6 }}>
              <strong>预警阈值：{Math.round(warnThreshold * 100)}%</strong>
            </div>
            <Slider
              value={warnThreshold}
              onChange={(v) => setWarnThreshold(v as number)}
              min={0.5}
              max={1}
              step={0.05}
              formatTooltip={(v) => `${Math.round((v as number) * 100)}%`}
              disabled={!enabled}
            />
            <div className={sectionStyles.fieldNote}>
              消耗达到预算的此比例时在界面展示预警横幅（不拦截）
            </div>
          </div>

          <div className={sectionStyles.statusRow}>
            <div>
              <strong>超限后仅拦截高成本任务</strong>
              <div className={sectionStyles.fieldNote}>
                开启时：超过预算后仅拦截图片/视频/高 token 任务，普通对话仍可继续；关闭时：超预算后拦截所有 AI 请求
              </div>
            </div>
            <Switch checked={blockHighCostOnly} onChange={setBlockHighCostOnly} disabled={!enabled} />
          </div>

          <div>
            <div style={{ marginBottom: 6 }}>
              <strong>高成本任务阈值：{formatCreditAmount(highCostThreshold)} 积分</strong>
            </div>
            <Slider
              value={highCostThreshold}
              onChange={(v) => setHighCostThreshold(v as number)}
              min={0.1}
              max={5}
              step={0.1}
              formatTooltip={(v) => `${formatCreditAmount(v as number)} 积分`}
              disabled={!enabled || !blockHighCostOnly}
            />
            <div className={sectionStyles.fieldNote}>
              预估消耗超过此值的对话/任务会被视为"高成本"，预算超限时拦截；图片/视频生成始终视为高成本
            </div>
          </div>

          <div>
            <Button
              type="primary"
              icon={<Save size={14} />}
              loading={saving}
              onClick={() => void handleSave()}
              long
            >
              保存预算设置
            </Button>
          </div>
        </Space>
      </Card>

      {/* 最近拦截记录 */}
      <Card bordered={false} className={sectionStyles.sectionCard} title="最近拦截记录">
        {status!.recentBlocks.length === 0 ? (
          <Text type="secondary">暂无拦截记录。设置预算上限后，被拦截的高成本任务会显示在这里。</Text>
        ) : (
          <Table
            columns={columns}
            data={status!.recentBlocks}
            rowKey="id"
            pagination={false}
            size="small"
            border={false}
          />
        )}
      </Card>
    </div>
  );
};
