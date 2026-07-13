// Asset download handler utilities
import { assetRepo, type AssetEntry } from './AssetRepository';
import type { Asset } from '../types';

export async function downloadAssetsForExport(
  assets: Asset[],
  onProgress?: (completed: number, total: number, failed: number) => void,
): Promise<AssetEntry[]> {
  const entries: AssetEntry[] = [];
  let completed = 0;
  let failed = 0;

  for (const asset of assets) {
    // Ensure the asset exists in the repo cache before downloading.
    // The export flow may not call loadForProject first, so we seed entries here.
    if (!assetRepo.getEntry(asset.id)) {
      assetRepo.seedEntry(asset);
    }

    try {
      await assetRepo.downloadAsset(asset.id);
      const entry = assetRepo.getEntry(asset.id);
      if (entry) {
        entries.push(entry);
      } else {
        // Fallback: if entry still missing after successful download, construct it
        failed++;
        entries.push({
          asset,
          downloaded: false,
          downloadError: 'Cache inconsistency after download',
        });
      }
    } catch (err) {
      failed++;
      entries.push({
        asset,
        downloaded: false,
        downloadError: err instanceof Error ? err.message : 'Download failed',
      });
    }
    completed++;
    onProgress?.(completed, assets.length, failed);
  }

  return entries;
}

export function getAssetPathInZip(asset: Asset): string {
  const safeName = sanitizeFilename(asset.name);
  return `assets/${asset.type}/${safeName}`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_');
}

export function detectDuplicateFilenames(assets: Asset[]): Map<string, Asset[]> {
  const map = new Map<string, Asset[]>();
  for (const a of assets) {
    const safe = sanitizeFilename(a.name);
    const existing = map.get(safe) ?? [];
    existing.push(a);
    map.set(safe, existing);
  }
  // Only return duplicates (2+ files with same name)
  const dups = new Map<string, Asset[]>();
  for (const [name, list] of map) {
    if (list.length > 1) dups.set(name, list);
  }
  return dups;
}
