// Workspace store - Zustand store managing project workspace state

import { create } from 'zustand';
import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  ExportAuditLog,
} from '../types';
import { serverApi } from '../api/serverApi';

interface WorkspaceState {
  currentProject: Project | null;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  exportHistory: ExportAuditLog[];
  exportHistoryLoading: boolean;
  setProject: (p: Project) => void;
  setScripts: (s: Script[]) => void;
  setStoryboards: (s: Storyboard[]) => void;
  setKeyframes: (k: Keyframe[]) => void;
  setVideoPlans: (v: VideoPlan[]) => void;
  setAssets: (a: Asset[]) => void;
  setExportHistory: (history: ExportAuditLog[]) => void;
  addExportAudit: (entry: ExportAuditLog) => void;
  refreshExportHistory: () => Promise<void>;
  loadProject: (projectId: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  currentProject: null,
  scripts: [],
  storyboards: [],
  keyframes: [],
  videoPlans: [],
  assets: [],
  exportHistory: [],
  exportHistoryLoading: false,

  setProject: (p) => {
    set({ currentProject: p });
    if (p?.id) {
      get().refreshExportHistory();
    }
  },
  setScripts: (s) => set({ scripts: s }),
  setStoryboards: (s) => set({ storyboards: s }),
  setKeyframes: (k) => set({ keyframes: k }),
  setVideoPlans: (v) => set({ videoPlans: v }),
  setAssets: (a) => set({ assets: a }),
  setExportHistory: (history) => set({ exportHistory: history }),
  addExportAudit: (entry) =>
    set((state) => ({ exportHistory: [entry, ...state.exportHistory].slice(0, 50) })),

  /**
   * Fetch recent export audit history for the current project from the backend.
   * Failures are non-fatal (gracefully degrades when backend is unavailable in mock/dev).
   */
  refreshExportHistory: async () => {
    const { currentProject } = get();
    if (!currentProject?.id) return;
    set({ exportHistoryLoading: true });
    try {
      const exports = await serverApi.exportAudit.listByProject(currentProject.id);
      set({ exportHistory: exports, exportHistoryLoading: false });
    } catch {
      set({ exportHistoryLoading: false });
    }
  },

  loadProject: async (projectId: string) => {
    try {
      const full = await serverApi.projects.get(projectId);
      const { scripts, storyboards, keyframes, videoPlans, assets, ...project } = full;
      set({
        currentProject: project,
        scripts,
        storyboards,
        keyframes,
        videoPlans,
        assets,
      });
      // After project loads, pull export history
      await get().refreshExportHistory();
    } catch {
      // Mock/dev mode: leave state as-is
    }
  },
}));
