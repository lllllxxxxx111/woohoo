import { useCallback, useRef, type SetStateAction } from 'react';
import { normalizeAiSettingsPayload } from '../../lib/ai';
import { createAiTask, listServerAiEndpoints, updateServerConversation } from '../../lib/serverApi';
import type { PendingAiTask } from './usePendingTaskSse';
import { mergeTaskMessageMeta } from './usePendingTaskSse';
import type {
  ActiveState,
  AgentContact,
  AiSettings,
  Asset,
  ChatSession,
  ExecutionMode,
  Message,
  MessageAttachment,
  Project,
  ResourceRef,
} from '../../types';
import { logger } from '../../lib/logger';
import {
  createId,
  endpointMatchesAiProvider,
  extractAgent,
  getChatSession,
  inferProjectNameFromConversation,
  normalizeResourceMentions,
  resolveAiTaskRequestModel,
  selectAiEndpointForSettings,
} from '../utils/appContextHelpers';

type SendMessageResult = {
  mode: ExecutionMode;
  taskId?: string;
};

type SendMessageOptions = {
  allowAssistantActions?: boolean;
  confirmedAssistantMessageId?: string;
  confirmedWorkflowGuardMessageId?: string;
  resourceRefs?: ResourceRef[];
  attachments?: MessageAttachment[];
  requireServerTask?: boolean;
  outputKind?: 'text' | 'image' | 'video' | 'audio' | 'document' | 'other';
  outputItems?: number;
  agentId?: string;
  triggerSource?: 'edit' | 'rewind' | 'normal';
  rewindFromMessageId?: string;
};

type UseAiMessageRuntimeOptions = {
  aiSettings: AiSettings;
  isAiConfigured: boolean;
  isServerWorkspaceReady: boolean;
  serverAiEndpointId: string | null;
  activeState: ActiveState;
  activeChat: ChatSession | undefined;
  projects: Project[];
  assets: Asset[];
  globalChatMessages: Message[];
  projectScopedAgents: AgentContact[];
  allAgentContacts: AgentContact[];
  defaultAgents: AgentContact[];
  setServerAiEndpointId: (updater: SetStateAction<string | null>) => void;
  createChatInProject: (projectId: string, title?: string) => Promise<ChatSession>;
  appendMessageLocally: (
    projectId: string | null,
    chatId: string | null,
    message: Message,
  ) => string | null;
  appendGlobalMessageLocally: (message: Message) => void;
  updateGlobalMessageLocally: (messageId: string, updater: (message: Message) => Message) => void;
  updateMessageLocally: (
    projectId: string | null,
    chatId: string | null,
    messageId: string,
    updater: (message: Message) => Message,
  ) => void;
  replaceMessageIdLocally: (
    projectId: string | null,
    chatId: string | null,
    tempMessageId: string,
    persistedMessageId: string,
  ) => void;
  removeMessageLocally: (
    projectId: string | null,
    chatId: string | null,
    messageId: string,
  ) => void;
  registerPendingTask: (taskId: string, task: PendingAiTask) => void;
};

