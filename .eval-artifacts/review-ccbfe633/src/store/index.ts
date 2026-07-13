import { create } from 'zustand';
import { createAiSettings, normalizeAiBaseUrl, normalizeAiSettingsPayload } from '../lib/ai';
import type {
  ActiveState,
  AgentContact,
  AiSettings,
  Asset,
  CollaborationSession,
  CollaborationAssignment,
  CollaborationMessage,
  LoopCheckResponse,
  Message,
  Project,
  Script,
  Storyboard,
} from '../types';
import type { AiTask } from '../lib/serverApi';
import {
  DEFAULT_ASSET_LIBRARY_VIEW_STATE,
  normalizeAssetLibraryViewRequest,
  type AssetLibraryViewRequest,
  type AssetLibraryViewState,
} from '../lib/assetLibraryView';

import type { ExecutionMode } from '../types';

const ACTIVE_STATE_STORAGE_KEY = 'woohoo-active-state-v2';
const DEFAULT_ACTIVE_STATE: ActiveState = { projectId: null, chatSessionId: null, currentTab: 'chat' };

function isWorkspaceTab(value: unknown): value is ActiveState['currentTab'] {
  return (
    value === 'chat' ||
    value === 'pipeline' ||
    value === 'imageGeneration' ||
    value === 'assets' ||
    value === 'automation' ||
    value === 'skills' ||
    value === 'preview'
  );
}

function normalizeActiveState(value: Partial<ActiveState> | null | undefined): ActiveState {
  return {
    projectId: typeof value?.projectId === 'string' ? value.projectId : null,
    chatSessionId: typeof value?.chatSessionId === 'string' ? value.chatSessionId : null,
    currentTab: isWorkspaceTab(value?.currentTab) ? value.currentTab : 'chat',
  };
}

function readStoredActiveState(): ActiveState {
  if (typeof window === 'undefined') {
    return DEFAULT_ACTIVE_STATE;
  }

  try {
    const raw = window.localStorage.getItem(ACTIVE_STATE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_ACTIVE_STATE;
    }

    const parsed = JSON.parse(raw) as unknown;
    const value =
      parsed && typeof parsed === 'object' && 'value' in parsed
        ? (parsed as { value?: Partial<ActiveState> }).value
        : (parsed as Partial<ActiveState>);
    return normalizeActiveState(value);
  } catch {
    return DEFAULT_ACTIVE_STATE;
  }
}

function persistActiveState(activeState: ActiveState) {
  if (typeof window === 'undefined') {
    return;
  }

  let userId: string | null = null;
  try {
    const rawSession = window.localStorage.getItem('woohoo-server-session-v1');
    if (rawSession) {
      const session = JSON.parse(rawSession) as { userId?: unknown };
      userId = typeof session.userId === 'string' ? session.userId : null;
    }
  } catch {
    userId = null;
  }

  window.localStorage.setItem(
    ACTIVE_STATE_STORAGE_KEY,
    JSON.stringify({
      userId,
      value: activeState,
    }),
  );
}

const initialActiveState = readStoredActiveState();

export type SendMessageResult = {
  mode: ExecutionMode;
  taskId?: string;
};

export type SendAiMessageOptions = {
  allowAssistantActions?: boolean;
  confirmedAssistantMessageId?: string;
  confirmedWorkflowGuardMessageId?: string;
  resourceRefs?: import('../types').ResourceRef[];
  attachments?: import('../types').MessageAttachment[];
  requireServerTask?: boolean;
  agentId?: string;
  triggerSource?: 'edit' | 'rewind' | 'normal';
  rewindFromMessageId?: string;
};

export interface AppStoreState {
  projects: Project[];
  globalChatMessages: Message[];
  assets: Asset[];
  scripts: Script[];
  storyboards: Storyboard[];
  activeState: ActiveState;
  activeAssets: Asset[];
  activeScript: Script | null;
  activeStoryboard: Storyboard | null;
  agentContacts: AgentContact[];
  allAgentContacts: AgentContact[];
  aiSettings: AiSettings;
  isAiConfigured: boolean;
  isAiResponding: boolean;
  isSidebarCollapsed: boolean;
  isSettingsOpen: boolean;
  isHelpOpen: boolean;
  isServerWorkspaceReady: boolean;
  workspaceBootstrapError: string | null;
  isAuthenticated: boolean;
  theme: 'dark' | 'light';
  language: string;
  autoSaveEnabled: boolean;
  serverAiEndpointId: string | null;
  pendingTaskCount: number;
  assetLibraryView: AssetLibraryViewState;

  /** 共享 SSE 实时任务数据（由 usePendingTaskSse 填充，供 PipelinePreview/AutomationArea 消费） */
  aiTasks: AiTask[];
  isSseConnected: boolean;
  sseError: string | null;

  /** 协同会话状态（由 SSE 协同事件填充） */
  activeCollaborationSession: CollaborationSession | null;
  activeCollaborationAssignments: CollaborationAssignment[];
  activeCollaborationMessages: CollaborationMessage[];
  collaborationLoopCheckResult: LoopCheckResponse | null;
  collaborationPendingQuestions: Array<{ agentId: string; question: string; fingerprint: string }>;

