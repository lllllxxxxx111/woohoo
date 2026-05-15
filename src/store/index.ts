import { create } from 'zustand';
import { createAiSettings, normalizeAiSettingsPayload } from '../lib/ai';
import type {
  ActiveState,
  AgentContact,
  AiSettings,
  Asset,
  CollaborationSession,
  CollaborationAssignment,
  LoopCheckResponse,
  Message,
  Project,
  Script,
  Storyboard,
} from '../types';
import type { AiTask } from '../lib/serverApi';

type ExecutionMode = 'task' | 'sync' | 'direct';

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

  /** 共享 SSE 实时任务数据（由 usePendingTaskSse 填充，供 PipelinePreview/AutomationArea 消费） */
  aiTasks: AiTask[];
  isSseConnected: boolean;
  sseError: string | null;

  /** 协同会话状态（由 SSE 协同事件填充） */
  activeCollaborationSession: CollaborationSession | null;
  activeCollaborationAssignments: CollaborationAssignment[];
  collaborationLoopCheckResult: LoopCheckResponse | null;

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
  updateAiSettings: (settings: AiSettings) => void;
  setAiTasks: (tasks: AiTask[]) => void;
  setSseConnected: (connected: boolean) => void;
  setSseError: (error: string | null) => void;
  setCollaborationSession: (session: CollaborationSession | null) => void;
  setCollaborationAssignments: (assignments: CollaborationAssignment[]) => void;
  setCollaborationLoopCheckResult: (result: LoopCheckResponse | null) => void;
  clearCollaboration: () => void;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  projects: [],
  globalChatMessages: [],
  assets: [],
  scripts: [],
  storyboards: [],
  activeState: { projectId: null, chatSessionId: null, currentTab: 'chat' },
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
  aiTasks: [],
  isSseConnected: false,
  sseError: null,
  activeCollaborationSession: null,
  activeCollaborationAssignments: [],
  collaborationLoopCheckResult: null,

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
        activeState: {
          ...state.activeState,
          projectId: null,
          chatSessionId: null,
          currentTab: 'chat',
        },
      }));
      return;
    }

    const targetProject = get().projects.find((project) => project.id === projectId);
    set((state) => ({
      activeState: {
        ...state.activeState,
        projectId,
        currentTab: 'chat',
        chatSessionId: targetProject?.chatSessions[0]?.id ?? null,
      },
    }));
  },
  setActiveChat: (projectId, chatId) =>
    set((state) => ({
      activeState: { ...state.activeState, projectId, chatSessionId: chatId, currentTab: 'chat' },
    })),
  switchTab: (tab) =>
    set((state) => ({
      activeState: { ...state.activeState, currentTab: tab },
    })),
  updateAiSettings: (settings) =>
    set({
      aiSettings: normalizeAiSettingsPayload(settings),
      serverAiEndpointId: null,
    }),
  setAiTasks: (aiTasks) => set({ aiTasks }),
  setSseConnected: (isSseConnected) => set({ isSseConnected }),
  setSseError: (sseError) => set({ sseError }),
  setCollaborationSession: (activeCollaborationSession) => set({ activeCollaborationSession }),
  setCollaborationAssignments: (activeCollaborationAssignments) => set({ activeCollaborationAssignments }),
  setCollaborationLoopCheckResult: (collaborationLoopCheckResult) => set({ collaborationLoopCheckResult }),
  clearCollaboration: () => set({ activeCollaborationSession: null, activeCollaborationAssignments: [], collaborationLoopCheckResult: null }),
}));
