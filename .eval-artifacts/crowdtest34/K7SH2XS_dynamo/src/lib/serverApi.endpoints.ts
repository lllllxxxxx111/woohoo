import type { AiSettings } from '../types';

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;
type ReadCachedApi = <T>(key: string, ttlMs: number, loader: () => Promise<T>) => Promise<T>;
type InvalidateApiCache = (...keys: string[]) => void;
type UpdateEndpointSettingsInput = Omit<AiSettings, 'apiKey'> & { apiKey?: string };

export type ServerAiEndpoint = {
  id: string;
  userId: string;
  name: string;
  provider: string;
  baseUrl: string;
  defaultModel?: string | null;
  isActive: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
  capabilities: ServerAiEndpointCapability[];
};

export type ServerAiEndpointCapability = {
  id: string;
  endpointId: string;
  capability: string;
  model?: string | null;
  pathOverride?: string | null;
  requestAdapter: string;
  responseAdapter: string;
  supportsStream: boolean;
  supportsTools: boolean;
  supportsFiles: boolean;
  enabled: boolean;
  priority: number;
  configJson?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertEndpointCapabilityInput = {
  capability: string;
  model?: string;
  pathOverride?: string;
  requestAdapter?: string;
  responseAdapter?: string;
  supportsStream?: boolean;
  supportsTools?: boolean;
  supportsFiles?: boolean;
  enabled?: boolean;
  priority?: number;
  configJson?: string;
};

export type ListEndpointModelsInput = {
  endpointId?: string | null;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
};

export type ListEndpointModelsResult = {
  models: string[];
};

export type ServerRoutingEvent = {
  id: string;
  requestId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  operation: string;
  capability: string;
  candidateEndpointId?: string | null;
  candidateModel?: string | null;
  candidateProvider?: string | null;
  finalEndpointId?: string | null;
  finalModel?: string | null;
  finalProvider?: string | null;
  explicitEndpointId?: string | null;
  requestedModel?: string | null;
  status: string;
  attemptIndex: number;
  maxAttempts: number;
  errorClassification?: string | null;
  errorMessage?: string | null;
  httpStatus?: number | null;
  latencyMs: number;
  wasFallback: boolean;
  fallbackReason?: string | null;
  createdAt: string;
};

export type EndpointHealthSummary = {
  endpointId: string;
  totalRequests: number;
  successCount: number;
  fallbackCount: number;
  failedCount: number;
  avgLatencyMs: number;
  recentErrors24h: number;
  lastErrorAt?: string | null;
  lastSuccessAt?: string | null;
};

export type RoutingEventsQuery = {
  endpointId?: string;
  capability?: string;
  status?: string;
  operation?: string;
  limit?: number;
  offset?: number;
};

export type RoutingEventsResult = {
  events: ServerRoutingEvent[];
  total: number;
};

export type ChatRoutingInfo = {
  wasFallback: boolean;
  attemptCount: number;
  reason: string;
  endpointId: string;
  endpointName: string;
};

type CreateEndpointApiInput = {
  requestApi: RequestApi;
  readCachedApi: ReadCachedApi;
  invalidateApiCache: InvalidateApiCache;
  cacheKeys: {
    aiEndpoints: string;
  };
  cacheTtls: {
    aiEndpoints: number;
  };
};

function buildAiEndpointName(settings: Pick<AiSettings, 'provider' | 'model'>) {
  const model = settings.model.trim() || 'default-model';
  return `Woohoo ${settings.provider} · ${model}`;
}

export function createEndpointApi({
  requestApi,
  readCachedApi,
  invalidateApiCache,
  cacheKeys,
  cacheTtls,
}: CreateEndpointApiInput) {
  const listServerAiEndpoints = async (forceRefresh = false) => {
    if (forceRefresh) {
      invalidateApiCache(cacheKeys.aiEndpoints);
    }

    return readCachedApi(cacheKeys.aiEndpoints, cacheTtls.aiEndpoints, () =>
      requestApi<ServerAiEndpoint[]>('/api/ai/endpoints'),
    );
  };

  const createServerAiEndpoint = async (settings: AiSettings) => {
    const payload: Record<string, string | undefined> = {
      name: buildAiEndpointName(settings),
      provider: settings.provider,
      baseUrl: settings.baseUrl.trim(),
      defaultModel: settings.model.trim() || undefined,
    };

    /** 仅当提供了有效的 API Key 时才包含在请求中 */
    if (settings.apiKey && settings.apiKey.trim()) {
      payload.apiKey = settings.apiKey.trim();
    }

    const endpoint = await requestApi<ServerAiEndpoint>('/api/ai/endpoints', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    invalidateApiCache(cacheKeys.aiEndpoints);
    return endpoint;
  };

  const updateServerAiEndpoint = async (
    endpointId: string,
    settings: UpdateEndpointSettingsInput,
  ) => {
    const payload: Record<string, string | undefined> = {
      name: buildAiEndpointName(settings),
      provider: settings.provider,
      baseUrl: settings.baseUrl.trim(),
      defaultModel: settings.model.trim() || undefined,
    };

    /**
     * 处理 API Key 更新逻辑：
     * - 如果提供了有效的新值 → 更新服务器端的密钥
     * - 如果是 undefined（编辑模式保留原值）→ 不包含此字段，后端保持原值不变
     * - 如果是空字符串 → 清除密钥
     */
    if (settings.apiKey !== undefined) {
      payload.apiKey = settings.apiKey.trim();
    }

    const endpoint = await requestApi<ServerAiEndpoint>(`/api/ai/endpoints/${endpointId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    invalidateApiCache(cacheKeys.aiEndpoints);
    return endpoint;
  };

  const deleteServerAiEndpoint = async (endpointId: string) => {
    await requestApi<void>(`/api/ai/endpoints/${endpointId}`, {
      method: 'DELETE',
    });

    invalidateApiCache(cacheKeys.aiEndpoints);
  };

  const listServerAiEndpointModels = async (input: ListEndpointModelsInput) => {
    return requestApi<ListEndpointModelsResult>('/api/ai/endpoints/models', {
      method: 'POST',
      body: JSON.stringify({
        endpointId: input.endpointId || undefined,
        provider: input.provider?.trim() || undefined,
        baseUrl: input.baseUrl?.trim() || undefined,
        apiKey: input.apiKey?.trim() || undefined,
      }),
    });
  };

  const listServerAiEndpointCapabilities = async (endpointId: string) => {
    return requestApi<ServerAiEndpointCapability[]>(
      `/api/ai/endpoints/${endpointId}/capabilities`,
    );
  };

  const upsertServerAiEndpointCapability = async (
    endpointId: string,
    input: UpsertEndpointCapabilityInput,
  ) => {
    const capability = await requestApi<ServerAiEndpointCapability>(
      `/api/ai/endpoints/${endpointId}/capabilities`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    );

    invalidateApiCache(cacheKeys.aiEndpoints);
    return capability;
  };

  const listRoutingEvents = async (query: RoutingEventsQuery = {}) => {
    const params = new URLSearchParams();
    if (query.endpointId) params.set('endpointId', query.endpointId);
    if (query.capability) params.set('capability', query.capability);
    if (query.status) params.set('status', query.status);
    if (query.operation) params.set('operation', query.operation);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.offset) params.set('offset', String(query.offset));
    const qs = params.toString();
    return requestApi<RoutingEventsResult>(
      `/api/ai/routing/events${qs ? `?${qs}` : ''}`,
    );
  };

  const getEndpointHealth = async () => {
    return requestApi<EndpointHealthSummary[]>('/api/ai/routing/health');
  };

  return {
    listServerAiEndpoints,
    createServerAiEndpoint,
    updateServerAiEndpoint,
    deleteServerAiEndpoint,
    listServerAiEndpointModels,
    listServerAiEndpointCapabilities,
    upsertServerAiEndpointCapability,
    listRoutingEvents,
    getEndpointHealth,
  };
}
