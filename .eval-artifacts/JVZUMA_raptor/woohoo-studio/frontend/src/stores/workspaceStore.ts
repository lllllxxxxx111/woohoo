// Workspace store - manages current project workspace state
import { create } from 'zustand';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

interface WorkspaceState {
  currentProject: Project | null;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  activeTab: string;
  isLoading: boolean;
  error: string | null;

  setProject: (project: Project) => void;
  setScripts: (scripts: Script[]) => void;
  setStoryboards: (storyboards: Storyboard[]) => void;
  setKeyframes: (keyframes: Keyframe[]) => void;
  setVideoPlans: (plans: VideoPlan[]) => void;
  setAssets: (assets: Asset[]) => void;
  setActiveTab: (tab: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  currentProject: null,
  scripts: [],
  storyboards: [],
  keyframes: [],
  videoPlans: [],
  assets: [],
  activeTab: 'overview',
  isLoading: false,
  error: null,
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...initialState,
  setProject: (project) => set({ currentProject: project }),
  setScripts: (scripts) => set({ scripts }),
  setStoryboards: (storyboards) => set({ storyboards }),
  setKeyframes: (keyframes) => set({ keyframes }),
  setVideoPlans: (videoPlans) => set({ videoPlans }),
  setAssets: (assets) => set({ assets }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  reset: () => set(initialState),
}));
