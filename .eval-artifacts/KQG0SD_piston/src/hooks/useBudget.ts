import { useCallback, useEffect, useState } from 'react';
import { getBudgetStatus, type BudgetStatus } from '../lib/serverApi';
import { logger } from '../lib/logger';

const BUDGET_REFRESH_EVENT = 'woohoo:budget-refresh';

export function notifyBudgetChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(BUDGET_REFRESH_EVENT));
}

export function useBudget() {
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
      logger.error('[useBudget] Failed to load budget status', reloadError);
      setError(message);
      throw reloadError;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const reloadSafely = () => { void reload().catch(() => {}); };
    reloadSafely();
    if (typeof window === 'undefined') return undefined;
    window.addEventListener(BUDGET_REFRESH_EVENT, reloadSafely);
    return () => window.removeEventListener(BUDGET_REFRESH_EVENT, reloadSafely);
  }, [reload]);

  return { status, loading, error, reload };
}
