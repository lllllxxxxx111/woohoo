import type {
  ActiveState,
  AgentContact,
  AiSettings,
  Asset,
  ChatSession,
  Message,
  Project,
  ResourceRef,
  Script,
  Storyboard,
} from '../../types';

function createLocalId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyWorkflowSummary() {
  return {
    status: 'draft',
    phase: 'ideation',
    progressPercent: 0,
    assetCount: 0,
    scriptReady: false,
    storyboardReady: false,
    storyboardLineCount: 0,
    conversationCount: 0,
    messageCount: 0,
    assignedAgentCount: 0,
    queuedTaskCount: 0,
    runningTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    roleCounts: {
      design: 0,
      review: 0,
      editor: 0,
      manager: 0,
      custom: 0,
    },
  };
}

export function createId(prefix: string): string {
  return createLocalId(prefix);
}

export function trimChatTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return '新对话';
  }

  return normalized.length > 20 ? `${normalized.slice(0, 20)}...` : normalized;
}

const PROJECT_NAME_NOISE_PATTERNS = [
  /^(好的?|嗯+|哦+|收到|了解|行|可以|继续|下一步|谢谢|辛苦了|ok|okay|yes|no|hi|hello)[!！。.\s]*$/i,
  /^(请继续|继续吧|继续即可|随便|都行)[!！。.\s]*$/i,
];

