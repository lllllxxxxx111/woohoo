import { describe, it, expect } from 'vitest';
import type { Asset } from '../types';
import {
  getAssetTags,
  extractAllTags,
  assetHasTag,
  filterAssetsByTag,
  buildAssetMetadataWithTags,
  DEFAULT_ASSET_LIBRARY_VIEW_STATE,
  normalizeAssetLibraryViewRequest,
  type AssetLibraryViewState,
} from './assetLibraryView';

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    projectId: 'project-1',
    name: '测试素材',
    type: 'image',
    url: '/uploads/test.png',
    metadata: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('getAssetTags', () => {
  it('returns empty array for null metadata', () => {
    const asset = makeAsset({ metadata: null });
    expect(getAssetTags(asset)).toEqual([]);
  });

  it('returns empty array for undefined metadata', () => {
    const asset = makeAsset({ metadata: undefined });
    expect(getAssetTags(asset)).toEqual([]);
  });

  it('returns empty array for empty metadata', () => {
    const asset = makeAsset({ metadata: {} });
    expect(getAssetTags(asset)).toEqual([]);
  });

  it('returns tags from array metadata.tags', () => {
    const asset = makeAsset({
      metadata: { tags: ['背景', '夜景', '城市'] },
    });
    expect(getAssetTags(asset)).toEqual(['背景', '夜景', '城市']);
  });

  it('returns tags from string metadata.tags (semicolon separated)', () => {
    const asset = makeAsset({
      metadata: { tags: '背景;夜景;城市' },
    });
    expect(getAssetTags(asset)).toEqual(['背景', '夜景', '城市']);
  });

  it('returns tags from string metadata.tags (newline separated)', () => {
    const asset = makeAsset({
      metadata: { tags: '背景\n夜景\n城市' },
    });
    expect(getAssetTags(asset)).toEqual(['背景', '夜景', '城市']);
  });

  it('returns tags from string metadata.tags (comma separated)', () => {
    const asset = makeAsset({
      metadata: { tags: '背景,夜景,城市' },
    });
    expect(getAssetTags(asset)).toEqual(['背景', '夜景', '城市']);
  });

  it('trims whitespace from tags', () => {
    const asset = makeAsset({
      metadata: { tags: [' 背景 ', ' 夜景 ', ' 城市 '] },
    });
    expect(getAssetTags(asset)).toEqual(['背景', '夜景', '城市']);
  });

  it('filters out empty tags', () => {
    const asset = makeAsset({
      metadata: { tags: ['背景', '', '  ', '城市'] },
    });
    expect(getAssetTags(asset)).toEqual(['背景', '城市']);
  });

  it('converts non-string tags to strings', () => {
    const asset = makeAsset({
      metadata: { tags: ['背景', 123, null, undefined] },
    });
    expect(getAssetTags(asset)).toEqual(['背景', '123', 'null', 'undefined']);
  });

  it('returns empty array for non-object metadata', () => {
    const asset = makeAsset({ metadata: 'invalid' as unknown as Record<string, unknown> });
    expect(getAssetTags(asset)).toEqual([]);
  });
});

describe('extractAllTags', () => {
  it('returns empty array for empty asset list', () => {
    expect(extractAllTags([])).toEqual([]);
  });

  it('extracts unique tags from multiple assets', () => {
    const assets = [
      makeAsset({ id: 'a1', metadata: { tags: ['背景', '城市'] } }),
      makeAsset({ id: 'a2', metadata: { tags: ['夜景', '背景'] } }),
      makeAsset({ id: 'a3', metadata: { tags: ['人物'] } }),
    ];
    expect(extractAllTags(assets)).toEqual(['背景', '城市', '人物', '夜景']);
  });

  it('handles assets without tags', () => {
    const assets = [
      makeAsset({ id: 'a1', metadata: { tags: ['背景'] } }),
      makeAsset({ id: 'a2', metadata: {} }),
      makeAsset({ id: 'a3', metadata: null }),
    ];
    expect(extractAllTags(assets)).toEqual(['背景']);
  });

  it('returns sorted tags', () => {
    const assets = [
      makeAsset({ id: 'a1', metadata: { tags: ['zebra', 'apple', 'mango'] } }),
    ];
    expect(extractAllTags(assets)).toEqual(['apple', 'mango', 'zebra']);
  });
});

