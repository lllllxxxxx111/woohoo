// Project store — manages current project metadata and related data loading
import { create } from 'zustand';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset, ExportAuditLog } from '../types';
import * as api from '../api/serverApi';

interface ProjectState {
  currentProject: Project | null;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  exportHistory: ExportAuditLog[];
  loading: boolean;
  error: string | null;

  loadProject: (id: string) => Promise<void>;
  loadExportHistory: (projectId: string) => Promise<void>;
  setProject: (p: Project) => void;
  setScripts: (s: Script[]) => void;
  setStoryboards: (s: Storyboard[]) => void;
  setKeyframes: (k: Keyframe[]) => void;
  setVideoPlans: (v: VideoPlan[]) => void;
  setAssets: (a: Asset[]) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentProject: null,
  scripts: [],
  storyboards: [],
  keyframes: [],
  videoPlans: [],
  assets: [],
  exportHistory: [],
  loading: false,
  error: null,

  loadProject: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const project = await api.getProject(id);
      set({
        currentProject: project,
        scripts: project.scripts ?? [],
        storyboards: project.storyboards ?? [],
        assets: project.assets ?? [],
        loading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load project', loading: false });
    }
  },

  loadExportHistory: async (projectId: string) => {
    try {
      const res = await api.listExportAudits(projectId);
      set({ exportHistory: res.exports });
    } catch {
      // Non-fatal: export history is best-effort
      set({ exportHistory: [] });
    }
  },

  setProject: (p) => set({ currentProject: p }),
  setScripts: (s) => set({ scripts: s }),
  setStoryboards: (s) => set({ storyboards: s }),
  setKeyframes: (k) => set({ keyframes: k }),
  setVideoPlans: (v) => set({ videoPlans: v }),
  setAssets: (a) => set({ assets: a }),
}));