function cleanProjectNameSourceText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][^\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isProjectNameNoise(content: string): boolean {
  const compact = content.replace(/\s+/g, '');
  if (!compact || compact.length < 2) {
    return true;
  }

  return PROJECT_NAME_NOISE_PATTERNS.some((pattern) => pattern.test(compact));
}

function normalizeProjectNameCandidate(content: string): string {
  let normalized = content
    .replace(
      /^请(?:帮我)?|^帮我|^我想(?:要)?|^我需要|^我们想|^想要|^想做|^做一个|^做一套|^创建|^新建|^关于|^围绕/,
      '',
    )
    .replace(/["'“”‘’]/g, '')
    .replace(/[，。！？,.!?；;:：]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return '新项目';
  }

  if (normalized.length > 24) {
    normalized = normalized.slice(0, 24).trim();
  }

  return normalized || '新项目';
}

function extractProjectNameCandidate(content: string): string {
  const normalized = cleanProjectNameSourceText(content);
  if (!normalized || isProjectNameNoise(normalized)) {
    return '';
  }

  const patterns = [
    /(?:项目|主题|方向|任务|目标)(?:是|为|关于)?[:：]?\s*([^，。！？,.!?]{2,24})/,
    /(?:做|创建|搭建|开发|制作|设计|写|生成|策划|规划)\s*(?:一个|一套|一款|一部|一份)?\s*([^，。！？,.!?]{2,24})/,
    /(?:关于|围绕)\s*([^，。！？,.!?]{2,24})/,
  ];

  for (const pattern of patterns) {
    const matched = normalized.match(pattern);
    if (matched?.[1]) {
      return normalizeProjectNameCandidate(matched[1]);
    }
  }

  const firstSegment = normalized.split(/[，。！？,.!?]/)[0]?.trim() || normalized;
  return normalizeProjectNameCandidate(firstSegment);
}

export function inferProjectNameFromConversation(
  messages: Message[],
  seedContent?: string,
): string {
  const userContents = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  const aiContents = messages
    .filter((message) => message.role === 'ai')
    .slice(-4)
    .map((message) => message.content);

  const candidates = [
    ...(seedContent ? [seedContent] : []),
    ...userContents.slice(-16),
    ...aiContents,
  ]
    .map(extractProjectNameCandidate)
    .filter((item) => item && !isProjectNameNoise(item));

  if (candidates.length === 0) {
    return '新项目';
  }

  return normalizeProjectNameCandidate(candidates[candidates.length - 1]);
}

export function getChatSession(
  projects: Project[],
  projectId: string,
  chatId: string,
): ChatSession | undefined {
  return projects
    .find((project) => project.id === projectId)
    ?.chatSessions.find((chat) => chat.id === chatId);
}

export function sanitizeActiveState(projects: Project[], state: ActiveState): ActiveState {
  if (!projects.length) {
    return { projectId: null, chatSessionId: null, currentTab: state.currentTab };
  }

  const project = state.projectId
    ? projects.find((item) => item.id === state.projectId)
    : projects[0];

  if (!project) {
    return {
      projectId: projects[0].id,
      chatSessionId: projects[0].chatSessions[0]?.id ?? null,
      currentTab: state.currentTab,
    };
  }

  const hasActiveChat = state.chatSessionId
    ? project.chatSessions.some((chat) => chat.id === state.chatSessionId)
    : false;

  return {
    projectId: project.id,
    chatSessionId: hasActiveChat ? state.chatSessionId : (project.chatSessions[0]?.id ?? null),
    currentTab: state.currentTab,
  };
}

export function buildSystemPrompt(
  basePrompt: string,
  agent?: AgentContact,
  projectContextPrompt?: string,
) {
  const parts = [
    basePrompt.trim(),
    projectContextPrompt?.trim(),
    agent?.systemPrompt?.trim(),
  ].filter(Boolean);
  return parts.join('\n\n');
}

export function extractAgent(content: string, agents: AgentContact[]) {
  const matchedAgent = agents.find((agent) => content.includes(`@${agent.name}`));

  if (!matchedAgent) {
    return { agent: undefined, sanitizedContent: content.trim() };
  }

  const sanitizedContent = content.split(`@${matchedAgent.name}`).join('').trim();

  return {
    agent: matchedAgent,
    sanitizedContent: sanitizedContent || content.trim(),
  };
}

export function createLocalProject(name: string): Project {
  return {
    id: createLocalId('proj'),
    name,
    status: 'draft',
    phase: 'ideation',
    chatSessions: [],
    agentRoster: [],
    workflow: createEmptyWorkflowSummary(),
    assetsCount: 0,
    createdAt: Date.now(),
  };
}

export function createLocalChat(projectId: string, title = '新对话'): ChatSession {
  return {
    id: createLocalId('chat'),
    projectId,
    title,
    messages: [],
    updatedAt: Date.now(),
  };
}

export function createLocalAsset(
  projectId: string,
  name: string,
  type: Asset['type'],
  url: string,
): Asset {
  return {
    id: createLocalId('asset'),
    projectId,
    name,
    type,
    url,
    createdAt: Date.now(),
  };
}

export function createLocalScript(projectId: string, title: string, content: string): Script {
  return {
    id: createLocalId('script'),
    projectId,
    title,
    content,
    updatedAt: Date.now(),
  };
}

export function createLocalStoryboard(projectId: string, lines: Storyboard['lines']): Storyboard {
  return {
    id: createLocalId('board'),
    projectId,
    lines,
    updatedAt: Date.now(),
  };
}

export function inferResponsibilityKind(agent: AgentContact) {
  const lowered = `${agent.responsibilityKind || ''} ${agent.name} ${agent.role}`.toLowerCase();
  if (
    lowered.includes('review') ||
    lowered.includes('审核') ||
    lowered.includes('合规') ||
    lowered.includes('风控')
  ) {
    return 'review';
  }
  if (
    lowered.includes('editor') ||
    lowered.includes('主编') ||
    lowered.includes('编辑') ||
    lowered.includes('大纲')
  ) {
    return 'editor';
  }
  if (
    lowered.includes('manager') ||
    lowered.includes('管理') ||
    lowered.includes('统筹') ||
    lowered.includes('经理')
  ) {
    return 'manager';
  }
  if (
    lowered.includes('design') ||
    lowered.includes('设计') ||
    lowered.includes('视觉') ||
    lowered.includes('分镜') ||
    lowered.includes('人物')
  ) {
    return 'design';
  }
  return 'custom';
}

export function buildProjectContextPrompt(project: Project | undefined, allAgents: AgentContact[]) {
  if (!project) {
    return '';
  }

  const roster = project.agentRoster ?? [];
  const roleCounts = project.workflow?.roleCounts ?? createEmptyWorkflowSummary().roleCounts;
  const assignedIds = new Set(roster.map((agent) => agent.id));
  const reusable = allAgents.filter((agent) => !assignedIds.has(agent.id));
  const lines = [
    `[当前项目上下文]`,
    `项目名称: ${project.name}`,
    `项目状态: ${project.status} / ${project.phase} / 进度 ${project.workflow?.progressPercent ?? 0}%`,
    `当前项目角色计数: 设计 ${roleCounts.design}，审核 ${roleCounts.review}，主编 ${roleCounts.editor}，管理 ${roleCounts.manager}，其他 ${roleCounts.custom}`,
    `当前项目流程: 资产 ${project.workflow?.assetCount ?? 0}，剧本 ${project.workflow?.scriptReady ? '已完成' : '未完成'}，分镜 ${project.workflow?.storyboardLineCount ?? 0}，对话 ${project.workflow?.conversationCount ?? 0}，消息 ${project.workflow?.messageCount ?? 0}，任务 ${project.workflow?.queuedTaskCount ?? 0}/${project.workflow?.runningTaskCount ?? 0}/${project.workflow?.completedTaskCount ?? 0}/${project.workflow?.failedTaskCount ?? 0}(排队/执行中/完成/失败)`,
  ];

  if (roster.length > 0) {
    lines.push('当前项目成员:');
    roster.forEach((agent) => {
      lines.push(
        `- ${agent.name} | 分类 ${inferResponsibilityKind(agent)} | 角色 ${agent.responsibilityLabel || agent.role} | 执行中 ${agent.activeTasks ?? 0} | 排队 ${agent.queuedTasks ?? 0}`,
      );
    });
  } else {
    lines.push('当前项目还没有绑定成员。');
  }

  if (reusable.length > 0) {
    lines.push('可复用但尚未加入当前项目的智能体:');
    reusable.slice(0, 8).forEach((agent) => {
      lines.push(`- ${agent.name} | 分类 ${inferResponsibilityKind(agent)} | 角色 ${agent.role}`);
    });
  }

  lines.push('只能基于当前项目做分工、进度和资源判断，不要引用其他项目。');
  return lines.join('\n');
}

function isResourceMentionBoundary(value: string | undefined) {
  return !value || /[\s,.;:!?()[\]{}<>，。；：！？、]/.test(value);
}

export function formatAssetTypeLabel(type: Asset['type']) {
  switch (type) {
    case 'image':
      return '图片';
    case 'video':
      return '视频';
    case 'audio':
      return '音频';
    default:
      return '文档';
  }
}

function toResourceRef(asset: Asset): ResourceRef {
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    projectId: asset.projectId,
    projectName: asset.projectName,
    versionLabel: asset.versionLabel,
  };
}

function mergeResourceRefs(...groups: Array<ResourceRef[] | undefined>): ResourceRef[] {
  const merged: ResourceRef[] = [];
  const seen = new Set<string>();

  groups.forEach((group) => {
    group?.forEach((resourceRef) => {
      if (!resourceRef.id || seen.has(resourceRef.id)) {
        return;
      }
      seen.add(resourceRef.id);
      merged.push(resourceRef);
    });
  });

  return merged;
}

function extractReferencedAssets(
  content: string,
  assets: Asset[],
  existingRefs: ResourceRef[] = [],
  preferredProjectId?: string | null,
): ResourceRef[] {
  if (!content.includes('#') || assets.length === 0) {
    return existingRefs;
  }

  const sortedAssets = [...assets].sort((left, right) => {
    const leftPreferred = preferredProjectId && left.projectId === preferredProjectId ? 1 : 0;
    const rightPreferred = preferredProjectId && right.projectId === preferredProjectId ? 1 : 0;
    if (leftPreferred !== rightPreferred) {
      return rightPreferred - leftPreferred;
    }
    const nameLengthDiff = right.name.length - left.name.length;
    if (nameLengthDiff !== 0) {
      return nameLengthDiff;
    }
    return right.createdAt - left.createdAt;
  });

  const seen = new Set(existingRefs.map((resourceRef) => resourceRef.id));
  const refs: ResourceRef[] = [...existingRefs];

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '#') {
      continue;
    }

    const matchedAsset = sortedAssets.find((asset) => {
      if (!content.startsWith(asset.name, index + 1)) {
        return false;
      }

      return isResourceMentionBoundary(content[index + 1 + asset.name.length]);
    });

    if (!matchedAsset || seen.has(matchedAsset.id)) {
      continue;
    }

    seen.add(matchedAsset.id);
    refs.push(toResourceRef(matchedAsset));
  }

  return refs;
}