describe('assetHasTag', () => {
  it('returns true when asset has the tag', () => {
    const asset = makeAsset({ metadata: { tags: ['背景', '夜景'] } });
    expect(assetHasTag(asset, '背景')).toBe(true);
  });

  it('returns false when asset does not have the tag', () => {
    const asset = makeAsset({ metadata: { tags: ['背景', '夜景'] } });
    expect(assetHasTag(asset, '人物')).toBe(false);
  });

  it('is case-insensitive', () => {
    const asset = makeAsset({ metadata: { tags: ['Background'] } });
    expect(assetHasTag(asset, 'background')).toBe(true);
  });

  it('returns true for empty tag (no filtering)', () => {
    const asset = makeAsset({ metadata: { tags: ['背景'] } });
    expect(assetHasTag(asset, '')).toBe(true);
  });

  it('returns true for null tag (no filtering)', () => {
    const asset = makeAsset({ metadata: { tags: ['背景'] } });
    expect(assetHasTag(asset, null as unknown as string)).toBe(true);
  });
});

describe('filterAssetsByTag', () => {
  const assets = [
    makeAsset({ id: 'a1', metadata: { tags: ['背景', '城市'] } }),
    makeAsset({ id: 'a2', metadata: { tags: ['夜景', '人物'] } }),
    makeAsset({ id: 'a3', metadata: {} }),
    makeAsset({ id: 'a4', metadata: { tags: ['背景', '人物'] } }),
  ];

  it('returns all assets when tag is null', () => {
    expect(filterAssetsByTag(assets, null)).toEqual(assets);
  });

  it('filters assets by tag', () => {
    const result = filterAssetsByTag(assets, '背景');
    expect(result.map((a) => a.id)).toEqual(['a1', 'a4']);
  });

  it('returns empty array when no assets match', () => {
    const result = filterAssetsByTag(assets, '不存在');
    expect(result).toEqual([]);
  });
});

describe('buildAssetMetadataWithTags', () => {
  it('adds tags to empty metadata', () => {
    const result = buildAssetMetadataWithTags(null, ['背景', '夜景']);
    expect(result).toEqual({ tags: ['背景', '夜景'] });
  });

  it('merges tags with existing metadata', () => {
    const existing = { favorite: true, rating: 5 };
    const result = buildAssetMetadataWithTags(existing, ['背景']);
    expect(result).toEqual({ favorite: true, rating: 5, tags: ['背景'] });
  });

  it('overwrites existing tags', () => {
    const existing = { tags: ['旧标签'], favorite: true };
    const result = buildAssetMetadataWithTags(existing, ['新标签']);
    expect(result).toEqual({ favorite: true, tags: ['新标签'] });
  });

  it('preserves other metadata fields', () => {
    const existing = { prompt: '测试提示词', sizeBytes: 1024 };
    const result = buildAssetMetadataWithTags(existing, ['背景']);
    expect(result.prompt).toBe('测试提示词');
    expect(result.sizeBytes).toBe(1024);
  });
});

describe('normalizeAssetLibraryViewRequest', () => {
  it('returns default state for empty input', () => {
    const result = normalizeAssetLibraryViewRequest({});
    expect(result).toEqual(DEFAULT_ASSET_LIBRARY_VIEW_STATE);
  });

  it('uses provided values', () => {
    const result = normalizeAssetLibraryViewRequest({
      filterType: 'image',
      scope: 'all',
      tag: '背景',
    });
    expect(result.filterType).toBe('image');
    expect(result.scope).toBe('all');
    expect(result.tag).toBe('背景');
  });

  it('falls back to fallback state for missing values', () => {
    const fallback: AssetLibraryViewState = {
      ...DEFAULT_ASSET_LIBRARY_VIEW_STATE,
      filterType: 'video',
      groupMode: 'project',
    };
    const result = normalizeAssetLibraryViewRequest({}, fallback);
    expect(result.filterType).toBe('video');
    expect(result.groupMode).toBe('project');
  });

  it('overrides fallback with provided values', () => {
    const fallback: AssetLibraryViewState = {
      ...DEFAULT_ASSET_LIBRARY_VIEW_STATE,
      filterType: 'video',
    };
    const result = normalizeAssetLibraryViewRequest({ filterType: 'audio' }, fallback);
    expect(result.filterType).toBe('audio');
  });

  it('includes tag in fallback', () => {
    const fallback = {
      ...DEFAULT_ASSET_LIBRARY_VIEW_STATE,
      tag: '旧标签',
    };
    const result = normalizeAssetLibraryViewRequest({}, fallback);
    expect(result.tag).toBe('旧标签');
  });
});
