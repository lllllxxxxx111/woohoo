import { describe, it, expect } from 'vitest';
import type { AgentContact, AiSettings, Asset, ChatSession, Message, Project } from '../../types';
import { createAiSettings } from '../../lib/ai';
import {
  trimChatTitle,
  inferProjectNameFromConversation,
  getChatSession,
  sanitizeActiveState,
  buildSystemPrompt,
  extractAgent,
  createEmptyWorkflowSummary,
  createLocalProject,
  createLocalChat,
  createLocalAsset,
  createLocalScript,
  createLocalStoryboard,
  inferResponsibilityKind,
  formatAssetTypeLabel,
  normalizeResourceMentions,
  detectAssetType,
  deriveScriptTitle,
  buildHistoryMessagesFromList,
  buildHistoryMessages,
  shouldFallbackToDirectAi,
  isUnauthorizedError,
  endpointMatchesAiSettings,
} from './appContextHelpers';

/**
 * 构建测试用的 Message 对象
 */
function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'user',
    content: '你好',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * 构建测试用的 AgentContact 对象
 */
function makeAgent(overrides: Partial<AgentContact> = {}): AgentContact {
  return {
    id: 'agent-1',
    name: '助手',
    role: '设计',
    ...overrides,
  };
}

/**
 * 构建测试用的 Project 对象
 */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: '测试项目',
    status: 'draft',
    phase: 'ideation',
    chatSessions: [],
    agentRoster: [],
    workflow: createEmptyWorkflowSummary(),
    assetsCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ==================== trimChatTitle ====================

describe('trimChatTitle', () => {
  it('应保留 20 字符以内的标题', () => {
    expect(trimChatTitle('短标题')).toBe('短标题');
  });

  it('应截断超过 20 字符的标题', () => {
    const longTitle = '一二三四五六七八九十一二三四五六七八九十一二三四五六';
    const result = trimChatTitle(longTitle);
    expect(result.length).toBeLessThan(longTitle.length);
    expect(result).toContain('...');
  });

  it('应将空白字符归一化', () => {
    expect(trimChatTitle('  多个   空格  ')).toBe('多个 空格');
  });

  it('应在空字符串时返回"新对话"', () => {
    expect(trimChatTitle('')).toBe('新对话');
  });

  it('应在纯空白字符时返回"新对话"', () => {
    expect(trimChatTitle('   ')).toBe('新对话');
  });
});

// ==================== createEmptyWorkflowSummary ====================

describe('createEmptyWorkflowSummary', () => {
  it('应返回默认的工作流摘要', () => {
    const summary = createEmptyWorkflowSummary();
    expect(summary.status).toBe('draft');
    expect(summary.phase).toBe('ideation');
    expect(summary.progressPercent).toBe(0);
    expect(summary.assetCount).toBe(0);
    expect(summary.scriptReady).toBe(false);
    expect(summary.storyboardReady).toBe(false);
    expect(summary.roleCounts).toEqual({
      design: 0,
      review: 0,
      editor: 0,
      manager: 0,
      custom: 0,
    });
  });
});

// ==================== getChatSession ====================

describe('getChatSession', () => {
  it('应返回匹配的聊天会话', () => {
    const chat: ChatSession = {
      id: 'chat-1',
      projectId: 'proj-1',
      title: '测试会话',
      messages: [],
      updatedAt: Date.now(),
    };
    const project = makeProject({ chatSessions: [chat] });
    const result = getChatSession([project], 'proj-1', 'chat-1');
    expect(result).toBe(chat);
  });

  it('应在项目不存在时返回 undefined', () => {
    const result = getChatSession([], 'proj-1', 'chat-1');
    expect(result).toBeUndefined();
  });

  it('应在聊天会话不存在时返回 undefined', () => {
    const project = makeProject({ chatSessions: [] });
    const result = getChatSession([project], 'proj-1', 'chat-1');
    expect(result).toBeUndefined();
  });
});

// ==================== sanitizeActiveState ====================

