import { useCallback, type SetStateAction } from 'react';
import {
  createServerMessage,
  deleteServerAsset,
  deleteServerMessage,
  getServerAssetReferences,
  rewindServerConversation,
  searchServerAssets,
  updateServerConversation,
  updateServerAsset,
  updateServerMessage,
  uploadServerAsset,
  upsertServerScript,
  upsertServerStoryboard,
} from '../../lib/serverApi';
import { logger } from '../../lib/logger';
import type {
  ActiveState,
  AgentContact,
  Asset,
  AssetReference,
  AssetSearchParams,
  AssetSearchResponse,
  Message,
  Project,
  Script,
  Storyboard,
} from '../../types';
import {
  createEmptyWorkflowSummary,
  createLocalScript,
  createLocalStoryboard,
  deriveScriptTitle,
  getChatSession,
  trimChatTitle,
} from '../utils/appContextHelpers';

type UseChatWorkspaceActionsOptions = {
  projects: Project[];
  globalChatMessages: Message[];
  allAgentContacts: AgentContact[];
  assets: Asset[];
  scripts: Script[];
  storyboards: Storyboard[];
  isServerWorkspaceReady: boolean;
  setProjects: (updater: (prev: Project[]) => Project[]) => void;
  setGlobalChatMessages: (updater: (prev: Message[]) => Message[]) => void;
  setAssets: (updater: (prev: Asset[]) => Asset[]) => void;
  setScripts: (updater: (prev: Script[]) => Script[]) => void;
  setStoryboards: (updater: (prev: Storyboard[]) => Storyboard[]) => void;
  setActiveState: (updater: SetStateAction<ActiveState>) => void;
  clearPendingTasksByConversation: (conversationId: string) => void;
  clearPendingTasksByPlaceholderIds: (
    conversationId: string,
    placeholderMessageIds: Set<string>,
  ) => void;
  refreshWorkspaceWithRetries: (reason: string, maxAttempts?: number) => Promise<unknown>;
};