export function normalizeResourceMentions(
  content: string,
  assets: Asset[],
  explicitRefs: ResourceRef[] = [],
  preferredProjectId?: string | null,
) {
  if (assets.length === 0) {
    return {
      sanitizedContent: content,
      resourceRefs: mergeResourceRefs(explicitRefs),
    };
  }

  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const tokenRefs: ResourceRef[] = [];
  const sanitizedContent = content.replace(
    /#([^#\n<]+?)<asset:([^>\s]+)>/g,
    (_, rawName: string, assetId: string) => {
      const asset = assetsById.get(assetId.trim());
      if (!asset) {
        return `#${rawName.trim()}`;
      }
      tokenRefs.push(toResourceRef(asset));
      return `#${asset.name}`;
    },
  );

  const mergedExplicitRefs = mergeResourceRefs(explicitRefs, tokenRefs);
  return {
    sanitizedContent,
    resourceRefs: extractReferencedAssets(
      sanitizedContent,
      assets,
      mergedExplicitRefs,
      preferredProjectId,
    ),
  };
}

export function detectAssetType(file: File): Asset['type'] {
  if (file.type.startsWith('image/')) {
    return 'image';
  }

  if (file.type.startsWith('video/')) {
    return 'video';
  }

  if (file.type.startsWith('audio/')) {
    return 'audio';
  }

  return 'document';
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error(`读取文件失败: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function deriveScriptTitle(content: string, currentTitle?: string) {
  const heading = content
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  const normalized = heading || currentTitle?.trim() || '主剧本';

  return normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

export function buildHistoryMessagesFromList(messages: Message[]) {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'ai' ? 'assistant' : 'user',
      content: message.content,
    })) as Array<{ role: 'user' | 'assistant'; content: string }>;
}

export function buildHistoryMessages(chatSnapshot?: ChatSession) {
  return buildHistoryMessagesFromList(chatSnapshot?.messages ?? []);
}

/**
 * 判断是否允许回退到直连AI模式
 * 当 requireServerTask=true 时，禁止任何形式的fallback
 */
export function shouldFallbackToDirectAi(error: unknown, requireServerTask = false) {
  if (requireServerTask) {
    return false;
  }

  if (!(error instanceof Error)) {
    return true;
  }

  const message = error.message.toLowerCase();

  return (
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('load failed') ||
    message.includes('fetch') ||
    message.includes('无法连接') ||
    message.includes('对话不存在')
  );
}

export function isUnauthorizedError(error: unknown) {
  return error instanceof Error && error.message === 'UNAUTHORIZED';
}

export function endpointMatchesAiSettings(
  endpoint: {
    provider: string;
    baseUrl: string;
    defaultModel?: string | null;
  },
  settings: Pick<AiSettings, 'provider' | 'baseUrl'>,
) {
  return (
    endpointMatchesAiProvider(endpoint, settings) &&
    normalizeBaseUrl(endpoint.baseUrl) === normalizeBaseUrl(settings.baseUrl)
  );
}

export function endpointMatchesAiConnection(
  endpoint: {
    provider: string;
    baseUrl: string;
  },
  settings: Pick<AiSettings, 'provider' | 'baseUrl'>,
) {
  return (
    endpointMatchesAiProvider(endpoint, settings) &&
    normalizeBaseUrl(endpoint.baseUrl) === normalizeBaseUrl(settings.baseUrl)
  );
}

export function endpointMatchesAiProvider(
  endpoint: {
    provider: string;
  },
  settings: Pick<AiSettings, 'provider'>,
) {
  return endpoint.provider.trim().toLowerCase() === settings.provider.trim().toLowerCase();
}

export function selectAiEndpointForSettings<
  TEndpoint extends {
    id: string;
    provider: string;
    baseUrl: string;
    defaultModel?: string | null;
    isActive: boolean;
    hasApiKey: boolean;
  },
>(
  endpoints: TEndpoint[],
  settings: Pick<AiSettings, 'provider' | 'baseUrl' | 'model'>,
  currentEndpointId?: string | null,
) {
  const usableProviderEndpoints = endpoints.filter(
    (endpoint) =>
      endpoint.isActive && endpoint.hasApiKey && endpointMatchesAiProvider(endpoint, settings),
  );
  const currentEndpoint = currentEndpointId
    ? usableProviderEndpoints.find((endpoint) => endpoint.id === currentEndpointId)
    : undefined;

  if (currentEndpoint) {
    return currentEndpoint;
  }

  return (
    usableProviderEndpoints.find((endpoint) => endpointMatchesAiSettings(endpoint, settings)) ??
    usableProviderEndpoints.find((endpoint) => endpointMatchesAiConnection(endpoint, settings)) ??
    (usableProviderEndpoints.length === 1 ? usableProviderEndpoints[0] : undefined)
  );
}

export function resolveAiTaskRequestModel(
  endpoint: {
    provider: string;
    baseUrl: string;
  },
  settings: Pick<AiSettings, 'provider' | 'baseUrl' | 'model'>,
) {
  const model = settings.model.trim();
  if (!model || !endpointMatchesAiConnection(endpoint, settings)) {
    return undefined;
  }

  return model;
}