  // Actions
  setTheme: (theme: 'dark' | 'light') => void;
  setLanguage: (lang: string) => void;
  setAutoSaveEnabled: (enabled: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setIsAuthenticated: (auth: boolean) => void;
  setActiveProject: (projectId: string | null) => void;
  setActiveChat: (projectId: string, chatId: string) => void;
  switchTab: (tab: ActiveState['currentTab']) => void;
  setAssetLibraryView: (request: AssetLibraryViewRequest) => void;
  updateAiSettings: (settings: AiSettings) => void;
  setServerAiEndpointId: (endpointId: string | null) => void;
  setAiTasks: (tasks: AiTask[]) => void;
  setSseConnected: (connected: boolean) => void;
  setSseError: (error: string | null) => void;
  setCollaborationSession: (session: CollaborationSession | null) => void;
  setCollaborationAssignments: (assignments: CollaborationAssignment[]) => void;
  setCollaborationMessages: (messages: CollaborationMessage[]) => void;
  setCollaborationLoopCheckResult: (result: LoopCheckResponse | null) => void;
  setCollaborationPendingQuestions: (
    questions: Array<{ agentId: string; question: string; fingerprint: string }>,
  ) => void;
  clearCollaboration: () => void;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  projects: [],
  globalChatMessages: [],
  assets: [],
  scripts: [],
  storyboards: [],
  activeState: initialActiveState,
  activeAssets: [],
  activeScript: null,
  activeStoryboard: null,
  agentContacts: [],
  allAgentContacts: [],
  aiSettings: createAiSettings(),
  isAiConfigured: false,
  isAiResponding: false,
  isSidebarCollapsed: false,
  isSettingsOpen: false,
  isHelpOpen: false,
  isServerWorkspaceReady: false,
  workspaceBootstrapError: null,
  isAuthenticated: false,
  theme: 'dark',
  language: 'zh-CN',
  autoSaveEnabled: true,
  serverAiEndpointId: null,
  pendingTaskCount: 0,
  assetLibraryView: DEFAULT_ASSET_LIBRARY_VIEW_STATE,
  aiTasks: [],
  isSseConnected: false,
  sseError: null,
  activeCollaborationSession: null,
  activeCollaborationAssignments: [],
  activeCollaborationMessages: [],
  collaborationLoopCheckResult: null,
  collaborationPendingQuestions: [],

  setTheme: (theme) => set({ theme }),
  setLanguage: (language) => {
    set({ language });
    if (typeof window !== 'undefined') {
      localStorage.setItem('woohoo-lang', language);
    }
  },
  setAutoSaveEnabled: (autoSaveEnabled) => set({ autoSaveEnabled }),
  setSidebarCollapsed: (isSidebarCollapsed) => set({ isSidebarCollapsed }),
  setSettingsOpen: (isSettingsOpen) => set({ isSettingsOpen }),
  setHelpOpen: (isHelpOpen) => set({ isHelpOpen }),
  setIsAuthenticated: (isAuthenticated) => set({ isAuthenticated }),
  setActiveProject: (projectId) => {
    if (!projectId) {
      set((state) => ({
        activeState: (() => {
          const nextState: ActiveState = {
            ...state.activeState,
            projectId: null,
            chatSessionId: null,
            currentTab: 'chat',
          };
          persistActiveState(nextState);
          return nextState;
        })(),
      }));
      return;
    }

    const targetProject = get().projects.find((project) => project.id === projectId);
    set((state) => ({
      activeState: (() => {
        const nextState: ActiveState = {
          ...state.activeState,
          projectId,
          currentTab: state.activeState.currentTab === 'preview' ? 'chat' : state.activeState.currentTab,
          chatSessionId: targetProject?.chatSessions[0]?.id ?? null,
        };
        persistActiveState(nextState);
        return nextState;
      })(),
    }));
  },
  setActiveChat: (projectId, chatId) =>
    set((state) => ({
      activeState: (() => {
        const nextState: ActiveState = { ...state.activeState, projectId, chatSessionId: chatId, currentTab: 'chat' };
        persistActiveState(nextState);
        return nextState;
      })(),
    })),
  switchTab: (tab) =>
    set((state) => ({
      activeState: (() => {
        const nextState: ActiveState = { ...state.activeState, currentTab: tab };
        persistActiveState(nextState);
        return nextState;
      })(),
    })),
  setAssetLibraryView: (request) =>
    set((state) => ({
      assetLibraryView: normalizeAssetLibraryViewRequest(request, state.assetLibraryView),
    })),
  updateAiSettings: (settings) =>
    set((state) => {
      const nextSettings = normalizeAiSettingsPayload(settings);
      const keepSelectedEndpoint =
        Boolean(state.serverAiEndpointId) &&
        state.aiSettings.provider.trim().toLowerCase() === nextSettings.provider.trim().toLowerCase() &&
        normalizeAiBaseUrl(state.aiSettings.provider, state.aiSettings.baseUrl) ===
        normalizeAiBaseUrl(nextSettings.provider, nextSettings.baseUrl);

      return {
        aiSettings: nextSettings,
        serverAiEndpointId: keepSelectedEndpoint ? state.serverAiEndpointId : null,
      };
    }),
  setServerAiEndpointId: (serverAiEndpointId) => set({ serverAiEndpointId }),
  setAiTasks: (aiTasks) => set({ aiTasks }),
  setSseConnected: (isSseConnected) => set({ isSseConnected }),
  setSseError: (sseError) => set({ sseError }),
  setCollaborationSession: (activeCollaborationSession) => set({ activeCollaborationSession }),
  setCollaborationAssignments: (activeCollaborationAssignments) =>
    set({ activeCollaborationAssignments }),
  setCollaborationMessages: (activeCollaborationMessages) => set({ activeCollaborationMessages }),
  setCollaborationLoopCheckResult: (collaborationLoopCheckResult) =>
    set({ collaborationLoopCheckResult }),
  setCollaborationPendingQuestions: (collaborationPendingQuestions) =>
    set({ collaborationPendingQuestions }),
  clearCollaboration: () =>
    set({
      activeCollaborationSession: null,
      activeCollaborationAssignments: [],
      activeCollaborationMessages: [],
      collaborationLoopCheckResult: null,
      collaborationPendingQuestions: [],
    }),
}));
