import { describe, it, expect } from 'vitest';
import type { Asset, Message, MessageAttachment, ResourceRef } from '../../../../types';
import {
  buildAssetMentionValue,
  detectCollaborationReadiness,
  extractMessageResourceRefs,
  extractMessageAttachments,
  scoreAssetSearch,
  formatAssetTypeLabel,
  mergeResourceRefs,
  parseInputResourceSelections,
  reconcileDraftResourceRefs,
} from './chatAreaUtils';

/**
 * 构建测试用的 Asset 对象
 */
function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    projectId: 'proj-1',
    name: '测试资产',
    type: 'image',
    url: 'https://example.com/asset.png',
    createdAt: 1700000000000,
    ...overrides,
  };
}

/**
 * 构建测试用的 ResourceRef 对象
 */
function makeResourceRef(overrides: Partial<ResourceRef> = {}): ResourceRef {
  return {
    id: 'res-1',
    name: '测试资源',
    type: 'image',
    ...overrides,
  };
}

/**
 * 构建测试用的 MessageAttachment 对象
 */
function makeAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    url: 'https://example.com/file.png',
    name: 'file.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    source: 'user_upload',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'user',
    content: '测试消息',
    timestamp: 1700000000000,
    status: 'done',
    type: 'text',
    ...overrides,
  };
}

// ==================== detectCollaborationReadiness ====================

