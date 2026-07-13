// High-level export-bundle builders: assemble a signed, sanitized zip archive
// containing a project's data, an asset folder, a manifest, and a README.

import JSZip from 'jszip';
import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  ExportOptions,
  ProjectSnapshot,
  ExportResult,
} from '../types';
import {
  getProject,
  getScripts,
  getStoryboards,
  getKeyframes,
  getVideoPlans,
  getAssets,
  recordExportAudit,
} from '../serverApi';
import { AssetRepository } from '../assets/AssetRepository';
import { sanitizeForExport } from './sanitize';
import { runPreflightChecks } from './preflight';
import {
  createManifest,
  generateReadmeExport,
  type ExportManifest,
  type ManifestAssetEntry,
} from './exportManifest';

export interface ExportBundleOptions {
  /** When supplied, override the default ExportOptions flags. */
  options?: ExportOptions;
  /** Force export even if preflight has warnings (blocking issues still abort). */
  proceedWithWarnings?: boolean;
  /** Optional callback fired with a human-readable progress message. */
  onProgress?: (msg: string) => void;
}

function defaultExportOptions(): ExportOptions {
  return {
    includeAssets: true,
    includeScripts: true,
    includeStoryboards: true,
    includeKeyframes: true,
    includeVideoPlans: true,
    includeSessions: false,
    assetQuality: 'original',
  };
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function timestampSlug(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Assemble a sanitized ProjectSnapshot from already-loaded domain objects.
 */
export function createProjectSnapshot(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[],
): ProjectSnapshot {
  return sanitizeForExport<ProjectSnapshot>({
    snapshotId: `snap-${Date.now()}`,
    projectId: project.id,
    capturedAt: new Date().toISOString(),
    project,
    scripts,
    storyboards,
    keyframes,
    videoPlans,
    assets,
    assetMetadata: assets,
  });
}

interface LoadedProjectData {
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
}

async function loadProjectData(projectId: string, progress?: (m: string) => void): Promise<LoadedProjectData> {
  progress?.('Loading project...');
  const project = await getProject(projectId);
  progress?.('Loading scripts...');
  const scripts = await getScripts(projectId);
  progress?.('Loading storyboards...');
  const storyboards = await getStoryboards(projectId);
  progress?.('Loading keyframes...');
  const keyframes = await getKeyframes(projectId);
  progress?.('Loading video plans...');
  const videoPlans = await getVideoPlans(projectId);
  progress?.('Loading asset metadata...');
  const assets = await getAssets(projectId);
  return { project, scripts, storyboards, keyframes, videoPlans, assets };
}

async function downloadAssetBlobs(
  repo: AssetRepository,
  assets: Asset[],
  progress?: (m: string) => void,
): Promise<void> {
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    progress?.(`Downloading asset ${i + 1}/${assets.length}: ${a.name}`);
    try {
      await repo.downloadAsset(a.id);
    } catch (err) {
      // downloadAsset already records the error on the cache entry; we keep going.
      progress?.(`  ! Failed to download ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function addJsonFile(zip: JSZip, path: string, data: unknown): void {
  zip.file(path, JSON.stringify(data, null, 2));
}

async function populateDataFolder(
  zip: JSZip,
  data: LoadedProjectData,
  opts: ExportOptions,
): Promise<void> {
  addJsonFile(zip, 'data/project.json', sanitizeForExport(data.project));
  if (opts.includeScripts) {
    addJsonFile(zip, 'data/scripts.json', sanitizeForExport(data.scripts));
  }
  if (opts.includeStoryboards) {
    addJsonFile(zip, 'data/storyboards.json', sanitizeForExport(data.storyboards));
  }
  if (opts.includeKeyframes) {
    addJsonFile(zip, 'data/keyframes.json', sanitizeForExport(data.keyframes));
  }
  if (opts.includeVideoPlans) {
    addJsonFile(zip, 'data/video_plans.json', sanitizeForExport(data.videoPlans));
  }
  if (opts.includeSessions) {
    // Sessions are not currently loaded by loadProjectData; write an empty array
    // for forward compatibility — callers that need sessions can extend this.
    addJsonFile(zip, 'data/sessions.json', []);
  }
}

async function populateAssetsFolder(
  zip: JSZip,
  repo: AssetRepository,
  assets: Asset[],
): Promise<Array<{ asset: Asset; blob?: Blob; downloadError?: string }>> {
  const out: Array<{ asset: Asset; blob?: Blob; downloadError?: string }> = [];
  for (const asset of assets) {
    const entry = repo.getEntry(asset.id);
    const blob = entry?.blob;
    const error = entry?.downloadError;
    if (blob) {
      // Prefix with asset id to avoid filename collisions, keep extension where present.
      const safeName = asset.name.replace(/[\\/]/g, '_');
      const path = `assets/${asset.id}_${safeName}`;
      zip.file(path, blob);
    }
    out.push({ asset, blob, downloadError: error });
  }
  return out;
}

async function buildZipCommon(
  projectId: string,
  exportType: 'full' | 'core',
  opts: ExportBundleOptions,
): Promise<ExportResult> {
  const flags = { ...defaultExportOptions(), ...opts.options };
  const progress = opts.onProgress;

  try {
    const data = await loadProjectData(projectId, progress);

    // Run preflight first. Blocking issues always abort; warnings only abort if
    // the caller hasn't opted to proceed.
    progress?.('Running preflight checks...');
    const preflight = runPreflightChecks(
      data.project,
      data.scripts,
      data.storyboards,
      data.keyframes,
      data.videoPlans,
      data.assets,
    );
    if (!preflight.canExport) {
      return {
        success: false,
        filename: '',
        error: `Preflight failed: ${preflight.summary}`,
      };
    }
    if (preflight.warningCount > 0 && !opts.proceedWithWarnings) {
      return {
        success: false,
        filename: '',
        error: `Preflight warnings: ${preflight.summary} (pass proceedWithWarnings: true to continue)`,
      };
    }

    const zip = new JSZip();
    const repo = new AssetRepository();
    await repo.loadForProject(projectId);

    // Download assets only for full exports.
    let rawAssets: Array<{ asset: Asset; blob?: Blob; downloadError?: string }> = [];
    if (exportType === 'full' && flags.includeAssets) {
      await downloadAssetBlobs(repo, data.assets, progress);
      progress?.('Packing assets...');
      rawAssets = await populateAssetsFolder(zip, repo, data.assets);
    } else {
      // Core / no-asset export: record metadata only, mark every asset as not packed.
      rawAssets = data.assets.map((a) => ({
        asset: a,
        blob: undefined,
        downloadError: 'Assets excluded from core export',
      }));
    }

    // Snapshot (sanitized) at the root.
    progress?.('Writing workspace snapshot...');
    const snapshot = createProjectSnapshot(
      data.project,
      data.scripts,
      data.storyboards,
      data.keyframes,
      data.videoPlans,
      data.assets,
    );
    addJsonFile(zip, 'workspace_snapshot.json', snapshot);

    // Structured data folder.
    progress?.('Writing data files...');
    await populateDataFolder(zip, data, flags);

    // Build and write manifest. The manifest signs itself after being written.
    progress?.('Building manifest...');
    const manifest = await createManifest({
      projectId: data.project.id,
      projectName: data.project.name,
      exportType,
      zip,
      scripts: data.scripts,
      storyboards: data.storyboards,
      keyframes: data.keyframes,
      videoPlans: data.videoPlans,
      rawAssets,
      model: data.project.settings?.pipeline?.model,
      resolution: data.project.settings?.resolution
        ? { w: data.project.settings.resolution.width, h: data.project.settings.resolution.height }
        : undefined,
      fps: data.project.settings?.fps,
      pipeline: data.project.settings?.pipeline?.parameters,
    });

    // Re-add the manifest (so its presence is reflected in the file list too).
    // We rebuild by writing the final manifest.json, then recomputing its own sha
    // and the full file list so everything is self-consistent.
    addJsonFile(zip, 'manifest.json', manifest);

    // The file list inside the manifest now lacks manifest.json itself.
    // Re-generate the file list to include it, then re-sign.
    const finalFiles = await (async (): Promise<ExportManifest['files']> => {
      // Compute sha256 for manifest.json content as written.
      const manifestBuf = new TextEncoder().encode(JSON.stringify(manifest, null, 2)).buffer;
      const { sha256Bytes } = await import('./crypto');
      const manifestHash = await sha256Bytes(manifestBuf);
      const manifestEntry = {
        path: 'manifest.json',
        kind: 'json' as const,
        sizeBytes: manifestBuf.byteLength,
        sha256: manifestHash,
      };
      // Merge with existing file list, replacing any prior manifest.json entry.
      const others = manifest.files.filter((f) => f.path !== 'manifest.json');
      return [...others, manifestEntry].sort((a, b) => a.path.localeCompare(b.path));
    })();

    const finalManifest: ExportManifest = { ...manifest, files: finalFiles };
    finalManifest.counts.files = finalFiles.length;
    // Recompute the manifest self-hash.
    const { sha256String } = await import('./crypto');
    const withoutSelf = Object.fromEntries(
      Object.entries(finalManifest).filter(([k]) => k !== 'manifestSha256'),
    );
    const selfJson = JSON.stringify(
      sanitizeForExport(withoutSelf),
      Object.keys(withoutSelf).sort(),
      0,
    );
    finalManifest.manifestSha256 = await sha256String(selfJson);
    // Overwrite manifest.json with the finalized content.
    addJsonFile(zip, 'manifest.json', finalManifest);

    // README last (so it can reference the finalized manifest).
    progress?.('Writing README...');
    zip.file('README_EXPORT.md', generateReadmeExport(finalManifest));

    // Generate the zip blob.
    progress?.('Compressing archive...');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

    const totalSizeBytes = blob.size;
    const totalAssets = finalManifest.counts.assets;
    const missingAssets = finalManifest.counts.missingAssets;

    // Audit log (best-effort; don't fail the export if audit endpoint errors).
    try {
      await recordExportAudit({
        projectId,
        exportType,
        manifestHash: finalManifest.manifestSha256,
        assetCount: totalAssets,
        missingAssetCount: missingAssets,
        totalSizeBytes,
      });
    } catch {
      // swallow
    }

    const safeName = data.project.name.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    const filename = `${safeName}-${exportType}-${timestampSlug()}.zip`;

    return {
      success: true,
      blob,
      filename,
      stats: {
        totalFiles: finalFiles.length,
        totalAssets,
        missingAssets,
        totalSizeBytes,
      },
    };
  } catch (err) {
    return {
      success: false,
      filename: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build a full project bundle: data + binary assets + signed manifest + README.
 */
export function exportFullProjectBundle(
  projectId: string,
  options: ExportBundleOptions = {},
): Promise<ExportResult> {
  return buildZipCommon(projectId, 'full', {
    ...options,
    options: { ...defaultExportOptions(), ...options.options, includeAssets: true },
  });
}

/**
 * Build a core project bundle: data + metadata only (no binary assets),
 * signed manifest + README.
 */
export function exportCoreProjectBundle(
  projectId: string,
  options: ExportBundleOptions = {},
): Promise<ExportResult> {
  return buildZipCommon(projectId, 'core', {
    ...options,
    options: { ...defaultExportOptions(), ...options.options, includeAssets: false },
  });
}
