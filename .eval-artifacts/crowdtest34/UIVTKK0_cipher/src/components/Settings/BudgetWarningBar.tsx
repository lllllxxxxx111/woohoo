import React, { useEffect, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { Gauge, X } from 'lucide-react';
import { formatCreditAmount } from '../../lib/credits';
import { useBudget } from '../../hooks/useBudget';
import styles from './BudgetWarningBar.module.css';

type BudgetWarningBarProps = {
  onOpenSettings: () => void;
};

export const BudgetWarningBar: React.FC<BudgetWarningBarProps> = ({ onOpenSettings }) => {
  const { status } = useBudget();
  const [dismissedLevel, setDismissedLevel] = useState<string | null>(null);
  const level = status?.overallLevel ?? 'ok';

  useEffect(() => {
    setDismissedLevel(null);
  }, [level]);

  if (!status?.settings.enabled || level === 'ok' || dismissedLevel === level) {
    return null;
  }

  const blocked = level === 'blocked';
  const message =
    status.warnings[0] ||
    (blocked ? '预算已达到上限，高成本请求会被阻断。' : '预算使用量接近上限。');
  const daily = status.daily.limit
    ? `今日 ${formatCreditAmount(status.daily.spent)} / ${formatCreditAmount(status.daily.limit)}`
    : null;
  const monthly = status.monthly.limit
    ? `本月 ${formatCreditAmount(status.monthly.spent)} / ${formatCreditAmount(status.monthly.limit)}`
    : null;

  return (
    <div className={`${styles.bar} ${blocked ? styles.blocked : ''}`}>
      <div className={styles.content}>
        <Gauge size={18} />
        <div className={styles.copy}>
          <strong>{blocked ? '预算已超限' : '预算接近上限'}</strong>
          <span>{[message, daily, monthly].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
      <div className={styles.actions}>
        <Button size="mini" type="text" onClick={onOpenSettings}>
          预算设置
        </Button>
        <Button
          size="mini"
          type="text"
          icon={<X size={14} />}
          onClick={() => setDismissedLevel(level)}
        />
      </div>
    </div>
  );
};
