import type { Asset, AssetReference, AssetReferenceType } from '../types';
import { getAssetTags } from '../types';

export type AssetLibraryFilterType = 'all' | Asset['type'];
export type AssetLibraryScope = 'current' | 'all';
export type AssetLibraryGroupMode = 'none' | 'project' | 'type';
export type AssetLibrarySortMode = 'recent' | 'name' | 'rating';

export type AssetLibraryViewRequest = {
  filterType?: AssetLibraryFilterType;
  groupMode?: AssetLibraryGroupMode;
  projectId?: string | null;
  scope?: AssetLibraryScope;
  sortMode?: AssetLibrarySortMode;
  tagFilter?: string | null;
};

export type AssetLibraryViewState = {
  filterType: AssetLibraryFilterType;
  groupMode: AssetLibraryGroupMode;
  projectId: string | null;
  scope: AssetLibraryScope;
  sortMode: AssetLibrarySortMode;
  tagFilter: string | null;
};

export const ASSET_TYPE_LABELS: Record<AssetLibraryFilterType, string> = {
  all: '全部',
  image: '图片',
  video: '视频',
  audio: '音频',
  document: '文档',
};

export const ASSET_SORT_LABELS: Record<AssetLibrarySortMode, string> = {
  recent: '最近',
  name: '名称',
  rating: '评分',
};

export const REFERENCE_TYPE_LABELS: Record<AssetReferenceType, string> = {
  storyboard: '分镜引用',
  pipelineStep: '流水线产出',
  pipelineStepInput: '流水线输入',
};

export const DEFAULT_ASSET_LIBRARY_VIEW_STATE: AssetLibraryViewState = {
  filterType: 'all',
  groupMode: 'none',
  projectId: null,
  scope: 'current',
  sortMode: 'recent',
  tagFilter: null,
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
    sortMode: input.sortMode ?? fallback.sortMode,
    tagFilter: input.tagFilter ?? fallback.tagFilter,
  };
}

/**
 * Extract and aggregate all unique tags from a list of assets.
 * Returns tags sorted by frequency (most used first), then alphabetically.
 */
export function aggregateAssetTags(assets: Asset[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    for (const tag of getAssetTags(asset.metadata)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.tag.localeCompare(b.tag);
    });
}

/**
 * Client-side filtering of assets (used for current-project scope where all assets
 * are already loaded in the store). For cross-project scope, the backend search API
 * is used instead.
 */
export function filterAssetsClientSide(
  assets: Asset[],
  options: {
    filterType?: AssetLibraryFilterType;
    favoriteOnly?: boolean;
    ratingMin?: number;
    searchQuery?: string;
    tagFilter?: string | null;
    projectId?: string | null;
  },
): Asset[] {
  const search = options.searchQuery?.trim().toLowerCase() ?? '';
  return assets.filter((asset) => {
    if (options.projectId && asset.projectId !== options.projectId) return false;
    if (options.filterType && options.filterType !== 'all' && asset.type !== options.filterType) return false;
    if (options.favoriteOnly && asset.metadata?.favorite !== true) return false;
    if (options.ratingMin && options.ratingMin > 0) {
      const rating = Number(asset.metadata?.rating ?? 0);
      if (rating < options.ratingMin) return false;
    }
    if (options.tagFilter) {
      const tags = getAssetTags(asset.metadata);
      if (!tags.includes(options.tagFilter)) return false;
    }
    if (search) {
      const name = asset.name.toLowerCase();
      const prompt = String(asset.metadata?.prompt ?? '').toLowerCase();
      const summary = String(asset.metadata?.summary ?? '').toLowerCase();
      const description = String(asset.metadata?.description ?? '').toLowerCase();
      const tags = getAssetTags(asset.metadata).join(' ').toLowerCase();
      const haystack = `${name} ${prompt} ${summary} ${description} ${tags}`;
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/**
 * Sort assets client-side according to sort mode.
 */
export function sortAssetsClientSide(assets: Asset[], sortMode: AssetLibrarySortMode): Asset[] {
  const sorted = [...assets];
  switch (sortMode) {
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'rating': {
      sorted.sort((a, b) => {
        const ra = Number(a.metadata?.rating ?? 0);
        const rb = Number(b.metadata?.rating ?? 0);
        if (rb !== ra) return rb - ra;
        return b.createdAt - a.createdAt;
      });
      break;
    }
    case 'recent':
    default:
      sorted.sort((a, b) => b.createdAt - a.createdAt);
      break;
  }
  return sorted;
}

/**
 * Group references by type for display in the UI.
 */
export function groupReferencesByType(references: AssetReference[]): {
  storyboard: AssetReference[];
  pipelineStep: AssetReference[];
  pipelineStepInput: AssetReference[];
} {
  return {
    storyboard: references.filter((r) => r.refType === 'storyboard'),
    pipelineStep: references.filter((r) => r.refType === 'pipelineStep'),
    pipelineStepInput: references.filter((r) => r.refType === 'pipelineStepInput'),
  };
}

/**
 * Build a human-readable summary string from a list of references.
 */
export function buildReferenceSummary(references: AssetReference[]): string {
  if (references.length === 0) return '无引用';
  const { storyboard, pipelineStep, pipelineStepInput } = groupReferencesByType(references);
  const parts: string[] = [];
  if (storyboard.length > 0) parts.push(`${storyboard.length} 处分镜`);
  if (pipelineStep.length > 0) parts.push(`${pipelineStep.length} 处流水线产出`);
  if (pipelineStepInput.length > 0) parts.push(`${pipelineStepInput.length} 处流水线输入`);
  return parts.join('、');
}
