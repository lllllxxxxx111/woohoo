// Enhanced export with manifest, checksums, snapshot, and audit recording
// Extends the existing exportFullProjectBundle / exportCoreProjectBundle
// without replacing them (backward compatible).

import JSZip from 'jszip';
import type {
  Project, Script, Storyboard, Keyframe, VideoPlan, Asset,
  ExportOptions, ExportResult, ExportType, ProjectSnapshot,
} from '../types';
import type { AssetEntry } from '../assets/AssetRepository';
import { downloadAssetsForExport, getAssetPathInZip, sanitizeFilename } from '../assets/handlers';
import {
  buildManifest, computeAssetHashes, generateValidationReport,
  type ExportManifest,
} from '../utils/exportManifest';
import { sanitizeForExport, type SanitizeForExportResult } from '../utils/redaction';
import { sha256String } from '../utils/crypto';
import { recordExportAudit } from '../serverApi';
import {
  DEFAULT_EXPORT_OPTIONS, CORE_EXPORT_OPTIONS, createProjectSnapshot, triggerDownload,
} from './exportUtils';

export interface EnhancedExportProgress {
  phase: 'preflight' | 'downloading' | 'packaging' | 'manifest' | 'audit' | 'done';
  completed: number;
  total: number;
  message?: string;
}

export interface EnhancedExportResult extends ExportResult {
  manifestHash: string;
  assetCount: number;
  missingAssetCount: number;
  validationReport: string;
  manifest: ExportManifest;
}

// Meta files that are added to the zip AFTER manifest is built:
//   manifest.json itself (self-referential — can't hash itself)
//   README_EXPORT.md (documentation, references manifestHash)
//   validation_report.md (documentation, references manifestHash)
// These are present in the zip but not listed in manifest.files[].
// manifest.counts.totalFiles accounts for them.
const META_FILE_COUNT = 3;

/**
 * Export full project bundle with manifest, checksums, snapshot, and audit.
 * Preserves the existing exportFullProjectBundle interface.
 */
