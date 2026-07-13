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
import { sha256Bytes, sha256String } from './crypto';
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

    // Build and write manifest. The manifest intentionally does NOT list itself
    // in `files` — it is self-verified via manifestSha256 (hash of the canonical
    // JSON with manifestSha256 removed), matching the verification instructions
    // in README_EXPORT.md.  README_EXPORT.md IS written first so its hash is
    // captured in the manifest's file list.
    progress?.('Building manifest...');

    // Build the draft manifest from everything written so far (data + snapshot +
    // assets). This gives counts, missing assets, generation params, and the
    // file hashes for all payload files.
    const draftManifest = await createManifest({
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

    // Assemble the unsigned final manifest (without manifestSha256 yet).
    // `files` starts as the draft file list (data + snapshot + assets); we will
    // add README_EXPORT.md after computing its hash.  manifest.json itself is
    // intentionally NOT listed (self-verified via manifestSha256).
    const finalManifestUnsigned: Omit<ExportManifest, 'manifestSha256'> = {
      schemaVersion: draftManifest.schemaVersion,
      projectId: draftManifest.projectId,
      projectName: draftManifest.projectName,
      exportedAt: draftManifest.exportedAt,
      exportType: draftManifest.exportType,
      counts: { ...draftManifest.counts },
      files: draftManifest.files.slice(),
      assets: draftManifest.assets,
      missingAssets: draftManifest.missingAssets,
      generationParams: draftManifest.generationParams,
    };

    // Generate README from the near-final unsigned manifest (placeholder for
    // manifestSha256 since we don't have it yet; the verifier reads the real
    // value from manifest.json directly).
    progress?.('Writing README...');
    const readmeText = generateReadmeExport({
      ...finalManifestUnsigned,
      manifestSha256: '<see manifest.json field: manifestSha256>',
    });
    const readmeBuf = new TextEncoder().encode(readmeText).buffer;
    const readmeEntry = {
      path: 'README_EXPORT.md',
      kind: 'readme' as const,
      sizeBytes: readmeBuf.byteLength,
      sha256: await sha256Bytes(readmeBuf),
    };

    // Inject the real README entry into files, then re-sort.
    finalManifestUnsigned.files = [...finalManifestUnsigned.files, readmeEntry].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    finalManifestUnsigned.counts.files = finalManifestUnsigned.files.length;

    // Self-sign over the finalized (still-unsigned) manifest: canonical
    // sorted-key, no-whitespace JSON after sanitization, excluding manifestSha256.
    const canonical = JSON.stringify(
      sanitizeForExport(finalManifestUnsigned),
      Object.keys(finalManifestUnsigned).sort(),
      0,
    );
    const manifestSha256 = await sha256String(canonical);

    const finalManifest: ExportManifest = {
      ...finalManifestUnsigned,
      manifestSha256,
    };

    // Write README (final bytes, hash already computed) and manifest.json last.
    zip.file('README_EXPORT.md', readmeText);
    addJsonFile(zip, 'manifest.json', finalManifest);

    // Validation report — machine-readable companion to README_EXPORT.json.
    // Because the report contains the final manifest hash and the manifest
    // contains the report's file hash, we need a 2-pass fixed point: start
    // from the first-pass manifest hash, iterate until stable (2 passes suffice).
    const preBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const preSize = preBlob.size;

    interface ReportShape {
      schemaVersion: string;
      validationTime: string;
      exportType: string;
      projectId: string;
      projectName: string;
      manifestHash: string;
      counts: { files: number; assets: number; missingAssets: number; totalSizeBytes: number };
      preflight: {
        blockingCount: number; warningCount: number; infoCount: number; canExport: boolean;
        issues: { severity: string; code: string; message: string; entityType?: string; entityId?: string }[];
      };
    }

    const buildReport = (mHash: string): ReportShape => sanitizeForExport({
      schemaVersion: '1.0.0',
      validationTime: new Date().toISOString(),
      exportType,
      projectId: data.project.id,
      projectName: data.project.name,
      manifestHash: mHash,
      counts: {
        files: finalManifestUnsigned.files.length + 1,
        assets: finalManifest.counts.assets,
        missingAssets: finalManifest.counts.missingAssets,
        totalSizeBytes: preSize,
      },
      preflight: {
        blockingCount: preflight.blockingCount,
        warningCount: preflight.warningCount,
        infoCount: preflight.infoCount,
        canExport: preflight.canExport,
        issues: preflight.issues.map((i) => ({
          severity: i.severity,
          code: i.code,
          message: i.message,
          entityType: i.entityType,
          entityId: i.entityId,
        })),
      },
    });

    // Fixed point: start with first-pass hash, converge in 2 iterations.
    let curHash = finalManifest.manifestSha256;
    let finalReportJson = '';
    let finalReportEntry: { path: string; kind: 'document'; sizeBytes: number; sha256: string } | null = null;
    for (let pass = 0; pass < 3; pass++) {
      const report: ReportShape = buildReport(curHash);
      finalReportJson = JSON.stringify(report, null, 2);
      const buf = new TextEncoder().encode(finalReportJson).buffer;
      const hash = await sha256Bytes(buf);
      finalReportEntry = {
        path: 'validation_report.json',
        kind: 'document',
        sizeBytes: buf.byteLength,
        sha256: hash,
      };
      // Build the unsigned manifest with this entry and re-sign.
      const files = [...finalManifestUnsigned.files.filter((f) => f.path !== 'validation_report.json'), finalReportEntry];
      files.sort((a, b) => a.path.localeCompare(b.path));
      const candidate: Omit<ExportManifest, 'manifestSha256'> = {
        ...finalManifestUnsigned,
        files,
        counts: { ...finalManifestUnsigned.counts, files: files.length },
      };
      const canon = JSON.stringify(sanitizeForExport(candidate), Object.keys(candidate).sort(), 0);
      const newHash = await sha256String(canon);
      if (newHash === curHash) break;
      curHash = newHash;
    }

    const finalManifest2: ExportManifest = {
      ...finalManifestUnsigned,
      files: finalManifestUnsigned.files
        .filter((f) => f.path !== 'validation_report.json')
        .concat([finalReportEntry!])
        .sort((a, b) => a.path.localeCompare(b.path)),
      counts: {
        ...finalManifestUnsigned.counts,
        files: finalManifestUnsigned.files.filter((f) => f.path !== 'validation_report.json').length + 1,
      },
      manifestSha256: curHash,
    };

    addJsonFile(zip, 'manifest.json', finalManifest2);
    zip.file('validation_report.json', finalReportJson);

    // Generate the final zip blob.
    progress?.('Compressing archive...');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

    const totalAssets = finalManifest2.counts.assets;
    const missingAssets = finalManifest2.counts.missingAssets;

    // Audit log (best-effort; don't fail the export if audit endpoint errors).
    try {
      await recordExportAudit({
        projectId,
        exportType,
        manifestHash: finalManifest2.manifestSha256,
        assetCount: totalAssets,
        missingAssetCount: missingAssets,
        totalSizeBytes: blob.size,
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
        totalFiles: finalManifest2.counts.files,
        totalAssets,
        missingAssets,
        totalSizeBytes: blob.size,
      },
      manifestHash: finalManifest2.manifestSha256,
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