describe('sanitizeActiveState', () => {
  it('应在项目列表为空时返回默认状态', () => {
    const result = sanitizeActiveState([], {
      projectId: 'proj-1',
      chatSessionId: 'chat-1',
      currentTab: 'imageGeneration',
    });
    expect(result).toEqual({
      projectId: null,
      chatSessionId: null,
      currentTab: 'imageGeneration',
    });
  });

  it('应在项目 ID 无效时回退到第一个项目', () => {
    const project = makeProject({ id: 'proj-1' });
    const result = sanitizeActiveState([project], {
      projectId: 'invalid',
      chatSessionId: null,
      currentTab: 'imageGeneration',
    });
    expect(result.projectId).toBe('proj-1');
    expect(result.currentTab).toBe('imageGeneration');
  });

  it('应在聊天会话 ID 无效时回退到第一个会话', () => {
    const chat: ChatSession = {
      id: 'chat-1',
      projectId: 'proj-1',
      title: '会话1',
      messages: [],
      updatedAt: Date.now(),
    };
    const project = makeProject({ id: 'proj-1', chatSessions: [chat] });
    const result = sanitizeActiveState([project], {
      projectId: 'proj-1',
      chatSessionId: 'invalid',
      currentTab: 'chat',
    });
    expect(result.chatSessionId).toBe('chat-1');
  });

  it('应保留有效的活跃状态', () => {
    const chat: ChatSession = {
      id: 'chat-1',
      projectId: 'proj-1',
      title: '会话1',
      messages: [],
      updatedAt: Date.now(),
    };
    const project = makeProject({ id: 'proj-1', chatSessions: [chat] });
    const result = sanitizeActiveState([project], {
      projectId: 'proj-1',
      chatSessionId: 'chat-1',
      currentTab: 'assets',
    });
    expect(result.projectId).toBe('proj-1');
    expect(result.chatSessionId).toBe('chat-1');
    expect(result.currentTab).toBe('assets');
  });
});

// ==================== buildSystemPrompt ====================

describe('buildSystemPrompt', () => {
  it('应拼接基础提示和项目上下文', () => {
    const result = buildSystemPrompt('基础提示', undefined, '项目上下文');
    expect(result).toBe('基础提示\n\n项目上下文');
  });

  it('应拼接基础提示、项目上下文和智能体提示', () => {
    const agent = makeAgent({ systemPrompt: '智能体提示' });
    const result = buildSystemPrompt('基础提示', agent, '项目上下文');
    expect(result).toBe('基础提示\n\n项目上下文\n\n智能体提示');
  });

  it('应忽略空字符串的部分', () => {
    const result = buildSystemPrompt('基础提示', undefined, '');
    expect(result).toBe('基础提示');
  });

  it('应处理所有参数为空字符串', () => {
    const result = buildSystemPrompt('', undefined, '');
    expect(result).toBe('');
  });
});

// ==================== extractAgent ====================

describe('extractAgent', () => {
  it('应提取 @提及的智能体', () => {
    const agent = makeAgent({ name: '设计师' });
    const result = extractAgent('请 @设计师 帮忙', [agent]);
    expect(result.agent).toBe(agent);
    expect(result.sanitizedContent).toBe('请  帮忙');
  });

  it('应在未提及智能体时返回 undefined', () => {
    const agent = makeAgent({ name: '设计师' });
    const result = extractAgent('请帮忙', [agent]);
    expect(result.agent).toBeUndefined();
    expect(result.sanitizedContent).toBe('请帮忙');
  });

  it('应在清除后内容为空时保留原始内容', () => {
    const agent = makeAgent({ name: '设计师' });
    const result = extractAgent('@设计师', [agent]);
    expect(result.agent).toBe(agent);
    expect(result.sanitizedContent).toBe('@设计师');
  });

  it('应处理空智能体列表', () => {
    const result = extractAgent('请 @设计师 帮忙', []);
    expect(result.agent).toBeUndefined();
  });
});

// ==================== createLocalProject ====================

describe('createLocalProject', () => {
  it('应创建包含指定名称的项目', () => {
    const project = createLocalProject('我的项目');
    expect(project.name).toBe('我的项目');
    expect(project.id).toContain('proj-');
    expect(project.status).toBe('draft');
    expect(project.phase).toBe('ideation');
    expect(project.chatSessions).toEqual([]);
    expect(project.agentRoster).toEqual([]);
  });
});

// ==================== createLocalChat ====================

describe('createLocalChat', () => {
  it('应创建包含指定项目 ID 和标题的聊天', () => {
    const chat = createLocalChat('proj-1', '测试聊天');
    expect(chat.projectId).toBe('proj-1');
    expect(chat.title).toBe('测试聊天');
    expect(chat.id).toContain('chat-');
    expect(chat.messages).toEqual([]);
  });

  it('应使用默认标题"新对话"', () => {
    const chat = createLocalChat('proj-1');
    expect(chat.title).toBe('新对话');
  });
});

