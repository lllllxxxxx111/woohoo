import { create } from 'zustand';
import type { PreflightResult, ExportOptions, ExportType } from '../types';
import {
  runPreflightCheck,
  startProjectExport,
  recordExportAudit,
  getExportAuditLogs,
  type ExportAuditRecord,
} from '../serverApi';

interface LastExportResult {
  success: boolean;
  manifestHash: string;
  assetCount: number;
  missingAssetCount: number;
  filename: string;
}

interface ExportStoreState {
  preflightResult: PreflightResult | null;
  isRunningPreflight: boolean;
  isExporting: boolean;
  lastExportResult: LastExportResult | null;
  auditHistory: ExportAuditRecord[];
  isLoadingHistory: boolean;

  runPreflight: (projectId: string) => Promise<void>;
  startExport: (projectId: string, type: ExportType, options: ExportOptions) => Promise<void>;
  loadAuditHistory: (projectId: string) => Promise<void>;
  clearPreflight: () => void;
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

  startExport: async (projectId: string, type: ExportType, options: ExportOptions) => {
    set({ isExporting: true, lastExportResult: null });
    try {
      const resp = await startProjectExport(projectId, type, options);
      const result: LastExportResult = {
        success: resp.success,
        manifestHash: resp.manifestHash,
        assetCount: resp.assetCount,
        missingAssetCount: resp.missingAssetCount,
        filename: resp.filename,
      };
      set({ lastExportResult: result, isExporting: false });

      if (resp.success) {
        try {
          await recordExportAudit({
            projectId,
            exportType: type,
            manifestHash: resp.manifestHash,
            assetCount: resp.assetCount,
            missingAssetCount: resp.missingAssetCount,
            totalSizeBytes: resp.totalSizeBytes,
          });
          // Refresh history after recording
          get().loadAuditHistory(projectId).catch(() => {});
        } catch {
          // Audit recording failure shouldn't block the export success UI
        }
      }
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
