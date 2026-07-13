// Asset repository handlers — asset upload, download, preview URL resolution.
import type { Asset, AssetType } from '../types';

/**
 * Build a display name for an asset from its filename or URL.
 */
export function getAssetDisplayName(asset: Asset): string {
  if (asset.name) return asset.name;
  try {
    const url = new URL(asset.url);
    const parts = url.pathname.split('/');
    return parts[parts.length - 1] || asset.id;
  } catch {
    return asset.id;
  }
}

/**
 * Check if an asset URL looks downloadable (http/https, not blob/data).
 */
export function isAssetDownloadable(asset: Asset): boolean {
  if (!asset.url) return false;
  return asset.url.startsWith('http://') || asset.url.startsWith('https://');
}

/**
 * Get a preview URL for an asset. Returns the asset URL directly for http(s) and blob/data URLs.
 */
export function getAssetPreviewUrl(asset: Asset): string {
  return asset.url;
}

/**
 * Group assets by type.
 */
export function groupAssetsByType(assets: Asset[]): Record<AssetType, Asset[]> {
  const groups: Record<string, Asset[]> = {
    image: [],
    video: [],
    audio: [],
    font: [],
    model: [],
    other: [],
  };
  for (const a of assets) {
    const type = a.type || 'other';
    if (!groups[type]) groups[type] = [];
    groups[type].push(a);
  }
  return groups as Record<AssetType, Asset[]>;
}

/**
 * Download an asset blob from its URL. Returns null on failure.
 */
export async function downloadAssetBlob(asset: Asset): Promise<Blob | null> {
  if (!asset.url) return null;
  try {
    const resp = await fetch(asset.url);
    if (!resp.ok) return null;
    return await resp.blob();
  } catch {
    return null;
  }
}

/**
 * Fetch multiple asset blobs in parallel, keyed by asset ID.
 */
export async function fetchAllAssetBlobs(assets: Asset[]): Promise<Record<string, Blob>> {
  const results: Record<string, Blob> = {};
  await Promise.all(
    assets.map(async (a) => {
      const blob = await downloadAssetBlob(a);
      if (blob) results[a.id] = blob;
    }),
  );
  return results;
}
