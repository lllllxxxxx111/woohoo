import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useAppStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import type {
  ActiveState,
  AgentContact,
  AiSettings,
  Asset,
  Message,
  Project,
  Script,
  Storyboard,
} from '../types';
import { AI_PROVIDER_PRESETS, hydrateAiSettings, isAiSettingsReady } from '../lib/ai';
import {
  bootstrapWorkspace,
  createServerConversation,
  createServerProject,
  deleteServerConversation,
  deleteServerProject,
  listServerAiEndpoints,
  updateServerProject,
} from '../lib/serverApi';
import { logger } from '../lib/logger';
import {
  createEmptyWorkflowSummary,
  createLocalChat,
  createLocalProject,
  getChatSession,
  isUnauthorizedError,
  sanitizeActiveState,
  selectAiEndpointForSettings,
} from './utils/appContextHelpers';
import {
  hydrateTheme,
  loadStorage,
  persistStorage,
  resolveStateUpdate,
  STORAGE_KEYS,
  stripSensitiveAiSettings,
} from './utils/storageHelpers';
import { usePendingTaskSse } from './hooks/usePendingTaskSse';
import { useChatWorkspaceActions } from './hooks/useChatWorkspaceActions';
import { useAiMessageRuntime } from './hooks/useAiMessageRuntime';
import { usePendingTaskRegistry } from './hooks/usePendingTaskRegistry';
import { useWorkspaceBootstrap } from './hooks/useWorkspaceBootstrap';
import { useWorkspacePersistence } from './hooks/useWorkspacePersistence';
import { defaultAgents } from '../config/defaultAgents';
import { type AppActions, AppActionsContext } from './appActionsContext';

