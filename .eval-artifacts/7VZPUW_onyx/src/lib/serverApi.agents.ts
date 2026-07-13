import type { AgentContact } from '../types';

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;
type InvalidateApiCache = (...keys: string[]) => void;

export type CreateAgentInput = {
  name: string;
  role: string;
  description?: string;
  systemPrompt: string;
  endpointId?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  badge?: string;
};

export type ProjectAgentInput = CreateAgentInput & {
  responsibilityKind?: 'design' | 'review' | 'editor' | 'manager' | 'custom';
  responsibilityLabel?: string;
};

type CreateAgentApiInput = {
  requestApi: RequestApi;
  invalidateApiCache: InvalidateApiCache;
  cacheKeys: {
    workspaceBootstrap: string;
  };
};

export function createAgentApi({ requestApi, invalidateApiCache, cacheKeys }: CreateAgentApiInput) {
  const listServerAgents = async () => {
    return requestApi<AgentContact[]>('/api/ai/agents');
  };

  const createServerAgent = async (input: CreateAgentInput) => {
    const agent = await requestApi<AgentContact>('/api/ai/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        role: input.role,
        description: input.description,
        systemPrompt: input.systemPrompt,
        endpointId: input.endpointId || undefined,
        model: input.model || undefined,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        badge: input.badge,
      }),
    });
    invalidateApiCache(cacheKeys.workspaceBootstrap);
    return agent;
  };

  const updateServerAgent = async (id: string, input: CreateAgentInput) => {
    const agent = await requestApi<AgentContact>(`/api/ai/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: input.name,
        role: input.role,
        description: input.description,
        systemPrompt: input.systemPrompt,
        endpointId: input.endpointId || undefined,
        model: input.model || undefined,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        badge: input.badge,
      }),
    });
    invalidateApiCache(cacheKeys.workspaceBootstrap);
    return agent;
  };

  const deleteServerAgent = async (id: string) => {
    await requestApi<void>(`/api/ai/agents/${id}`, {
      method: 'DELETE',
    });
    invalidateApiCache(cacheKeys.workspaceBootstrap);
  };

  const listProjectAgents = async (projectId: string) => {
    return requestApi<AgentContact[]>(`/api/projects/${projectId}/agents`);
  };

  const assignProjectAgent = async (
    projectId: string,
    agentId: string,
    responsibilityKind?: ProjectAgentInput['responsibilityKind'],
    responsibilityLabel?: string,
  ) => {
    const roster = await requestApi<AgentContact[]>(`/api/projects/${projectId}/agents/assign`, {
      method: 'POST',
      body: JSON.stringify({
        agentId,
        responsibilityKind,
        responsibilityLabel: responsibilityLabel?.trim() || undefined,
      }),
    });
    invalidateApiCache(cacheKeys.workspaceBootstrap);
    return roster;
  };

  const createProjectAgent = async (projectId: string, input: ProjectAgentInput) => {
    const agent = await requestApi<AgentContact>(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        role: input.role,
        description: input.description,
        systemPrompt: input.systemPrompt,
        endpointId: input.endpointId || undefined,
        model: input.model || undefined,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        badge: input.badge,
        responsibilityKind: input.responsibilityKind,
        responsibilityLabel: input.responsibilityLabel?.trim() || undefined,
      }),
    });
    invalidateApiCache(cacheKeys.workspaceBootstrap);
    return agent;
  };

  const removeProjectAgent = async (projectId: string, agentId: string) => {
    await requestApi<void>(`/api/projects/${projectId}/agents/${agentId}`, {
      method: 'DELETE',
    });
    invalidateApiCache(cacheKeys.workspaceBootstrap);
  };

  return {
    listServerAgents,
    createServerAgent,
    updateServerAgent,
    deleteServerAgent,
    listProjectAgents,
    assignProjectAgent,
    createProjectAgent,
    removeProjectAgent,
  };
}
