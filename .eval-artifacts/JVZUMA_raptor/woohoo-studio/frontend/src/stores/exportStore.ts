// Export store - tracks export state and history
import { create } from 'zustand';
import type { ExportAuditRecord } from '../serverApi';

interface ExportState {
  isExporting: boolean;
  exportProgress: number;
  lastExportResult: {
    manifestHash?: string;
    assetCount: number;
    missingAssetCount: number;
    totalSizeBytes: number;
    filename: string;
  } | null;
  exportHistory: ExportAuditRecord[];
  preflightIssues: PreflightIssue[];
  showPreflightDialog: boolean;

  setExporting: (exporting: boolean) => void;
  setProgress: (progress: number) => void;
  setLastExportResult: (result: ExportState['lastExportResult']) => void;
  setExportHistory: (history: ExportAuditRecord[]) => void;
  setPreflightIssues: (issues: PreflightIssue[]) => void;
  setShowPreflightDialog: (show: boolean) => void;
}

export type PreflightSeverity = 'blocking' | 'warning' | 'info';

export interface PreflightIssue {
  severity: PreflightSeverity;
  category: string;
  message: string;
  detail?: string;
  entityId?: string;
}

export const useExportStore = create<ExportState>((set) => ({
  isExporting: false,
  exportProgress: 0,
  lastExportResult: null,
  exportHistory: [],
  preflightIssues: [],
  showPreflightDialog: false,

  setExporting: (isExporting) => set({ isExporting }),
  setProgress: (exportProgress) => set({ exportProgress }),
  setLastExportResult: (lastExportResult) => set({ lastExportResult }),
  setExportHistory: (exportHistory) => set({ exportHistory }),
  setPreflightIssues: (preflightIssues) => set({ preflightIssues }),
  setShowPreflightDialog: (showPreflightDialog) => set({ showPreflightDialog }),
}));
