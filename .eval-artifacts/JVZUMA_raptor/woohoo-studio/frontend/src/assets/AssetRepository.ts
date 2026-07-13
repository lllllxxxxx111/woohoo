// Asset repository helpers - manages asset listing, download, caching
import type { Asset } from '../types';
import { getAssets, downloadAssetBlob, getAssetDownloadUrl } from '../serverApi';

export interface AssetEntry {
  asset: Asset;
  blob?: Blob;
  downloadError?: string;
  downloaded: boolean;
}

export class AssetRepository {
  private cache = new Map<string, AssetEntry>();

  async loadForProject(projectId: string): Promise<AssetEntry[]> {
    const assets = await getAssets(projectId);
    const entries: AssetEntry[] = assets.map((a) => ({
      asset: a,
      downloaded: false,
    }));
    entries.forEach((e) => this.cache.set(e.asset.id, e));
    return entries;
  }

  /** Seed a single asset entry into the cache (used by export flow to ensure entries exist before download) */
  seedEntry(asset: Asset): AssetEntry {
    const entry: AssetEntry = { asset, downloaded: false };
    this.cache.set(asset.id, entry);
    return entry;
  }

  async downloadAsset(assetId: string): Promise<Blob> {
    let entry = this.cache.get(assetId);
    if (!entry) {
      // Entry wasn't pre-seeded; create a placeholder (shouldn't normally happen if seedEntry is called)
      throw new Error(`Asset ${assetId} not found in repository. Call seedEntry() first.`);
    }
    try {
      const blob = await downloadAssetBlob(assetId);
      entry.blob = blob;
      entry.downloaded = true;
      entry.downloadError = undefined;
      return blob;
    } catch (err) {
      entry.downloadError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  getDownloadUrl(assetId: string): string {
    return getAssetDownloadUrl(assetId);
  }

  getEntry(assetId: string): AssetEntry | undefined {
    return this.cache.get(assetId);
  }

  getAll(): AssetEntry[] {
    return Array.from(this.cache.values());
  }

  clear(): void {
    this.cache.clear();
  }
}

export const assetRepo = new AssetRepository();
