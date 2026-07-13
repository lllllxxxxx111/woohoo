// Legacy export helpers — maintain backward compatibility with existing callers.
// These wrap the new buildExportBundle function so existing buttons/flows don't break.
import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  ExportOptions,
  ProjectSnapshot,
} from '../types';
import { buildExportBundle } from '../utils/exportBundle';
import { sanitizeForExport } from '../utils/sanitize';

export interface LegacyExportInput {
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  options?: ExportOptions;
  onProgress?: (progress: number, message: string) => void;
}

/**
 * Existing exportFullProjectBundle — now delegates to buildExportBundle with manifest and checksums.
 */
export async function exportFullProjectBundle(input: LegacyExportInput) {
  const result = await buildExportBundle({
    project: input.project,
    scripts: input.scripts,
    storyboards: input.storyboards,
    keyframes: input.keyframes,
    videoPlans: input.videoPlans,
    assets: input.assets,
    exportType: 'full',
    onProgress: input.onProgress,
  });
  return {
    blob: result.blob,
    fileName: result.fileName,
    manifest: result.manifest,
  };
}

/**
 * Existing exportCoreProjectBundle — core planning bundle without heavy assets.
 */
export async function exportCoreProjectBundle(input: LegacyExportInput) {
  const result = await buildExportBundle({
    project: input.project,
    scripts: input.scripts,
    storyboards: input.storyboards,
    keyframes: input.keyframes,
    videoPlans: input.videoPlans,
    assets: input.assets,
    exportType: 'core',
    onProgress: input.onProgress,
  });
  return {
    blob: result.blob,
    fileName: result.fileName,
    manifest: result.manifest,
  };
}

/**
 * Existing createProjectSnapshot — returns a JSON snapshot without zipping.
 * Note: full ZIP snapshot export is available via buildExportBundle with exportType='snapshot'.
 */
export function createProjectSnapshot(input: LegacyExportInput): ProjectSnapshot {
  const snapshot: ProjectSnapshot = {
    id: crypto.randomUUID(),
    projectId: input.project.id,
    createdAt: new Date().toISOString(),
    data: sanitizeForExport({
      project: input.project,
      scripts: input.scripts,
      storyboards: input.storyboards,
      keyframes: input.keyframes,
      assets: input.assets,
      videoPlans: input.videoPlans,
    }),
  };
  return snapshot;
}