// ==================== createLocalAsset ====================

describe('createLocalAsset', () => {
  it('应创建包含指定属性的资产', () => {
    const asset = createLocalAsset('proj-1', '图片1', 'image', 'https://example.com/img.png');
    expect(asset.projectId).toBe('proj-1');
    expect(asset.name).toBe('图片1');
    expect(asset.type).toBe('image');
    expect(asset.url).toBe('https://example.com/img.png');
    expect(asset.id).toContain('asset-');
  });
});

// ==================== createLocalScript ====================

describe('createLocalScript', () => {
  it('应创建包含指定属性的剧本', () => {
    const script = createLocalScript('proj-1', '主剧本', '剧本内容');
    expect(script.projectId).toBe('proj-1');
    expect(script.title).toBe('主剧本');
    expect(script.content).toBe('剧本内容');
    expect(script.id).toContain('script-');
  });
});

// ==================== createLocalStoryboard ====================

describe('createLocalStoryboard', () => {
  it('应创建包含指定分镜行的分镜板', () => {
    const lines = [{ id: 'line-1', sceneNumber: 1, description: '场景1', duration: 5, assets: [] }];
    const storyboard = createLocalStoryboard('proj-1', lines);
    expect(storyboard.projectId).toBe('proj-1');
    expect(storyboard.lines).toEqual(lines);
    expect(storyboard.id).toContain('board-');
  });
});

// ==================== inferResponsibilityKind ====================

describe('inferResponsibilityKind', () => {
  it('应根据 review 关键词推断为 review', () => {
    expect(inferResponsibilityKind(makeAgent({ responsibilityKind: 'review' }))).toBe('review');
    expect(inferResponsibilityKind(makeAgent({ name: '审核员' }))).toBe('review');
    expect(inferResponsibilityKind(makeAgent({ role: '合规检查' }))).toBe('review');
  });

  it('应根据 editor 关键词推断为 editor', () => {
    expect(inferResponsibilityKind(makeAgent({ responsibilityKind: 'editor' }))).toBe('editor');
    expect(inferResponsibilityKind(makeAgent({ name: '主编' }))).toBe('editor');
    expect(inferResponsibilityKind(makeAgent({ role: '编辑' }))).toBe('editor');
  });

  it('应根据 manager 关键词推断为 manager', () => {
    expect(inferResponsibilityKind(makeAgent({ responsibilityKind: 'manager' }))).toBe('manager');
    expect(inferResponsibilityKind(makeAgent({ name: '管理者' }))).toBe('manager');
    expect(inferResponsibilityKind(makeAgent({ role: '统筹' }))).toBe('manager');
  });

  it('应根据 design 关键词推断为 design', () => {
    expect(inferResponsibilityKind(makeAgent({ responsibilityKind: 'design' }))).toBe('design');
    expect(inferResponsibilityKind(makeAgent({ name: '设计师' }))).toBe('design');
    expect(inferResponsibilityKind(makeAgent({ role: '视觉' }))).toBe('design');
  });

  it('应在无匹配关键词时推断为 custom', () => {
    expect(inferResponsibilityKind(makeAgent({ name: '助手', role: '通用' }))).toBe('custom');
  });
});

// ==================== formatAssetTypeLabel ====================

describe('formatAssetTypeLabel', () => {
  it('应将 image 格式化为"图片"', () => {
    expect(formatAssetTypeLabel('image')).toBe('图片');
  });

  it('应将 video 格式化为"视频"', () => {
    expect(formatAssetTypeLabel('video')).toBe('视频');
  });

  it('应将 audio 格式化为"音频"', () => {
    expect(formatAssetTypeLabel('audio')).toBe('音频');
  });

  it('应将 document 格式化为"文档"', () => {
    expect(formatAssetTypeLabel('document')).toBe('文档');
  });
});

// ==================== normalizeResourceMentions ====================