export function useAiMessageRuntime({
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
  setServerAiEndpointId,
  createChatInProject,
  appendMessageLocally,
  updateMessageLocally,
  replaceMessageIdLocally,
  removeMessageLocally,
  registerPendingTask,
}: UseAiMessageRuntimeOptions) {
  const ensureChatTargetPromiseRef = useRef<Promise<{
    targetProjectId: string;
    targetChatId: string;
    chatSnapshot?: ChatSession;
  }> | null>(null);

  const ensureChatTarget = useCallback(async () => {
    let targetProjectId = activeState.projectId;
    let targetChatId = activeState.chatSessionId;
    let chatSnapshot =
      targetProjectId && targetChatId
        ? getChatSession(projects, targetProjectId, targetChatId)
        : undefined;

    if (targetProjectId && targetChatId && chatSnapshot) {
      return { targetProjectId, targetChatId, chatSnapshot };
    }

    if (ensureChatTargetPromiseRef.current) {
      return ensureChatTargetPromiseRef.current;
    }

    ensureChatTargetPromiseRef.current = (async () => {
      let nextProjectId = targetProjectId;
      let nextChatId = targetChatId;
      let nextChatSnapshot = chatSnapshot;

      if (!nextProjectId) {
        throw new Error('PROJECT_REQUIRED');
      }

      if (!nextChatId || !nextChatSnapshot) {
        const chat = await createChatInProject(nextProjectId, '新对话');
        nextChatId = chat.id;
        nextChatSnapshot = chat;
      }

      return {
        targetProjectId: nextProjectId,
        targetChatId: nextChatId,
        chatSnapshot: nextChatSnapshot,
      };
    })();

    try {
      return await ensureChatTargetPromiseRef.current;
    } finally {
      ensureChatTargetPromiseRef.current = null;
    }
  }, [activeState.projectId, activeState.chatSessionId, createChatInProject, projects]);

  const suggestProjectName = useCallback(
    (seedContent?: string) => {
      const sourceMessages = activeState.projectId
        ? (activeChat?.messages ?? [])
        : globalChatMessages;

      return inferProjectNameFromConversation(sourceMessages, seedContent);
    },
    [activeState.projectId, activeChat?.messages, globalChatMessages],
  );

  const ensureServerAiEndpoint = useCallback(
    async (settings: AiSettings) => {
      const endpoints = await listServerAiEndpoints();
      const matchedEndpoint = selectAiEndpointForSettings(endpoints, settings, serverAiEndpointId);
      if (matchedEndpoint) {
        setServerAiEndpointId(matchedEndpoint.id);
        return matchedEndpoint;
      }

      const disabledOrMissingKeyEndpoint = endpoints.find((endpoint) =>
        endpointMatchesAiProvider(endpoint, settings),
      );
      if (disabledOrMissingKeyEndpoint) {
        throw new Error(
          `匹配的 AI 通道没有保存 API Key 或当前不可用（provider=${settings.provider}）。请前往“设置 > API 通道”编辑该通道并重新保存密钥。`,
        );
      }

      throw new Error(
        `未找到可用的 AI 端点（provider=${settings.provider}, model=${settings.model || '未设置'}）。请前往“设置 > API 通道”手动创建或调整通道。`,
      );
    },
    [serverAiEndpointId, setServerAiEndpointId],
  );

  const sendAiMessage = useCallback(
    async (content: string, options?: SendMessageOptions): Promise<SendMessageResult> => {
      const trimmed = content.trim();

      if (!trimmed) {
        return { mode: 'direct' };
      }

      if (!isAiConfigured) {
        throw new Error('请先在设置中完成 AI 接入配置');
      }

      const normalizedSettings = normalizeAiSettingsPayload(aiSettings);
      const availableAgents = projectScopedAgents;
      const { agent: mentionedAgent, sanitizedContent } = extractAgent(trimmed, availableAgents);
      const explicitAgent = options?.agentId
        ? availableAgents.find((item) => item.id === options.agentId)
        : undefined;
      const agent = explicitAgent ?? mentionedAgent;
      const usingProjectScope = Boolean(activeState.projectId);

      if (!usingProjectScope) {
        throw new Error('请先创建或选择项目，再通过已保存的后端 API 通道发起 AI 对话。');
      }

      const { targetProjectId, targetChatId } = await ensureChatTarget();
      const { sanitizedContent: normalizedContent, resourceRefs } = normalizeResourceMentions(
        sanitizedContent,
        assets,
        options?.resourceRefs,
        targetProjectId,
      );
      const attachments = options?.attachments ?? [];
      const userMessageId = createId('msg');
      const triggerSource = options?.triggerSource;
      const initialUserMessageMeta: Message['meta'] =
        options?.confirmedWorkflowGuardMessageId ||
        resourceRefs.length > 0 ||
        attachments.length > 0 ||
        Boolean(triggerSource)
          ? {
              ...(options?.confirmedWorkflowGuardMessageId
                ? {
                    confirmedWorkflowGuardMessageId: options.confirmedWorkflowGuardMessageId,
                    workflowGuardConfirmPending: true,
                  }
                : {}),
              ...(resourceRefs.length > 0 ? { resourceRefs } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(triggerSource ? { triggerSource } : {}),
            }
          : undefined;

      const nextTitle = appendMessageLocally(targetProjectId, targetChatId, {
        id: userMessageId,
        role: 'user',
        content: normalizedContent,
        timestamp: Date.now(),
        agentId: agent?.id,
        status: 'done',
        type: 'text',
        meta: initialUserMessageMeta,
      });

      const placeholderMessageId = createId('msg');
      appendMessageLocally(targetProjectId, targetChatId, {
        id: placeholderMessageId,
        role: 'ai',
        content: isServerWorkspaceReady ? '任务提交中...' : 'AI 正在思考中...',
        timestamp: Date.now(),
        agentId: agent?.id,
        model: normalizedSettings.model,
        status: 'pending',
        type: 'text',
        meta: {
          provider: normalizedSettings.provider,
          operation: 'task',
          outputKind: 'text',
          outputItems: 1,
          ...(resourceRefs.length > 0 ? { resourceRefs } : {}),
          ...(triggerSource ? { triggerSource } : {}),
        },
      });

      let persistedUserMessageId = userMessageId;
      let persistedPlaceholderMessageId = placeholderMessageId;

      try {
        if (isServerWorkspaceReady) {
          const endpoint = await ensureServerAiEndpoint(normalizedSettings);
          const requestModel = resolveAiTaskRequestModel(endpoint, normalizedSettings);
          const displayModel =
            requestModel || endpoint.defaultModel?.trim() || normalizedSettings.model;
          const task = await createAiTask({
            conversationId: targetChatId,
            content: normalizedContent,
            resourceRefs,
            agentId: agent?.id,
            endpointId: endpoint.id,
            model: requestModel,
            systemPrompt: normalizedSettings.systemPrompt,
            temperature: normalizedSettings.temperature,
            maxTokens: normalizedSettings.maxTokens,
            topP: normalizedSettings.topP,
            frequencyPenalty: normalizedSettings.frequencyPenalty,
            forceStreamFallback: normalizedSettings.forceStreamFallback,
            outputKind: options?.outputKind,
            outputItems: options?.outputItems,
            allowAssistantActions: options?.allowAssistantActions,
            confirmedAssistantMessageId: options?.confirmedAssistantMessageId,
            confirmedWorkflowGuardMessageId: options?.confirmedWorkflowGuardMessageId,
            triggerSource,
          });
          const effectiveUserMessageId =
            typeof task.userMessageId === 'string' && task.userMessageId.trim()
              ? task.userMessageId.trim()
              : userMessageId;
          const effectivePlaceholderMessageId =
            typeof task.assistantMessageId === 'string' && task.assistantMessageId.trim()
              ? task.assistantMessageId.trim()
              : placeholderMessageId;
          persistedUserMessageId = effectiveUserMessageId;
          persistedPlaceholderMessageId = effectivePlaceholderMessageId;

          if (effectiveUserMessageId !== userMessageId) {
            replaceMessageIdLocally(
              targetProjectId,
              targetChatId,
              userMessageId,
              effectiveUserMessageId,
            );
          }
          if (effectivePlaceholderMessageId !== placeholderMessageId) {
            replaceMessageIdLocally(
              targetProjectId,
              targetChatId,
              placeholderMessageId,
              effectivePlaceholderMessageId,
            );
          }

          if (task.projectId !== targetProjectId || task.conversationId !== targetChatId) {
            throw new Error('任务会话绑定异常，已阻止结果串入当前对话');
          }

          registerPendingTask(task.id, {
            projectId: targetProjectId,
            chatId: targetChatId,
            conversationId: targetChatId,
            placeholderMessageId: effectivePlaceholderMessageId,
            requestedModel: displayModel,
            provider: normalizedSettings.provider,
          });

          updateMessageLocally(
            targetProjectId,
            targetChatId,
            effectivePlaceholderMessageId,
            (message) => ({
              ...message,
              content: task.status === 'running' ? 'AI 正在处理中...' : '任务已提交，排队中...',
              status: 'pending',
              model: task.model || displayModel,
              meta: {
                ...mergeTaskMessageMeta(message.meta, task, normalizedSettings.provider),
                operation: 'task',
              },
            }),
          );

          if (options?.confirmedWorkflowGuardMessageId) {
            updateMessageLocally(
              targetProjectId,
              targetChatId,
              effectiveUserMessageId,
              (message) => ({
                ...message,
                meta: {
                  ...(message.meta ?? {}),
                  confirmedWorkflowGuardMessageId: options.confirmedWorkflowGuardMessageId,
                  workflowGuardConfirmPending: options.confirmedAssistantMessageId
                    ? true
                    : undefined,
                },
              }),
            );
          }
          if (nextTitle) {
            void updateServerConversation(targetChatId, nextTitle).catch((error) => {
              logger.error('Failed to sync conversation title', error);
            });
          }

          return { mode: 'task', taskId: task.id };
        }

        throw new Error('本地后端未就绪，AI 对话必须通过已保存的后端 API 通道执行。');
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';

        if (options?.confirmedWorkflowGuardMessageId) {
          removeMessageLocally(targetProjectId, targetChatId, persistedUserMessageId);
        }

        updateMessageLocally(
          targetProjectId,
          targetChatId,
          persistedPlaceholderMessageId,
          (currentMessage) => ({
            ...currentMessage,
            role: 'system',
            content: `AI 调用失败：${message}`,
            timestamp: Date.now(),
            status: 'error',
            model: undefined,
            type: 'text',
            meta: {
              ...(currentMessage.meta ?? {}),
              lastError: message,
              taskStatus: currentMessage.meta?.taskStatus,
            },
          }),
        );

        throw error;
      }
    },
    [
      isAiConfigured,
      aiSettings,
      projectScopedAgents,
      activeState.projectId,
      assets,
      globalChatMessages,
      ensureChatTarget,
      projects,
      appendMessageLocally,
      isServerWorkspaceReady,
      ensureServerAiEndpoint,
      updateMessageLocally,
      replaceMessageIdLocally,
      registerPendingTask,
      removeMessageLocally,
    ],
  );

  return {
    sendAiMessage,
    suggestProjectName,
  };
}
