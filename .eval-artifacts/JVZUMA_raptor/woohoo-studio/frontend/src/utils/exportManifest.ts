// Export Manifest types and generation
// manifest.json records project identity, file listings with checksums,
// asset status, and generation parameters for reproducibility.

import type { Project, Asset, ExportType } from '../types';
import type { AssetEntry } from '../assets/AssetRepository';
import { sha256String } from './crypto';
import { summarizePipelineParams } from './redaction';

export const MANIFEST_SCHEMA_VERSION = '1.0.0';

export interface ManifestFileEntry {
  path: string;
  kind: 'json' | 'asset' | 'document' | 'other';
  sizeBytes: number;
  sha256: string;
}

export interface ManifestAssetEntry {
  assetId: string;
  name: string;
  type: string;
  source: string;
  packagedPath?: string;
  packaged: boolean;
  failureReason?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface ExportManifest {
  schemaVersion: string;
  projectId: string;
  projectName: string;
  exportedAt: string;
  exportType: ExportType;
  manifestHash: string;
  counts: {
    totalFiles: number;
    jsonFiles: number;
    assetFiles: number;
    totalAssets: number;
    packagedAssets: number;
    missingAssets: number;
    scripts: number;
    storyboards: number;
    keyframes: number;
    videoPlans: number;
  };
  files: ManifestFileEntry[];
  assets: ManifestAssetEntry[];
  missingAssets: string[];
  pipelineSummary: Record<string, string>;
  tool: {
    name: string;
    version: string;
  };
}

export interface ManifestBuildContext {
  project: Project;
  exportType: ExportType;
  scripts: unknown[];
  storyboards: unknown[];
  keyframes: unknown[];
  videoPlans: unknown[];
  assetEntries: AssetEntry[];
  jsonFileEntries: Array<{ path: string; content: string; sizeBytes: number }>;
  packagedAssetFiles: Array<{ assetId: string; path: string; blob: Blob }>;
  /** Number of additional meta files (manifest.json itself, README, etc.) added after manifest generation */
  extraMetaFileCount?: number;
}

export async function buildManifest(ctx: ManifestBuildContext): Promise<ExportManifest> {
  const exportedAt = new Date().toISOString();
  const files: ManifestFileEntry[] = [];
  const assets: ManifestAssetEntry[] = [];
  const missingAssets: string[] = [];

  // Build file entries for JSON files
  for (const jf of ctx.jsonFileEntries) {
    const hash = await sha256String(jf.content);
    files.push({
      path: jf.path,
      kind: jf.path.endsWith('.json') ? 'json' : 'document',
      sizeBytes: jf.sizeBytes,
      sha256: hash,
    });
  }

  // Build asset entries and file entries for packaged assets
  let packagedAssetCount = 0;
  const packagedPathMap = new Map<string, string>();
  for (const pf of ctx.packagedAssetFiles) {
    packagedPathMap.set(pf.assetId, pf.path);
  }

  for (const entry of ctx.assetEntries) {
    const packaged = entry.downloaded && entry.blob != null;
    const packagedPath = packaged ? packagedPathMap.get(entry.asset.id) : undefined;

    const assetManifestEntry: ManifestAssetEntry = {
      assetId: entry.asset.id,
      name: entry.asset.name,
      type: entry.asset.type,
      source: entry.asset.url,
      packaged,
      packagedPath,
      sizeBytes: entry.blob?.size ?? entry.asset.sizeBytes,
      sha256: entry.asset.sha256,
    };

    if (!packaged) {
      assetManifestEntry.failureReason = entry.downloadError ?? 'Asset not included in export';
      missingAssets.push(entry.asset.id);
    } else {
      packagedAssetCount++;
    }

    assets.push(assetManifestEntry);

    // Add file entry for packaged assets
    if (packaged && entry.blob && packagedPath) {
      const hash = entry.asset.sha256 ?? '';
      files.push({
        path: packagedPath,
        kind: 'asset',
        sizeBytes: entry.blob.size,
        sha256: hash,
      });
    }
  }

  const jsonFileCount = files.filter((f) => f.kind === 'json').length;
  const extraMeta = ctx.extraMetaFileCount ?? 1; // default: +1 for manifest.json itself

  const counts = {
    totalFiles: files.length + extraMeta,
    jsonFiles: jsonFileCount + (extraMeta > 0 ? 1 : 0), // +1 for manifest.json
    assetFiles: files.filter((f) => f.kind === 'asset').length,
    totalAssets: ctx.assetEntries.length,
    packagedAssets: packagedAssetCount,
    missingAssets: missingAssets.length,
    scripts: ctx.scripts.length,
    storyboards: ctx.storyboards.length,
    keyframes: ctx.keyframes.length,
    videoPlans: ctx.videoPlans.length,
  };

  const pipelineSummary = summarizePipelineParams(ctx.project.settings?.pipeline?.parameters);

  const manifest: ExportManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: ctx.project.id,
    projectName: ctx.project.name,
    exportedAt,
    exportType: ctx.exportType,
    manifestHash: '', // Filled in after serialization
    counts,
    files,
    assets,
    missingAssets,
    pipelineSummary,
    tool: {
      name: 'Woohoo Studio',
      version: '0.3.0',
    },
  };

  // Compute manifest hash: serialize manifest without manifestHash field, then SHA-256.
  // Using delete+assign to preserve key ordering (spread+undefined can cause ordering issues
  // in some engines; delete removes the key entirely like destructuring would).
  const manifestForHash = { ...manifest };
  delete (manifestForHash as Partial<ExportManifest>).manifestHash;
  const manifestJson = JSON.stringify(manifestForHash);
  manifest.manifestHash = await sha256String(manifestJson);

