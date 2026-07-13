import type { Asset } from '../types';

export type AssetLibraryFilterType = 'all' | Asset['type'];
export type AssetLibraryScope = 'current' | 'all';
export type AssetLibraryGroupMode = 'none' | 'project' | 'type';

export type AssetLibraryViewRequest = {
  filterType?: AssetLibraryFilterType;
  groupMode?: AssetLibraryGroupMode;
  projectId?: string | null;
  scope?: AssetLibraryScope;
};

export type AssetLibraryViewState = {
  filterType: AssetLibraryFilterType;
  groupMode: AssetLibraryGroupMode;
  projectId: string | null;
  scope: AssetLibraryScope;
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
  };
}
