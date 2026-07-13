import type { Asset } from '../types';

export type AssetLibraryFilterType = 'all' | Asset['type'];
export type AssetLibraryScope = 'current' | 'all';
export type AssetLibraryGroupMode = 'none' | 'project' | 'type';

export type AssetLibraryViewRequest = {
  filterType?: AssetLibraryFilterType;
  groupMode?: AssetLibraryGroupMode;
  projectId?: string | null;
  scope?: AssetLibraryScope;
  searchQuery?: string;
  tag?: string | null;
  favoriteOnly?: boolean;
  ratingMin?: number;
  sort?: 'created_at' | 'name' | 'updated_at' | 'rating';
  order?: 'asc' | 'desc';
};

export type AssetLibraryViewState = {
  filterType: AssetLibraryFilterType;
  groupMode: AssetLibraryGroupMode;
  projectId: string | null;
  scope: AssetLibraryScope;
  searchQuery: string;
  tag: string | null;
  favoriteOnly: boolean;
  ratingMin: number;
  sort: 'created_at' | 'name' | 'updated_at' | 'rating';
  order: 'asc' | 'desc';
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
  searchQuery: '',
  tag: null,
  favoriteOnly: false,
  ratingMin: 0,
  sort: 'created_at',
  order: 'desc',
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
    searchQuery: input.searchQuery ?? fallback.searchQuery,
    tag: input.tag ?? fallback.tag,
    favoriteOnly: input.favoriteOnly ?? fallback.favoriteOnly,
    ratingMin: input.ratingMin ?? fallback.ratingMin,
    sort: input.sort ?? fallback.sort,
    order: input.order ?? fallback.order,
  };
}

/**
 * 从素材 metadata 中安全提取 tags 数组
 */
export function getAssetTags(asset: Pick<Asset, 'metadata'>): string[] {
  const tags = asset.metadata?.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

/**
 * 收集一组素材中所有出现过的标签（去重、排序）
 */
export function collectAllTags(assets: Pick<Asset, 'metadata'>[]): string[] {
  const set = new Set<string>();
  for (const asset of assets) {
    for (const tag of getAssetTags(asset)) {
      set.add(tag);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/**
 * 本地过滤素材列表（用于前端已有数据的快速过滤，跨项目搜索则走后端 API）
 */
export function filterAssetsLocally(
  assets: Asset[],
  filters: {
    searchQuery?: string;
    filterType?: AssetLibraryFilterType;
    tag?: string | null;
    favoriteOnly?: boolean;
    ratingMin?: number;
  },
): Asset[] {
  const query = filters.searchQuery?.trim().toLowerCase() ?? '';
  const typeFilter = filters.filterType ?? 'all';
  const tagFilter = filters.tag ?? null;
  const favOnly = filters.favoriteOnly ?? false;
  const ratingMin = filters.ratingMin ?? 0;

  return assets.filter((asset) => {
    if (typeFilter !== 'all' && asset.type !== typeFilter) return false;
    if (favOnly && asset.metadata?.favorite !== true) return false;
    if (ratingMin > 0) {
      const r = Number(asset.metadata?.rating ?? 0);
      if (!Number.isFinite(r) || r < ratingMin) return false;
    }
    if (tagFilter) {
      const tags = getAssetTags(asset);
      if (!tags.includes(tagFilter)) return false;
    }
    if (query) {
      const name = asset.name.toLowerCase();
      const meta = asset.metadata;
      const prompt = String(meta?.prompt ?? '').toLowerCase();
      const summary = String(meta?.summary ?? '').toLowerCase();
      const description = String(meta?.description ?? '').toLowerCase();
      const tags = getAssetTags(asset).join(' ').toLowerCase();
      const haystack = `${name} ${prompt} ${summary} ${description} ${tags}`;
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