describe('detectCollaborationReadiness', () => {
  it('应在非项目对话中拒绝启动协同', () => {
    const result = detectCollaborationReadiness(
      [
        makeMessage({ role: 'user', content: '做一个悬疑短剧' }),
        makeMessage({ id: 'msg-ai', role: 'ai', content: '可以，我先给你方案。' }),
      ],
      false,
    );

    expect(result.ready).toBe(false);
  });

  it('应在基础创意信息收敛后标记为可启动协同', () => {
    const result = detectCollaborationReadiness(
      [
        makeMessage({
          role: 'user',
          content: '做一个面向年轻女性的三集悬疑短剧，节奏快，主题是职场反转。',
        }),
        makeMessage({
          id: 'msg-ai',
          role: 'ai',
          content: '已确认目标受众、主题、节奏和集数，可以开始制作大纲。',
        }),
      ],
      true,
    );

    expect(result.ready).toBe(true);
    expect(result.entryMessageId).toBe('msg-ai');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('应在信息不足时继续等待补充', () => {
    const result = detectCollaborationReadiness(
      [
        makeMessage({ role: 'user', content: '帮我想个点子' }),
        makeMessage({ id: 'msg-ai', role: 'ai', content: '可以，想做什么方向？' }),
      ],
      true,
    );

    expect(result.ready).toBe(false);
  });
});

// ==================== buildAssetMentionValue ====================

describe('buildAssetMentionValue', () => {
  it('应正确拼接资产名称和ID', () => {
    const asset = makeAsset({ name: '角色设计', id: 'abc123' });
    expect(buildAssetMentionValue(asset)).toBe('角色设计<asset:abc123>');
  });

  it('应处理空名称', () => {
    const asset = makeAsset({ name: '', id: 'xyz' });
    expect(buildAssetMentionValue(asset)).toBe('<asset:xyz>');
  });

  it('应处理包含特殊字符的名称', () => {
    const asset = makeAsset({ name: '图片<1>', id: 'id1' });
    expect(buildAssetMentionValue(asset)).toBe('图片<1><asset:id1>');
  });
});

// ==================== extractMessageResourceRefs ====================

describe('extractMessageResourceRefs', () => {
  it('应从消息中提取有效的 resourceRefs', () => {
    const refs = [
      makeResourceRef({ id: 'r1', name: '资源1', type: 'image' }),
      makeResourceRef({ id: 'r2', name: '资源2', type: 'video' }),
    ];
    const message = { meta: { resourceRefs: refs } };
    expect(extractMessageResourceRefs(message)).toEqual(refs);
  });

  it('应过滤掉无效的 resourceRef 项', () => {
    const refs = [
      makeResourceRef({ id: 'r1', name: '资源1', type: 'image' }),
      { id: 123, name: '无效', type: 'image' } as unknown as ResourceRef,
      { id: 'r3', name: 456, type: 'video' } as unknown as ResourceRef,
      null as unknown as ResourceRef,
    ];
    const message = { meta: { resourceRefs: refs } };
    const result = extractMessageResourceRefs(message);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r1');
  });

  it('应在 message 为 null 时返回空数组', () => {
    expect(extractMessageResourceRefs(null)).toEqual([]);
  });

  it('应在 message 为 undefined 时返回空数组', () => {
    expect(extractMessageResourceRefs(undefined)).toEqual([]);
  });

  it('应在 meta 不存在时返回空数组', () => {
    expect(extractMessageResourceRefs({})).toEqual([]);
  });

  it('应在 resourceRefs 不是数组时返回空数组', () => {
    expect(extractMessageResourceRefs({ meta: { resourceRefs: 'invalid' as unknown as ResourceRef[] } })).toEqual([]);
  });

  it('应在 resourceRefs 为空数组时返回空数组', () => {
    expect(extractMessageResourceRefs({ meta: { resourceRefs: [] } })).toEqual([]);
  });
});

// ==================== extractMessageAttachments ====================

describe('extractMessageAttachments', () => {
  it('应优先返回 message.attachments', () => {
    const attachments = [makeAttachment({ name: 'top.png' })];
    const metaAttachments = [makeAttachment({ name: 'meta.png' })];
    const message = {
      attachments,
      meta: { attachments: metaAttachments },
    };
    const result = extractMessageAttachments(message);
    expect(result).toEqual(attachments);
  });

  it('应在 message.attachments 为空数组时回退到 meta.attachments', () => {
    const metaAttachments = [
      makeAttachment({ name: 'meta.png', url: 'https://example.com/meta.png', mimeType: 'image/png', sizeBytes: 2048 }),
    ];
    const message = {
      attachments: [],
      meta: { attachments: metaAttachments },
    };
    const result = extractMessageAttachments(message);
    expect(result).toEqual(metaAttachments);
  });

  it('应过滤 meta.attachments 中的无效项', () => {
    const metaAttachments = [
      makeAttachment({ name: 'valid.png' }),
      { url: 123, name: 'invalid', mimeType: 'image/png', sizeBytes: 100 } as unknown as MessageAttachment,
      { url: 'https://example.com/a.png', name: 'invalid2', mimeType: 456, sizeBytes: 100 } as unknown as MessageAttachment,
    ];
    const message = { meta: { attachments: metaAttachments } };
    const result = extractMessageAttachments(message);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid.png');
  });

  it('应在 message 为 null 时返回空数组', () => {
    expect(extractMessageAttachments(null)).toEqual([]);
  });

  it('应在 message 为 undefined 时返回空数组', () => {
    expect(extractMessageAttachments(undefined)).toEqual([]);
  });

  it('应在没有任何附件时返回空数组', () => {
    expect(extractMessageAttachments({})).toEqual([]);
  });

  it('应在 meta.attachments 不是数组时返回空数组', () => {
    expect(extractMessageAttachments({ meta: { attachments: 'invalid' as unknown as MessageAttachment[] } })).toEqual([]);
  });
});

// ==================== scoreAssetSearch ====================

describe('scoreAssetSearch', () => {
  const baseAsset = makeAsset({
    name: '角色设计',
    projectId: 'proj-1',
    createdAt: 1700000000000,
  });

  it('应在查询为空时返回 currentProjectBonus + 时间权重', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '', 'proj-1');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeGreaterThanOrEqual(30);
  });

  it('应在查询为空且不在当前项目时仅返回时间权重', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '', 'other-proj');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(30);
  });

  it('应在名称完全匹配时给予最高分', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '角色设计', 'proj-1');
    expect(score).toBeGreaterThanOrEqual(180);
  });

  it('应在名称前缀匹配时给予较高分', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '角色', 'proj-1');
    expect(score).toBeGreaterThanOrEqual(120);
  });

  it('应在名称包含匹配时给予中等分', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '设计', 'proj-1');
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it('应在项目名称匹配时给予额外分', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '项目', null);
    expect(score).toBeGreaterThanOrEqual(36);
  });

  it('应在类型标签匹配时给予额外分', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '图片', null);
    expect(score).toBeGreaterThanOrEqual(32);
  });

  it('应在无任何匹配时返回 0', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '完全不相关xyz', null);
    expect(score).toBe(0);
  });

  it('应在当前项目匹配时加 30 分', () => {
    const scoreInProject = scoreAssetSearch(baseAsset, '我的项目', '角色', 'proj-1');
    const scoreNotInProject = scoreAssetSearch(baseAsset, '我的项目', '角色', 'other-proj');
    expect(scoreInProject - scoreNotInProject).toBe(30);
  });

  it('应支持多 token 查询', () => {
    const score = scoreAssetSearch(baseAsset, '我的项目', '角色 设计', 'proj-1');
    expect(score).toBeGreaterThanOrEqual(200);
  });

  it('应在 ID 包含查询 token 时给予额外分', () => {
    const asset = makeAsset({ id: 'asset-1' });
    const score = scoreAssetSearch(asset, '项目', 'asset', null);
    expect(score).toBeGreaterThanOrEqual(18);
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

  it('应将 undefined 格式化为"文档"', () => {
    expect(formatAssetTypeLabel(undefined)).toBe('文档');
  });

  it('应将未知类型格式化为"文档"', () => {
    expect(formatAssetTypeLabel('other' as Asset['type'])).toBe('文档');
  });
});

