import { useCallback, useEffect, useState } from 'react';
import { getImageCredits, type UserCredits } from '../lib/serverApi';
import { logger } from '../lib/logger';

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
    void reload().catch(() => {
      // Error state is already exposed to the caller.
    });
  }, [reload]);

  return { credits, loading, error, reload };
}
