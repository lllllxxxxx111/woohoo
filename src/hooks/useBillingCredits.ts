import { useCallback, useEffect, useState } from 'react';
import { getImageCredits, type UserCredits } from '../lib/serverApi';
import { logger } from '../lib/logger';

const BILLING_CREDITS_REFRESH_EVENT = 'woohoo:billing-credits-refresh';

export function notifyBillingCreditsChanged() {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new Event(BILLING_CREDITS_REFRESH_EVENT));
}

export function useBillingCredits() {
  const [credits, setCredits] = useState<UserCredits | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextCredits = await getImageCredits();
      setCredits(nextCredits);
      return nextCredits;
    } catch (reloadError) {
      const message = reloadError instanceof Error ? reloadError.message : '积分余额读取失败';
      logger.error('[useBillingCredits] Failed to load billing credits', reloadError);
      setError(message);
      throw reloadError;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const reloadSafely = () => {
      void reload().catch(() => {
        // Error state is already exposed to the caller.
      });
    };

    reloadSafely();

    if (typeof window === 'undefined') {
      return undefined;
    }

    window.addEventListener(BILLING_CREDITS_REFRESH_EVENT, reloadSafely);
    return () => window.removeEventListener(BILLING_CREDITS_REFRESH_EVENT, reloadSafely);
  }, [reload]);

  return { credits, loading, error, reload };
}