type WorkspaceBootstrapPayload = Awaited<ReturnType<typeof bootstrapWorkspace>>;

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const {
    projects,
    globalChatMessages,
    assets,
    scripts,
    storyboards,
    allAgentContacts,
    activeState,
    isAuthenticated,
    theme,
    autoSaveEnabled,
    aiSettings,
    serverAiEndpointId,
    isServerWorkspaceReady,
    pendingTaskCount,
    activeCollaborationSession,
    activeCollaborationAssignments,
    collaborationLoopCheckResult,
  } = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      globalChatMessages: state.globalChatMessages,
      assets: state.assets,
      scripts: state.scripts,
      storyboards: state.storyboards,
      allAgentContacts: state.allAgentContacts,
      activeState: state.activeState,
      isAuthenticated: state.isAuthenticated,
      theme: state.theme,
      autoSaveEnabled: state.autoSaveEnabled,
      aiSettings: state.aiSettings,
      serverAiEndpointId: state.serverAiEndpointId,
      isServerWorkspaceReady: state.isServerWorkspaceReady,
      pendingTaskCount: state.pendingTaskCount,
      activeCollaborationSession: state.activeCollaborationSession,
      activeCollaborationAssignments: state.activeCollaborationAssignments,
      collaborationLoopCheckResult: state.collaborationLoopCheckResult,
    })),
  );

  const setProjects = useCallback((updater: SetStateAction<Project[]>) => {
    useAppStore.setState((state) => ({
      projects: resolveStateUpdate(updater, state.projects),
    }));
  }, []);

  const setGlobalChatMessages = useCallback((updater: SetStateAction<Message[]>) => {
    useAppStore.setState((state) => ({
      globalChatMessages: resolveStateUpdate(updater, state.globalChatMessages),
    }));
  }, []);

  const setAssets = useCallback((updater: SetStateAction<Asset[]>) => {
    useAppStore.setState((state) => {
      const nextAssets = resolveStateUpdate(updater, state.assets);
      return {
        assets: nextAssets,
        activeAssets: nextAssets.filter((asset) => asset.projectId === state.activeState.projectId),
      };
    });
  }, []);

  const setScripts = useCallback((updater: SetStateAction<Script[]>) => {
    useAppStore.setState((state) => ({
      scripts: resolveStateUpdate(updater, state.scripts),
    }));
  }, []);

  const setStoryboards = useCallback((updater: SetStateAction<Storyboard[]>) => {
    useAppStore.setState((state) => ({
      storyboards: resolveStateUpdate(updater, state.storyboards),
    }));
  }, []);

  const setAllAgentContacts = useCallback((updater: SetStateAction<AgentContact[]>) => {
    useAppStore.setState((state) => ({
      allAgentContacts: resolveStateUpdate(updater, state.allAgentContacts),
    }));
  }, []);

  const setActiveState = useCallback((updater: SetStateAction<ActiveState>) => {
    useAppStore.setState((state) => ({
      activeState: resolveStateUpdate(updater, state.activeState),
    }));
  }, []);

  const setIsAuthenticated = useCallback((updater: SetStateAction<boolean>) => {
    useAppStore.setState((state) => ({
      isAuthenticated: resolveStateUpdate(updater, state.isAuthenticated),
    }));
  }, []);

  const setServerAiEndpointId = useCallback((updater: SetStateAction<string | null>) => {
    useAppStore.setState((state) => ({
      serverAiEndpointId: resolveStateUpdate(updater, state.serverAiEndpointId),
    }));
  }, []);

  const setIsServerWorkspaceReady = useCallback((updater: SetStateAction<boolean>) => {
    useAppStore.setState((state) => ({
      isServerWorkspaceReady: resolveStateUpdate(updater, state.isServerWorkspaceReady),
    }));
  }, []);

  const setWorkspaceBootstrapError = useCallback((updater: SetStateAction<string | null>) => {
    useAppStore.setState((state) => ({
      workspaceBootstrapError: resolveStateUpdate(updater, state.workspaceBootstrapError),
    }));
  }, []);

  const setPendingTaskCount = useCallback((updater: SetStateAction<number>) => {
    useAppStore.setState((state) => {
      const nextValue = resolveStateUpdate(updater, state.pendingTaskCount);
      if (nextValue === state.pendingTaskCount) {
        return state;
      }

      return {
        pendingTaskCount: nextValue,
      };
    });
  }, []);

  const {
    pendingTaskMapRef,
    registerPendingTask,
    clearPendingTasksByConversation,
    clearPendingTasksByPlaceholderIds,
    recoverPendingTasksFromProjects,
    syncPendingTaskCount,
  } = usePendingTaskRegistry({
    setPendingTaskCount,
  });

  const hasHydratedStoreRef = useRef(false);
  useEffect(() => {
    if (hasHydratedStoreRef.current) {
      return;
    }

    try {
      const storedProjects = loadStorage<Project[]>(STORAGE_KEYS.projects, []);
      const storedActiveState = loadStorage<ActiveState>(STORAGE_KEYS.activeState, {
        projectId: storedProjects[0]?.id ?? null,
        chatSessionId: storedProjects[0]?.chatSessions[0]?.id ?? null,
        currentTab: 'chat',
      });

      useAppStore.setState({
        projects: storedProjects,
        globalChatMessages: loadStorage<Message[]>(STORAGE_KEYS.globalChatMessages, []),
        assets: loadStorage<Asset[]>(STORAGE_KEYS.assets, []),
        scripts: loadStorage<Script[]>(STORAGE_KEYS.scripts, []),
        storyboards: loadStorage<Storyboard[]>(STORAGE_KEYS.storyboards, []),
        allAgentContacts: loadStorage<AgentContact[]>(STORAGE_KEYS.agents, defaultAgents),
        activeState: sanitizeActiveState(storedProjects, storedActiveState),
        isSidebarCollapsed: typeof window !== 'undefined' && window.innerWidth <= 920,
        isSettingsOpen: false,
        isHelpOpen: false,
        isAuthenticated: false,
        language:
          typeof window !== 'undefined' ? localStorage.getItem('woohoo-lang') || 'zh-CN' : 'zh-CN',
        theme: hydrateTheme(loadStorage(STORAGE_KEYS.theme, 'dark')),
        autoSaveEnabled: loadStorage<boolean>(STORAGE_KEYS.autoSave, true),
        aiSettings: hydrateAiSettings(
          stripSensitiveAiSettings(
            loadStorage<Partial<AiSettings> | null>(STORAGE_KEYS.aiSettings, null),
          ),
        ),
        serverAiEndpointId: loadStorage<string | null>(STORAGE_KEYS.aiEndpointId, null),
        isServerWorkspaceReady: false,
        workspaceBootstrapError: null,
        pendingTaskCount: 0,
      });

      hasHydratedStoreRef.current = true;
    } catch (error) {
      logger.error('Store hydration failed, will retry on next mount', error);
    }
  }, []);

  useEffect(() => {
    // We do a one-time mount pass to recover any tasks that were pending when the browser was closed
    recoverPendingTasksFromProjects(useAppStore.getState().projects);
  }, [recoverPendingTasksFromProjects]);

  const activeAssets = assets.filter((asset) => asset.projectId === activeState.projectId);
  const activeScript = scripts.find((script) => script.projectId === activeState.projectId) || null;
  const activeStoryboard =
    storyboards.find((storyboard) => storyboard.projectId === activeState.projectId) || null;
  const isAiConfigured =
    isAiSettingsReady(aiSettings) ||
    (isServerWorkspaceReady &&
      Boolean(serverAiEndpointId) &&
      Boolean(aiSettings.baseUrl.trim()) &&
      Boolean(aiSettings.model.trim()));
  const activeProject = projects.find((project) => project.id === activeState.projectId);
  const recoverableAiSettings = aiSettings;

  /** 稳定化项目级智能体列表引用，避免子组件频繁重渲染 */
  const projectScopedAgents = useMemo(
    () =>
      activeProject?.agentRoster ?? (allAgentContacts.length ? allAgentContacts : defaultAgents),
    [activeProject?.agentRoster, allAgentContacts],
  );
  const activeChat =
    activeState.projectId && activeState.chatSessionId
      ? getChatSession(projects, activeState.projectId, activeState.chatSessionId)
      : undefined;
  const activeMessages = activeState.projectId ? (activeChat?.messages ?? []) : globalChatMessages;
  const isAiResponding = Boolean(activeMessages.some((message) => message.status === 'pending'));

  useWorkspaceBootstrap({
    setProjects,
    setAssets,
    setScripts,
    setStoryboards,
    setAllAgentContacts,
    setIsAuthenticated,
    setIsServerWorkspaceReady,
    setWorkspaceBootstrapError,
    defaultAgents,
    isUnauthorizedError,
    recoverPendingTasksFromProjects,
  });

  useWorkspacePersistence({
    storageKeys: STORAGE_KEYS,
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
  });

  useEffect(() => {
    const providerPreset = AI_PROVIDER_PRESETS[recoverableAiSettings.provider];
    const canRecoverServerManagedKey =
      isServerWorkspaceReady &&
      !serverAiEndpointId &&
      Boolean(providerPreset?.requiresApiKey) &&
      !recoverableAiSettings.apiKey.trim() &&
      Boolean(recoverableAiSettings.baseUrl.trim()) &&
      Boolean(recoverableAiSettings.model.trim());

    if (!canRecoverServerManagedKey) {
      return;
    }

    let cancelled = false;

    const recoverEndpointBinding = async () => {
      try {
        const endpoints = await listServerAiEndpoints();
        if (cancelled) {
          return;
        }

        const matched = selectAiEndpointForSettings(endpoints, recoverableAiSettings);
        if (matched) {
          setServerAiEndpointId(matched.id);
        }
      } catch (error) {
        logger.warn('[AppContext] Failed to recover server endpoint binding', error);
      }
    };

    void recoverEndpointBinding();
    return () => {
      cancelled = true;
    };
  }, [isServerWorkspaceReady, recoverableAiSettings, serverAiEndpointId, setServerAiEndpointId]);

  const createProject = useCallback(
    async (name: string) => {
      const nextName = name.trim() || '新项目';
      const createdFromGlobalChat = !activeState.projectId;

      try {
        const project = await createServerProject(nextName);
        const hydratedProject: Project = {
          ...project,
          agentRoster: allAgentContacts,
          workflow: {
            ...createEmptyWorkflowSummary(),
            assignedAgentCount: allAgentContacts.length,
          },
        };
        setIsServerWorkspaceReady(true);
        setProjects((prev) => [hydratedProject, ...prev]);
        if (createdFromGlobalChat) {
          setGlobalChatMessages([]);
        }
        return hydratedProject;
      } catch (error) {
        logger.error('Failed to create project on server', error);
        const project = {
          ...createLocalProject(nextName),
          agentRoster: allAgentContacts,
          workflow: {
            ...createEmptyWorkflowSummary(),
            assignedAgentCount: allAgentContacts.length,
          },
        };
        setIsServerWorkspaceReady(true);
        setProjects((prev) => [project, ...prev]);
        if (createdFromGlobalChat) {
          setGlobalChatMessages([]);
        }
        return project;
      }
    },
    [
      activeState.projectId,
      allAgentContacts,
      setGlobalChatMessages,
      setIsServerWorkspaceReady,
      setProjects,
    ],
  );

  const updateProject = useCallback(
    async (projectId: string, name: string) => {
      try {
        const updated = await updateServerProject(projectId, name);
        setIsServerWorkspaceReady(true);
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId ? { ...project, name: updated.name } : project,
          ),
        );
        return updated;
      } catch (error) {
        logger.error('Failed to update project on server', error);
        let fallbackProject: Project | undefined;
        setProjects((prev) => {
          const updated = prev.map((project) =>
            project.id === projectId ? { ...project, name } : project,
          );
          fallbackProject = updated.find((p) => p.id === projectId);
          return updated;
        });
        if (!fallbackProject) {
          throw new Error(`Project ${projectId} not found for local fallback`);
        }
        return { ...fallbackProject, name } as Project;
      }
    },
    [setIsServerWorkspaceReady, setProjects],
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      try {
        await deleteServerProject(projectId);
      } catch (error) {
        logger.error('Failed to delete project on server', error);
      }

      setProjects((prev) => prev.filter((project) => project.id !== projectId));

      setActiveState((prev) => {
        if (prev.projectId !== projectId) {
          return prev;
        }
        const fallbackProject = projects.find((p) => p.id !== projectId);
        return {
          ...prev,
          projectId: fallbackProject?.id ?? null,
          chatSessionId: fallbackProject?.chatSessions[0]?.id ?? null,
        };
      });
    },
    [projects, setActiveState, setProjects],
  );

  const createChatInProject = useCallback(
    async (projectId: string, title = '新对话') => {
      try {
        const session = await createServerConversation(projectId, title);
        setIsServerWorkspaceReady(true);
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId
              ? { ...project, chatSessions: [session, ...project.chatSessions] }
              : project,
          ),
        );
        setActiveState({ projectId, chatSessionId: session.id, currentTab: 'chat' });
        return session;
      } catch (error) {
        logger.error('Failed to create conversation on server', error);
        const session = createLocalChat(projectId, title);
        setIsServerWorkspaceReady(true);
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId
              ? { ...project, chatSessions: [session, ...project.chatSessions] }
              : project,
          ),
        );
        setActiveState({ projectId, chatSessionId: session.id, currentTab: 'chat' });
        return session;
      }
    },
    [setActiveState, setIsServerWorkspaceReady, setProjects],
  );

  const deleteChatInProject = useCallback(
    async (projectId: string, chatId: string) => {
      try {
        await deleteServerConversation(chatId);
      } catch (error) {
        logger.error('Failed to delete conversation on server', error);
      }

      setProjects((prev) =>
        prev.map((project) =>
          project.id !== projectId
            ? project
            : {
              ...project,
              chatSessions: project.chatSessions.filter((chat) => chat.id !== chatId),
            },
        ),
      );

      setActiveState((prev) => {
        if (prev.projectId !== projectId || prev.chatSessionId !== chatId) {
          return prev;
        }

        const targetProject = projects.find((project) => project.id === projectId);
        const fallbackChatId =
          targetProject?.chatSessions.find((chat) => chat.id !== chatId)?.id ?? null;
        return {
          ...prev,
          chatSessionId: fallbackChatId,
        };
      });
    },
    [projects, setActiveState, setProjects],
  );

  const refreshWorkspaceWithRetries = useCallback(
    async (reason: string, maxAttempts = 3): Promise<WorkspaceBootstrapPayload | null> => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const workspace = await bootstrapWorkspace(true);
          setProjects(workspace.projects);
          setAssets(workspace.assets);
          setScripts(workspace.scripts);
          setStoryboards(workspace.storyboards);
          recoverPendingTasksFromProjects(workspace.projects);
          setAllAgentContacts(
            Array.isArray(workspace.agents) && workspace.agents.length > 0
              ? workspace.agents
              : defaultAgents,
          );
          setIsServerWorkspaceReady(true);
          return workspace;
        } catch (error) {
          if (attempt >= maxAttempts) {
            logger.error(`Failed to refresh workspace after ${reason}`, error);
            return null;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
      }

      return null;
    },
    [
      setProjects,
      setAssets,
      setScripts,
      setStoryboards,
      setAllAgentContacts,
      setIsServerWorkspaceReady,
      recoverPendingTasksFromProjects,
    ],
  );

  const {
    rewindChatToMessage,
    updateMessageInChat,
    appendMessageLocally,
    updateMessageIdLocally,
    addMessage,
    appendGlobalMessageLocally,
    updateGlobalMessageLocally,
    updateMessageLocally,
    removeMessageLocally,
    deleteMessageInChat,
    uploadAssets,
    updateAsset,
    deleteAsset,
    saveScript,
    saveStoryboard,
  } = useChatWorkspaceActions({
    projects,
    globalChatMessages,
    allAgentContacts,
    assets,
    scripts,
    storyboards,
    isServerWorkspaceReady,
    setProjects,
    setGlobalChatMessages,
    setAssets,
    setScripts,
    setStoryboards,
    setActiveState,
    clearPendingTasksByConversation,
    clearPendingTasksByPlaceholderIds,
    refreshWorkspaceWithRetries,
  });

  const refreshWorkspaceAfterTaskCompletion = useCallback(async () => {
    await refreshWorkspaceWithRetries('task completion');
  }, [refreshWorkspaceWithRetries]);

  const refreshWorkspace = useCallback(
    async (reason = 'manual refresh', maxAttempts = 3) => {
      return refreshWorkspaceWithRetries(reason, maxAttempts);
    },
    [refreshWorkspaceWithRetries],
  );

  const markUnauthenticated = useCallback(() => {
    setIsAuthenticated(false);
  }, [setIsAuthenticated]);

  usePendingTaskSse({
    isServerWorkspaceReady,
    isAuthenticated,
    pendingTaskCount,
    pendingTaskMapRef,
    syncPendingTaskCount,
    updateMessageLocally,
    refreshWorkspaceAfterTaskCompletion,
    markUnauthenticated,
  });

  const { sendAiMessage, suggestProjectName } = useAiMessageRuntime({
    aiSettings,
    isAiConfigured,
    isServerWorkspaceReady,
    serverAiEndpointId,
    activeState,
    activeChat,
    projects,
    assets,
    globalChatMessages,
    projectScopedAgents,
    allAgentContacts,
    defaultAgents,
    setServerAiEndpointId,
    createChatInProject,
    appendMessageLocally,
    appendGlobalMessageLocally,
    updateGlobalMessageLocally,
    updateMessageLocally,
    replaceMessageIdLocally: updateMessageIdLocally,
    removeMessageLocally,
    registerPendingTask,
  });

  useLayoutEffect(() => {
    useAppStore.setState({
      activeAssets,
      activeScript,
      activeStoryboard,
      agentContacts: projectScopedAgents,
      isAiConfigured,
      isAiResponding,
    });
  }, [
    activeAssets,
    activeScript,
    activeStoryboard,
    projectScopedAgents,
    isAiConfigured,
    isAiResponding,
  ]);

  const actions = useMemo<AppActions>(
    () => ({
      createProject,
      updateProject,
      deleteProject,
      createChatInProject,
      deleteChatInProject,
      deleteMessageInChat,
      rewindChatToMessage,
      updateMessageInChat,
      addMessage,
      uploadAssets,
      updateAsset,
      deleteAsset,
      saveScript,
      saveStoryboard,
      refreshWorkspace,
      suggestProjectName,
      sendAiMessage,
    }),
    [
      createProject,
      updateProject,
      deleteProject,
      createChatInProject,
      deleteChatInProject,
      deleteMessageInChat,
      rewindChatToMessage,
      updateMessageInChat,
      addMessage,
      uploadAssets,
      updateAsset,
      deleteAsset,
      saveScript,
      saveStoryboard,
      refreshWorkspace,
      suggestProjectName,
      sendAiMessage,
    ],
  );

  return <AppActionsContext.Provider value={actions}>{children}</AppActionsContext.Provider>;
};
