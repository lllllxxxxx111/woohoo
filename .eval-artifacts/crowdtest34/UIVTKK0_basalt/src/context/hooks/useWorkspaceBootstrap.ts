import { useEffect, type SetStateAction } from 'react';
import { bootstrapWorkspace } from '../../lib/serverApi';
import { logger } from '../../lib/logger';
import type { AgentContact, Asset, Project, Script, Storyboard } from '../../types';

type UseWorkspaceBootstrapOptions = {
  setProjects: (updater: SetStateAction<Project[]>) => void;
  setAssets: (updater: SetStateAction<Asset[]>) => void;
  setScripts: (updater: SetStateAction<Script[]>) => void;
  setStoryboards: (updater: SetStateAction<Storyboard[]>) => void;
  setAllAgentContacts: (updater: SetStateAction<AgentContact[]>) => void;
  setIsAuthenticated: (updater: SetStateAction<boolean>) => void;
  setIsServerWorkspaceReady: (updater: SetStateAction<boolean>) => void;
  setWorkspaceBootstrapError: (updater: SetStateAction<string | null>) => void;
  defaultAgents: AgentContact[];
  isUnauthorizedError: (error: unknown) => boolean;
  recoverPendingTasksFromProjects: (projects: Project[]) => number;
};

export function useWorkspaceBootstrap({
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
}: UseWorkspaceBootstrapOptions) {
  useEffect(() => {
    let cancelled = false;

    const syncWorkspace = async () => {
      try {
        const workspace = await bootstrapWorkspace();
        if (cancelled) {
          return;
        }

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
        setWorkspaceBootstrapError(null);
        setIsAuthenticated(true);
        setIsServerWorkspaceReady(true);
      } catch (error) {
        if (isUnauthorizedError(error)) {
          setWorkspaceBootstrapError(null);
          setIsAuthenticated(false);
          setIsServerWorkspaceReady(true); // Stop loading, show auth modal
        } else {
          logger.error('Failed to bootstrap workspace from server', error);
          const errorMessage = error instanceof Error ? error.message : '服务端初始化失败';
          setWorkspaceBootstrapError(errorMessage || '服务端初始化失败');
          setIsServerWorkspaceReady(true); // Allow rendering fallback even if other errors
        }
      }
    };

    void syncWorkspace();
    window.addEventListener('woohoo:server-session-updated', syncWorkspace);

    return () => {
      cancelled = true;
      window.removeEventListener('woohoo:server-session-updated', syncWorkspace);
    };
  }, [
    defaultAgents,
    isUnauthorizedError,
    setProjects,
    setAssets,
    setScripts,
    setStoryboards,
    setAllAgentContacts,
    setIsAuthenticated,
    setIsServerWorkspaceReady,
    setWorkspaceBootstrapError,
    recoverPendingTasksFromProjects,
  ]);
}
