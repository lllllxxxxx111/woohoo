import type { AiSettings } from '../types';

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;
type ReadCachedApi = <T>(key: string, ttlMs: number, loader: () => Promise<T>) => Promise<T>;
type InvalidateApiCache = (...keys: string[]) => void;

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

function buildAiEndpointName(settings: AiSettings) {
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

  const updateServerAiEndpoint = async (endpointId: string, settings: AiSettings) => {
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

  return {
    listServerAiEndpoints,
    createServerAiEndpoint,
    updateServerAiEndpoint,
    deleteServerAiEndpoint,
    listServerAiEndpointCapabilities,
    upsertServerAiEndpointCapability,
  };
}
