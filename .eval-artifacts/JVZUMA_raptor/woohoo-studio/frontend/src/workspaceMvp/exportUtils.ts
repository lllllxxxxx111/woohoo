// Existing export utility - creates project bundles using JSZip
// This is the baseline that the new manifest/preflight/audit features extend
import JSZip from 'jszip';
import type {
  Project, Script, Storyboard, Keyframe, VideoPlan, Asset,
  ExportOptions, ExportResult, ProjectSnapshot,
} from '../types';
import { downloadAssetsForExport, getAssetPathInZip } from '../assets/handlers';
import type { AssetEntry } from '../assets/AssetRepository';

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeAssets: true,
  includeScripts: true,
  includeStoryboards: true,
  includeKeyframes: true,
  includeVideoPlans: true,
  includeSessions: false,
  assetQuality: 'original',
};

export const CORE_EXPORT_OPTIONS: ExportOptions = {
  includeAssets: false,
  includeScripts: true,
  includeStoryboards: true,
  includeKeyframes: false,
  includeVideoPlans: false,
  includeSessions: false,
};

export async function createProjectSnapshot(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[],
): Promise<ProjectSnapshot> {
  return {
    snapshotId: crypto.randomUUID(),
    projectId: project.id,
    capturedAt: new Date().toISOString(),
    project,
    scripts,
    storyboards,
    keyframes,
    videoPlans,
    assets: [], // Full assets not included in snapshot to keep it lightweight
    assetMetadata: assets.map((a) => ({ ...a })),
  };
}

export async function exportFullProjectBundle(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
  onProgress?: (phase: string, completed: number, total: number) => void,
): Promise<ExportResult> {
  const zip = new JSZip();
  const filename = `${sanitizeProjectName(project.name)}_full_${timestamp()}.zip`;

  // Add JSON data files
  zip.file('project.json', JSON.stringify(project, null, 2));

  if (options.includeScripts) {
    zip.file('scripts.json', JSON.stringify(scripts, null, 2));
  }
  if (options.includeStoryboards) {
    zip.file('storyboards.json', JSON.stringify(storyboards, null, 2));
  }
  if (options.includeKeyframes) {
    zip.file('keyframes.json', JSON.stringify(keyframes, null, 2));
  }
  if (options.includeVideoPlans) {
    zip.file('video_plans.json', JSON.stringify(videoPlans, null, 2));
  }

  // Asset metadata
  zip.file('assets.json', JSON.stringify(assets, null, 2));

  // Download and add assets
  let downloadedEntries: AssetEntry[] = [];
  let missingCount = 0;

  if (options.includeAssets && assets.length > 0) {
    onProgress?.('downloading', 0, assets.length);
    downloadedEntries = await downloadAssetsForExport(assets, (done, total, failed) => {
      onProgress?.('downloading', done, total);
      missingCount = failed;
    });

    for (const entry of downloadedEntries) {
      if (entry.blob && entry.downloaded) {
        const path = getAssetPathInZip(entry.asset);
        zip.file(path, entry.blob);
      }
    }
  }

  onProgress?.('packaging', 1, 1);
  const blob = await zip.generateAsync({ type: 'blob' });

  return {
    success: true,
    blob,
    filename,
    stats: {
      totalFiles: Object.keys(zip.files).length,
      totalAssets: downloadedEntries.filter((e) => e.downloaded).length,
      missingAssets: missingCount,
      totalSizeBytes: blob.size,
    },
  };
}

export async function exportCoreProjectBundle(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
): Promise<ExportResult> {
  const zip = new JSZip();
  const filename = `${sanitizeProjectName(project.name)}_core_${timestamp()}.zip`;

  zip.file('project.json', JSON.stringify(project, null, 2));
  zip.file('scripts.json', JSON.stringify(scripts, null, 2));
  zip.file('storyboards.json', JSON.stringify(storyboards, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });

  return {
    success: true,
    blob,
    filename,
    stats: {
      totalFiles: Object.keys(zip.files).length,
      totalAssets: 0,
      missingAssets: 0,
      totalSizeBytes: blob.size,
    },
  };
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeProjectName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_');
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}
