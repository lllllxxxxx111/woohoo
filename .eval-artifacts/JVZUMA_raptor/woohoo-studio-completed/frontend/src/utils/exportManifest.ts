// Export manifest builder: inventories files, assets, metadata for a project export,
// and self-signs the manifest with a SHA-256.

import type { Asset } from '../types';
import JSZip from 'jszip';
import { sha256Bytes, sha256Blob, sha256String } from './crypto';
import { sanitizeForExport } from './sanitize';

export type ManifestFileKind = 'json' | 'asset' | 'document' | 'snapshot' | 'readme';

export interface ManifestFileEntry {
  path: string;
  kind: ManifestFileKind;
  sizeBytes: number;
  sha256: string;
}

export interface ManifestAssetEntry {
  assetId: string;
  name: string;
  type: string;
  source: string;
  packed: boolean;
  errorReason?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface MissingAssetEntry {
  assetId: string;
  name: string;
  reason: string;
}

export interface ExportManifest {
  schemaVersion: '1.0.0';
  projectId: string;
  projectName: string;
  exportedAt: string;
  exportType: 'full' | 'core';
  counts: {
    files: number;
    assets: number;
    scripts: number;
    storyboards: number;
    keyframes: number;
    videoPlans: number;
    missingAssets: number;
  };
  files: ManifestFileEntry[];
  assets: ManifestAssetEntry[];
  missingAssets: MissingAssetEntry[];
  generationParams: {
    model?: string;
    resolution?: { w: number; h: number };
    fps?: number;
    pipeline?: Record<string, unknown>;
  };
  manifestSha256: string;
}

/**
 * Infer a file's ManifestFileKind from its zip path.
 */
function inferFileKind(path: string): ManifestFileKind {
  const lower = path.toLowerCase();
  if (lower === 'readme_export.md' || lower.startsWith('readme')) return 'readme';
  if (lower === 'workspace_snapshot.json') return 'snapshot';
  if (lower.startsWith('assets/')) return 'asset';
  if (lower.endsWith('.json')) return 'json';
  return 'document';
}

interface RawAssetInput {
  asset: Asset;
  blob?: Blob;
  downloadError?: string;
}

/**
 * Walk every file in a JSZip instance and compute its size + sha256.
 * Directory entries are skipped.
 */
export async function buildFileListFromZip(zip: JSZip): Promise<ManifestFileEntry[]> {
  const entries: ManifestFileEntry[] = [];
  // Zip entries are available via zip.files; directory entries end with '/'.
  const filePaths = Object.keys(zip.files).filter((p) => !p.endsWith('/'));

  for (const path of filePaths) {
    const fileObj = zip.file(path);
    if (!fileObj) continue;

    // JSZip v3: async('arraybuffer') returns the file content as ArrayBuffer.
    const buf = await fileObj.async('arraybuffer');
    entries.push({
      path,
      kind: inferFileKind(path),
      sizeBytes: buf.byteLength,
      sha256: await sha256Bytes(buf),
    });
  }

  // Stable ordering for reproducibility.
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/**
 * Build asset manifest + missing-asset list from Asset entries (and optional blobs).
 */
export function buildAssetManifest(assets: RawAssetInput[]): {
  assets: ManifestAssetEntry[];
  missingAssets: MissingAssetEntry[];
} {
  const packedAssets: ManifestAssetEntry[] = [];
  const missing: MissingAssetEntry[] = [];

  for (const { asset, blob, downloadError } of assets) {
    const hasError = !!downloadError || !blob;
    if (hasError) {
      missing.push({
        assetId: asset.id,
        name: asset.name,
        reason: downloadError || 'No blob downloaded',
      });
      packedAssets.push({
        assetId: asset.id,
        name: asset.name,
        type: asset.type,
        source: asset.url,
        packed: false,
        errorReason: downloadError || 'Blob missing',
        sizeBytes: asset.sizeBytes,
        sha256: asset.sha256,
      });
    } else {
      packedAssets.push({
        assetId: asset.id,
        name: asset.name,
        type: asset.type,
        source: asset.url,
        packed: true,
        sizeBytes: blob.size,
        // sha256 will be computed from the blob later (see createManifest) when
        // we add it to the zip; we prefill with the recorded one if available.
        sha256: asset.sha256,
      });
    }
  }

  return { assets: packedAssets, missingAssets: missing };
}

export interface CreateManifestParams {
  projectId: string;
  projectName: string;
  exportType: 'full' | 'core';
  zip: JSZip;
  scripts: Array<{ id: string }>;
  storyboards: Array<{ id: string }>;
  keyframes: Array<{ id: string }>;
  videoPlans: Array<{
    model?: string;
    resolution?: { width: number; height: number };
    fps?: number;
  }>;
  rawAssets: RawAssetInput[];
  model?: string;
  resolution?: { w: number; h: number };
  fps?: number;
  pipeline?: Record<string, unknown>;
}

/**
 * Build a full ExportManifest from a populated zip and project metadata.
 * After building, computes its own sha256 over the sanitized JSON body
 * (excluding the manifestSha256 field itself) and stamps it on the result.
 */
export async function createManifest(params: CreateManifestParams): Promise<ExportManifest> {
  const { assets: assetEntries, missingAssets } = buildAssetManifest(params.rawAssets);

  // Compute sha256 for any packed assets whose blob we have and whose entry
  // does not yet carry a fresh hash.
  for (let i = 0; i < params.rawAssets.length; i++) {
    const { blob } = params.rawAssets[i];
    const entry = assetEntries[i];
    if (blob && entry.packed) {
      entry.sizeBytes = blob.size;
      entry.sha256 = await sha256Blob(blob);
    }
  }

  const files = await buildFileListFromZip(params.zip);

  // Derive generation params from the first video plan if present and not overridden.
  const primaryPlan = params.videoPlans[0];
  const generationParams: ExportManifest['generationParams'] = {
    model: params.model ?? primaryPlan?.model,
    resolution: params.resolution ?? (primaryPlan?.resolution
      ? { w: primaryPlan.resolution.width, h: primaryPlan.resolution.height }
      : undefined),
    fps: params.fps ?? primaryPlan?.fps,
    pipeline: params.pipeline,
  };

  const manifest: Omit<ExportManifest, 'manifestSha256'> = {
    schemaVersion: '1.0.0',
    projectId: params.projectId,
    projectName: params.projectName,
    exportedAt: new Date().toISOString(),
    exportType: params.exportType,
    counts: {
      files: files.length,
      assets: assetEntries.filter((a) => a.packed).length,
      scripts: params.scripts.length,
      storyboards: params.storyboards.length,
      keyframes: params.keyframes.length,
      videoPlans: params.videoPlans.length,
      missingAssets: missingAssets.length,
    },
    files,
    assets: assetEntries,
    missingAssets,
    generationParams,
  };

  // Sanitize before signing so the hash represents what was actually written.
  const sanitized = sanitizeForExport(manifest);
  // Re-serialize deterministically (sorted keys) so the hash is stable.
  const manifestJson = JSON.stringify(sanitized, Object.keys(sanitized as object).sort(), 0);
  const manifestSha256 = await sha256String(manifestJson);

  return {
    ...(sanitized as typeof manifest),
    manifestSha256,
  };
}

/**
 * Generate a human-readable README that explains how to verify the bundle.
 */
export function generateReadmeExport(manifest: ExportManifest): string {
  const lines: string[] = [];
  lines.push(`# Project Export — ${manifest.projectName}`);
  lines.push('');
  lines.push(`- **Project ID:** \`${manifest.projectId}\``);
  lines.push(`- **Export type:** \`${manifest.exportType}\``);
  lines.push(`- **Exported at:** ${manifest.exportedAt}`);
  lines.push(`- **Schema version:** ${manifest.schemaVersion}`);
  lines.push(`- **Manifest SHA-256:** \`${manifest.manifestSha256}\``);
  lines.push('');
  lines.push('## Contents');
  lines.push('');
  lines.push(`- Files: ${manifest.counts.files}`);
  lines.push(`- Assets (packed): ${manifest.counts.assets}`);
  lines.push(`- Scripts: ${manifest.counts.scripts}`);
  lines.push(`- Storyboards: ${manifest.counts.storyboards}`);
  lines.push(`- Keyframes: ${manifest.counts.keyframes}`);
  lines.push(`- Video plans: ${manifest.counts.videoPlans}`);
  lines.push(`- Missing assets: ${manifest.counts.missingAssets}`);
  lines.push('');

  if (manifest.generationParams.model || manifest.generationParams.resolution || manifest.generationParams.fps) {
    lines.push('## Generation parameters');
    lines.push('');
    if (manifest.generationParams.model) lines.push(`- Model: ${manifest.generationParams.model}`);
    if (manifest.generationParams.resolution) {
      lines.push(`- Resolution: ${manifest.generationParams.resolution.w}x${manifest.generationParams.resolution.h}`);
    }
    if (manifest.generationParams.fps) lines.push(`- FPS: ${manifest.generationParams.fps}`);
    lines.push('');
  }

  lines.push('## File listing');
  lines.push('');
  for (const f of manifest.files) {
    lines.push(`- \`${f.path}\` (${f.kind}) — ${f.sizeBytes} bytes — \`${f.sha256}\``);
  }
  lines.push('');

  if (manifest.missingAssets.length > 0) {
    lines.push('## Missing assets');
    lines.push('');
    for (const m of manifest.missingAssets) {
      lines.push(`- \`${m.assetId}\` (${m.name}): ${m.reason}`);
    }
    lines.push('');
  }

  lines.push('## Verification');
  lines.push('');
  lines.push('To verify the integrity of this bundle:');
  lines.push('');
  lines.push('1. Extract the zip archive.');
  lines.push('2. For each file listed above, compute SHA-256 and compare to the recorded hash.');
  lines.push('3. Compute SHA-256 over `manifest.json` **after removing the `manifestSha256` field** and');
  lines.push('   confirm it matches the value recorded in this README.');
  lines.push('');

  return lines.join('\n');
}