describe('normalizeResourceMentions', () => {
  it('应解析资产提及标记并返回清理后的内容和资源引用', () => {
    const assets: Asset[] = [
      {
        id: 'a1',
        projectId: 'proj-1',
        name: '角色设计',
        type: 'image',
        url: 'https://example.com/img.png',
        createdAt: Date.now(),
      },
    ];
    const result = normalizeResourceMentions('请参考 #角色设计<asset:a1>', assets);
    expect(result.sanitizedContent).toBe('请参考 #角色设计');
    expect(result.resourceRefs).toHaveLength(1);
    expect(result.resourceRefs[0].id).toBe('a1');
  });

  it('应在资产列表为空时返回原始内容', () => {
    const result = normalizeResourceMentions('请参考 #角色设计<asset:a1>', []);
    expect(result.sanitizedContent).toBe('请参考 #角色设计<asset:a1>');
    expect(result.resourceRefs).toHaveLength(0);
  });

  it('应处理无资产提及的内容', () => {
    const result = normalizeResourceMentions('普通消息', []);
    expect(result.sanitizedContent).toBe('普通消息');
  });
});

// ==================== detectAssetType ====================

describe('detectAssetType', () => {
  it('应检测图片类型', () => {
    const file = new File([''], 'test.png', { type: 'image/png' });
    expect(detectAssetType(file)).toBe('image');
  });

  it('应检测视频类型', () => {
    const file = new File([''], 'test.mp4', { type: 'video/mp4' });
    expect(detectAssetType(file)).toBe('video');
  });

  it('应检测音频类型', () => {
    const file = new File([''], 'test.mp3', { type: 'audio/mpeg' });
    expect(detectAssetType(file)).toBe('audio');
  });

  it('应将其他类型归为 document', () => {
    const file = new File([''], 'test.pdf', { type: 'application/pdf' });
    expect(detectAssetType(file)).toBe('document');
  });

  it('应将空 MIME 类型归为 document', () => {
    const file = new File([''], 'test.bin', { type: '' });
    expect(detectAssetType(file)).toBe('document');
  });
});

// ==================== deriveScriptTitle ====================

describe('deriveScriptTitle', () => {
  it('应从 Markdown 标题行提取标题', () => {
    expect(deriveScriptTitle('# 我的剧本\n内容')).toBe('我的剧本');
  });

  it('应从非标题行提取第一个非空行', () => {
    expect(deriveScriptTitle('第一行\n第二行')).toBe('第一行');
  });

  it('应在内容为空时使用 currentTitle', () => {
    expect(deriveScriptTitle('', '备用标题')).toBe('备用标题');
  });

  it('应在内容和 currentTitle 都为空时返回"主剧本"', () => {
    expect(deriveScriptTitle('')).toBe('主剧本');
  });

  it('应截断超过 40 字符的标题', () => {
    const longTitle = '一'.repeat(50);
    const result = deriveScriptTitle(`# ${longTitle}`);
    expect(result.length).toBeLessThanOrEqual(43);
    expect(result.endsWith('...')).toBe(true);
  });
});

// ==================== buildHistoryMessagesFromList ====================

