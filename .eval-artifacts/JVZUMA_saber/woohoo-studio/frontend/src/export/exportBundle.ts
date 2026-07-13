// Existing export bundle module - provides exportFullProjectBundle, exportCoreProjectBundle, createProjectSnapshot
// Enhanced with manifest, preflight, audit features in this update

import JSZip from 'jszip';
import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  ProjectSnapshot,
  ExportOptions,
  ExportType,
  ExportResult,
  ExportManifest,
  PreflightResult,
  FileEntry,
  AssetEntry,
} from '../types';
import { downloadAssetWithFallback, sanitizeAssetFilename, getAssetExtension } from '../assets/handlers';
import { runPreflightChecks, runPreflightChecksAsync, mergePreflightResults } from './preflight';
import { sha256Hex, sanitizeForExport, sanitizeUrl } from './integrity';
import { buildExportReadme } from './exportDocs';
import { serverApi } from '../api/serverApi';

const SCHEMA_VERSION = '1.0.0';
const GENERATOR_NAME = 'woohoo-studio-export';
const GENERATOR_VERSION = '0.2.0';

export function createProjectSnapshot(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[]
): ProjectSnapshot {
  const cleanProject = sanitizeForExport(project) as Project;
  const cleanScripts = scripts.map(s => sanitizeForExport(s)) as Script[];
  const cleanStoryboards = storyboards.map(s => sanitizeForExport(s)) as Storyboard[];
  const cleanKeyframes = keyframes.map(k => sanitizeForExport(k)) as Keyframe[];
  const cleanVideoPlans = videoPlans.map(v => sanitizeForExport(v)) as VideoPlan[];
  const cleanAssets = assets.map(a => {
    const cleaned = sanitizeForExport(a) as Asset;
    cleaned.url = sanitizeUrl(cleaned.url);
    return cleaned;
  });

  return {
    project: cleanProject,
    scripts: cleanScripts,
    storyboards: cleanStoryboards,
    keyframes: cleanKeyframes,
    videoPlans: cleanVideoPlans,
    assets: cleanAssets,
    snapshotAt: new Date().toISOString(),
    version: SCHEMA_VERSION,
  };
}

function getDefaultOptions(type: ExportType): ExportOptions {
  return {
    includeAssets: type === 'full',
    includeKeyframes: true,
    includeVideoPlans: type === 'full',
  };
}

async function downloadAndPackAssets(
  assets: Asset[],
  zip: JSZip,
  onProgress?: (done: number, total: number, name: string) => void
): Promise<{
  assetEntries: AssetEntry[];
  fileEntries: FileEntry[];
  missingAssetIds: string[];
  totalAssetBytes: number;
}> {
  const assetEntries: AssetEntry[] = [];
  const fileEntries: FileEntry[] = [];
  const missingAssetIds: string[] = [];
  let totalAssetBytes = 0;

  const assetsFolder = zip.folder('assets');
  if (!assetsFolder) throw new Error('Failed to create assets folder');

  const nameCount = new Map<string, number>();

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const baseName = sanitizeAssetFilename(asset.name);
    const ext = getAssetExtension(asset.name, asset.type);
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');

    const existing = nameCount.get(baseName) || 0;
    nameCount.set(baseName, existing + 1);
    const packedName = existing > 0
      ? `${nameWithoutExt}_${existing}.${ext}`
      : `${nameWithoutExt}.${ext}`;

    onProgress?.(i, assets.length, asset.name);

    const { blob, error } = await downloadAssetWithFallback(asset);

    if (blob && !error) {
      const arrayBuf = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuf);
      const hash = await sha256Hex(uint8);
      totalAssetBytes += uint8.length;

      assetsFolder.file(packedName, uint8);

      assetEntries.push({
        assetId: asset.id,
        name: asset.name,
        type: asset.type,
        source: sanitizeUrl(asset.url),
        packedInBundle: true,
        bundlePath: `assets/${packedName}`,
        sizeBytes: uint8.length,
        sha256: hash,
      });
      fileEntries.push({
        path: `assets/${packedName}`,
        kind: 'asset',
        sizeBytes: uint8.length,
        sha256: hash,
      });
    } else {
      missingAssetIds.push(asset.id);
      assetEntries.push({
        assetId: asset.id,
        name: asset.name,
        type: asset.type,
        source: sanitizeUrl(asset.url),
        packedInBundle: false,
        failureReason: error || 'Unknown download failure',
      });
    }
  }

  return { assetEntries, fileEntries, missingAssetIds, totalAssetBytes };
}

export async function exportFullProjectBundle(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[],
  options?: Partial<ExportOptions>,
  onProgress?: (stage: string, done: number, total: number, label?: string) => void,
  forceBypassBlocking = false
): Promise<ExportResult> {
  return exportBundle(
    'full', project, scripts, storyboards, keyframes, videoPlans, assets,
    { ...getDefaultOptions('full'), ...options }, onProgress, forceBypassBlocking
  );
}

