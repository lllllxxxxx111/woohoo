import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Space,
  Switch,
  Tag,
} from '@arco-design/web-react';
import { RefreshCw, Save } from 'lucide-react';
import { useToast } from '../../context/useToast';
import { formatCreditAmount } from '../../lib/credits';
import {
  updateBudgetSettings,
  type BudgetBlockEvent,
  type BudgetStatus,
  type BudgetWindowStatus,
  type UpdateBudgetSettingsInput,
} from '../../lib/serverApi';
import { useBudget } from '../../hooks/useBudget';
import styles from './BudgetControl.module.css';

type BudgetDraft = UpdateBudgetSettingsInput;

const DEFAULT_DRAFT: BudgetDraft = {
  dailyLimit: null,
  monthlyLimit: null,
  warningThreshold: 0.8,
  blockHighCostOnly: true,
  highCostThreshold: 0.5,
  enabled: false,
};

function percentLabel(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '未设置';
  }
  return `${Math.round(value * 100)}%`;
}

function limitLabel(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '不限额';
  }
  return `${formatCreditAmount(value)} 积分`;
}

function statusColor(status: BudgetStatus['overallLevel']) {
  if (status === 'blocked') return 'red';
  if (status === 'warning') return 'orange';
  return 'green';
}

function statusLabel(status: BudgetStatus['overallLevel']) {
  if (status === 'blocked') return '已超限';
  if (status === 'warning') return '接近上限';
  return '正常';
}

function normalizeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function BudgetWindowCard({ title, window }: { title: string; window: BudgetWindowStatus }) {
  const percent = Math.min(100, Math.max(0, Math.round((window.percentUsed ?? 0) * 100)));
  return (
    <div className={styles.windowCard}>
      <div className={styles.windowHeader}>
        <strong>{title}</strong>
        <Tag color={window.blocked ? 'red' : window.warning ? 'orange' : 'green'}>
          {window.blocked ? '已超限' : window.warning ? '预警' : '正常'}
        </Tag>
      </div>
      <div className={styles.progressTrack}>
        <div
          className={`${styles.progressFill} ${window.blocked ? styles.blocked : ''}`}
          style={{ '--budget-progress': `${percent}%` } as React.CSSProperties}
        />
      </div>
      <div className={styles.windowMeta}>
        <span>已用 {formatCreditAmount(window.spent)} 积分</span>
        <span>{limitLabel(window.limit)}</span>
      </div>
      <div className={styles.windowMeta}>
        <span>使用率 {percentLabel(window.percentUsed)}</span>
        <span>剩余 {limitLabel(window.remaining)}</span>
      </div>
    </div>
  );
}

function BlockEventRow({ event }: { event: BudgetBlockEvent }) {
  return (
    <div className={styles.blockRow}>
      <div className={styles.blockReason}>
        <strong>{event.reason}</strong>
        <span>
          {event.taskType} · 预计 {formatCreditAmount(event.estimatedCost)} 积分 · 已用{' '}
          {formatCreditAmount(event.spentAmount)} / {formatCreditAmount(event.limitAmount)}
        </span>
      </div>
      <Tag color={event.windowType === 'monthly' ? 'purple' : 'arcoblue'}>
        {event.windowType === 'monthly' ? '月度' : '日度'}
      </Tag>
    </div>
  );
}