describe('buildHistoryMessagesFromList', () => {
  it('应将 ai 角色转换为 assistant', () => {
    const messages = [makeMessage({ role: 'ai', content: '你好' })];
    const result = buildHistoryMessagesFromList(messages);
    expect(result[0].role).toBe('assistant');
  });

  it('应将 user 角色保持不变', () => {
    const messages = [makeMessage({ role: 'user', content: '你好' })];
    const result = buildHistoryMessagesFromList(messages);
    expect(result[0].role).toBe('user');
  });

  it('应过滤掉 system 消息', () => {
    const messages = [
      makeMessage({ role: 'system', content: '系统消息' }),
      makeMessage({ role: 'user', content: '用户消息' }),
    ];
    const result = buildHistoryMessagesFromList(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('应处理空消息列表', () => {
    const result = buildHistoryMessagesFromList([]);
    expect(result).toEqual([]);
  });
});

// ==================== buildHistoryMessages ====================

describe('buildHistoryMessages', () => {
  it('应从聊天快照构建历史消息', () => {
    const chat: ChatSession = {
      id: 'chat-1',
      projectId: 'proj-1',
      title: '测试',
      messages: [
        makeMessage({ role: 'user', content: '你好' }),
        makeMessage({ role: 'ai', content: '你好啊' }),
      ],
      updatedAt: Date.now(),
    };
    const result = buildHistoryMessages(chat);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('应在聊天快照为 undefined 时返回空数组', () => {
    const result = buildHistoryMessages(undefined);
    expect(result).toEqual([]);
  });
});

// ==================== shouldFallbackToDirectAi ====================

describe('shouldFallbackToDirectAi', () => {
  it('应在 requireServerTask 为 true 时始终返回 false', () => {
    expect(shouldFallbackToDirectAi(new Error('failed to fetch'), true)).toBe(false);
  });

  it('应在网络错误时返回 true', () => {
    expect(shouldFallbackToDirectAi(new Error('failed to fetch'))).toBe(true);
    expect(shouldFallbackToDirectAi(new Error('network error'))).toBe(true);
    expect(shouldFallbackToDirectAi(new Error('load failed'))).toBe(true);
  });

  it('应在非 Error 对象时返回 true', () => {
    expect(shouldFallbackToDirectAi('string error')).toBe(true);
    expect(shouldFallbackToDirectAi(null)).toBe(true);
    expect(shouldFallbackToDirectAi(undefined)).toBe(true);
  });

  it('应在非网络错误时返回 false', () => {
    expect(shouldFallbackToDirectAi(new Error('内部错误'))).toBe(false);
  });

  it('应在"对话不存在"错误时返回 true', () => {
    expect(shouldFallbackToDirectAi(new Error('对话不存在'))).toBe(true);
  });
});

// ==================== isUnauthorizedError ====================

describe('isUnauthorizedError', () => {
  it('应识别 UNAUTHORIZED 错误', () => {
    expect(isUnauthorizedError(new Error('UNAUTHORIZED'))).toBe(true);
  });

  it('应拒绝非 UNAUTHORIZED 错误', () => {
    expect(isUnauthorizedError(new Error('FORBIDDEN'))).toBe(false);
  });

  it('应拒绝非 Error 对象', () => {
    expect(isUnauthorizedError('UNAUTHORIZED')).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });
});

// ==================== endpointMatchesAiSettings ====================

describe('endpointMatchesAiSettings', () => {
  const settings: AiSettings = {
    ...createAiSettings('openai'),
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4',
  };

  it('应在所有字段匹配时返回 true', () => {
    const endpoint = {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4',
    };
    expect(endpointMatchesAiSettings(endpoint, settings)).toBe(true);
  });

  it('应忽略大小写差异', () => {
    const endpoint = {
      provider: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1/',
      defaultModel: 'gpt-4',
    };
    expect(endpointMatchesAiSettings(endpoint, settings)).toBe(true);
  });

  it('应在 provider 不匹配时返回 false', () => {
    const endpoint = {
      provider: 'deepseek',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4',
    };
    expect(endpointMatchesAiSettings(endpoint, settings)).toBe(false);
  });

  it('应在 baseUrl 不匹配时返回 false', () => {
    const endpoint = {
      provider: 'openai',
      baseUrl: 'https://other.api.com/v1',
      defaultModel: 'gpt-4',
    };
    expect(endpointMatchesAiSettings(endpoint, settings)).toBe(false);
  });

  it('应在 model 不匹配时返回 false', () => {
    const endpoint = {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-3.5',
    };
    expect(endpointMatchesAiSettings(endpoint, settings)).toBe(false);
  });

  it('应在 defaultModel 为 null 且 settings.model 为空时匹配', () => {
    const endpoint = {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: null,
    };
    const emptyModelSettings = { ...settings, model: '' };
    expect(endpointMatchesAiSettings(endpoint, emptyModelSettings)).toBe(true);
  });
});

// ==================== inferProjectNameFromConversation ====================

describe('inferProjectNameFromConversation', () => {
  it('应从用户消息中推断项目名称', () => {
    const messages = [
      makeMessage({ role: 'user', content: '帮我做一个科幻短片' }),
    ];
    const result = inferProjectNameFromConversation(messages);
    expect(result).toBeTruthy();
    expect(result).not.toBe('新项目');
  });

  it('应在消息为空时返回"新项目"', () => {
    const result = inferProjectNameFromConversation([]);
    expect(result).toBe('新项目');
  });

  it('应使用 seedContent 作为优先候选', () => {
    const messages = [makeMessage({ role: 'user', content: '好的' })];
    const result = inferProjectNameFromConversation(messages, '帮我做一个科幻短片');
    expect(result).not.toBe('新项目');
  });

  it('应过滤噪声消息', () => {
    const messages = [
      makeMessage({ role: 'user', content: '好的' }),
      makeMessage({ role: 'user', content: '嗯嗯' }),
    ];
    const result = inferProjectNameFromConversation(messages);
    expect(result).toBe('新项目');
  });
});
