/** useMessageActions - 消息操作逻辑 Hook，管理消息编辑、撤回、删除、复制、发送、项目创建等操作 */
import { useDeferredValue, useEffect, useState, useMemo, useCallback } from 'react';
import { useAppStore } from '../../../../../store';
import { useToast } from '../../../../../context/useToast';
import { useAppActions } from '../../../../../context/useAppActions';
import { cancelTask } from '../../../../../lib/ai';
import {
  listServerAiEndpoints,
  testServerAiCompletionByEndpoint,
} from '../../../../../lib/serverApi';
import type { AgentContact, Asset, ResourceRef, Message, MessageAttachment, ChatSession } from '../../../../../types';
import {
  resolveAiTaskRequestModel,
  selectAiEndpointForSettings,
} from '../../../../../context/utils/appContextHelpers';
import { buildAssetMentionValue, extractMessageAttachments, extractMessageResourceRefs,
  formatAssetTypeLabel, mergeResourceRefs, parseInputResourceSelections, reconcileDraftResourceRefs, scoreAssetSearch,
} from '../chatAreaUtils';
import { uploadFiles, isAllowedFileType } from '../../../../../lib/fileUpload';
import type { StoryOutlineSupplementDraft } from '../ChatMessageGroupItem';
import { normalizeStoryOutlineDraft, parseStoryOutlineDraftFromAiContent } from './storyOutlineUtils';

/** 发送消息载荷类型 */
export type SendPayload = {
  content: string;
  resourceRefs: ResourceRef[];
  attachments: MessageAttachment[];
  editingMessageId?: string;
  agentId?: string;
};

/** Mentions 选项类型 */
type MentionOption = string | number | {
  label: React.ReactNode;
  value: string | number;
  disabled?: boolean;
  [key: string]: unknown;
};

/** useMessageActions 的参数 */
export type UseMessageActionsParams = {
  activeProject: ReturnType<typeof useAppStore.getState>['projects'][number] | undefined;
  activeChat: ChatSession | undefined;
  activeState: { projectId: string | null; chatSessionId: string | null };
  activeMessages: Message[];
  agentContacts: AgentContact[];
  assets: Asset[];
  projectNameById: Map<string, string>;
  isAiResponding: boolean;
  isAiConfigured: boolean;
  aiSettings: ReturnType<typeof useAppStore.getState>['aiSettings'];
  isAtBottomRef: React.MutableRefObject<boolean>;
  setSettingsOpen: (open: boolean) => void;
  setActiveProject: (projectId: string) => void;
};

/** useMessageActions 的返回值 */
export type UseMessageActionsResult = {
  editingMessage: { messageId: string; agentId?: string } | null;
  setEditingMessage: React.Dispatch<React.SetStateAction<{ messageId: string; agentId?: string } | null>>;
  rewindingMessageId: string | null;
  setRewindingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  deletingMessageId: string | null;
  setDeletingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  isRewindSend: boolean;
  setIsRewindSend: React.Dispatch<React.SetStateAction<boolean>>;
  handleStartEditingMessage: (message: Message) => void;
  handleCancelEditing: () => void;
  handleRevokeMessage: (message: Message) => Promise<void>;
  handleRevokeUserMessage: (message: Message) => void;
  handleDeleteMessage: (message: Message) => Promise<void>;
  handleDeleteMessageForItem: (message: Message) => void;
  handleCopyMessage: (message: Message) => Promise<void>;
  handleCopyMessageForItem: (message: Message) => void;
  executeSendPayload: (payload: SendPayload, options?: { restoreOnError?: boolean }) => Promise<boolean>;
  pendingSendPayload: SendPayload | null;
  setPendingSendPayload: React.Dispatch<React.SetStateAction<SendPayload | null>>;
  pendingSendAfterProjectCreate: SendPayload | null;
  setPendingSendAfterProjectCreate: React.Dispatch<React.SetStateAction<SendPayload | null>>;
  skipProjectCreationPrompt: boolean;
  setSkipProjectCreationPrompt: React.Dispatch<React.SetStateAction<boolean>>;
  showProjectCreateConfirm: boolean;
  setShowProjectCreateConfirm: React.Dispatch<React.SetStateAction<boolean>>;
  showCreateProjectModal: boolean;
  setShowCreateProjectModal: React.Dispatch<React.SetStateAction<boolean>>;
  newProjectName: string;
  setNewProjectName: React.Dispatch<React.SetStateAction<string>>;
  handleSendMessage: () => Promise<void>;
  handleDeclineProjectCreation: () => Promise<void>;
  handleCreateProjectBeforeSend: () => Promise<void>;
  handleCreateProjectOnly: () => Promise<void>;
  handleOpenCreateProjectModal: (seedContent?: string) => void;
  handleCancelPendingTasks: () => Promise<void>;
  handleFilesSelected: (files: File[]) => Promise<void>;
  handleRemoveAttachment: (index: number) => void;
  pendingAttachments: MessageAttachment[];
  setPendingAttachments: React.Dispatch<React.SetStateAction<MessageAttachment[]>>;
  inputValue: string;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  draftResourceRefs: ResourceRef[];
  setDraftResourceRefs: React.Dispatch<React.SetStateAction<ResourceRef[]>>;
  mentionPrefix: string;
  setMentionPrefix: React.Dispatch<React.SetStateAction<string>>;
  mentionSearchText: string;
  setMentionSearchText: React.Dispatch<React.SetStateAction<string>>;
  handleInputChange: (value: string) => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handleMentionClick: (agentName: string) => void;
  pendingCancelableTaskIds: string[];
  mentionOptions: MentionOption[];
  handleOptimizeStoryOutlineDraft: (draft: StoryOutlineSupplementDraft) => Promise<StoryOutlineSupplementDraft>;
};

