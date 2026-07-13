// Asset handlers - download, preview, validation helpers

import type { Asset } from '../types';

export async function downloadAsset(asset: Asset): Promise<Blob> {
  const resp = await fetch(asset.url);
  if (!resp.ok) {
    throw new Error(`Failed to download asset ${asset.name}: ${resp.status}`);
  }
  return resp.blob();
}

export async function downloadAssetWithFallback(asset: Asset): Promise<{ blob?: Blob; error?: string }> {
  try {
    const blob = await downloadAsset(asset);
    return { blob };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function sanitizeAssetFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export function detectDuplicateFilenames(assets: Asset[]): string[] {
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  for (const a of assets) {
    const name = sanitizeAssetFilename(a.name);
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count > 1) duplicates.push(name);
  }
  return duplicates;
}

export function getAssetExtension(name: string, type: Asset['type']): string {
  const ext = name.split('.').pop();
  if (ext && ext.length <= 5 && ext !== name) return ext.toLowerCase();
  const map: Record<string, string> = {
    image: 'png',
    video: 'mp4',
    audio: 'mp3',
    document: 'txt',
    other: 'bin',
  };
  return map[type] || 'bin';
}

export function isAssetUrlValid(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'blob:'].includes(u.protocol) || url.startsWith('/');
  } catch {
    return url.startsWith('/') || url.startsWith('blob:');
  }
}
