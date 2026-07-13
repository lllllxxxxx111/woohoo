import { create } from 'zustand';
import type { PreflightResult, ExportOptions, ExportType } from '../types';
import {
  runPreflightCheck,
  recordExportAudit,
  getExportAuditLogs,
  type ExportAuditRecord,
} from '../serverApi';
import { exportFullProjectBundle, exportCoreProjectBundle } from '../utils/exportBundle';

interface LastExportResult {
  success: boolean;
  manifestHash?: string;
  assetCount: number;
  missingAssetCount: number;
  totalSizeBytes: number;
  filename: string;
  error?: string;
}

interface ExportStoreState {
  preflightResult: PreflightResult | null;
  isRunningPreflight: boolean;
  isExporting: boolean;
  lastExportResult: LastExportResult | null;
  auditHistory: ExportAuditRecord[];
  isLoadingHistory: boolean;

  runPreflight: (projectId: string) => Promise<void>;
  startExport: (projectId: string, type: ExportType, options: ExportOptions) => Promise<LastExportResult>;
  loadAuditHistory: (projectId: string) => Promise<void>;
  clearPreflight: () => void;
}

/** Trigger browser download for a Blob. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick to let the browser start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const useExportStore = create<ExportStoreState>((set, get) => ({
  preflightResult: null,
  isRunningPreflight: false,
  isExporting: false,
  lastExportResult: null,
  auditHistory: [],
  isLoadingHistory: false,

  clearPreflight: () => set({ preflightResult: null }),

  runPreflight: async (projectId: string) => {
    set({ isRunningPreflight: true, preflightResult: null });
    try {
      const result = await runPreflightCheck(projectId);
      set({ preflightResult: result, isRunningPreflight: false });
    } catch (err) {
      set({ isRunningPreflight: false });
      throw err;
    }
  },

  startExport: async (projectId: string, type: ExportType, _options: ExportOptions) => {
    set({ isExporting: true, lastExportResult: null });
    try {
      // Generate the zip on the client. Core export skips binaries; full export
      // includes them when network is available, but either way our helpers
      // always produce a well-formed zip with manifest + snapshot + README.
      const runExport = type === 'core' ? exportCoreProjectBundle : exportFullProjectBundle;
      const resp = await runExport(projectId, { proceedWithWarnings: true });

      if (!resp.success || !resp.blob) {
        const error: LastExportResult = {
          success: false,
          assetCount: 0,
          missingAssetCount: 0,
          totalSizeBytes: 0,
          filename: resp.filename,
          error: resp.error || 'Export failed',
        };
        set({ lastExportResult: error, isExporting: false });
        throw new Error(error.error);
      }

      // Trigger browser download
      triggerDownload(resp.blob, resp.filename);

      const result: LastExportResult = {
        success: true,
        manifestHash: resp.manifestHash,
        assetCount: resp.stats?.totalAssets ?? 0,
        missingAssetCount: resp.stats?.missingAssets ?? 0,
        totalSizeBytes: resp.stats?.totalSizeBytes ?? resp.blob.size,
        filename: resp.filename,
      };
      set({ lastExportResult: result, isExporting: false });

      // Best-effort audit log (do not block UX if it fails).
      try {
        await recordExportAudit({
          projectId,
          exportType: type,
          manifestHash: result.manifestHash!,
          assetCount: result.assetCount,
          missingAssetCount: result.missingAssetCount,
          totalSizeBytes: result.totalSizeBytes,
        });
        get().loadAuditHistory(projectId).catch(() => {});
      } catch {
        // audit failure is non-fatal
      }

      return result;
    } catch (err) {
      set({ isExporting: false });
      throw err;
    }
  },

  loadAuditHistory: async (projectId: string) => {
    set({ isLoadingHistory: true });
    try {
      const logs = await getExportAuditLogs(projectId);
      set({ auditHistory: logs, isLoadingHistory: false });
    } catch {
      set({ auditHistory: [], isLoadingHistory: false });
    }
  },
}));