// ==================== mergeResourceRefs ====================

describe('mergeResourceRefs', () => {
  it('应合并多组资源引用', () => {
    const group1 = [makeResourceRef({ id: 'r1' }), makeResourceRef({ id: 'r2' })];
    const group2 = [makeResourceRef({ id: 'r3' })];
    const result = mergeResourceRefs(group1, group2);
    expect(result).toHaveLength(3);
  });

  it('应去重相同 id 的资源引用', () => {
    const group1 = [makeResourceRef({ id: 'r1', name: '资源A' })];
    const group2 = [makeResourceRef({ id: 'r1', name: '资源A副本' })];
    const result = mergeResourceRefs(group1, group2);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('资源A');
  });

  it('应跳过 id 为空字符串的资源引用', () => {
    const group = [makeResourceRef({ id: '' }), makeResourceRef({ id: 'r1' })];
    const result = mergeResourceRefs(group);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r1');
  });

  it('应处理 undefined 组', () => {
    const group = [makeResourceRef({ id: 'r1' })];
    const result = mergeResourceRefs(group, undefined, undefined);
    expect(result).toHaveLength(1);
  });

  it('应处理所有组均为 undefined', () => {
    const result = mergeResourceRefs(undefined, undefined);
    expect(result).toEqual([]);
  });

  it('应处理空数组组', () => {
    const result = mergeResourceRefs([], []);
    expect(result).toEqual([]);
  });
});

// ==================== parseInputResourceSelections ====================

