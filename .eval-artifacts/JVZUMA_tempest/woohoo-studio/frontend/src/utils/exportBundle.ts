// Export bundle builder — generates manifest.json, workspace_snapshot.json, validation_report.md,
// packs all data and assets into a JSZip archive, computes checksums, and returns summary info.
//
// This extends the existing exportFullProjectBundle / exportCoreProjectBundle / createProjectSnapshot
// without replacing them.

import JSZip from 'jszip';
import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  ExportManifest,
  ManifestFileEntry,
  ManifestAssetEntry,
  ExportCounts,
  ExportType,
  GenerationParams,
  PreflightResult,
  WorkspaceSnapshot,
} from '../types';
import { sha256Hex, sha256Blob, computeManifestHash } from './crypto';
import { sanitizeForExport, sanitizeString } from './sanitize';
import { buildWorkspaceSnapshot } from './workspaceSnapshot';
import { generateValidationReport } from './validationReport';

export interface ExportBuildInput {
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  exportType: ExportType;
  preflight?: PreflightResult;
  /** Optional: pre-fetched asset blobs keyed by assetId. If not provided, assets will be fetched from URLs. */
  assetBlobs?: Record<string, Blob>;
  /** Called with progress 0..1 */
  onProgress?: (progress: number, message: string) => void;
}

export interface ExportBuildResult {
  blob: Blob;
  manifest: ExportManifest;
  fileName: string;
  summary: {
    manifestHash: string;
    packedAssetCount: number;
    missingAssetCount: number;
    totalFileCount: number;
    totalSizeBytes: number;
  };
}

/**
 * Build a full or core export bundle as a ZIP Blob.
 *
 * For 'full' export:  includes assets, scripts, storyboards, keyframes, video plans, snapshot, manifest, report.
 * For 'core' export:  includes scripts, storyboards, video plans, manifest, report — no heavy assets or keyframe images.
 * For 'snapshot':     includes project data snapshot only, no binary assets.
 */
