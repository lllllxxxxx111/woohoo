// Export store — orchestrates preflight, bundle build, download, and audit recording.
import { create } from 'zustand';
import type { ExportType, PreflightResult, ExportManifest } from '../types';
import { runPreflight } from '../utils/preflight';
import { buildExportBundle } from '../utils/exportBundle';
import { recordExportAudit } from '../api/serverApi';
import { useProjectStore } from './projectStore';

interface ExportState {
  isExporting: boolean;
  exportProgress: number;
  exportMessage: string;
  preflightResult: PreflightResult | null;
  lastManifest: ExportManifest | null;
  lastExportSummary: {
    manifestHash: string;
    packedAssetCount: number;
    missingAssetCount: number;
    totalFileCount: number;
    totalSizeBytes: number;
  } | null;
  toastMessage: string | null;
  toastType: 'success' | 'error' | null;

  runPreflight: (data: Parameters<typeof runPreflight>[0]) => PreflightResult;
  performExport: (args: {
    project: Parameters<typeof buildExportBundle>[0]['project'];
    scripts: Parameters<typeof buildExportBundle>[0]['scripts'];
    storyboards: Parameters<typeof buildExportBundle>[0]['storyboards'];
    keyframes: Parameters<typeof buildExportBundle>[0]['keyframes'];
    videoPlans: Parameters<typeof buildExportBundle>[0]['videoPlans'];
    assets: Parameters<typeof buildExportBundle>[0]['assets'];
    exportType: ExportType;
    preflight: PreflightResult;
    force?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  triggerDownload: (blob: Blob, fileName: string) => void;
  clearToast: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const useExportStore = create<ExportState>((set, get) => ({
  isExporting: false,
  exportProgress: 0,
  exportMessage: '',
  preflightResult: null,
  lastManifest: null,
  lastExportSummary: null,
  toastMessage: null,
  toastType: null,

  runPreflight: (data) => {
    const result = runPreflight(data);
    set({ preflightResult: result });
    return result;
  },

  performExport: async (args) => {
    const { project, scripts, storyboards, keyframes, videoPlans, assets, exportType, preflight, force } = args;

    // Blocking check
    if (!force && preflight.summary.blockingCount > 0) {
      return { success: false, error: `Cannot export: ${preflight.summary.blockingCount} blocking issue(s) found.` };
    }

    set({ isExporting: true, exportProgress: 0, exportMessage: 'Starting export...' });

    try {
      const result = await buildExportBundle({
        project,
        scripts,
        storyboards,
        keyframes,
        videoPlans,
        assets,
        exportType,
        preflight,
        onProgress: (p, msg) => set({ exportProgress: p, exportMessage: msg }),
      });

      // Download
      get().triggerDownload(result.blob, result.fileName);

      // Record audit (non-blocking — export already succeeded even if audit fails)
      try {
        await recordExportAudit({
          projectId: project.id,
          exportType,
          manifestHash: result.summary.manifestHash,
          assetCount: result.summary.packedAssetCount,
          missingAssetCount: result.summary.missingAssetCount,
          fileCount: result.summary.totalFileCount,
          totalSizeBytes: result.summary.totalSizeBytes,
          blockingCount: preflight.summary.blockingCount,
          warningCount: preflight.summary.warningCount,
        });
        // Refresh the export history for this project so the UI shows the new entry
        useProjectStore.getState().loadExportHistory(project.id).catch(() => {});
      } catch {
        // Audit recording failure is non-fatal for the user
      }

      set({
        isExporting: false,
        exportProgress: 1,
        lastManifest: result.manifest,
        lastExportSummary: {
          manifestHash: result.summary.manifestHash,
          packedAssetCount: result.summary.packedAssetCount,
          missingAssetCount: result.summary.missingAssetCount,
          totalFileCount: result.summary.totalFileCount,
          totalSizeBytes: result.summary.totalSizeBytes,
        },
        // Toast must include: filename, packed asset count, missing asset count (per spec)
        toastMessage:
          `✓ ${result.fileName}\n` +
          `Hash: ${result.summary.manifestHash.substring(0, 12)}… • ` +
          `${result.summary.totalFileCount} files (${formatBytes(result.summary.totalSizeBytes)}) • ` +
          `${result.summary.packedAssetCount} assets packed • ${result.summary.missingAssetCount} missing`,
        toastType: 'success',
      });

      return { success: true };
    } catch (err) {
      set({
        isExporting: false,
        toastMessage: `Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        toastType: 'error',
      });
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  },

  triggerDownload: (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  clearToast: () => set({ toastMessage: null, toastType: null }),
}));
