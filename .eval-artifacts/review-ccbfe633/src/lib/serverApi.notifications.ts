type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;
type ReadCachedApi = <T>(key: string, ttlMs: number, loader: () => Promise<T>) => Promise<T>;
type InvalidateApiCache = (...keys: string[]) => void;

export type NotificationChannelType =
  | 'email'
  | 'webhook'
  | 'feishu'
  | 'dingtalk'
  | 'wecom'
  | 'slack'
  | 'telegram'
  | 'other';

export type OpsNotificationChannel = {
  id: string;
  userId: string;
  name: string;
  channelType: NotificationChannelType;
  target: string;
  config?: Record<string, unknown> | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OpsNotificationEvent = {
  id: string;
  userId?: string | null;
  channelId?: string | null;
  findingId?: string | null;
  eventType: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  dedupeKey: string;
  attemptCount: number;
  lastError?: string | null;
  nextAttemptAt?: string | null;
  payload?: Record<string, unknown> | null;
  responseBody?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  sentAt?: string | null;
};

export type TestNotificationInput = {
  channelType: NotificationChannelType;
  target: string;
  config?: Record<string, unknown> | null;
  title?: string;
  message?: string;
};

export type TestNotificationResult = {
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  channelType: NotificationChannelType;
  responseBody?: string | null;
  event: OpsNotificationEvent;
};

export type UpsertNotificationChannelInput = {
  name: string;
  channelType: NotificationChannelType;
  target: string;
  config?: Record<string, unknown> | null;
  isEnabled?: boolean;
};

type CreateNotificationApiInput = {
  requestApi: RequestApi;
  readCachedApi: ReadCachedApi;
  invalidateApiCache: InvalidateApiCache;
  cacheKeys: {
    notificationChannels: string;
  };
  cacheTtls: {
    notificationChannels: number;
  };
};

export function createNotificationApi({
  requestApi,
  readCachedApi,
  invalidateApiCache,
  cacheKeys,
  cacheTtls,
}: CreateNotificationApiInput) {
  const listNotificationChannels = async (forceRefresh = false) => {
    if (forceRefresh) {
      invalidateApiCache(cacheKeys.notificationChannels);
    }

    return readCachedApi(cacheKeys.notificationChannels, cacheTtls.notificationChannels, () =>
      requestApi<OpsNotificationChannel[]>('/api/ops/notification-channels'),
    );
  };

  const createNotificationChannel = async (input: UpsertNotificationChannelInput) => {
    const channel = await requestApi<OpsNotificationChannel>('/api/ops/notification-channels', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name.trim(),
        channelType: input.channelType,
        target: input.target.trim(),
        config: input.config ?? undefined,
        isEnabled: input.isEnabled ?? true,
      }),
    });

    invalidateApiCache(cacheKeys.notificationChannels);
    return channel;
  };

  const updateNotificationChannel = async (id: string, input: UpsertNotificationChannelInput) => {
    const channel = await requestApi<OpsNotificationChannel>(
      `/api/ops/notification-channels/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: input.name.trim(),
          channelType: input.channelType,
          target: input.target.trim(),
          config: input.config ?? undefined,
          isEnabled: input.isEnabled ?? true,
        }),
      },
    );

    invalidateApiCache(cacheKeys.notificationChannels);
    return channel;
  };

  const deleteNotificationChannel = async (id: string) => {
    await requestApi<void>(`/api/ops/notification-channels/${id}`, {
      method: 'DELETE',
    });

    invalidateApiCache(cacheKeys.notificationChannels);
  };

  const testNotificationChannel = async (input: TestNotificationInput) => {
    return requestApi<TestNotificationResult>('/api/ops/notification-channels/test', {
      method: 'POST',
      body: JSON.stringify({
        channelType: input.channelType,
        target: input.target.trim(),
        config: input.config ?? undefined,
        title: input.title?.trim() || undefined,
        message: input.message?.trim() || undefined,
      }),
    });
  };

  const listNotificationEvents = async (limit = 20) => {
    return requestApi<OpsNotificationEvent[]>(
      `/api/ops/notification-events?limit=${Math.max(1, Math.min(limit, 200))}`,
    );
  };

  return {
    listNotificationChannels,
    createNotificationChannel,
    updateNotificationChannel,
    deleteNotificationChannel,
    testNotificationChannel,
    listNotificationEvents,
  };
}