export async function buildExportBundle(input: ExportBuildInput): Promise<ExportBuildResult> {
  const {
    project,
    scripts,
    storyboards,
    keyframes,
    videoPlans,
    assets: assetList,
    exportType,
    preflight,
    assetBlobs,
    onProgress,
  } = input;

  const zip = new JSZip();
  const fileEntries: ManifestFileEntry[] = [];
  const assetEntries: ManifestAssetEntry[] = [];
  const missingAssets: string[] = [];
  const packedAssetNames = new Set<string>();

  const includeAssets = exportType === 'full';
  onProgress?.(0.05, 'Preparing export bundle...');

  // --- Sanitize project data ---
  const sanitizedProject = sanitizeForExport(project);
  const sanitizedScripts = sanitizeForExport(scripts);
  const sanitizedStoryboards = sanitizeForExport(storyboards);
  const sanitizedKeyframes = sanitizeForExport(keyframes);
  const sanitizedVideoPlans = sanitizeForExport(videoPlans);

  // --- Write project data JSON ---
  const projectData = {
    project: sanitizedProject,
    scripts: sanitizedScripts,
    storyboards: sanitizedStoryboards,
    keyframes: sanitizedKeyframes,
    videoPlans: sanitizedVideoPlans,
  };

  const projectJson = JSON.stringify(projectData, null, 2);
  zip.file('project.json', projectJson);
  fileEntries.push(await makeFileEntry('project.json', 'data', projectJson));

  onProgress?.(0.15, 'Writing project data...');

  // --- Workspace snapshot ---
  const snapshot: WorkspaceSnapshot = buildWorkspaceSnapshot({
    project,
    scripts,
    storyboards,
    keyframes,
    videoPlans,
    assets: assetList,
  });
  const snapshotJson = JSON.stringify(snapshot, null, 2);
  zip.file('workspace_snapshot.json', snapshotJson);
  fileEntries.push(await makeFileEntry('workspace_snapshot.json', 'metadata', snapshotJson));

  onProgress?.(0.25, 'Building workspace snapshot...');

  // --- Assets ---
  if (includeAssets) {
    const assetsFolder = zip.folder('assets');
    const total = assetList.length;
    for (let i = 0; i < total; i++) {
      const a = assetList[i];
      onProgress?.(0.25 + 0.55 * ((i + 1) / total), `Packing asset ${i + 1}/${total}: ${a.name}`);

      // Dedupe: if name conflicts, prefix with assetId
      let fileName = a.name;
      if (packedAssetNames.has(fileName)) {
        const dot = fileName.lastIndexOf('.');
        const base = dot > 0 ? fileName.substring(0, dot) : fileName;
        const ext = dot > 0 ? fileName.substring(dot) : '';
        fileName = `${base}_${a.id.substring(0, 8)}${ext}`;
      }
      packedAssetNames.add(fileName);

      let blob: Blob | null = assetBlobs?.[a.id] ?? null;
      let errorReason: string | undefined;
      let packed = false;

      if (!blob && a.url) {
        try {
          // Skip blob:/data: URLs as they can't be reliably fetched cross-origin
          if (a.url.startsWith('http')) {
            const resp = await fetch(a.url);
            if (resp.ok) {
              blob = await resp.blob();
            } else {
              errorReason = `HTTP ${resp.status}`;
            }
          } else if (a.url.startsWith('blob:') || a.url.startsWith('data:')) {
            // Try to resolve as blob URL
            try {
              const resp = await fetch(a.url);
              if (resp.ok) blob = await resp.blob();
              else errorReason = 'Failed to resolve local URL';
            } catch {
              errorReason = 'Local/blob URL unreachable';
            }
          } else {
            errorReason = 'Unsupported URL scheme';
          }
        } catch (err) {
          errorReason = err instanceof Error ? err.message : 'Network error';
        }
      } else if (!a.url) {
        errorReason = 'No URL';
      }

      if (blob) {
        assetsFolder!.file(fileName, blob);
        const hash = await sha256Blob(blob);
        fileEntries.push({
          path: `assets/${fileName}`,
          kind: 'asset',
          sizeBytes: blob.size,
          sha256: hash,
        });
        packed = true;
      } else {
        missingAssets.push(a.id);
      }

      assetEntries.push({
        assetId: a.id,
        name: a.name,
        type: a.type,
        url: sanitizeString(a.url || ''),
        source: a.sourceUrl ? sanitizeString(a.sourceUrl) : undefined,
        packed,
        errorReason,
      });
    }
  } else {
    // Core/snapshot exports: list assets without packing binaries
    for (const a of assetList) {
      assetEntries.push({
        assetId: a.id,
        name: a.name,
        type: a.type,
        url: sanitizeString(a.url || ''),
        source: a.sourceUrl ? sanitizeString(a.sourceUrl) : undefined,
        packed: false,
        errorReason: includeAssets ? undefined : 'Not included in core/snapshot export',
      });
    }
  }

  onProgress?.(0.85, 'Generating manifest...');

  // --- Counts (initial; will be updated after we add manifest/report entries) ---
  const counts: ExportCounts = {
    files: 0,
    assets: assetList.length,
    missingAssets: missingAssets.length,
    scripts: scripts.length,
    storyboards: storyboards.length,
    keyframes: keyframes.length,
    videoPlans: videoPlans.length,
  };

  // --- Generation params summary (aggregated from video plans) ---
  const genParams: GenerationParams = {};
  if (videoPlans.length > 0) {
    const vp = videoPlans[0];
    genParams.resolution = vp.config.resolution;
    genParams.fps = vp.config.fps;
    genParams.duration = vp.config.duration;
    genParams.style = vp.config.style;
    genParams.model = vp.config.model;
    genParams.pipeline = vp.config.pipeline;
  }

  // --- Step 1: compute manifestHash over content/asset/document files (everything except manifest.json itself) ---
  // The content files already in fileEntries are: project.json, workspace_snapshot.json, assets/*.
  // We'll also include validation_report.md and README_EXPORT.md (but NOT manifest.json itself, to avoid circular hash).
  // First compute a preliminary manifest without hash to generate the report.
  let manifest: ExportManifest = {
    projectId: project.id,
    projectName: project.name,
    exportedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    exportType,
    counts: { ...counts, files: fileEntries.length + 2 }, // +2 for report/README
    files: [],
    assets: assetEntries,
    missingAssets,
    generationParams: genParams,
  };

  // Compute content hash over core payload files (project.json, workspace_snapshot.json, assets/*).
  // We deliberately do NOT hash validation_report.md / README_EXPORT.md because they embed
  // the manifest hash itself, creating a circular dependency. The hash is intended to
  // certify the *project data*; the report is human-readable documentation derived from it.
  // This avoids any convergence/fixed-point issues and produces a stable, verifiable hash.
  const allFileEntries: ManifestFileEntry[] = [...fileEntries];

  const contentHash = await computeManifestHash(
    allFileEntries.map((e) => ({ path: e.path, sha256: e.sha256 })),
  );

  manifest = {
    ...manifest,
    manifestHash: contentHash,
    counts: { ...counts, files: fileEntries.length + 3 }, // +3: report, README, manifest.json
    files: [],
  };

  // Generate and write the final report (embeds the now-final contentHash)
  const finalReport = generateValidationReport({ manifest, preflight });
  zip.file('validation_report.md', finalReport);
  const reportEntry = await makeFileEntry('validation_report.md', 'document', finalReport);
  allFileEntries.push(reportEntry);

  zip.file('README_EXPORT.md', finalReport);
  const readmeEntry = await makeFileEntry('README_EXPORT.md', 'document', finalReport);
  allFileEntries.push(readmeEntry);

  // Compute manifest.json's own content first (without its own entry), then add it.
  // manifest.json always appears last in files[]; manifestHash covers everything else.
  // Bootstrap manifest.json's own sha256 iteratively:
  // 1. Start with all-zeros for its own entry
  // 2. Serialize, hash bytes -> candidate sha256
  // 3. Set entry.sha256 = candidate; repeat until stable (usually 1-2 iterations).
  let selfEntry: ManifestFileEntry = {
    path: 'manifest.json',
    kind: 'metadata',
    sizeBytes: 0,
    sha256: '0'.repeat(64),
  };
  allFileEntries.push(selfEntry);

  let manifestBytes = '';
  let selfHash = '0'.repeat(64);
  for (let i = 0; i < 6; i++) {
    selfEntry.sha256 = selfHash;
    selfEntry.sizeBytes = new Blob([manifestBytes]).size; // updated after serialize
    manifestBytes = JSON.stringify({ ...manifest, files: allFileEntries }, null, 2);
    const encoder = new TextEncoder();
    const nextHash = await sha256Hex(encoder.encode(manifestBytes));
    selfEntry.sizeBytes = manifestBytes.length;
    if (nextHash === selfHash) break;
    selfHash = nextHash;
  }
  selfEntry.sha256 = selfHash;
  allFileEntries[allFileEntries.length - 1] = selfEntry;

  // After convergence, manifestBytes from the last iteration is the final canonical form.
  // Write it directly to avoid any accidental drift from re-serializing.
  zip.file('manifest.json', manifestBytes);

  // Final manifest (in-memory return value) points at all file entries including itself
  manifest = { ...manifest, files: allFileEntries, counts: { ...counts, files: allFileEntries.length } };

  onProgress?.(0.95, 'Finalising ZIP...');

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

  const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fileName = `${safeName}_${exportType}_${ts}.zip`;

  return {
    blob,
    manifest,
    fileName,
    summary: {
      manifestHash: contentHash,
      packedAssetCount: assetEntries.filter((a) => a.packed).length,
      missingAssetCount: missingAssets.length,
      totalFileCount: allFileEntries.length,
      totalSizeBytes: blob.size,
    },
  };
}

async function makeFileEntry(path: string, kind: ManifestFileEntry['kind'], content: string): Promise<ManifestFileEntry> {
  const bytes = new TextEncoder().encode(content);
  const hash = await sha256Hex(bytes);
  return {
    path,
    kind,
    sizeBytes: bytes.length,
    sha256: hash,
  };
}
