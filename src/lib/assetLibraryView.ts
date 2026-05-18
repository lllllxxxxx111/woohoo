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

const ASSET_LIBRARY_VIEW_EVENT = 'woohoo:asset-library-view';
const ASSET_LIBRARY_VIEW_STORAGE_KEY = 'woohoo-asset-library-view-request-v1';

export const ASSET_TYPE_LABELS: Record<AssetLibraryFilterType, string> = {
  all: '全部',
  image: '图片',
  video: '视频',
  audio: '音频',
  document: '文档',
};

function normalizeRequest(input: AssetLibraryViewRequest): AssetLibraryViewRequest {
  return {
    filterType: input.filterType ?? 'all',
    groupMode: input.groupMode ?? 'none',
    projectId: input.projectId ?? null,
    scope: input.scope ?? 'current',
  };
}

export function requestAssetLibraryView(input: AssetLibraryViewRequest) {
  if (typeof window === 'undefined') {
    return;
  }

  const detail = normalizeRequest(input);
  window.sessionStorage.setItem(ASSET_LIBRARY_VIEW_STORAGE_KEY, JSON.stringify(detail));
  window.dispatchEvent(new CustomEvent<AssetLibraryViewRequest>(ASSET_LIBRARY_VIEW_EVENT, { detail }));
}

export function consumePendingAssetLibraryViewRequest() {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.sessionStorage.getItem(ASSET_LIBRARY_VIEW_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  window.sessionStorage.removeItem(ASSET_LIBRARY_VIEW_STORAGE_KEY);
  try {
    const parsed = JSON.parse(raw) as AssetLibraryViewRequest;
    return normalizeRequest(parsed);
  } catch {
    return null;
  }
}

export function listenAssetLibraryViewRequests(
  handler: (request: AssetLibraryViewRequest) => void,
) {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const listener = (event: Event) => {
    handler((event as CustomEvent<AssetLibraryViewRequest>).detail);
  };
  window.addEventListener(ASSET_LIBRARY_VIEW_EVENT, listener);
  return () => window.removeEventListener(ASSET_LIBRARY_VIEW_EVENT, listener);
}
