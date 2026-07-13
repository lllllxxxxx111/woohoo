import React from 'react';
import { AlertTriangle, Ban, Gauge, X } from 'lucide-react';
import { useBudget } from '../../hooks/useBudget';
import { formatCreditAmount } from '../../lib/credits';

type BudgetWarningBarProps = {
  onOpenBudgetSettings?: () => void;
};

/**
 * 预算预警横幅：在聊天/图片/视频页面顶部显示，当预算接近阈值或超限时提醒用户
 */
export const BudgetWarningBar: React.FC<BudgetWarningBarProps> = ({ onOpenBudgetSettings }) => {
  const { status } = useBudget();
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    // Reset dismiss when status level changes
    setDismissed(false);
  }, [status?.level]);

  if (!status || !status.settings.enabled || status.level === 'ok' || dismissed) {
    return null;
  }

  const isBlocked = status.level === 'blocked';
  const dailyRatio = status.daily.hasLimit ? status.daily.usageRatio : 0;
  const monthlyRatio = status.monthly.hasLimit ? status.monthly.usageRatio : 0;
  const topRatio = Math.max(dailyRatio, monthlyRatio);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        borderRadius: 10,
        fontSize: 13,
        marginBottom: 10,
        background: isBlocked
          ? 'rgba(245, 63, 63, 0.10)'
          : 'rgba(255, 125, 0, 0.10)',
        border: `1px solid ${isBlocked ? 'rgba(245,63,63,0.3)' : 'rgba(255,125,0,0.3)'}`,
        color: isBlocked ? '#f53f3f' : '#ff7d00',
      }}
    >
      {isBlocked ? <Ban size={16} /> : <AlertTriangle size={16} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        {isBlocked ? (
          <strong>预算已超限</strong>
        ) : (
          <strong>预算使用 {Math.round(topRatio * 100)}%</strong>
        )}
        <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>
          {status.warnings.slice(0, 2).join(' · ')}
        </span>
      </div>
      {onOpenBudgetSettings && (
        <button
          type="button"
          onClick={onOpenBudgetSettings}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            borderRadius: 6,
            border: 'none',
            background: isBlocked ? 'rgba(245,63,63,0.15)' : 'rgba(255,125,0,0.15)',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 12,
            whiteSpace: 'nowrap',
          }}
        >
          <Gauge size={12} />
          预算设置
        </button>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        style={{
          background: 'none',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          padding: 2,
          opacity: 0.6,
        }}
        aria-label="关闭"
      >
        <X size={14} />
      </button>
    </div>
  );
};