describe('parseInputResourceSelections', () => {
  it('应解析输入中的资产提及并返回选中的资源引用', () => {
    const assets = [
      makeAsset({ id: 'a1', name: '角色设计', type: 'image' }),
      makeAsset({ id: 'a2', name: '背景音乐', type: 'audio' }),
    ];
    const content = '请参考 #角色设计<asset:a1> 和 #背景音乐<asset:a2>';
    const result = parseInputResourceSelections(content, assets);
    expect(result.nextValue).toBe('请参考 #角色设计 和 #背景音乐');
    expect(result.selectedRefs).toHaveLength(2);
    expect(result.selectedRefs[0].id).toBe('a1');
    expect(result.selectedRefs[1].id).toBe('a2');
  });

  it('应在资产 ID 不存在时保留原始文本', () => {
    const assets = [makeAsset({ id: 'a1', name: '角色设计' })];
    const content = '请参考 #不存在<asset:unknown>';
    const result = parseInputResourceSelections(content, assets);
    expect(result.nextValue).toBe('请参考 #不存在');
    expect(result.selectedRefs).toHaveLength(0);
  });

  it('应去重选中的资源引用', () => {
    const assets = [makeAsset({ id: 'a1', name: '角色设计' })];
    const content = '#角色设计<asset:a1> 和 #角色设计<asset:a1>';
    const result = parseInputResourceSelections(content, assets);
    expect(result.selectedRefs).toHaveLength(1);
  });

  it('应处理无资产提及的输入', () => {
    const assets = [makeAsset({ id: 'a1', name: '角色设计' })];
    const content = '这是一条普通消息';
    const result = parseInputResourceSelections(content, assets);
    expect(result.nextValue).toBe('这是一条普通消息');
    expect(result.selectedRefs).toHaveLength(0);
  });

  it('应处理空资产列表', () => {
    const content = '#角色设计<asset:a1>';
    const result = parseInputResourceSelections(content, []);
    expect(result.nextValue).toBe('#角色设计');
    expect(result.selectedRefs).toHaveLength(0);
  });

  it('应处理空字符串输入', () => {
    const result = parseInputResourceSelections('', []);
    expect(result.nextValue).toBe('');
    expect(result.selectedRefs).toHaveLength(0);
  });
});

// ==================== reconcileDraftResourceRefs ====================

describe('reconcileDraftResourceRefs', () => {
  it('应保留内容中提及的资源引用', () => {
    const assets = [makeAsset({ id: 'a1', name: '角色设计' })];
    const refs = [makeResourceRef({ id: 'a1', name: '角色设计', type: 'image' })];
    const content = '请参考 #角色设计 来修改';
    const result = reconcileDraftResourceRefs(content, refs, assets);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('应移除内容中未提及的资源引用', () => {
    const assets = [makeAsset({ id: 'a1', name: '角色设计' })];
    const refs = [makeResourceRef({ id: 'a1', name: '角色设计', type: 'image' })];
    const content = '这条消息没有提及任何资产';
    const result = reconcileDraftResourceRefs(content, refs, assets);
    expect(result).toHaveLength(0);
  });

  it('应在 refs 为空时返回空数组', () => {
    const assets = [makeAsset({ id: 'a1', name: '角色设计' })];
    const result = reconcileDraftResourceRefs('内容', [], assets);
    expect(result).toEqual([]);
  });

  it('应在 assets 为空时返回空数组', () => {
    const refs = [makeResourceRef({ id: 'a1', name: '角色设计', type: 'image' })];
    const result = reconcileDraftResourceRefs('内容', refs, []);
    expect(result).toEqual([]);
  });

  it('应处理资产 ID 不存在的情况', () => {
    const assets = [makeAsset({ id: 'a2', name: '其他资产' })];
    const refs = [makeResourceRef({ id: 'a1', name: '角色设计', type: 'image' })];
    const content = '请参考 #角色设计';
    const result = reconcileDraftResourceRefs(content, refs, assets);
    expect(result).toHaveLength(0);
  });

  it('应去重相同 id 的资源引用', () => {
    const assets = [makeAsset({ id: 'a1', name: '角色设计' })];
    const refs = [
      makeResourceRef({ id: 'a1', name: '角色设计', type: 'image' }),
      makeResourceRef({ id: 'a1', name: '角色设计', type: 'image' }),
    ];
    const content = '请参考 #角色设计';
    const result = reconcileDraftResourceRefs(content, refs, assets);
    expect(result).toHaveLength(1);
  });

  it('应正确处理同一名称多次提及的情况', () => {
    const assets = [makeAsset({ id: 'a1', name: '角色设计' })];
    const refs = [makeResourceRef({ id: 'a1', name: '角色设计', type: 'image' })];
    const content = '#角色设计 和 #角色设计 两次提及';
    const result = reconcileDraftResourceRefs(content, refs, assets);
    expect(result).toHaveLength(1);
  });
});
