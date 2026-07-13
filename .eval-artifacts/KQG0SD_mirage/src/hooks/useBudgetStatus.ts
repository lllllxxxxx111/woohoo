import { useCallback, useEffect, useState } from 'react';
import { BudgetStatus, getBudgetStatus } from '../lib/serverApi';
import { logger } from '../lib/logger';

const BUDGET_STATUS_REFRESH_EVENT = 'woohoo:budget-status-refresh';
const REFRESH_INTERVAL_MS = 60_000; // 1 minute

export function notifyBudgetStatusChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(BUDGET_STATUS_REFRESH_EVENT));
}

export function useBudgetStatus() {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getBudgetStatus();
      setStatus(next);
      return next;
    } catch (reloadError) {
      const message = reloadError instanceof Error ? reloadError.message : '预算状态读取失败';
      logger.error('[useBudgetStatus] Failed to load budget status', reloadError);
      setError(message);
      throw reloadError;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const reloadSafely = () => {
      void reload().catch(() => {});
    };
    reloadSafely();

    if (typeof window === 'undefined') return undefined;

    window.addEventListener(BUDGET_STATUS_REFRESH_EVENT, reloadSafely);
    const interval = window.setInterval(reloadSafely, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener(BUDGET_STATUS_REFRESH_EVENT, reloadSafely);
      window.clearInterval(interval);
    };
  }, [reload]);

  return { status, loading, error, reload };
}
