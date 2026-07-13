import type { Asset } from '../types';

export type AssetLibraryFilterType = 'all' | Asset['type'];
export type AssetLibraryScope = 'current' | 'all';
export type AssetLibraryGroupMode = 'none' | 'project' | 'type';

export type AssetLibraryViewRequest = {
  filterType?: AssetLibraryFilterType;
  groupMode?: AssetLibraryGroupMode;
  projectId?: string | null;
  scope?: AssetLibraryScope;
  tag?: string | null;
};

export type AssetLibraryViewState = {
  filterType: AssetLibraryFilterType;
  groupMode: AssetLibraryGroupMode;
  projectId: string | null;
  scope: AssetLibraryScope;
  tag: string | null;
};

export const ASSET_TYPE_LABELS: Record<AssetLibraryFilterType, string> = {
  all: '全部',
  image: '图片',
  video: '视频',
  audio: '音频',
  document: '文档',
};

export const DEFAULT_ASSET_LIBRARY_VIEW_STATE: AssetLibraryViewState = {
  filterType: 'all',
  groupMode: 'none',
  projectId: null,
  scope: 'current',
  tag: null,
};

export function normalizeAssetLibraryViewRequest(
  input: AssetLibraryViewRequest,
  fallback: AssetLibraryViewState = DEFAULT_ASSET_LIBRARY_VIEW_STATE,
): AssetLibraryViewState {
  return {
    filterType: input.filterType ?? fallback.filterType,
    groupMode: input.groupMode ?? fallback.groupMode,
    projectId: input.projectId ?? fallback.projectId,
    scope: input.scope ?? fallback.scope,
    tag: input.tag ?? fallback.tag,
  };
}

/**
 * 从素材 metadata 中提取 tags 数组
 * 兼容 metadata.tags 为数组或分号/换行分隔字符串的情况
 */
export function getAssetTags(asset: Asset): string[] {
  const metadata = asset.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [];
  }

  const tagsValue = metadata.tags;
  if (Array.isArray(tagsValue)) {
    return tagsValue
      .map((tag) => String(tag).trim())
      .filter(Boolean);
  }

  if (typeof tagsValue === 'string' && tagsValue.trim()) {
    return tagsValue
      .split(/\n|；|;|,/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * 从素材列表中提取所有唯一标签
 */
export function extractAllTags(assets: Asset[]): string[] {
  const tagSet = new Set<string>();
  for (const asset of assets) {
    for (const tag of getAssetTags(asset)) {
      tagSet.add(tag);
    }
  }
  return Array.from(tagSet).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/**
 * 判断素材是否包含指定标签
 */
export function assetHasTag(asset: Asset, tag: string): boolean {
  if (!tag) return true;
  return getAssetTags(asset).some((t) => t.toLowerCase() === tag.toLowerCase());
}

/**
 * 为素材构建 tags metadata 字段（合并已有 metadata）
 */
export function buildAssetMetadataWithTags(
  existingMetadata: Asset['metadata'],
  tags: string[],
): Record<string, unknown> {
  const base = existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
    ? { ...existingMetadata }
    : {};
  return { ...base, tags };
}

/**
 * 按标签过滤素材
 */
export function filterAssetsByTag(assets: Asset[], tag: string | null): Asset[] {
  if (!tag) return assets;
  return assets.filter((asset) => assetHasTag(asset, tag));
}
