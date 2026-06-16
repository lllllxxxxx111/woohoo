import { useEffect, type SetStateAction } from 'react';
import type {
  ActiveState,
  AgentContact,
  AiSettings,
  Asset,
  CollaborationAssignment,
  CollaborationSession,
  LoopCheckResponse,
  Message,
  Project,
  Script,
  Storyboard,
} from '../../types';
import {
  buildCollaborationStorageKey,
  type StoredCollaborationSnapshotMap,
} from '../utils/storageHelpers';

type WorkspaceStorageKeys = {
  projects: string;
  globalChatMessages: string;
  assets: string;
  scripts: string;
  storyboards: string;
  agents: string;
  activeState: string;
  theme: string;
  autoSave: string;
  aiSettings: string;
  aiEndpointId: string;
  collaborationSessions: string;
};

type UseWorkspacePersistenceOptions = {
  storageKeys: WorkspaceStorageKeys;
  projects: Project[];
  globalChatMessages: Message[];
  assets: Asset[];
  scripts: Script[];
  storyboards: Storyboard[];
  allAgentContacts: AgentContact[];
  activeState: ActiveState;
  activeCollaborationSession: CollaborationSession | null;
  activeCollaborationAssignments: CollaborationAssignment[];
  collaborationLoopCheckResult: LoopCheckResponse | null;
  theme: 'dark' | 'light';
  autoSaveEnabled: boolean;
  aiSettings: AiSettings;
  serverAiEndpointId: string | null;
  persistStorage: (key: string, value: unknown) => void;
  setActiveState: (updater: SetStateAction<ActiveState>) => void;
  sanitizeActiveState: (projects: Project[], state: ActiveState) => ActiveState;
};

export function useWorkspacePersistence({
  storageKeys,
  projects,
  globalChatMessages,
  assets,
  scripts,
  storyboards,
  allAgentContacts,
  activeState,
  activeCollaborationSession,
  activeCollaborationAssignments,
  collaborationLoopCheckResult,
  theme,
  autoSaveEnabled,
  aiSettings,
  serverAiEndpointId,
  persistStorage,
  setActiveState,
  sanitizeActiveState,
}: UseWorkspacePersistenceOptions) {
  useEffect(() => {
    if (!autoSaveEnabled) {
      return;
    }
    persistStorage(storageKeys.projects, projects);
  }, [autoSaveEnabled, persistStorage, projects, storageKeys.projects]);

  useEffect(() => {
    if (!autoSaveEnabled) {
      return;
    }
    persistStorage(storageKeys.globalChatMessages, globalChatMessages);
  }, [autoSaveEnabled, globalChatMessages, persistStorage, storageKeys.globalChatMessages]);

  useEffect(() => {
    if (!autoSaveEnabled) {
      return;
    }
    persistStorage(storageKeys.assets, assets);
  }, [autoSaveEnabled, assets, persistStorage, storageKeys.assets]);

  useEffect(() => {
    if (!autoSaveEnabled) {
      return;
    }
    persistStorage(storageKeys.scripts, scripts);
  }, [autoSaveEnabled, persistStorage, scripts, storageKeys.scripts]);

  useEffect(() => {
    if (!autoSaveEnabled) {
      return;
    }
    persistStorage(storageKeys.storyboards, storyboards);
  }, [autoSaveEnabled, persistStorage, storageKeys.storyboards, storyboards]);

  useEffect(() => {
    if (!autoSaveEnabled) {
      return;
    }
    persistStorage(storageKeys.agents, allAgentContacts);
  }, [autoSaveEnabled, allAgentContacts, persistStorage, storageKeys.agents]);

  useEffect(() => {
    if (!autoSaveEnabled) {
      return;
    }
    persistStorage(storageKeys.activeState, activeState);
  }, [autoSaveEnabled, activeState, persistStorage, storageKeys.activeState]);

  useEffect(() => {
    persistStorage(storageKeys.autoSave, autoSaveEnabled);
  }, [autoSaveEnabled, persistStorage, storageKeys.autoSave]);

  useEffect(() => {
    persistStorage(storageKeys.theme, theme);

    // Standard system theme classes
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(`theme-${theme}`);

    // Arco Design specific theme attribute
    if (theme === 'dark') {
      document.body.setAttribute('arco-theme', 'dark');
    } else {
      document.body.removeAttribute('arco-theme');
    }
  }, [persistStorage, storageKeys.theme, theme]);

  useEffect(() => {
    persistStorage(storageKeys.aiSettings, {
      ...aiSettings,
      apiKey: '',
    });
  }, [aiSettings, persistStorage, storageKeys.aiSettings]);

  useEffect(() => {
    persistStorage(storageKeys.aiEndpointId, serverAiEndpointId);
  }, [persistStorage, serverAiEndpointId, storageKeys.aiEndpointId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !activeCollaborationSession?.projectId || !activeCollaborationSession.conversationId) {
      return;
    }

    const storageKey = storageKeys.collaborationSessions;
    const conversationKey = buildCollaborationStorageKey(
      activeCollaborationSession.projectId,
      activeCollaborationSession.conversationId,
    );

    let nextSnapshotMap: StoredCollaborationSnapshotMap = {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          nextSnapshotMap = parsed as StoredCollaborationSnapshotMap;
        }
      }
    } catch {
      nextSnapshotMap = {};
    }

    nextSnapshotMap[conversationKey] = {
      session: activeCollaborationSession,
      assignments: activeCollaborationAssignments,
      loopCheckResult: collaborationLoopCheckResult,
    };
    persistStorage(storageKey, nextSnapshotMap);
  }, [
    activeCollaborationAssignments,
    activeCollaborationSession,
    collaborationLoopCheckResult,
    persistStorage,
    storageKeys.collaborationSessions,
  ]);

  useEffect(() => {
    setActiveState((prev) => {
      const sanitized = sanitizeActiveState(projects, prev);
      if (
        sanitized.projectId === prev.projectId &&
        sanitized.chatSessionId === prev.chatSessionId &&
        sanitized.currentTab === prev.currentTab
      ) {
        return prev;
      }
      return sanitized;
    });
  }, [projects, sanitizeActiveState, setActiveState]);
}