export async function exportFullProjectBundleEnhanced(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
  onProgress?: (p: EnhancedExportProgress) => void,
): Promise<EnhancedExportResult> {
  const zip = new JSZip();
  const filename = `${sanitizeFilename(project.name)}_full_${timestamp()}.zip`;
  const exportType: ExportType = 'full';

  onProgress?.({ phase: 'downloading', completed: 0, total: assets.length });

  // Download assets
  const assetEntries: AssetEntry[] = options.includeAssets
    ? await downloadAssetsForExport(assets, (done, total) => {
        onProgress?.({ phase: 'downloading', completed: done, total, message: `Downloaded ${done}/${total} assets` });
      })
    : assets.map((a) => ({ asset: a, downloaded: false, downloadError: 'Assets not included in this export type' }));

  onProgress?.({ phase: 'packaging', completed: 0, total: 1, message: 'Packaging JSON data' });

  // JSON data files are redacted and post-serialization scrubbed so no secret
  // pattern (JWT, sk-..., PEM, local paths) can leak via stringified objects.
  const redactionTriggers = new Set<string>();
  let redactionHits = 0;
  const jsonFiles: Array<{ path: string; content: string; sizeBytes: number }> = [];

  const addJson = (path: string, data: unknown) => {
    const result: SanitizeForExportResult = sanitizeForExport(data);
    zip.file(path, result.json);
    jsonFiles.push({ path, content: result.json, sizeBytes: new TextEncoder().encode(result.json).length });
    redactionHits += result.redactionStats.hits;
    for (const t of result.redactionStats.triggers) redactionTriggers.add(t);
  };

  addJson('project.json', project);

  if (options.includeScripts) addJson('scripts.json', scripts);
  if (options.includeStoryboards) addJson('storyboards.json', storyboards);
  if (options.includeKeyframes) addJson('keyframes.json', keyframes);
  if (options.includeVideoPlans) addJson('video_plans.json', videoPlans);
  addJson('assets.json', assets);

  // Add asset files to zip and track packaged paths
  const packagedAssetFiles: Array<{ assetId: string; path: string; blob: Blob }> = [];
  const pathCount = new Map<string, number>();

  for (const entry of assetEntries) {
    if (entry.blob && entry.downloaded) {
      let path = getAssetPathInZip(entry.asset);
      const count = pathCount.get(path) ?? 0;
      if (count > 0) {
        const ext = path.lastIndexOf('.');
        const base = ext > 0 ? path.substring(0, ext) : path;
        const suffix = ext > 0 ? path.substring(ext) : '';
        path = `${base}_${count + 1}${suffix}`;
      }
      pathCount.set(getAssetPathInZip(entry.asset), count + 1);
      zip.file(path, entry.blob);
      packagedAssetFiles.push({ assetId: entry.asset.id, path, blob: entry.blob });
    }
  }

  onProgress?.({ phase: 'manifest', completed: 0, total: 1, message: 'Computing checksums and generating manifest' });

  // Compute SHA-256 for each packaged asset BEFORE building manifest
  const assetHashes = await computeAssetHashes(packagedAssetFiles);
  for (const entry of assetEntries) {
    const hash = assetHashes.get(entry.asset.id);
    if (hash) entry.asset.sha256 = hash;
  }

  // Create workspace snapshot (reproducibility) — also redacted
  const snapshot: ProjectSnapshot = await createProjectSnapshot(
    project, scripts, storyboards, keyframes, videoPlans, assets,
  );
  const snapshotResult = sanitizeForExport(snapshot);
  const snapshotJson = snapshotResult.json;
  redactionHits += snapshotResult.redactionStats.hits;
  for (const t of snapshotResult.redactionStats.triggers) redactionTriggers.add(t);
  zip.file('workspace_snapshot.json', snapshotJson);
  jsonFiles.push({
    path: 'workspace_snapshot.json',
    content: snapshotJson,
    sizeBytes: new TextEncoder().encode(snapshotJson).length,
  });

  // Re-redact the project for manifest building (manifest itself is safe JSON
  // and will be scrubbed at serialization time via manifestToJson)
  const redactedProject = sanitizeForExport(project).json;
  // parse back for buildManifest which expects an object (we already know it's valid JSON)
  const safeProject = JSON.parse(redactedProject) as Project;

  // Build manifest with extraMetaFileCount so hash covers the correct final counts
  const manifest = await buildManifest({
    project: safeProject,
    exportType,
    scripts,
    storyboards,
    keyframes,
    videoPlans,
    assetEntries,
    jsonFileEntries: jsonFiles,
    packagedAssetFiles,
    extraMetaFileCount: META_FILE_COUNT,
  });

  // Generate documentation files (reference final manifest hash)
  //
  // The manifest object built above still contains asset URLs / pipeline
  // strings that could carry secrets (signed URLs, tokens in query strings,
  // etc.). Run it through the full sanitization pipeline, then recompute
  // manifestHash over the sanitized form so what's on disk verifies cleanly.
  const manifestSanitized = sanitizeForExport(manifest);
  redactionHits += manifestSanitized.redactionStats.hits;
  for (const t of manifestSanitized.redactionStats.triggers) redactionTriggers.add(t);
  const finalManifest = JSON.parse(manifestSanitized.json) as ExportManifest;
  finalManifest.manifestHash = '';
  finalManifest.manifestHash = await sha256String(JSON.stringify(finalManifest));
  const finalManifestJson = JSON.stringify(finalManifest, null, 2);

  const readmeContent = generateReadmeExport(finalManifest);
  const reportContent = generateValidationReport(finalManifest);

  // Add meta files to zip (NOT to manifest.files — see META_FILE_COUNT comment)
  zip.file('README_EXPORT.md', readmeContent);
  zip.file('validation_report.md', reportContent);
  zip.file('manifest.json', finalManifestJson);

  onProgress?.({ phase: 'packaging', completed: 1, total: 1, message: 'Finalizing zip' });

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  onProgress?.({ phase: 'audit', completed: 0, total: 1, message: 'Recording export audit' });

  try {
    await recordExportAudit({
      projectId: project.id,
      exportType,
      manifestHash: finalManifest.manifestHash,
      assetCount: finalManifest.counts.packagedAssets,
      missingAssetCount: finalManifest.counts.missingAssets,
      totalSizeBytes: blob.size,
    });
  } catch (err) {
    console.warn('Failed to record export audit:', err);
  }

  onProgress?.({ phase: 'done', completed: 1, total: 1, message: 'Export complete' });

  return {
    success: true,
    blob,
    filename,
    manifestHash: finalManifest.manifestHash,
    assetCount: finalManifest.counts.packagedAssets,
    missingAssetCount: finalManifest.counts.missingAssets,
    validationReport: reportContent,
    manifest: finalManifest,
    stats: {
      totalFiles: Object.keys(zip.files).length,
      totalAssets: finalManifest.counts.packagedAssets,
      missingAssets: finalManifest.counts.missingAssets,
      totalSizeBytes: blob.size,
    },
  };
}

/**
 * Export core project bundle with manifest and audit.
 * Preserves the lightweight core export behavior while adding integrity features.
 */