export const BudgetControl: React.FC = () => {
  const { showToast } = useToast();
  const { status, loading, error, reload } = useBudget();
  const [draft, setDraft] = useState<BudgetDraft>(DEFAULT_DRAFT);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!status) return;
    setDraft({
      dailyLimit: status.settings.dailyLimit ?? null,
      monthlyLimit: status.settings.monthlyLimit ?? null,
      warningThreshold: status.settings.warningThreshold,
      blockHighCostOnly: status.settings.blockHighCostOnly,
      highCostThreshold: status.settings.highCostThreshold,
      enabled: status.settings.enabled,
    });
  }, [status]);

  const alerts = useMemo(() => status?.warnings ?? [], [status]);

  const save = async () => {
    setSaving(true);
    try {
      await updateBudgetSettings({
        dailyLimit: normalizeNumber(draft.dailyLimit),
        monthlyLimit: normalizeNumber(draft.monthlyLimit),
        warningThreshold: Math.min(1, Math.max(0.5, draft.warningThreshold)),
        blockHighCostOnly: draft.blockHighCostOnly,
        highCostThreshold: Math.max(0.01, draft.highCostThreshold),
        enabled: draft.enabled,
      });
      await reload();
      showToast({
        type: 'success',
        title: '预算设置已保存',
        message: draft.enabled ? '后续高成本请求会先进行预算检查' : '预算控制已关闭',
      });
    } catch (saveError) {
      showToast({
        type: 'error',
        title: '预算设置保存失败',
        message: saveError instanceof Error ? saveError.message : '请稍后重试',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.hero}>
        <div>
          <h3>预算控制</h3>
          <p>按日和按月限制积分消耗，超限时阻断图片、视频和高成本对话请求。</p>
        </div>
        <Tag className={styles.statusTag} color={statusColor(status?.overallLevel ?? 'ok')}>
          {status ? statusLabel(status.overallLevel) : '读取中'}
        </Tag>
      </div>

      {error ? <Alert type="error" content={error} /> : null}
      {alerts.map((message) => (
        <Alert key={message} type={status?.overallLevel === 'blocked' ? 'error' : 'warning'} content={message} />
      ))}

      {status ? (
        <div className={styles.grid}>
          <BudgetWindowCard title="今日预算" window={status.daily} />
          <BudgetWindowCard title="本月预算" window={status.monthly} />
        </div>
      ) : null}

      <Card bordered={false} className={styles.formCard}>
        <div className={styles.formRow}>
          <div>
            <strong>启用预算控制</strong>
            <div className={styles.formHint}>关闭后只展示用量，不会阻断请求。</div>
          </div>
          <Switch
            checked={draft.enabled}
            onChange={(checked) => setDraft((prev) => ({ ...prev, enabled: checked }))}
          />
        </div>

        <div className={styles.formRow}>
          <div>
            <strong>日预算上限</strong>
            <div className={styles.formHint}>留空表示不限制日消耗。</div>
          </div>
          <div className={styles.numberGroup}>
            <InputNumber
              min={0}
              step={1}
              value={draft.dailyLimit ?? undefined}
              onChange={(value) => setDraft((prev) => ({ ...prev, dailyLimit: normalizeNumber(value) }))}
            />
            <span>积分</span>
          </div>
        </div>

        <div className={styles.formRow}>
          <div>
            <strong>月预算上限</strong>
            <div className={styles.formHint}>留空表示不限制月消耗。</div>
          </div>
          <div className={styles.numberGroup}>
            <InputNumber
              min={0}
              step={5}
              value={draft.monthlyLimit ?? undefined}
              onChange={(value) => setDraft((prev) => ({ ...prev, monthlyLimit: normalizeNumber(value) }))}
            />
            <span>积分</span>
          </div>
        </div>

        <div className={styles.formRow}>
          <div>
            <strong>预警阈值</strong>
            <div className={styles.formHint}>达到该比例时显示提醒但不阻断。</div>
          </div>
          <div className={styles.numberGroup}>
            <InputNumber
              min={50}
              max={100}
              step={5}
              value={Math.round(draft.warningThreshold * 100)}
              onChange={(value) =>
                setDraft((prev) => ({
                  ...prev,
                  warningThreshold: Math.min(1, Math.max(0.5, Number(value || 80) / 100)),
                }))
              }
            />
            <span>%</span>
          </div>
        </div>

        <div className={styles.formRow}>
          <div>
            <strong>仅阻断高成本任务</strong>
            <div className={styles.formHint}>超限后仍允许短文本对话，图片和视频始终视为高成本。</div>
          </div>
          <Switch
            checked={draft.blockHighCostOnly}
            onChange={(checked) =>
              setDraft((prev) => ({ ...prev, blockHighCostOnly: checked }))
            }
          />
        </div>

        <div className={styles.formRow}>
          <div>
            <strong>高成本对话阈值</strong>
            <div className={styles.formHint}>预计消耗达到该值的对话会被预算超限规则阻断。</div>
          </div>
          <div className={styles.numberGroup}>
            <InputNumber
              min={0.01}
              step={0.1}
              value={draft.highCostThreshold}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, highCostThreshold: Number(value || 0.5) }))
              }
            />
            <span>积分</span>
          </div>
        </div>

        <Space>
          <Button type="primary" icon={<Save size={16} />} loading={saving} onClick={save}>
            保存预算
          </Button>
          <Button icon={<RefreshCw size={16} />} loading={loading} onClick={() => void reload()}>
            刷新
          </Button>
        </Space>
      </Card>

      <div className={styles.blocksCard}>
        <div className={styles.windowHeader}>
          <strong>最近阻断记录</strong>
          <Tag>{status?.recentBlocks.length ?? 0}</Tag>
        </div>
        <div className={styles.blockList}>
          {status?.recentBlocks.length ? (
            status.recentBlocks.map((event) => <BlockEventRow key={event.id} event={event} />)
          ) : (
            <span className={styles.formHint}>暂无预算阻断记录。</span>
          )}
        </div>
      </div>
    </div>
  );
};