export async function exportCoreProjectBundle(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  assets: Asset[],
  options?: Partial<ExportOptions>,
  onProgress?: (stage: string, done: number, total: number, label?: string) => void,
  forceBypassBlocking = false
): Promise<ExportResult> {
  return exportBundle(
    'core', project, scripts, storyboards, keyframes, [], assets,
    { ...getDefaultOptions('core'), ...options, includeAssets: false, includeVideoPlans: false },
    onProgress, forceBypassBlocking
  );
}

async function exportBundle(
  exportType: ExportType,
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[],
  options: ExportOptions,
  onProgress?: (stage: string, done: number, total: number, label?: string) => void,
  forceBypassBlocking = false
): Promise<ExportResult> {
  // 1. Preflight (synchronous checks always run)
  onProgress?.('preflight', 0, 1);
  let preflight: PreflightResult = runPreflightChecks(
    project, scripts, storyboards, keyframes, videoPlans, assets
  );

  // Async network probes (asset/keyframe reachability) — always warning, never blocking.
  // Runs in parallel with preflight UI; failures don't stop export since they
  // may be false negatives (auth-gated CDN, CORS, offline dev, etc.)
  if (preflight.passed || forceBypassBlocking) {
    onProgress?.('preflight', 1, 2, 'Probing asset URLs...');
    try {
      const asyncResult = await runPreflightChecksAsync(
        project, scripts, storyboards, keyframes, videoPlans, assets
      );
      preflight = mergePreflightResults(preflight, asyncResult);
    } catch {
      // Async probes failing entirely is not fatal (no network in tests, etc.)
    }
  }
  onProgress?.('preflight', 1, 1);

  if (preflight.blockingCount > 0 && !forceBypassBlocking) {
    return {
      success: false,
      manifest: {} as ExportManifest,
      manifestHash: '',
      bundleFilename: '',
      packedAssetCount: 0,
      missingAssetCount: preflight.issues.filter(i => i.severity === 'blocking').length,
      preflight,
    };
  }

  const zip = new JSZip();
  const contentFileEntries: FileEntry[] = []; // files that are NOT manifest/README
  let assetEntries: AssetEntry[] = [];
  let missingAssetIds: string[] = [];
  let totalAssetBytes = 0;
  let totalDataBytes = 0;

  // 2. workspace_snapshot.json
  onProgress?.('snapshot', 0, 1);
  const snapshot = createProjectSnapshot(
    project, scripts, storyboards,
    options.includeKeyframes ? keyframes : [],
    options.includeVideoPlans ? videoPlans : [],
    assets
  );
  const snapshotJson = JSON.stringify(snapshot, null, 2);
  const snapshotBytes = new TextEncoder().encode(snapshotJson);
  totalDataBytes += snapshotBytes.length;
  zip.file('workspace_snapshot.json', snapshotJson);
  contentFileEntries.push({
    path: 'workspace_snapshot.json',
    kind: 'data',
    sizeBytes: snapshotBytes.length,
    sha256: await sha256Hex(snapshotBytes),
  });
  onProgress?.('snapshot', 1, 1);

  // 3. data/ individual files
  const dataFolder = zip.folder('data');
  if (dataFolder) {
    const dataItems: Array<{ name: string; data: unknown }> = [
      { name: 'project.json', data: snapshot.project },
      { name: 'scripts.json', data: snapshot.scripts },
      { name: 'storyboards.json', data: snapshot.storyboards },
    ];
    if (options.includeKeyframes) {
      dataItems.push({ name: 'keyframes.json', data: snapshot.keyframes });
    }
    if (options.includeVideoPlans) {
      dataItems.push({ name: 'video_plans.json', data: snapshot.videoPlans });
    }
    dataItems.push({ name: 'assets.json', data: snapshot.assets });

    for (const item of dataItems) {
      const content = JSON.stringify(item.data, null, 2);
      const bytes = new TextEncoder().encode(content);
      totalDataBytes += bytes.length;
      const hash = await sha256Hex(bytes);
      dataFolder.file(item.name, content);
      contentFileEntries.push({
        path: `data/${item.name}`,
        kind: 'data',
        sizeBytes: bytes.length,
        sha256: hash,
      });
    }
  }

  // 4. Assets
  if (options.includeAssets && assets.length > 0) {
    const result = await downloadAndPackAssets(
      assets, zip,
      (done, total, name) => onProgress?.('assets', done, total, name)
    );
    assetEntries = result.assetEntries;
    contentFileEntries.push(...result.fileEntries);
    missingAssetIds = result.missingAssetIds;
    totalAssetBytes = result.totalAssetBytes;
    onProgress?.('assets', assets.length, assets.length);
  } else {
    assetEntries = assets.map(a => ({
      assetId: a.id,
      name: a.name,
      type: a.type,
      source: sanitizeUrl(a.url),
      packedInBundle: false,
      failureReason: options.includeAssets ? undefined : 'Assets not included in core bundle',
    }));
  }

  // 5. Build manifest.json and README_EXPORT.md.
  //
  // Integrity model:
  //   - manifest.files[] lists verifiable content files: workspace_snapshot.json,
  //     data/*, and assets/* — each with sizeBytes + sha256.
  //   - manifest.json's own hash is NOT in files[] (self-referential; verifier
  //     recomputes it independently).
  //   - README_EXPORT.md is human-readable documentation, NOT listed in
  //     manifest.files[] (it contains the manifestHash string, creating a chicken-
  //     and-egg problem if we tried to include its hash in the manifest it describes).
  //   - manifest.counts.files = total files including README and manifest itself.
  //
  // Construction order (no circular dependency, no iteration needed):
  //   1. Build manifest with content files only (no README entry in files[])
  //   2. Serialize → compute manifestHash
  //   3. Build README using that manifestHash (written verbatim)
  //   4. Write README and manifest.json to zip in that order
  const parameterSummary = extractParameterSummary(keyframes, videoPlans);
  const exportedAt = new Date().toISOString();

  const manifest: ExportManifest = {
    schemaVersion: SCHEMA_VERSION,
    projectId: project.id,
    projectName: project.name,
    exportedAt,
    exportType,
    exportOptions: options,
    counts: {
      scripts: scripts.length,
      storyboards: storyboards.length,
      keyframes: options.includeKeyframes ? keyframes.length : 0,
      videoPlans: options.includeVideoPlans ? videoPlans.length : 0,
      assets: options.includeAssets ? assets.length : 0,
      // +2 = README_EXPORT.md and manifest.json itself (counted but not in files[])
      files: contentFileEntries.length + 2,
    },
    files: contentFileEntries,
    assets: assetEntries,
    missingAssets: missingAssetIds,
    parameterSummary,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
  };

  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestBytes = new TextEncoder().encode(manifestJson);
  const manifestHash = await sha256Hex(manifestBytes);

  // Build README with the known manifestHash
  const readmeContent = buildExportReadme(manifest, manifestHash, preflight);
  const readmeBytes = new TextEncoder().encode(readmeContent);
  zip.file('README_EXPORT.md', readmeContent);
  totalDataBytes += readmeBytes.length;
  totalDataBytes += manifestBytes.length;

  // Write manifest.json to zip (written AFTER readme so its hash is stable)
  zip.file('manifest.json', manifestJson);

  // 8. Generate ZIP
  onProgress?.('zipping', 0, 1);
  const bundleBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  onProgress?.('zipping', 1, 1);

  const safeProjectName = sanitizeAssetFilename(project.name) || 'project';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bundleFilename = `${safeProjectName}_${exportType}_${timestamp}.zip`;

  const packedAssetCount = assetEntries.filter(a => a.packedInBundle).length;

  // 9. Audit log (fire-and-forget; failure shouldn't block export)
  try {
    await serverApi.exportAudit.record({
      userId: project.userId,
      projectId: project.id,
      exportType,
      manifestHash,
      assetCount: packedAssetCount,
      missingAssetCount: missingAssetIds.length,
      fileCount: contentFileEntries.length + 2,
      totalSizeBytes: totalAssetBytes + totalDataBytes,
      blockingIssuesOverride: forceBypassBlocking && preflight.blockingCount > 0,
    });
  } catch {
    // Audit recording failure is non-fatal
  }

  return {
    success: true,
    manifest,
    manifestHash,
    bundleBlob,
    bundleFilename,
    packedAssetCount,
    missingAssetCount: missingAssetIds.length,
    preflight,
  };
}

function extractParameterSummary(
  keyframes: Keyframe[],
  videoPlans: VideoPlan[]
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (keyframes.length > 0) {
    const paramKeys = new Set<string>();
    let withParams = 0;
    for (const kf of keyframes) {
      if (kf.parameters) {
        withParams++;
        Object.keys(kf.parameters).forEach(k => paramKeys.add(k));
      }
    }
    summary.keyframes = {
      total: keyframes.length,
      withParameters: withParams,
      parameterKeys: Array.from(paramKeys).sort(),
    };
  }

  if (videoPlans.length > 0) {
    const plan = videoPlans[0];
    summary.videoPlan = {
      resolution: plan.settings?.resolution,
      fps: plan.settings?.fps,
      duration: plan.settings?.duration,
      style: plan.settings?.style,
    };
  }

  return summary;
}
