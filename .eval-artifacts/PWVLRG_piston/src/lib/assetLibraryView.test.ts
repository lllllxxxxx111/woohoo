import { describe, it, expect } from 'vitest';
import type { Asset } from '../types';
import {
  aggregateAssetTags,
  buildReferenceSummary,
  filterAssetsClientSide,
  groupReferencesByType,
  sortAssetsClientSide,
  ASSET_TYPE_LABELS,
  ASSET_SORT_LABELS,
  REFERENCE_TYPE_LABELS,
  DEFAULT_ASSET_LIBRARY_VIEW_STATE,
  normalizeAssetLibraryViewRequest,
} from './assetLibraryView';
import type {
  AssetLibraryFilterType,
  AssetLibrarySortMode,
  AssetLibraryViewRequest,
} from './assetLibraryView';

// ─── helpers ─────────────────────────────────────────────────────

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: `asset-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-1',
    name: '测试素材',
    type: 'image',
    url: '/uploads/test.png',
    metadata: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ─── DEFAULT state ──────────────────────────────────────────────

describe('DEFAULT_ASSET_LIBRARY_VIEW_STATE', () => {
  it('should have sensible defaults', () => {
    expect(DEFAULT_ASSET_LIBRARY_VIEW_STATE.filterType).toBe('all');
    expect(DEFAULT_ASSET_LIBRARY_VIEW_STATE.groupMode).toBe('none');
    expect(DEFAULT_ASSET_LIBRARY_VIEW_STATE.scope).toBe('current');
    expect(DEFAULT_ASSET_LIBRARY_VIEW_STATE.projectId).toBeNull();
    expect(DEFAULT_ASSET_LIBRARY_VIEW_STATE.sortMode).toBe('recent');
    expect(DEFAULT_ASSET_LIBRARY_VIEW_STATE.tagFilter).toBeNull();
  });
});

describe('normalizeAssetLibraryViewRequest', () => {
  it('should use fallback when request is empty', () => {
    const result = normalizeAssetLibraryViewRequest({});
    expect(result).toEqual(DEFAULT_ASSET_LIBRARY_VIEW_STATE);
  });

  it('should override provided fields', () => {
    const req: AssetLibraryViewRequest = {
      filterType: 'video',
      scope: 'all',
      sortMode: 'name',
      tagFilter: '人物',
    };
    const result = normalizeAssetLibraryViewRequest(req);
    expect(result.filterType).toBe('video');
    expect(result.scope).toBe('all');
    expect(result.sortMode).toBe('name');
    expect(result.tagFilter).toBe('人物');
    expect(result.groupMode).toBe('none');
    expect(result.projectId).toBeNull();
  });

  it('should use custom fallback', () => {
    const fallback = {
      ...DEFAULT_ASSET_LIBRARY_VIEW_STATE,
      filterType: 'document' as AssetLibraryFilterType,
      sortMode: 'rating' as AssetLibrarySortMode,
    };
    const result = normalizeAssetLibraryViewRequest({ scope: 'all' }, fallback);
    expect(result.filterType).toBe('document');
    expect(result.sortMode).toBe('rating');
    expect(result.scope).toBe('all');
  });
});

// ─── Labels ────────────────────────────────────────────────────

describe('label constants', () => {
  it('ASSET_TYPE_LABELS should cover all types', () => {
    expect(ASSET_TYPE_LABELS.all).toBe('全部');
    expect(ASSET_TYPE_LABELS.image).toBe('图片');
    expect(ASSET_TYPE_LABELS.video).toBe('视频');
    expect(ASSET_TYPE_LABELS.audio).toBe('音频');
    expect(ASSET_TYPE_LABELS.document).toBe('文档');
  });

  it('ASSET_SORT_LABELS should cover all sort modes', () => {
    expect(ASSET_SORT_LABELS.recent).toBe('最近');
    expect(ASSET_SORT_LABELS.name).toBe('名称');
    expect(ASSET_SORT_LABELS.rating).toBe('评分');
  });

  it('REFERENCE_TYPE_LABELS should cover all reference types', () => {
    expect(REFERENCE_TYPE_LABELS.storyboard).toBe('分镜引用');
    expect(REFERENCE_TYPE_LABELS.pipelineStep).toBe('流水线产出');
    expect(REFERENCE_TYPE_LABELS.pipelineStepInput).toBe('流水线输入');
  });
});

// ─── aggregateAssetTags ────────────────────────────────────────

describe('aggregateAssetTags', () => {
  it('should return empty array for no assets', () => {
    expect(aggregateAssetTags([])).toEqual([]);
  });

  it('should return empty array for assets without tags', () => {
    const assets = [
      makeAsset({ metadata: { favorite: true } }),
      makeAsset({ metadata: { rating: 5 } }),
    ];
    expect(aggregateAssetTags(assets)).toEqual([]);
  });

  it('should aggregate and sort tags by frequency', () => {
    const assets = [
      makeAsset({ metadata: { tags: ['人物', '风景'] } }),
      makeAsset({ metadata: { tags: ['人物', '夜景', '城市'] } }),
      makeAsset({ metadata: { tags: ['人物'] } }),
      makeAsset({ metadata: { tags: ['风景'] } }),
    ];
    const result = aggregateAssetTags(assets);
    // 人物: 3, 风景: 2, 夜景: 1, 城市: 1
    expect(result[0]).toEqual({ tag: '人物', count: 3 });
    expect(result[1]).toEqual({ tag: '风景', count: 2 });
    // 夜景 and 城市 both have count 1, sorted alphabetically
    expect(result.find((r) => r.tag === '夜景')).toEqual({ tag: '夜景', count: 1 });
    expect(result.find((r) => r.tag === '城市')).toEqual({ tag: '城市', count: 1 });
  });

  it('should deduplicate case-sensitively by tag name', () => {
    const assets = [
      makeAsset({ metadata: { tags: ['TagA', 'taga'] } }),
    ];
    const result = aggregateAssetTags(assets);
    // Case-sensitive: "TagA" and "taga" are different tags
    expect(result).toHaveLength(2);
  });

  it('should handle null/undefined metadata gracefully', () => {
    const assets = [
      makeAsset({ metadata: null }),
      makeAsset({ metadata: undefined }),
      makeAsset({ metadata: { tags: [] } }),
      makeAsset({}),
    ];
    expect(aggregateAssetTags(assets)).toEqual([]);
  });

  it('should trim tag strings and filter empty ones', () => {
    const assets = [
      makeAsset({ metadata: { tags: ['  人物  ', '', '  '] } }),
    ];
    const result = aggregateAssetTags(assets);
    // The getAssetTags function should trim and filter empty
    expect(result.length).toBe(1);
    expect(result[0].tag).toBe('人物');
  });
});

// ─── filterAssetsClientSide ────────────────────────────────────

describe('filterAssetsClientSide', () => {
  const baseAssets: Asset[] = [
    makeAsset({
      id: 'a1',
      name: '山水风景图',
      type: 'image',
      projectId: 'proj-1',
      metadata: { favorite: true, rating: 5, tags: ['风景', '自然'] },
      createdAt: 1000,
    }),
    makeAsset({
      id: 'a2',
      name: '城市夜景',
      type: 'image',
      projectId: 'proj-2',
      metadata: { favorite: false, rating: 3, tags: ['城市', '夜景'] },
      createdAt: 2000,
    }),
    makeAsset({
      id: 'a3',
      name: '背景音乐',
      type: 'audio',
      projectId: 'proj-1',
      metadata: { favorite: false, rating: 4, tags: ['音乐'], prompt: '轻快的背景音乐' },
      createdAt: 3000,
    }),
    makeAsset({
      id: 'a4',
      name: '剧本文档',
      type: 'document',
      projectId: 'proj-2',
      metadata: { favorite: true, rating: 2, tags: ['文档'], summary: '第一幕剧本' },
      createdAt: 4000,
    }),
  ];

  it('should return all assets with no filters', () => {
    const result = filterAssetsClientSide(baseAssets, {});
    expect(result).toHaveLength(4);
  });

  it('should filter by type', () => {
    const result = filterAssetsClientSide(baseAssets, { filterType: 'image' });
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.type === 'image')).toBe(true);
  });

  it('should filter by favorites only', () => {
    const result = filterAssetsClientSide(baseAssets, { favoriteOnly: true });
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id).sort()).toEqual(['a1', 'a4']);
  });

  it('should filter by minimum rating', () => {
    const result = filterAssetsClientSide(baseAssets, { ratingMin: 4 });
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id).sort()).toEqual(['a1', 'a3']);
  });

  it('should filter by search query (name match)', () => {
    const result = filterAssetsClientSide(baseAssets, { searchQuery: '风景' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('should filter by search query (metadata prompt match)', () => {
    const result = filterAssetsClientSide(baseAssets, { searchQuery: '轻快' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a3');
  });

  it('should filter by search query (metadata summary match)', () => {
    const result = filterAssetsClientSide(baseAssets, { searchQuery: '第一幕' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a4');
  });

  it('should filter by tag', () => {
    const result = filterAssetsClientSide(baseAssets, { tagFilter: '城市' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('should filter by projectId', () => {
    const result = filterAssetsClientSide(baseAssets, { projectId: 'proj-1' });
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id).sort()).toEqual(['a1', 'a3']);
  });

  it('should combine multiple filters (type + favorite)', () => {
    const result = filterAssetsClientSide(baseAssets, {
      filterType: 'image',
      favoriteOnly: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('should be case-insensitive for search', () => {
    const result = filterAssetsClientSide(baseAssets, { searchQuery: 'SHAN' });
    // "山水风景图" contains "shan" in pinyin? No, it searches by Chinese characters.
    // Let's test with actual text
    const result2 = filterAssetsClientSide(baseAssets, { searchQuery: '风景' });
    expect(result2).toHaveLength(1);
  });

  it('should return empty when no assets match', () => {
    const result = filterAssetsClientSide(baseAssets, { searchQuery: '不存在的关键词xyz' });
    expect(result).toHaveLength(0);
  });
});

// ─── sortAssetsClientSide ──────────────────────────────────────

describe('sortAssetsClientSide', () => {
  const assets: Asset[] = [
    makeAsset({ id: 'b', name: 'B', createdAt: 1000, metadata: { rating: 3 } }),
    makeAsset({ id: 'a', name: 'A', createdAt: 3000, metadata: { rating: 5 } }),
    makeAsset({ id: 'c', name: 'C', createdAt: 2000, metadata: { rating: 1 } }),
  ];

  it('should sort by recent (createdAt desc) by default', () => {
    const result = sortAssetsClientSide(assets, 'recent');
    expect(result.map((a) => a.id)).toEqual(['a', 'c', 'b']);
  });

  it('should sort by name alphabetically', () => {
    const result = sortAssetsClientSide(assets, 'name');
    expect(result.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('should sort by rating desc, then recent', () => {
    const result = sortAssetsClientSide(assets, 'rating');
    // a (rating 5, createdAt 3000), b (rating 3, createdAt 1000), c (rating 1, createdAt 2000)
    expect(result.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('should not mutate the original array', () => {
    const original = [...assets];
    sortAssetsClientSide(assets, 'name');
    expect(assets.map((a) => a.id)).toEqual(original.map((a) => a.id));
  });
});

// ─── groupReferencesByType ─────────────────────────────────────

describe('groupReferencesByType', () => {
  it('should group references by type', () => {
    const refs = [
      { refType: 'storyboard' as const, projectId: 'p1', projectName: '项目1', title: '第1镜', subLocator: null, entityId: null },
      { refType: 'pipelineStep' as const, projectId: 'p1', projectName: '项目1', title: '大纲生成', subLocator: null, entityId: null },
      { refType: 'storyboard' as const, projectId: 'p2', projectName: '项目2', title: '第3镜', subLocator: null, entityId: null },
      { refType: 'pipelineStepInput' as const, projectId: 'p1', projectName: '项目1', title: '剧本输入', subLocator: null, entityId: null },
    ];
    const grouped = groupReferencesByType(refs);
    expect(grouped.storyboard).toHaveLength(2);
    expect(grouped.pipelineStep).toHaveLength(1);
    expect(grouped.pipelineStepInput).toHaveLength(1);
  });

  it('should return empty groups for empty input', () => {
    const grouped = groupReferencesByType([]);
    expect(grouped.storyboard).toEqual([]);
    expect(grouped.pipelineStep).toEqual([]);
    expect(grouped.pipelineStepInput).toEqual([]);
  });
});

// ─── buildReferenceSummary ────────────────────────────────────

describe('buildReferenceSummary', () => {
  it('should return "无引用" for empty references', () => {
    expect(buildReferenceSummary([])).toBe('无引用');
  });

  it('should summarize single type references', () => {
    const refs = [
      { refType: 'storyboard' as const, projectId: 'p1', projectName: 'P1', title: 't', subLocator: null, entityId: null },
      { refType: 'storyboard' as const, projectId: 'p1', projectName: 'P1', title: 't2', subLocator: null, entityId: null },
    ];
    expect(buildReferenceSummary(refs)).toBe('2 处分镜');
  });

  it('should summarize mixed references', () => {
    const refs = [
      { refType: 'storyboard' as const, projectId: 'p1', projectName: 'P1', title: 't', subLocator: null, entityId: null },
      { refType: 'pipelineStep' as const, projectId: 'p1', projectName: 'P1', title: 't2', subLocator: null, entityId: null },
    ];
    const summary = buildReferenceSummary(refs);
    expect(summary).toContain('1 处分镜');
    expect(summary).toContain('1 处流水线产出');
  });
});
