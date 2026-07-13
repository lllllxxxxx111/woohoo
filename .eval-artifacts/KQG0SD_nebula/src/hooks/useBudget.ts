import { useCallback, useEffect, useState } from 'react';
import {
  getBudgetSnapshot,
  listBudgetEvents,
  type BudgetEvent,
  type BudgetSnapshot,
} from '../lib/serverApi';
import { logger } from '../lib/logger';

const BUDGET_REFRESH_EVENT = 'woohoo:budget-refresh';

export function notifyBudgetChanged() {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new Event(BUDGET_REFRESH_EVENT));
}

export function useBudget() {
  const [snapshot, setSnapshot] = useState<BudgetSnapshot | null>(null);
  const [events, setEvents] = useState<BudgetEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [snap, evts] = await Promise.all([getBudgetSnapshot(), listBudgetEvents()]);
      setSnapshot(snap);
      setEvents(evts);
      return { snapshot: snap, events: evts };
    } catch (reloadError) {
      const message = reloadError instanceof Error ? reloadError.message : '预算读取失败';
      logger.error('[useBudget] Failed to load budget', reloadError);
      setError(message);
      throw reloadError;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const reloadSafely = () => {
      void reload().catch(() => {
        // 错误状态已暴露给调用方
      });
    };

    reloadSafely();

    if (typeof window === 'undefined') {
      return undefined;
    }

    window.addEventListener(BUDGET_REFRESH_EVENT, reloadSafely);
    return () => window.removeEventListener(BUDGET_REFRESH_EVENT, reloadSafely);
  }, [reload]);

  return { snapshot, events, loading, error, reload };
}