/**
 * 消息操作逻辑 Hook
 *
 * 管理所有与消息交互相关的状态和操作方法，包括编辑、撤回、删除、复制、发送、
 * 项目创建确认、文件上传、@提及等。
 *
 * @param params - 包含项目、聊天、智能体、资产等依赖的参数对象
 * @returns 消息操作状态与方法
 */
export function useMessageActions(params: UseMessageActionsParams): UseMessageActionsResult {
  const {
    activeProject, activeChat, activeState, activeMessages, agentContacts, assets,
    projectNameById, isAiResponding, isAiConfigured, aiSettings,
    isAtBottomRef, setSettingsOpen, setActiveProject,
  } = params;
  const isServerWorkspaceReady = useAppStore((state) => state.isServerWorkspaceReady);
  const serverAiEndpointId = useAppStore((state) => state.serverAiEndpointId);

  const { showToast } = useToast();
  const {
    sendAiMessage, createProject, suggestProjectName,
    deleteMessageInChat, rewindChatToMessage,
  } = useAppActions();

  const [inputValue, setInputValue] = useState('');
  const [draftResourceRefs, setDraftResourceRefs] = useState<ResourceRef[]>([]);
  const [mentionPrefix, setMentionPrefix] = useState('@');
  const [mentionSearchText, setMentionSearchText] = useState('');
  const deferredMentionSearchText = useDeferredValue(mentionSearchText);
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [editingMessage, setEditingMessage] = useState<{ messageId: string; agentId?: string } | null>(null);
  const [skipProjectCreationPrompt, setSkipProjectCreationPrompt] = useState(false);
  const [showProjectCreateConfirm, setShowProjectCreateConfirm] = useState(false);
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [pendingSendPayload, setPendingSendPayload] = useState<SendPayload | null>(null);
  const [pendingSendAfterProjectCreate, setPendingSendAfterProjectCreate] = useState<SendPayload | null>(null);
  const [rewindingMessageId, setRewindingMessageId] = useState<string | null>(null);
  /** 标记下一次发送是否为撤回后的重新发送 */
  const [isRewindSend, setIsRewindSend] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);

  /** 计算可取消的待处理任务 ID 列表 */
  const pendingCancelableTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of activeMessages) {
      if (message.role !== 'ai') continue;
      const taskId = message.meta?.taskId?.trim();
      const taskStatus = message.meta?.taskStatus;
      const isTaskPending = message.status === 'pending' || taskStatus === 'queued' || taskStatus === 'running';
      if (taskId && isTaskPending) ids.add(taskId);
    }
    return Array.from(ids);
  }, [activeMessages]);

  /** 计算 @/# 提及选项 */
  const mentionOptions = useMemo(() => {
    if (mentionPrefix === '@') {
      return agentContacts.map((agent) => ({
        label: `${agent.name}`, value: agent.name,
        _role: agent.responsibilityLabel || agent.role, _type: 'agent',
      }));
    }
    if (mentionPrefix === '#') {
      return [...assets]
        .map((asset) => {
          const projectName = projectNameById.get(asset.projectId) || '未命名项目';
          const typeLabel = formatAssetTypeLabel(asset.type);
          return {
            asset, projectName,
            score: scoreAssetSearch(asset, projectName, deferredMentionSearchText, activeState.projectId),
            _type: 'asset', _typeLabel: typeLabel, _isCurrent: asset.projectId === activeState.projectId,
          };
        })
        .filter((item) => (deferredMentionSearchText.trim() ? item.score > 0 : true))
        .sort((left, right) => right.score !== left.score ? right.score - left.score : right.asset.createdAt - left.asset.createdAt)
        .slice(0, 40)
        .map(({ asset, projectName, _typeLabel, _isCurrent }) => ({
          label: asset.name, value: buildAssetMentionValue(asset),
          _projectName: projectName, _typeLabel, _isCurrent, _type: 'asset',
        }));
    }
    return [];
  }, [mentionPrefix, agentContacts, assets, projectNameById, deferredMentionSearchText, activeState.projectId]);

  /** 处理输入框内容变化，解析资源引用选择 */
  const handleInputChange = useCallback((value: string) => {
    const { nextValue, selectedRefs } = parseInputResourceSelections(value, assets);
    setInputValue(nextValue);
    setDraftResourceRefs((prev) => reconcileDraftResourceRefs(nextValue, mergeResourceRefs(prev, selectedRefs), assets));
  }, [assets]);

  /** 处理开始编辑用户消息，将消息内容回填到输入框 */
  const handleStartEditingMessage = useCallback((message: Message) => {
    if (message.role !== 'user' || !activeProject || !activeChat) return;
    const messageResourceRefs = extractMessageResourceRefs(message);
    const messageAttachments = extractMessageAttachments(message);
    setEditingMessage({ messageId: message.id, agentId: typeof message.agentId === 'string' ? message.agentId : undefined });
    setInputValue(message.content || '');
    setDraftResourceRefs(messageResourceRefs);
    setPendingAttachments(messageAttachments);
  }, [activeProject, activeChat]);

  /** 取消编辑消息 */
  const handleCancelEditing = useCallback(() => {
    setEditingMessage(null);
    setInputValue('');
    setDraftResourceRefs([]);
    setPendingAttachments([]);
  }, []);

  /** 处理撤回用户消息，删除该条及后续消息并回滚资源状态 */
  const handleRevokeMessage = useCallback(async (message: Message) => {
    if (message.role !== 'user' || !activeProject || !activeChat) return;
    const confirmed = window.confirm('撤回后将删除该条及后续消息，并回滚对应资源状态，确认继续吗？');
    if (!confirmed) return;
    setRewindingMessageId(message.id);
    try {
      await rewindChatToMessage(activeProject.id, activeChat.id, message.id, true);
      const messageResourceRefs = extractMessageResourceRefs(message);
      const messageAttachments = extractMessageAttachments(message);
      setEditingMessage(null);
      setInputValue(message.content || '');
      setDraftResourceRefs(messageResourceRefs);
      setPendingAttachments(messageAttachments);
      setIsRewindSend(true);
      showToast({ type: 'success', title: '已撤回', message: '会话内容已回退，该条消息已回填到输入框' });
    } catch (error) {
      showToast({ type: 'error', title: '撤回失败', message: error instanceof Error ? error.message : '无法撤回该消息' });
    } finally {
      setRewindingMessageId(null);
    }
  }, [activeProject, activeChat, rewindChatToMessage, showToast]);

  /** 处理删除指定消息 */
  const handleDeleteMessage = useCallback(async (message: Message) => {
    if (deletingMessageId) return;
    setDeletingMessageId(message.id);
    try {
      await deleteMessageInChat(activeState.projectId, activeState.chatSessionId, message.id);
      if (editingMessage?.messageId === message.id) handleCancelEditing();
      showToast({ type: 'success', title: '已删除', message: '该条聊天记录已删除' });
    } catch (error) {
      showToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '无法删除该条聊天记录' });
    } finally {
      setDeletingMessageId(null);
    }
  }, [activeState.chatSessionId, activeState.projectId, deleteMessageInChat, deletingMessageId, editingMessage?.messageId, handleCancelEditing, showToast]);

  /** 撤回用户消息的包装回调 */
  const handleRevokeUserMessage = useCallback((message: Message) => { void handleRevokeMessage(message); }, [handleRevokeMessage]);

  /** 删除消息的包装回调，供列表项组件调用 */
  const handleDeleteMessageForItem = useCallback((message: Message) => { void handleDeleteMessage(message); }, [handleDeleteMessage]);

  /** 复制消息文本内容到剪贴板 */
  const handleCopyMessage = useCallback(async (message: Message) => {
    const text = typeof message?.content === 'string' ? message.content : '';
    if (!text.trim()) {
      showToast({ type: 'warning', title: '复制失败', message: '该条消息没有可复制的文本内容' });
      return;
    }
    const copyWithFallback = async () => {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!copied) throw new Error('复制失败');
    };
    try {
      await copyWithFallback();
      showToast({ type: 'success', title: '已复制', message: '消息内容已复制到剪贴板' });
    } catch (error) {
      showToast({ type: 'error', title: '复制失败', message: error instanceof Error ? error.message : '无法复制该条消息' });
    }
  }, [showToast]);

  /** 复制消息的包装回调，供列表项组件调用 */
  const handleCopyMessageForItem = useCallback((message: Message) => { void handleCopyMessage(message); }, [handleCopyMessage]);

  /** 执行发送消息的载荷 */
  const executeSendPayload = useCallback(async (payload: SendPayload, options?: { restoreOnError?: boolean }) => {
    const restoreOnError = options?.restoreOnError ?? true;
    const triggerSource = payload.editingMessageId ? 'edit' : isRewindSend ? 'rewind' : undefined;
    let editRewindApplied = false;
    setInputValue('');
    setDraftResourceRefs([]);
    setPendingAttachments([]);
    isAtBottomRef.current = true;
    try {
      if (payload.editingMessageId && activeProject && activeChat) {
        try {
          await rewindChatToMessage(activeProject.id, activeChat.id, payload.editingMessageId);
          editRewindApplied = true;
          setEditingMessage(null);
        } catch (rewindError) {
          setEditingMessage({ messageId: payload.editingMessageId, agentId: payload.agentId });
          throw rewindError;
        }
      }
      await sendAiMessage(payload.content, {
        ...(payload.resourceRefs.length > 0 ? { resourceRefs: payload.resourceRefs } : {}),
        ...(payload.attachments.length > 0 ? { attachments: payload.attachments } : {}),
        ...(payload.agentId ? { agentId: payload.agentId } : {}),
        ...(triggerSource ? { triggerSource } : {}),
        ...(payload.editingMessageId ? { rewindFromMessageId: payload.editingMessageId } : {}),
      });
      if (isRewindSend) setIsRewindSend(false);
      setRewindingMessageId(null);
      return true;
    } catch (error) {
      if (restoreOnError) {
        setInputValue(payload.content);
        setDraftResourceRefs(payload.resourceRefs);
        setPendingAttachments(payload.attachments);
        setEditingMessage(
          !payload.editingMessageId || editRewindApplied
            ? null
            : { messageId: payload.editingMessageId, agentId: payload.agentId },
        );
      }
      setRewindingMessageId(null);
      showToast({ type: 'error', title: '消息发送失败', message: error instanceof Error ? error.message : '网络或服务异常' });
      return false;
    }
  }, [activeProject, activeChat, rewindChatToMessage, isRewindSend, sendAiMessage, showToast, isAtBottomRef]);

  /** 打开创建项目弹窗 */
  const handleOpenCreateProjectModal = (seedContent?: string) => {
    setNewProjectName(suggestProjectName(seedContent));
    setShowProjectCreateConfirm(false);
    setShowCreateProjectModal(true);
  };

  /** 处理发送消息 */
  const handleSendMessage = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed && pendingAttachments.length === 0) return;
    if (isAiResponding) {
      showToast({ type: 'warning', title: 'AI 正在回复中', message: '请等待当前回复完成，或先点击"停止等待"取消任务。' });
      return;
    }
    if (!isAiConfigured) {
      showToast({ type: 'warning', title: '配置未完成', message: '请先前往系统设置配置模型参数' });
      setSettingsOpen(true);
      return;
    }
    const payload: SendPayload = {
      content: trimmed, resourceRefs: draftResourceRefs,
      attachments: [...pendingAttachments], editingMessageId: editingMessage?.messageId, agentId: editingMessage?.agentId,
    };
    if (!activeProject && !skipProjectCreationPrompt) {
      setPendingSendPayload(payload);
      setShowProjectCreateConfirm(true);
      return;
    }
    await executeSendPayload(payload);
  };

  /** 拒绝创建项目，继续全局对话 */
  const handleDeclineProjectCreation = async () => {
    if (!pendingSendPayload) return;
    const payload = pendingSendPayload;
    setPendingSendPayload(null);
    setShowProjectCreateConfirm(false);
    setSkipProjectCreationPrompt(true);
    await executeSendPayload(payload);
  };

  /** 先创建项目再发送消息 */
  const handleCreateProjectBeforeSend = async () => {
    if (!pendingSendPayload) return;
    const payload = pendingSendPayload;
    const nextName = newProjectName.trim() || suggestProjectName(payload.content);
    try {
      const project = await createProject(nextName);
      setActiveProject(project.id);
      setPendingSendAfterProjectCreate(payload);
      setPendingSendPayload(null);
      setShowCreateProjectModal(false);
      setShowProjectCreateConfirm(false);
      setSkipProjectCreationPrompt(false);
    } catch (error) {
      showToast({ type: 'error', title: '创建项目失败', message: error instanceof Error ? error.message : '无法创建项目' });
    }
  };

  /** 仅创建项目（不发送消息） */
  const handleCreateProjectOnly = async () => {
    const nextName = newProjectName.trim() || suggestProjectName(inputValue.trim());
    try {
      const project = await createProject(nextName);
      setActiveProject(project.id);
      setShowCreateProjectModal(false);
      setShowProjectCreateConfirm(false);
      setPendingSendPayload(null);
      setSkipProjectCreationPrompt(false);
    } catch (error) {
      showToast({ type: 'error', title: '创建项目失败', message: error instanceof Error ? error.message : '无法创建项目' });
    }
  };

  /** 项目创建完成后自动发送待发送消息 */
  useEffect(() => {
    if (!pendingSendAfterProjectCreate || !activeState.projectId) return;
    const payload = pendingSendAfterProjectCreate;
    setPendingSendAfterProjectCreate(null);
    void executeSendPayload(payload, { restoreOnError: true });
  }, [activeState.projectId, executeSendPayload, pendingSendAfterProjectCreate]);

  /** 切换到项目时重置项目创建确认状态 */
  useEffect(() => {
    if (activeState.projectId) {
      setShowProjectCreateConfirm(false);
      setSkipProjectCreationPrompt(false);
    }
  }, [activeState.projectId]);

  /** 处理键盘按下事件，Enter 发送消息，Shift+Enter 换行 */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSendMessage();
    }
  };

  /** 处理 @提及点击，将智能体名称插入输入框 */
  const handleMentionClick = useCallback((agentName: string) => {
    setInputValue((prev) => `${prev}${prev.trim() ? ' ' : ''}@${agentName} `);
  }, []);

  /** 取消所有待处理任务 */
  const handleCancelPendingTasks = useCallback(async () => {
    if (pendingCancelableTaskIds.length === 0) {
      showToast({ type: 'warning', title: '当前无可取消任务', message: '没有检测到正在运行的服务端任务。' });
      return;
    }
    const results = await Promise.allSettled(pendingCancelableTaskIds.map((taskId) => cancelTask(taskId)));
    const cancelledCount = results.filter((result) => result.status === 'fulfilled').length;
    const failedCount = results.length - cancelledCount;
    if (cancelledCount > 0 && failedCount === 0) {
      showToast({ type: 'success', title: '已发送取消请求', message: `成功取消 ${cancelledCount} 个任务` });
    } else if (cancelledCount > 0 && failedCount > 0) {
      showToast({ type: 'warning', title: '部分任务取消失败', message: `已取消 ${cancelledCount} 个，失败 ${failedCount} 个` });
    } else {
      showToast({ type: 'error', title: '取消失败', message: '未能取消当前任务，请稍后重试' });
    }
  }, [pendingCancelableTaskIds, showToast]);

  /** 处理文件选择事件 */
  const handleFilesSelected = async (files: File[]) => {
    if (!activeProject) {
      showToast({ type: 'warning', title: '请先选择项目', message: '需要先选择一个项目才能上传附件' });
      return;
    }
    const validFiles = files.filter(isAllowedFileType);
    if (validFiles.length < files.length) {
      showToast({ type: 'warning', title: '部分文件不支持', message: `${files.length - validFiles.length} 个文件格式不被支持` });
    }
    if (validFiles.length === 0) return;
    try {
      showToast({ type: 'info', title: '正在上传', message: `正在上传 ${validFiles.length} 个文件...` });
      const uploadedAttachments = await uploadFiles(validFiles, activeProject.id);
      setPendingAttachments((prev) => [...prev, ...uploadedAttachments]);
      showToast({ type: 'success', title: '上传成功', message: `已添加 ${uploadedAttachments.length} 个附件` });
    } catch (error) {
      showToast({ type: 'error', title: '上传失败', message: error instanceof Error ? error.message : '文件上传出错' });
    }
  };

  /** 移除待发送的附件 */
  const handleRemoveAttachment = (index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  /** AI 优化故事大纲草稿 */
  const handleOptimizeStoryOutlineDraft = useCallback(async (draft: StoryOutlineSupplementDraft) => {
    if (!isAiConfigured) throw new Error('请先完成 AI 配置后再使用优化功能');
    const normalizedDraft = normalizeStoryOutlineDraft(draft);
    const hasInput = Object.values(normalizedDraft).some((value) => Boolean(value.trim()));
    if (!hasInput) throw new Error('请先填写至少一项再进行 AI 优化');
    const optimizationPrompt = [
      '你是一名编剧编辑，请优化用户给出的"故事大纲前置设定"。',
      '规则：', '1. 不改变用户核心意图，不编造新事实。',
      '2. 用更清晰、可执行、具体的表达。', '3. 字段为空时保留空字符串。',
      '4. 仅返回 JSON，不要 Markdown，不要解释。',
      '返回格式：{"genre":"","protagonist":"","conflict":"","usage":"","ending":"","extraNotes":""}',
      '', `输入 JSON：${JSON.stringify(normalizedDraft)}`,
    ].join('\n');
    try {
      if (!isServerWorkspaceReady) {
        throw new Error('本地后端未就绪，AI 优化必须通过已保存的后端 API 通道执行');
      }

      const endpoints = await listServerAiEndpoints();
      const endpoint = selectAiEndpointForSettings(endpoints, aiSettings, serverAiEndpointId);
      if (!endpoint) {
        throw new Error('未找到可用的 AI 通道，请先在“设置 > API 通道”中创建、启用并保存密钥');
      }

      const model =
        resolveAiTaskRequestModel(endpoint, aiSettings) ||
        endpoint.defaultModel?.trim() ||
        aiSettings.model;
      const result = await testServerAiCompletionByEndpoint(
        endpoint.id,
        { ...aiSettings, model },
        optimizationPrompt,
        {
          forceStreamFallback: aiSettings.forceStreamFallback !== false,
        },
      );
      return parseStoryOutlineDraftFromAiContent(result.content || '');
    } catch (error) {
      showToast({ type: 'error', title: 'AI优化失败', message: error instanceof Error ? error.message : '无法优化当前补充内容' });
      throw error;
    }
  }, [aiSettings, isAiConfigured, isServerWorkspaceReady, serverAiEndpointId, showToast]);

  return {
    editingMessage, setEditingMessage, rewindingMessageId, setRewindingMessageId,
    deletingMessageId, setDeletingMessageId, isRewindSend, setIsRewindSend,
    handleStartEditingMessage, handleCancelEditing, handleRevokeMessage, handleRevokeUserMessage,
    handleDeleteMessage, handleDeleteMessageForItem, handleCopyMessage, handleCopyMessageForItem,
    executeSendPayload, pendingSendPayload, setPendingSendPayload,
    pendingSendAfterProjectCreate, setPendingSendAfterProjectCreate,
    skipProjectCreationPrompt, setSkipProjectCreationPrompt,
    showProjectCreateConfirm, setShowProjectCreateConfirm,
    showCreateProjectModal, setShowCreateProjectModal,
    newProjectName, setNewProjectName,
    handleSendMessage, handleDeclineProjectCreation,
    handleCreateProjectBeforeSend, handleCreateProjectOnly,
    handleOpenCreateProjectModal, handleCancelPendingTasks,
    handleFilesSelected, handleRemoveAttachment,
    pendingAttachments, setPendingAttachments,
    inputValue, setInputValue, draftResourceRefs, setDraftResourceRefs,
    mentionPrefix, setMentionPrefix, mentionSearchText, setMentionSearchText,
    handleInputChange, handleKeyDown, handleMentionClick,
    pendingCancelableTaskIds, mentionOptions, handleOptimizeStoryOutlineDraft,
  };
}