export function useChatWorkspaceActions({
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
}: UseChatWorkspaceActionsOptions) {
  const rewindChatLocally = useCallback(
    (projectId: string, chatId: string, messageId: string) => {
      setProjects((prev) =>
        prev.map((project) =>
          project.id !== projectId
            ? project
            : {
                ...project,
                chatSessions: project.chatSessions.map((session) => {
                  if (session.id !== chatId) {
                    return session;
                  }
                  const anchorIndex = session.messages.findIndex(
                    (message) => message.id === messageId,
                  );
                  if (anchorIndex < 0) {
                    return session;
                  }
                  return {
                    ...session,
                    messages: session.messages.slice(0, anchorIndex + 1),
                    updatedAt: Date.now(),
                  };
                }),
              },
        ),
      );
    },
    [setProjects],
  );

  const updateMessageIdLocally = useCallback(
    (
      projectId: string | null,
      chatId: string | null,
      tempMessageId: string,
      persistedMessageId: string,
    ) => {
      if (
        !projectId ||
        !chatId ||
        !tempMessageId ||
        !persistedMessageId ||
        tempMessageId === persistedMessageId
      ) {
        return;
      }

      setProjects((prev) => {
        const projectIndex = prev.findIndex((project) => project.id === projectId);
        if (projectIndex === -1) return prev;

        const project = prev[projectIndex];
        const chatIndex = project.chatSessions.findIndex((session) => session.id === chatId);
        if (chatIndex === -1) return prev;

        const chat = project.chatSessions[chatIndex];
        let changed = false;
        const nextMessages = chat.messages.map((item) => {
          if (item.id !== tempMessageId) {
            return item;
          }
          changed = true;
          return { ...item, id: persistedMessageId };
        });

        if (!changed) {
          return prev;
        }

        const nextChat = { ...chat, messages: nextMessages };
        const nextChatSessions = [...project.chatSessions];
        nextChatSessions[chatIndex] = nextChat;

        const nextProject = { ...project, chatSessions: nextChatSessions };
        const nextProjects = [...prev];
        nextProjects[projectIndex] = nextProject;
        return nextProjects;
      });
    },
    [setProjects],
  );

  const findServerMessageMatch = useCallback(
    (sessionMessages: Message[], localMessage?: Message, fallbackMessageId?: string) => {
      const normalizedFallbackId = fallbackMessageId?.trim();
      if (normalizedFallbackId) {
        const exactMatch = sessionMessages.find((message) => message.id === normalizedFallbackId);
        if (exactMatch) {
          return exactMatch;
        }
      }

      if (!localMessage) {
        return undefined;
      }

      const localContent = localMessage.content.trim();
      const localRole = localMessage.role;
      const localType = localMessage.type || 'text';
      const localAgentId = localMessage.agentId || '';

      const candidates = sessionMessages.filter((message) => {
        if (message.role !== localRole) {
          return false;
        }
        if ((message.type || 'text') !== localType) {
          return false;
        }
        if ((message.agentId || '') !== localAgentId) {
          return false;
        }
        return message.content.trim() === localContent;
      });

      if (candidates.length <= 1) {
        return candidates[0];
      }

      return [...candidates].sort(
        (left, right) =>
          Math.abs(left.timestamp - localMessage.timestamp) -
          Math.abs(right.timestamp - localMessage.timestamp),
      )[0];
    },
    [],
  );

  const rewindChatToMessage = useCallback(
    async (projectId: string, chatId: string, messageId: string, assetsOnly = false) => {
      const anchorMessageId = messageId.trim();
      if (!anchorMessageId) {
        return;
      }
      const localAnchorMessage =
        getChatSession(projects, projectId, chatId)?.messages.find(
          (message) => message.id === anchorMessageId,
        ) ?? undefined;

      if (!isServerWorkspaceReady) {
        rewindChatLocally(projectId, chatId, anchorMessageId);
        return;
      }

      clearPendingTasksByConversation(chatId);

      try {
        await rewindServerConversation(chatId, anchorMessageId, assetsOnly);
        await refreshWorkspaceWithRetries('conversation rewind');
      } catch (error) {
        const errorText = error instanceof Error ? error.message : '';
        const isNotFoundLikeError =
          errorText.includes('消息不存在') || errorText.includes('not found');

        if (isNotFoundLikeError) {
          const workspace = (await refreshWorkspaceWithRetries(
            'message ID sync before rewind',
          )) as { projects: Project[] } | null;
          if (workspace) {
            const sessionMessages =
              getChatSession(workspace.projects, projectId, chatId)?.messages ?? [];
            const serverMessage = findServerMessageMatch(
              sessionMessages,
              localAnchorMessage,
              anchorMessageId,
            );
            if (serverMessage) {
              updateMessageIdLocally(projectId, chatId, anchorMessageId, serverMessage.id);
              await rewindServerConversation(chatId, serverMessage.id, assetsOnly);
              await refreshWorkspaceWithRetries('conversation rewind retry');
              return;
            }
          }
        }

        throw error;
      }
    },
    [
      isServerWorkspaceReady,
      projects,
      rewindChatLocally,
      clearPendingTasksByConversation,
      refreshWorkspaceWithRetries,
      findServerMessageMatch,
      updateMessageIdLocally,
    ],
  );

  const appendMessageLocally = useCallback(
    (projectId: string | null, chatId: string | null, message: Message) => {
      if (!projectId || !chatId) {
        return null;
      }

      const sessionSnapshot = getChatSession(projects, projectId, chatId);
      const nextTitle =
        message.role === 'user' &&
        (!sessionSnapshot ||
          (sessionSnapshot.messages.length === 0 && sessionSnapshot.title === '新对话'))
          ? trimChatTitle(message.content)
          : null;

      setProjects((prev) => {
        const fallbackTitle = nextTitle ?? sessionSnapshot?.title ?? '新对话';
        let matchedProject = false;

        const nextProjects = prev.map((project) => {
          if (project.id !== projectId) {
            return project;
          }

          matchedProject = true;
          const chatIndex = project.chatSessions.findIndex((session) => session.id === chatId);

          if (chatIndex === -1) {
            return {
              ...project,
              chatSessions: [
                {
                  id: chatId,
                  projectId,
                  title: fallbackTitle,
                  messages: [message],
                  updatedAt: message.timestamp,
                },
                ...project.chatSessions,
              ],
            };
          }

          return {
            ...project,
            chatSessions: project.chatSessions.map((session) => {
              if (session.id !== chatId) {
                return session;
              }

              return {
                ...session,
                title: nextTitle ?? session.title,
                messages: [...session.messages, message],
                updatedAt: message.timestamp,
              };
            }),
          };
        });

        if (matchedProject) {
          return nextProjects;
        }

        return [
          {
            id: projectId,
            name: '新项目',
            status: 'draft',
            phase: 'ideation',
            chatSessions: [
              {
                id: chatId,
                projectId,
                title: fallbackTitle,
                messages: [message],
                updatedAt: message.timestamp,
              },
            ],
            agentRoster: allAgentContacts,
            workflow: createEmptyWorkflowSummary(),
            assetsCount: 0,
            createdAt: message.timestamp,
          },
          ...nextProjects,
        ];
      });
      setActiveState((prev) => ({
        ...prev,
        projectId,
        chatSessionId: chatId,
        currentTab: 'chat',
      }));

      return nextTitle;
    },
    [projects, setProjects, allAgentContacts, setActiveState],
  );

  const addMessage = useCallback(
    (projectId: string | null, chatId: string | null, message: Message) => {
      if (!projectId || !chatId) {
        return;
      }

      const nextTitle = appendMessageLocally(projectId, chatId, message);

      void createServerMessage(chatId, {
        role: message.role === 'ai' ? 'assistant' : message.role,
        content: message.content,
        agentId: message.agentId,
        modelUsed: message.model,
        type: message.type,
        meta: message.meta,
      })
        .then((serverMessage) => {
          if (serverMessage.id && serverMessage.id !== message.id) {
            updateMessageIdLocally(projectId, chatId, message.id, serverMessage.id);
          }
        })
        .catch((error) => {
          logger.error('Failed to persist message on server', error);
        });

      if (nextTitle) {
        void updateServerConversation(chatId, nextTitle).catch((error) => {
          logger.error('Failed to sync conversation title', error);
        });
      }
    },
    [appendMessageLocally, updateMessageIdLocally],
  );

  const appendGlobalMessageLocally = useCallback(
    (message: Message) => {
      setGlobalChatMessages((prev) => [...prev, message]);
    },
    [setGlobalChatMessages],
  );

  const updateGlobalMessageLocally = useCallback(
    (messageId: string, updater: (message: Message) => Message) => {
      setGlobalChatMessages((prev) =>
        prev.map((message) => (message.id === messageId ? updater(message) : message)),
      );
    },
    [setGlobalChatMessages],
  );

  const updateMessageLocally = useCallback(
    (
      projectId: string | null,
      chatId: string | null,
      messageId: string,
      updater: (message: Message) => Message,
    ) => {
      if (!projectId || !chatId) {
        return;
      }

      setProjects((prev) => {
        const projectIndex = prev.findIndex((p) => p.id === projectId);
        if (projectIndex === -1) return prev;

        const project = prev[projectIndex];
        const sessionIndex = project.chatSessions.findIndex((s) => s.id === chatId);
        if (sessionIndex === -1) return prev;

        const session = project.chatSessions[sessionIndex];
        const messageIndex = session.messages.findIndex((m) => m.id === messageId);
        if (messageIndex === -1) return prev;

        const updatedMessage = updater(session.messages[messageIndex]);
        if (updatedMessage === session.messages[messageIndex]) return prev;

        const nextProjects = prev.slice();
        nextProjects[projectIndex] = {
          ...project,
          chatSessions: project.chatSessions.slice(),
        };
        nextProjects[projectIndex].chatSessions[sessionIndex] = {
          ...session,
          updatedAt: Date.now(),
          messages: session.messages.slice(),
        };
        nextProjects[projectIndex].chatSessions[sessionIndex].messages[messageIndex] =
          updatedMessage;
        return nextProjects;
      });
    },
    [setProjects],
  );

  const collectRelatedMessageIds = useCallback(
    (messages: Message[], anchorMessageId: string): string[] => {
      const anchorIndex = messages.findIndex((message) => message.id === anchorMessageId);
      if (anchorIndex === -1) {
        return [anchorMessageId];
      }

      const anchorMessage = messages[anchorIndex];
      if (anchorMessage.role !== 'user') {
        return [anchorMessageId];
      }

      const ids = [anchorMessage.id];
      for (let index = anchorIndex + 1; index < messages.length; index += 1) {
        const current = messages[index];
        if (current.role === 'user') {
          break;
        }
        ids.push(current.id);
      }

      return ids;
    },
    [],
  );

  const removeMessagesLocally = useCallback(
    (projectId: string | null, chatId: string | null, messageIds: string[]) => {
      if (!projectId || !chatId) {
        return;
      }

      const idSet = new Set(messageIds);
      if (idSet.size === 0) {
        return;
      }

      setProjects((prev) =>
        prev.map((project) =>
          project.id !== projectId
            ? project
            : {
                ...project,
                chatSessions: project.chatSessions.map((session) =>
                  session.id !== chatId
                    ? session
                    : {
                        ...session,
                        updatedAt: Date.now(),
                        messages: session.messages.filter((message) => !idSet.has(message.id)),
                      },
                ),
              },
        ),
      );
    },
    [setProjects],
  );

  const removeMessageLocally = useCallback(
    (projectId: string | null, chatId: string | null, messageId: string) => {
      removeMessagesLocally(projectId, chatId, [messageId]);
    },
    [removeMessagesLocally],
  );

  const removeGlobalMessagesLocally = useCallback(
    (messageIds: string[]) => {
      const idSet = new Set(messageIds);
      if (idSet.size === 0) {
        return;
      }

      setGlobalChatMessages((prev) => prev.filter((message) => !idSet.has(message.id)));
    },
    [setGlobalChatMessages],
  );

  const deleteMessageInChat = useCallback(
    async (projectId: string | null, chatId: string | null, messageId: string) => {
      const targetMessageId = messageId.trim();
      if (!targetMessageId) {
        return;
      }

      const getLocalTargetMessageIds = () => {
        if (!projectId || !chatId) {
          return collectRelatedMessageIds(globalChatMessages, targetMessageId);
        }
        const sessionMessages = getChatSession(projects, projectId, chatId)?.messages ?? [];
        return collectRelatedMessageIds(sessionMessages, targetMessageId);
      };

      const targetMessageIds = getLocalTargetMessageIds();
      const targetMessageIdSet = new Set(targetMessageIds);
      const localTargetMessage =
        projectId && chatId
          ? getChatSession(projects, projectId, chatId)?.messages.find(
              (message) => message.id === targetMessageId,
            )
          : undefined;

      if (!projectId || !chatId) {
        removeGlobalMessagesLocally(targetMessageIds);
        return;
      }

      clearPendingTasksByPlaceholderIds(chatId, targetMessageIdSet);

      if (!isServerWorkspaceReady) {
        removeMessagesLocally(projectId, chatId, targetMessageIds);
        return;
      }

      try {
        await deleteServerMessage(chatId, targetMessageId);
        removeMessagesLocally(projectId, chatId, targetMessageIds);
      } catch (error) {
        logger.error('Failed to delete message on server', error);
        const errorText = error instanceof Error ? error.message.toLowerCase() : '';
        const isNotFoundLikeError =
          errorText.includes('消息不存在') ||
          errorText.includes('not found') ||
          errorText.includes('(404)') ||
          errorText.includes('404');

        if (isNotFoundLikeError) {
          const workspace = (await refreshWorkspaceWithRetries(
            'message ID sync before delete',
          )) as { projects: Project[] } | null;
          if (workspace) {
            const sessionMessages =
              getChatSession(workspace.projects, projectId, chatId)?.messages ?? [];
            const serverMessage = findServerMessageMatch(
              sessionMessages,
              localTargetMessage,
              targetMessageId,
            );
            if (serverMessage) {
              try {
                await deleteServerMessage(chatId, serverMessage.id);
                updateMessageIdLocally(projectId, chatId, targetMessageId, serverMessage.id);
                removeMessagesLocally(projectId, chatId, targetMessageIds);
                return;
              } catch (retryError) {
                logger.error('Failed to delete message on server after ID remap', retryError);
              }
            }
          }
          removeMessagesLocally(projectId, chatId, targetMessageIds);
          return;
        }

        throw error;
      }
    },
    [
      collectRelatedMessageIds,
      globalChatMessages,
      projects,
      clearPendingTasksByPlaceholderIds,
      isServerWorkspaceReady,
      removeGlobalMessagesLocally,
      removeMessagesLocally,
      refreshWorkspaceWithRetries,
      findServerMessageMatch,
      updateMessageIdLocally,
    ],
  );

  const uploadAssets = useCallback(
    async (projectId: string, files: File[]) => {
      const nextAssets = await Promise.all(
        files.map(async (file) => {
          try {
            return await uploadServerAsset(projectId, file);
          } catch (error) {
            logger.error('Failed to upload asset to server', error);
            throw error;
          }
        }),
      );

      setAssets((prev) => [...nextAssets, ...prev]);
      setProjects((prev) =>
        prev.map((project) =>
          project.id === projectId
            ? { ...project, assetsCount: project.assetsCount + nextAssets.length }
            : project,
        ),
      );

      return nextAssets;
    },
    [setAssets, setProjects],
  );

  const deleteAsset = useCallback(
    async (assetId: string, options?: { force?: boolean }) => {
      const targetAsset = assets.find((asset) => asset.id === assetId);
      if (!targetAsset) {
        return;
      }

      try {
        await deleteServerAsset(assetId, options);
      } catch (error) {
        logger.error('Failed to delete asset on server', error);
        throw error;
      }

      setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
      setProjects((prev) =>
        prev.map((project) =>
          project.id === targetAsset.projectId
            ? { ...project, assetsCount: Math.max(0, project.assetsCount - 1) }
            : project,
        ),
      );
      setStoryboards((prev) =>
        prev.map((storyboard) =>
          storyboard.projectId !== targetAsset.projectId
            ? storyboard
            : {
                ...storyboard,
                lines: storyboard.lines.map((line) => ({
                  ...line,
                  assets: line.assets.filter((asset) => asset.id !== assetId),
                })),
              },
        ),
      );
    },
    [assets, setAssets, setProjects, setStoryboards],
  );

  const searchAssets = useCallback(
    async (params: AssetSearchParams): Promise<AssetSearchResponse> => {
      return searchServerAssets(params);
    },
    [],
  );

  const getAssetReferences = useCallback(
    async (assetId: string): Promise<{ references: AssetReference[]; total: number; canDelete: boolean }> => {
      const resp = await getServerAssetReferences(assetId);
      return {
        references: resp.references,
        total: resp.total,
        canDelete: resp.canDelete,
      };
    },
    [],
  );

  const updateAsset = useCallback(
    async (
      assetId: string,
      input: Partial<Pick<Asset, 'name' | 'type' | 'url' | 'metadata'>>,
    ) => {
      const targetAsset = assets.find((asset) => asset.id === assetId);
      if (!targetAsset) {
        throw new Error('资产不存在');
      }

      const nextAsset = await updateServerAsset(assetId, input);

      setAssets((prev) => prev.map((asset) => (asset.id === assetId ? nextAsset : asset)));
      setStoryboards((prev) =>
        prev.map((storyboard) =>
          storyboard.projectId !== nextAsset.projectId
            ? storyboard
            : {
                ...storyboard,
                lines: storyboard.lines.map((line) => ({
                  ...line,
                  assets: line.assets.map((asset) => (asset.id === assetId ? nextAsset : asset)),
                })),
              },
        ),
      );

      return nextAsset;
    },
    [assets, setAssets, setStoryboards],
  );

  const saveScript = useCallback(
    async (projectId: string, content: string, title?: string) => {
      const existingScript = scripts.find((script) => script.projectId === projectId);
      const nextTitle = deriveScriptTitle(content, title || existingScript?.title);

      let nextScript: Script;
      let savedOnServer = false;
      try {
        nextScript = await upsertServerScript(projectId, nextTitle, content);
        savedOnServer = true;
      } catch (error) {
        logger.error('Failed to save script on server', error);
        nextScript = existingScript
          ? { ...existingScript, title: nextTitle, content, updatedAt: Date.now() }
          : createLocalScript(projectId, nextTitle, content);
      }

      setScripts((prev) => {
        const hasCurrent = prev.some((script) => script.projectId === projectId);
        if (!hasCurrent) {
          return [nextScript, ...prev];
        }

          return prev.map((script) => (script.projectId === projectId ? nextScript : script));
      });

      if (savedOnServer) {
        void refreshWorkspaceWithRetries('script document asset sync', 2);
      }

      return nextScript;
    },
    [refreshWorkspaceWithRetries, scripts, setScripts],
  );

  const saveStoryboard = useCallback(
    async (projectId: string, lines: Storyboard['lines']) => {
      const normalizedLines = lines.map((line, index) => ({
        ...line,
        sceneNumber: line.sceneNumber > 0 ? line.sceneNumber : index + 1,
        description: line.description.trim() || '请填写镜头描述',
        duration: line.duration > 0 ? line.duration : 3,
      }));

      let nextStoryboard: Storyboard;
      let savedOnServer = false;
      try {
        nextStoryboard = await upsertServerStoryboard(projectId, normalizedLines);
        savedOnServer = true;
      } catch (error) {
        logger.error('Failed to save storyboard on server', error);
        const currentStoryboard = storyboards.find(
          (storyboard) => storyboard.projectId === projectId,
        );
        nextStoryboard = currentStoryboard
          ? { ...currentStoryboard, lines: normalizedLines, updatedAt: Date.now() }
          : createLocalStoryboard(projectId, normalizedLines);
      }

      setStoryboards((prev) => {
        const hasCurrent = prev.some((storyboard) => storyboard.projectId === projectId);
        if (!hasCurrent) {
          return [nextStoryboard, ...prev];
        }

        return prev.map((storyboard) =>
          storyboard.projectId === projectId ? nextStoryboard : storyboard,
        );
      });

      if (savedOnServer) {
        void refreshWorkspaceWithRetries('storyboard document asset sync', 2);
      }

      return nextStoryboard;
    },
    [refreshWorkspaceWithRetries, storyboards, setStoryboards],
  );

  const updateMessageInChat = useCallback(
    async (
      projectId: string | null,
      chatId: string | null,
      messageId: string,
      newContent: string,
    ) => {
      const targetMessageId = messageId.trim();
      if (!targetMessageId || !newContent.trim()) {
        return;
      }

      if (!projectId || !chatId) {
        updateGlobalMessageLocally(targetMessageId, (msg) => ({ ...msg, content: newContent }));
        return;
      }

      updateMessageLocally(projectId, chatId, targetMessageId, (msg) => ({
        ...msg,
        content: newContent,
      }));
      const localTargetMessage =
        getChatSession(projects, projectId, chatId)?.messages.find(
          (message) => message.id === targetMessageId,
        ) ?? undefined;

      if (!isServerWorkspaceReady) {
        return;
      }

      try {
        await updateServerMessage(chatId, targetMessageId, newContent);
      } catch (error) {
        logger.error('Failed to update message on server', error);
        const errorText = error instanceof Error ? error.message.toLowerCase() : '';
        const isNotFoundLikeError =
          errorText.includes('消息不存在') ||
          errorText.includes('not found') ||
          errorText.includes('(404)') ||
          errorText.includes('404');

        if (isNotFoundLikeError) {
          const workspace = (await refreshWorkspaceWithRetries(
            'message ID sync before update',
          )) as { projects: Project[] } | null;
          if (workspace) {
            const sessionMessages =
              getChatSession(workspace.projects, projectId, chatId)?.messages ?? [];
            const serverMessage = findServerMessageMatch(
              sessionMessages,
              localTargetMessage,
              targetMessageId,
            );
            if (serverMessage) {
              try {
                await updateServerMessage(chatId, serverMessage.id, newContent);
                updateMessageIdLocally(projectId, chatId, targetMessageId, serverMessage.id);
                return;
              } catch {
                updateMessageLocally(projectId, chatId, targetMessageId, (msg) => ({
                  ...msg,
                  content: newContent,
                }));
                return;
              }
            }
          }
          updateMessageLocally(projectId, chatId, targetMessageId, (msg) => ({
            ...msg,
            content: newContent,
          }));
          return;
        }

        throw error;
      }
    },
    [
      isServerWorkspaceReady,
      projects,
      updateGlobalMessageLocally,
      updateMessageLocally,
      refreshWorkspaceWithRetries,
      findServerMessageMatch,
      updateMessageIdLocally,
    ],
  );

  return {
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
    searchAssets,
    getAssetReferences,
    saveScript,
    saveStoryboard,
    buildHistoryMessagesFromGlobal: () => globalChatMessages,
    buildRelatedMessageIdsFromGlobal: (anchorMessageId: string) =>
      collectRelatedMessageIds(globalChatMessages, anchorMessageId),
  };
}
