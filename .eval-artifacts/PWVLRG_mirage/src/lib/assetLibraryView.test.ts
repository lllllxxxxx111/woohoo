import { describe, it, expect } from 'vitest';
import type { Asset } from '../types';
import {
  getAssetTags,
  collectAllTags,
  filterAssetsLocally,
  normalizeAssetLibraryViewRequest,
  DEFAULT_ASSET_LIBRARY_VIEW_STATE,
} from './assetLibraryView';

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    projectId: 'proj-1',
    name: '测试素材',
    type: 'image',
    url: 'https://example.com/img.png',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ==================== getAssetTags ====================

describe('getAssetTags', () => {
  it('应从 metadata.tags 中提取字符串数组', () => {
    const asset = makeAsset({ metadata: { tags: ['角色', '场景', '设计'] } });
    expect(getAssetTags(asset)).toEqual(['角色', '场景', '设计']);
  });

  it('应在 metadata 为 null 时返回空数组', () => {
    const asset = makeAsset({ metadata: null });
    expect(getAssetTags(asset)).toEqual([]);
  });

  it('应在 tags 不是数组时返回空数组', () => {
    const asset = makeAsset({ metadata: { tags: 'not-an-array' } as Record<string, unknown> });
    expect(getAssetTags(asset)).toEqual([]);
  });

  it('应过滤掉非字符串和空白标签', () => {
    const asset = makeAsset({
      metadata: { tags: ['角色', '', '  ', '场景', 123 as unknown as string] },
    });
    expect(getAssetTags(asset)).toEqual(['角色', '场景']);
  });

  it('应在 metadata 中没有 tags 字段时返回空数组', () => {
    const asset = makeAsset({ metadata: { favorite: true } });
    expect(getAssetTags(asset)).toEqual([]);
  });
});

// ==================== collectAllTags ====================

describe('collectAllTags', () => {
  it('应收集多个素材中所有出现过的标签并去重排序', () => {
    const assets: Asset[] = [
      makeAsset({ id: 'a1', metadata: { tags: ['角色', '场景'] } }),
      makeAsset({ id: 'a2', metadata: { tags: ['角色', '道具', '场景'] } }),
      makeAsset({ id: 'a3', metadata: { tags: ['背景'] } }),
    ];
    const tags = collectAllTags(assets);
    expect(tags).toContain('角色');
    expect(tags).toContain('场景');
    expect(tags).toContain('道具');
    expect(tags).toContain('背景');
    expect(new Set(tags).size).toBe(tags.length); // 去重
  });

  it('应在空数组输入时返回空数组', () => {
    expect(collectAllTags([])).toEqual([]);
  });

  it('应忽略没有标签的素材', () => {
    const assets: Asset[] = [
      makeAsset({ id: 'a1', metadata: null }),
      makeAsset({ id: 'a2', metadata: { favorite: true } }),
    ];
    expect(collectAllTags(assets)).toEqual([]);
  });
});

// ==================== filterAssetsLocally ====================

describe('filterAssetsLocally', () => {
  const assets: Asset[] = [
    makeAsset({
      id: 'a1',
      name: '角色设定图',
      type: 'image',
      metadata: { tags: ['角色'], favorite: true, rating: 5, prompt: 'anime character design' },
    }),
    makeAsset({
      id: 'a2',
      name: '场景背景图',
      type: 'image',
      metadata: { tags: ['场景'], rating: 3, prompt: 'landscape background' },
    }),
    makeAsset({
      id: 'a3',
      name: '背景音乐',
      type: 'audio',
      metadata: { tags: ['音乐'], rating: 4 },
    }),
    makeAsset({
      id: 'a4',
      name: '剧本草稿',
      type: 'document',
      metadata: { tags: ['文档', '剧本'] },
    }),
  ];

  it('无过滤条件时返回全部素材', () => {
    const result = filterAssetsLocally(assets, {});
    expect(result).toHaveLength(4);
  });

  it('按素材类型过滤', () => {
    const result = filterAssetsLocally(assets, { filterType: 'image' });
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.type === 'image')).toBe(true);
  });

  it('按收藏状态过滤', () => {
    const result = filterAssetsLocally(assets, { favoriteOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('按最低评分过滤', () => {
    const result = filterAssetsLocally(assets, { ratingMin: 4 });
    expect(result).toHaveLength(2); // a1 (5) and a3 (4)
    expect(result.map((a) => a.id).sort()).toEqual(['a1', 'a3']);
  });

  it('按标签过滤', () => {
    const result = filterAssetsLocally(assets, { tag: '场景' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('按搜索关键字过滤（匹配素材名）', () => {
    const result = filterAssetsLocally(assets, { searchQuery: '角色' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('按搜索关键字过滤（匹配 metadata.prompt）', () => {
    const result = filterAssetsLocally(assets, { searchQuery: 'landscape' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('组合多个过滤条件', () => {
    const result = filterAssetsLocally(assets, {
      filterType: 'image',
      ratingMin: 4,
      tag: '角色',
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('搜索不区分大小写', () => {
    const result = filterAssetsLocally(assets, { searchQuery: 'CHARACTER' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('空搜索字符串应匹配全部', () => {
    const result = filterAssetsLocally(assets, { searchQuery: '   ' });
    expect(result).toHaveLength(4);
  });
});

// ==================== normalizeAssetLibraryViewRequest ====================

describe('normalizeAssetLibraryViewRequest', () => {
  it('应使用默认值填充缺失字段', () => {
    const result = normalizeAssetLibraryViewRequest({});
    expect(result.filterType).toBe('all');
    expect(result.groupMode).toBe('none');
    expect(result.projectId).toBeNull();
    expect(result.scope).toBe('current');
    expect(result.searchQuery).toBe('');
    expect(result.tag).toBeNull();
    expect(result.favoriteOnly).toBe(false);
    expect(result.ratingMin).toBe(0);
    expect(result.sort).toBe('created_at');
    expect(result.order).toBe('desc');
  });

  it('应合并请求字段与 fallback 值', () => {
    const result = normalizeAssetLibraryViewRequest(
      { filterType: 'image', scope: 'all', tag: '角色' },
      { ...DEFAULT_ASSET_LIBRARY_VIEW_STATE, groupMode: 'project' },
    );
    expect(result.filterType).toBe('image');
    expect(result.scope).toBe('all');
    expect(result.tag).toBe('角色');
    expect(result.groupMode).toBe('project'); // from fallback
  });
});