  return manifest;
}

/**
 * Read a Blob into a Uint8Array. Uses Blob.prototype.arrayBuffer() when available
 * (modern browsers), falls back to FileReader for jsdom/older environments.
 */
export async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  // Prefer arrayBuffer() if available (modern browsers, Node.js)
  if (typeof blob.arrayBuffer === 'function') {
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  }
  // Fallback to FileReader (jsdom and older browsers)
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as ArrayBuffer;
      resolve(new Uint8Array(result));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Compute SHA-256 hashes for packaged asset files.
 * Works in both browser and jsdom environments.
 */
export async function computeAssetHashes(
  packagedFiles: Array<{ assetId: string; path: string; blob: Blob }>,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const pf of packagedFiles) {
    const data = await blobToUint8Array(pf.blob);
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    hashes.set(pf.assetId, hex);
  }
  return hashes;
}

export function manifestToJson(manifest: ExportManifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function validateManifestJson(json: string): { valid: boolean; error?: string } {
  try {
    const parsed = JSON.parse(json) as ExportManifest;
    if (!parsed.schemaVersion) return { valid: false, error: 'Missing schemaVersion' };
    if (!parsed.projectId) return { valid: false, error: 'Missing projectId' };
    if (!parsed.exportedAt) return { valid: false, error: 'Missing exportedAt' };
    if (!parsed.files) return { valid: false, error: 'Missing files' };
    if (!Array.isArray(parsed.files)) return { valid: false, error: 'files must be an array' };
    if (!parsed.manifestHash) return { valid: false, error: 'Missing manifestHash' };
    if (typeof parsed.manifestHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(parsed.manifestHash)) {
      return { valid: false, error: 'manifestHash must be a 64-character hex SHA-256 digest' };
    }
    if (!parsed.counts || typeof parsed.counts !== 'object') {
      return { valid: false, error: 'Missing or invalid counts' };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
}

// Generate the validation_report.md content
export function generateValidationReport(manifest: ExportManifest): string {
  const lines: string[] = [];
  lines.push(`# Export Validation Report`);
  lines.push('');
  lines.push(`**Project**: ${manifest.projectName} (${manifest.projectId})`);
  lines.push(`**Exported at**: ${manifest.exportedAt}`);
  lines.push(`**Export type**: ${manifest.exportType}`);
  lines.push(`**Manifest hash**: \`${manifest.manifestHash}\``);
  lines.push(`**Schema version**: ${manifest.schemaVersion}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total files | ${manifest.counts.totalFiles} |`);
  lines.push(`| JSON files | ${manifest.counts.jsonFiles} |`);
  lines.push(`| Asset files | ${manifest.counts.assetFiles} |`);
  lines.push(`| Total assets | ${manifest.counts.totalAssets} |`);
  lines.push(`| Packaged assets | ${manifest.counts.packagedAssets} |`);
  lines.push(`| Missing assets | ${manifest.counts.missingAssets} |`);
  lines.push(`| Scripts | ${manifest.counts.scripts} |`);
  lines.push(`| Storyboards | ${manifest.counts.storyboards} |`);
  lines.push(`| Keyframes | ${manifest.counts.keyframes} |`);
  lines.push(`| Video plans | ${manifest.counts.videoPlans} |`);
  lines.push('');

  if (manifest.missingAssets.length > 0) {
    lines.push(`## Missing Assets`);
    lines.push('');
    lines.push(`The following ${manifest.missingAssets.length} asset(s) could not be packaged:`);
    lines.push('');
    for (const assetId of manifest.missingAssets) {
      const assetEntry = manifest.assets.find((a) => a.assetId === assetId);
      lines.push(`- **${assetEntry?.name ?? assetId}** (\`${assetId}\`): ${assetEntry?.failureReason ?? 'Unknown reason'}`);
    }
    lines.push('');
  }

  lines.push(`## File Manifest`);
  lines.push('');
  lines.push(`| Path | Kind | Size (bytes) | SHA-256 |`);
  lines.push(`|------|------|-------------|---------|`);
  for (const f of manifest.files) {
    lines.push(`| ${f.path} | ${f.kind} | ${f.sizeBytes} | \`${f.sha256.substring(0, 16)}...\` |`);
  }
  lines.push('');

  lines.push(`## Verification Instructions`);
  lines.push('');
  lines.push(`To verify package integrity:`);
  lines.push('');
  lines.push(`1. Extract the zip archive.`);
  lines.push(`2. Open ` + '`manifest.json`' + ` and note the ` + '`manifestHash`' + ` field.`);
  lines.push(`3. For each file listed in ` + '`files`' + `, compute its SHA-256 hash and compare with the value in the manifest.`);
  lines.push(`4. Verify that no expected files are missing from the archive.`);
  lines.push(`5. Check ` + '`missingAssets`' + ` to understand which assets were not downloadable at export time.`);
  lines.push('');
  lines.push(`## Reproducibility`);
  lines.push('');
  lines.push(`The ` + '`workspace_snapshot.json`' + ` file contains the complete project state at export time (with sensitive fields redacted). Use it to:`);
  lines.push('');
  lines.push(`- Review the exact scripts, storyboards, and keyframes used.`);
  lines.push(`- Check pipeline parameters (API keys and secrets are redacted).`);
  lines.push(`- Cross-reference asset metadata with the packaged files.`);
  lines.push('');

  return lines.join('\n');
}