export async function exportCoreProjectBundleEnhanced(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  onProgress?: (p: EnhancedExportProgress) => void,
): Promise<EnhancedExportResult> {
  const zip = new JSZip();
  const filename = `${sanitizeFilename(project.name)}_core_${timestamp()}.zip`;
  const exportType: ExportType = 'core';

  onProgress?.({ phase: 'packaging', completed: 0, total: 1, message: 'Packaging core bundle' });

  const redactionTriggers = new Set<string>();
  let redactionHits = 0;
  const jsonFiles: Array<{ path: string; content: string; sizeBytes: number }> = [];

  const addJson = (path: string, data: unknown) => {
    const result = sanitizeForExport(data);
    zip.file(path, result.json);
    jsonFiles.push({ path, content: result.json, sizeBytes: new TextEncoder().encode(result.json).length });
    redactionHits += result.redactionStats.hits;
    for (const t of result.redactionStats.triggers) redactionTriggers.add(t);
  };

  addJson('project.json', project);
  addJson('scripts.json', scripts);
  addJson('storyboards.json', storyboards);

  // Create snapshot — redacted
  const snapshot: ProjectSnapshot = await createProjectSnapshot(
    project, scripts, storyboards, [], [], [],
  );
  const snapshotResult = sanitizeForExport(snapshot);
  const snapshotJson = snapshotResult.json;
  redactionHits += snapshotResult.redactionStats.hits;
  for (const t of snapshotResult.redactionStats.triggers) redactionTriggers.add(t);
  zip.file('workspace_snapshot.json', snapshotJson);
  jsonFiles.push({
    path: 'workspace_snapshot.json',
    content: snapshotJson,
    sizeBytes: new TextEncoder().encode(snapshotJson).length,
  });

  onProgress?.({ phase: 'manifest', completed: 0, total: 1, message: 'Generating manifest' });

  // Build manifest from a sanitized project object
  const safeProject = JSON.parse(sanitizeForExport(project).json) as Project;

  const manifest = await buildManifest({
    project: safeProject,
    exportType,
    scripts,
    storyboards,
    keyframes: [],
    videoPlans: [],
    assetEntries: [],
    jsonFileEntries: jsonFiles,
    packagedAssetFiles: [],
    extraMetaFileCount: META_FILE_COUNT,
  });

  // Final redaction pass on manifest, recompute hash
  const manifestSanitized = sanitizeForExport(manifest);
  redactionHits += manifestSanitized.redactionStats.hits;
  for (const t of manifestSanitized.redactionStats.triggers) redactionTriggers.add(t);
  const finalManifest = JSON.parse(manifestSanitized.json) as ExportManifest;
  finalManifest.manifestHash = '';
  finalManifest.manifestHash = await sha256String(JSON.stringify(finalManifest));
  const finalManifestJson = JSON.stringify(finalManifest, null, 2);

  const readmeContent = generateReadmeExport(finalManifest);
  const reportContent = generateValidationReport(finalManifest);

  zip.file('README_EXPORT.md', readmeContent);
  zip.file('validation_report.md', reportContent);
  zip.file('manifest.json', finalManifestJson);

  onProgress?.({ phase: 'packaging', completed: 1, total: 1, message: 'Finalizing zip' });

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

  onProgress?.({ phase: 'audit', completed: 0, total: 1, message: 'Recording audit' });

  try {
    await recordExportAudit({
      projectId: project.id,
      exportType,
      manifestHash: finalManifest.manifestHash,
      assetCount: 0,
      missingAssetCount: 0,
      totalSizeBytes: blob.size,
    });
  } catch (err) {
    console.warn('Failed to record export audit:', err);
  }

  onProgress?.({ phase: 'done', completed: 1, total: 1 });

  return {
    success: true,
    blob,
    filename,
    manifestHash: finalManifest.manifestHash,
    assetCount: 0,
    missingAssetCount: 0,
    validationReport: reportContent,
    manifest: finalManifest,
    stats: {
      totalFiles: Object.keys(zip.files).length,
      totalAssets: 0,
      missingAssets: 0,
      totalSizeBytes: blob.size,
    },
  };
}

function generateReadmeExport(manifest: ExportManifest): string {
  return `# ${manifest.projectName} - Export Package

> Exported: ${manifest.exportedAt}
> Type: ${manifest.exportType}
> Manifest Hash: \`${manifest.manifestHash}\`

## Package Contents

This zip file contains a reproducible export of the project "${manifest.projectName}".

### Files

**Integrity-verified files (listed in manifest.json with SHA-256 checksums):**

- \`project.json\` - Project metadata.
- \`scripts.json\` - Script and scene data (if included).
- \`storyboards.json\` - Storyboard and shot data (if included).
- \`keyframes.json\` - Keyframe data (if included in full export).
- \`video_plans.json\` - Video generation plans (if included in full export).
- \`assets.json\` - Asset metadata (if included in full export).
- \`workspace_snapshot.json\` - Full project state at export time (sensitive fields redacted).
- \`assets/\` - Downloaded asset files (if included in full export).

**Companion documentation files:**

- \`manifest.json\` - Complete manifest with file listings, SHA-256 checksums, and asset status.
- \`README_EXPORT.md\` - This file.
- \`validation_report.md\` - Human-readable validation summary.

### Verification

To verify integrity:

1. Extract the archive.
2. Open \`manifest.json\` and note the \`manifestHash\` field.
3. For each file listed in \`files\`, compute its SHA-256 hash and compare with the value in the manifest.
4. Re-serialize the manifest (with \`manifestHash\` set to empty string) and compare SHA-256 to verify the manifest itself hasn't been tampered with.
5. Check \`missingAssets\` to understand which assets were not downloadable at export time.

### Sensitive Data

API keys, tokens, passwords, and local filesystem paths are automatically redacted.
See \`workspace_snapshot.json\` - redacted fields show \`[REDACTED]\`.

### Reproducing the Experiment

Use \`workspace_snapshot.json\` to restore project state in Woohoo Studio.
The snapshot includes scripts, storyboards, keyframes, video plans, and asset metadata.
Missing assets (listed in manifest.missingAssets) will need to be re-downloaded or re-uploaded.
`;
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

export { triggerDownload };
