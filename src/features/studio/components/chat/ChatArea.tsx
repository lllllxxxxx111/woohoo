/**
 * ChatArea - 聊天区域主组件
 *
 * 负责组合消息分组、消息操作、工作流守卫等 hooks，
 * 以及编排 ChatInputArea、AgentSidePanel、ProjectCreateModal 等子组件。
 */
import React, { Suspense, lazy, useEffect, useState, useMemo, useCallback } from 'react';
import { Settings2, Bot, LoaderCircle, Sparkles, Square, Users } from 'lucide-react';
import { Button, Tag, Empty, Avatar, Typography, Space } from '@arco-design/web-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { useToast } from '../../../../context/useToast';
import { useAppActions } from '../../../../context/useAppActions';
import { AI_PROVIDER_PRESETS } from '../../../../lib/ai';
import {
  listServerAgents,
  updateServerAgent,
  createCollaborationSession,
  dispatchCollaboration,
} from '../../../../lib/serverApi';
import type { CreateAgentInput } from '../../../../lib/serverApi';
import type { AgentContact } from '../../../../types';
import { TaskGroupItem } from './ChatMessageGroupItem';
import { useMessageGroups, EMPTY_MESSAGES } from './hooks/useMessageGroups';
import { useWorkflowGuard } from './hooks/useWorkflowGuard';
import { useMessageActions } from './hooks/useMessageActions';
import { ChatInputArea } from './ChatInputArea';
import { AgentSidePanel } from './AgentSidePanel';
import { ProjectCreateModal } from './ProjectCreateModal';
import { CollaborationStatus } from './CollaborationStatus';
import { CollaborationAlert } from './CollaborationAlert';
import styles from './ChatArea.module.css';

const AgentDetailModal = lazy(() => import('./AgentDetailModal'));
const AgentEditModal = lazy(() => import('./AgentEditModal'));

const { Title, Text } = Typography;

/** 主聊天区域组件 */
export const ChatArea: React.FC = () => {
  const { showToast } = useToast();
  const { sendAiMessage } = useAppActions();

  const {
    projects,
    globalChatMessages,
    assets,
    activeState,
    agentContacts,
    aiSettings,
    isAiConfigured,
    isAiResponding,
    isServerWorkspaceReady,
    setActiveProject,
    setSettingsOpen,
    activeCollaborationSession,
    activeCollaborationAssignments,
    collaborationLoopCheckResult,
  } = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      globalChatMessages: state.globalChatMessages,
      assets: state.assets,
      activeState: state.activeState,
      agentContacts: state.agentContacts,
      aiSettings: state.aiSettings,
      isAiConfigured: state.isAiConfigured,
      isAiResponding: state.isAiResponding,
      isServerWorkspaceReady: state.isServerWorkspaceReady,
      setActiveProject: state.setActiveProject,
      setSettingsOpen: state.setSettingsOpen,
      activeCollaborationSession: state.activeCollaborationSession,
      activeCollaborationAssignments: state.activeCollaborationAssignments,
      collaborationLoopCheckResult: state.collaborationLoopCheckResult,
    })),
  );

  /** 智能体详情模态框状态 */
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  /** 智能体编辑模态框状态 */
  const [editModalVisible, setEditModalVisible] = useState(false);
  /** 当前选中的智能体数据 */
  const [selectedAgent, setSelectedAgent] = useState<AgentContact | null>(null);

  /** 同步智能体数据到 store */
  const syncAgentsToStore = useCallback((nextAgents: AgentContact[]) => {
    const latestAgentsById = new Map(nextAgents.map((agent) => [agent.id, agent]));
    useAppStore.setState((state) => ({
      allAgentContacts: nextAgents,
      projects: state.projects.map((project) => {
        if (!Array.isArray(project.agentRoster) || project.agentRoster.length === 0) {
          return project;
        }

        let hasChanged = false;
        const nextRoster = project.agentRoster.map((agent) => {
          const latest = latestAgentsById.get(agent.id);
          if (!latest) {
            return agent;
          }
          if (latest !== agent) {
            hasChanged = true;
          }
          return latest;
        });

        return hasChanged ? { ...project, agentRoster: nextRoster } : project;
      }),
    }));
  }, []);

  const activeProject = projects.find((p) => p.id === activeState.projectId);
  const activeChat = activeProject?.chatSessions.find((c) => c.id === activeState.chatSessionId);
  const rawMessages = activeState.projectId
    ? (activeChat?.messages ?? EMPTY_MESSAGES)
    : globalChatMessages;
  const activeMessages = rawMessages;
  const isReady = isServerWorkspaceReady;

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const providerLabel = AI_PROVIDER_PRESETS[aiSettings.provider]?.label || 'AI 模型';
  const conversationKey = `${activeState.projectId || 'global'}:${activeState.chatSessionId || 'global'}`;

  /** 消息分组 Hook */
  const messageGroupsState = useMessageGroups({
    activeMessages,
    conversationKey,
    isAiResponding,
  });

  /** 消息操作 Hook */
  const messageActions = useMessageActions({
    activeProject,
    activeChat,
    activeState,
    activeMessages,
    agentContacts,
    assets,
    projectNameById,
    isAiResponding,
    isAiConfigured,
    aiSettings,
    isAtBottomRef: messageGroupsState.isAtBottomRef,
    setSettingsOpen,
    setActiveProject,
  });

  /** 工作流守卫 Hook */
  const workflowGuardResult = useWorkflowGuard({
    activeMessages,
    agentContacts,
    assets,
    sendAiMessage,
    showToast,
    isAtBottomRef: messageGroupsState.isAtBottomRef,
  });

  const activeAgentsMap = useMemo(
    () => new Map(agentContacts.map((a) => [a.id, a])),
    [agentContacts],
  );

  /** 处理查看智能体详情 */
  const handleViewAgentDetail = useCallback((agent: AgentContact) => {
    setSelectedAgent(agent);
    setDetailModalVisible(true);
  }, []);

  /** 处理编辑智能体 */
  const handleEditAgent = useCallback((agent: AgentContact) => {
    setSelectedAgent(agent);
    setDetailModalVisible(false);
    setEditModalVisible(true);
  }, []);

  /** 处理保存智能体编辑数据 */
  const handleSaveAgent = useCallback(
    async (data: Partial<AgentContact>) => {
      if (!selectedAgent) return;
      try {
        showToast({ type: 'info', title: '保存中', message: '正在更新智能体信息...' });
        const payload: CreateAgentInput = {
          name: (data.name ?? selectedAgent.name).trim(),
          role: (data.role ?? selectedAgent.role).trim(),
          systemPrompt: (data.systemPrompt ?? selectedAgent.systemPrompt ?? '').trim(),
          description:
            data.description !== undefined
              ? (data.description || '').trim() || undefined
              : selectedAgent.description,
          endpointId:
            data.endpointId !== undefined
              ? (data.endpointId || '').trim() || undefined
              : selectedAgent.endpointId,
          model:
            data.model !== undefined ? (data.model || '').trim() || undefined : selectedAgent.model,
          temperature:
            data.temperature !== undefined ? data.temperature : selectedAgent.temperature,
          maxTokens: data.maxTokens !== undefined ? data.maxTokens : selectedAgent.maxTokens,
          badge:
            data.badge !== undefined
              ? (data.badge || '').trim() || undefined
              : (selectedAgent.badge || '').trim() || undefined,
        };

        await updateServerAgent(selectedAgent.id, payload);
        const refreshedAgents = await listServerAgents();
        syncAgentsToStore(refreshedAgents);
        showToast({ type: 'success', title: '保存成功', message: '智能体信息已更新' });
        setEditModalVisible(false);
        setSelectedAgent(null);
      } catch (error) {
        showToast({
          type: 'error',
          title: '保存失败',
          message: error instanceof Error ? error.message : '未知错误',
        });
      }
    },
    [selectedAgent, syncAgentsToStore, showToast],
  );

  /** 处理关闭详情模态框 */
  const handleCloseDetailModal = useCallback(() => {
    setDetailModalVisible(false);
    setSelectedAgent(null);
  }, []);

  /** 处理关闭编辑模态框 */
  const handleCloseEditModal = useCallback(() => {
    setEditModalVisible(false);
    setSelectedAgent(null);
  }, []);

  /** 启动协同会话：创建会话并分派当前项目智能体 */
  const [isStartingCollaboration, setIsStartingCollaboration] = useState(false);
  const handleStartCollaboration = useCallback(async () => {
    if (!activeProject || !activeState.chatSessionId) {
      showToast({ type: 'warning', title: '无法启动协同', message: '请先选择项目和对话。' });
      return;
    }

    setIsStartingCollaboration(true);
    try {
      const session = await createCollaborationSession({
        projectId: activeProject.id,
        conversationId: activeState.chatSessionId,
      });

      useAppStore.getState().setCollaborationSession(session);

      const projectAgents = agentContacts.filter((a) =>
        activeProject.agentRoster?.some((r) => r.id === a.id),
      );

      if (projectAgents.length > 0) {
        const dispatchResult = await dispatchCollaboration(session.id, {
          assignments: projectAgents.map((agent) => ({
            agentId: agent.id,
            taskType: agent.role || 'general',
            goal: agent.systemPrompt?.slice(0, 200) || `执行${agent.role || '通用'}任务`,
          })),
        });

        useAppStore.getState().setCollaborationAssignments(dispatchResult.assignments);
      }

      showToast({
        type: 'success',
        title: '协同会话已启动',
        message: `会话ID: ${session.id.slice(0, 8)}...，已分派 ${projectAgents.length} 个智能体`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '启动协同失败',
        message: error instanceof Error ? error.message : '未知错误',
      });
    } finally {
      setIsStartingCollaboration(false);
    }
  }, [activeProject, activeState.chatSessionId, agentContacts, showToast]);

  /** 会话切换时重置消息操作状态 */
  useEffect(() => {
    messageActions.setEditingMessage(null);
    messageActions.setRewindingMessageId(null);
    messageActions.setDeletingMessageId(null);
    messageActions.setDraftResourceRefs([]);
    messageActions.setMentionSearchText('');
  }, [conversationKey]);

  return (
    <div className={styles.containerLayout}>
      <div className={styles.chatArea}>
        {/* 聊天头部 */}
        <div className={styles.chatHeader}>
          <div className={styles.chatInfo}>
            <Title
              heading={5}
              style={{ margin: 0, fontSize: '15px', color: 'var(--text-primary)' }}
            >
              {activeProject ? activeChat?.title || '新的工作对话' : '全局AI助手'}
            </Title>
            <Space size="small" style={{ marginTop: 2 }}>
              <Tag
                size="small"
                color={isAiConfigured ? 'green' : 'orange'}
                bordered
                style={{ fontSize: '11px', height: '20px' }}
              >
                {isAiConfigured ? providerLabel : '未配置'}
              </Tag>
              <Tag
                size="small"
                color="arcoblue"
                bordered
                style={{ fontSize: '11px', height: '20px' }}
              >
                {aiSettings.model || 'N/A'}
              </Tag>
            </Space>
          </div>
          <div className={styles.headerActions}>
            {activeProject && !activeCollaborationSession && (
              <Button
                type="secondary"
                shape="round"
                size="small"
                icon={<Users size={14} />}
                onClick={() => void handleStartCollaboration()}
                loading={isStartingCollaboration}
                style={{ fontSize: '12px' }}
              >
                启动协同
              </Button>
            )}
            {!activeProject && (
              <Button
                type="primary"
                shape="round"
                size="small"
                onClick={() =>
                  messageActions.handleOpenCreateProjectModal(messageActions.inputValue.trim())
                }
                style={{ fontSize: '12px' }}
              >
                创建项目
              </Button>
            )}
            <Button
              icon={<Settings2 size={14} />}
              onClick={() => setSettingsOpen(true)}
              type="secondary"
              shape="round"
              size="small"
              style={{ fontSize: '12px' }}
            >
              配置模型
            </Button>
          </div>
        </div>

        {/* 协同状态展示 */}
        {activeCollaborationSession && (
          <CollaborationStatus
            session={activeCollaborationSession}
            assignments={activeCollaborationAssignments}
          />
        )}
        <CollaborationAlert loopCheckResult={collaborationLoopCheckResult} />

        {/* 消息列表 */}
        <div
          className={styles.messageList}
          ref={messageGroupsState.scrollRef}
          onScroll={messageGroupsState.handleScroll}
        >
          {!isReady ? (
            <div className={styles.initializingPlaceholder}>
              <LoaderCircle size={20} className={styles.spinner} style={{ opacity: 0.4 }} />
              <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                加载对话记录...
              </span>
            </div>
          ) : activeMessages.length === 0 ? (
            <div className={styles.emptyState}>
              <Empty
                icon={<Sparkles size={40} className={styles.emptyIcon} />}
                description={
                  <div className={styles.emptyContent}>
                    <Title heading={6}>开启智能创作之旅</Title>
                    <Text type="secondary">
                      {isAiConfigured
                        ? activeProject
                          ? '在这里输入您的需求，或通过 @ 提及特定职能的智能体。系统将协助您完成从创意到落地的全过程。'
                          : '当前是全局对话模式。发送消息后可继续全局沟通，或先创建项目进入项目化工作流。'
                        : '当前尚未检测到有效的大模型配置，请先点击此处或导航进入设置页面完成初始化。'}
                    </Text>
                    <div className={styles.emptyAction}>
                      <Button type="primary" shape="round" onClick={() => setSettingsOpen(true)}>
                        {isAiConfigured ? '管理配置' : '去配置 AI'}
                      </Button>
                    </div>
                  </div>
                }
              />
            </div>
          ) : (
            <>
              {/* 任务折叠控制栏 */}
              {messageGroupsState.messageGroups.length > 2 && (
                <div className={styles.groupControlBar}>
                  <span className={styles.groupControlLabel}>
                    共 {messageGroupsState.messageGroups.length} 个任务单元
                  </span>
                  <Space size="small">
                    <Button size="mini" onClick={() => messageGroupsState.collapseAllGroups(true)}>
                      全部折叠
                    </Button>
                    <Button size="mini" onClick={() => messageGroupsState.collapseAllGroups(false)}>
                      全部展开
                    </Button>
                  </Space>
                </div>
              )}

              {messageGroupsState.hasHiddenGroups && (
                <button
                  type="button"
                  className={styles.loadEarlierGroupsBtn}
                  onClick={messageGroupsState.loadOlderGroups}
                >
                  显示更早记录（剩余 {messageGroupsState.hiddenGroupCount} 个任务单元）
                </button>
              )}

              {/* 按任务组渲染消息 */}
              {messageGroupsState.visibleMessageGroups.map((group) => {
                const isCollapsed = messageGroupsState.collapsedGroups.has(group.id);
                const isTaskGroup = group.type === 'user_task' && group.messages.length > 1;

                return (
                  <TaskGroupItem
                    key={group.id}
                    group={group}
                    isCollapsed={isCollapsed}
                    isTaskGroup={isTaskGroup}
                    onToggle={() => messageGroupsState.toggleGroupCollapse(group.id)}
                    activeAgentsMap={activeAgentsMap}
                    agentContacts={agentContacts}
                    activeAssets={assets}
                    currentProjectId={activeState.projectId}
                    canEditUserMessage={Boolean(activeProject && activeChat)}
                    onOptimizeStoryOutlineDraft={messageActions.handleOptimizeStoryOutlineDraft}
                    onWorkflowGuardConfirm={workflowGuardResult.handleWorkflowGuardConfirmForMessage}
                    submittingWorkflowGuardId={workflowGuardResult.submittingWorkflowGuardId}
                    pendingWorkflowGuardIds={workflowGuardResult.pendingWorkflowGuardIds}
                    confirmedWorkflowGuardIds={workflowGuardResult.confirmedWorkflowGuardIds}
                    onMentionClick={messageActions.handleMentionClick}
                    onEditUserMessage={messageActions.handleStartEditingMessage}
                    onRevokeUserMessage={messageActions.handleRevokeUserMessage}
                    onDeleteMessage={messageActions.handleDeleteMessageForItem}
                    onCopyMessage={messageActions.handleCopyMessageForItem}
                    rewindingMessageId={messageActions.rewindingMessageId}
                    deletingMessageId={messageActions.deletingMessageId}
                  />
                );
              })}
            </>
          )}

          {/* AI 思考气泡 */}
          {(() => {
            const hasStreamingMessage = activeMessages.some(
              (m) =>
                m.role === 'ai' &&
                (m.status === 'pending' ||
                  m.meta?.taskStatus === 'running' ||
                  m.meta?.taskStatus === 'queued'),
            );
            return isAiResponding && !hasStreamingMessage;
          })() && (
              <div className={`${styles.messageWrapper} ${styles.ai}`}>
                <Avatar size={34} style={{ backgroundColor: 'var(--color-fill-1)' }}>
                  <Bot size={18} />
                </Avatar>
                <div className={styles.messageBody}>
                  <div className={`${styles.messageContent} ${styles.thinkingBubble}`}>
                    <LoaderCircle size={14} className={styles.spinner} style={{ marginRight: 8 }} />
                    <span style={{ fontSize: '13px' }}>正在为您构建深度回复...</span>
                    <button
                      className={styles.cancelThinkingBtn}
                      onClick={() => {
                        void messageActions.handleCancelPendingTasks();
                      }}
                      title={
                        messageActions.pendingCancelableTaskIds.length > 0
                          ? '停止等待'
                          : '当前无可取消任务'
                      }
                      type="button"
                      disabled={messageActions.pendingCancelableTaskIds.length === 0}
                    >
                      <Square size={12} />
                    </button>
                  </div>
                </div>
              </div>
            )}

          <div ref={messageGroupsState.bottomRef}></div>
        </div>

        {/* 输入区域 */}
        <ChatInputArea
          inputValue={messageActions.inputValue}
          onInputChange={messageActions.handleInputChange}
          onKeyDown={messageActions.handleKeyDown}
          onSend={messageActions.handleSendMessage}
          mentionOptions={messageActions.mentionOptions}
          onMentionPrefixChange={messageActions.setMentionPrefix}
          onMentionSearchTextChange={messageActions.setMentionSearchText}
          editingMessage={messageActions.editingMessage}
          onCancelEditing={messageActions.handleCancelEditing}
          pendingAttachments={messageActions.pendingAttachments}
          onRemoveAttachment={messageActions.handleRemoveAttachment}
          onFilesSelected={messageActions.handleFilesSelected}
          draftResourceRefs={messageActions.draftResourceRefs}
          projectNameById={projectNameById}
          isAiResponding={isAiResponding}
          isAiConfigured={isAiConfigured}
          activeProject={activeProject}
          showProjectCreateConfirm={messageActions.showProjectCreateConfirm}
          pendingSendPayload={messageActions.pendingSendPayload}
          onCreateProjectConfirm={() => {
            messageActions.setShowProjectCreateConfirm(false);
            messageActions.handleOpenCreateProjectModal(messageActions.pendingSendPayload?.content);
          }}
          onDeclineProjectCreation={messageActions.handleDeclineProjectCreation}
          onCancelProjectCreation={() => {
            messageActions.setShowProjectCreateConfirm(false);
            messageActions.setPendingSendPayload(null);
          }}
          rewindingMessageId={messageActions.rewindingMessageId}
          deletingMessageId={messageActions.deletingMessageId}
        />
      </div>

      {/* 智能体侧边栏 */}
      <AgentSidePanel
        agentContacts={agentContacts}
        activeProject={activeProject}
        onMentionClick={messageActions.handleMentionClick}
        onViewAgentDetail={handleViewAgentDetail}
        onEditAgent={handleEditAgent}
      />

      {/* 项目创建弹窗 */}
      <ProjectCreateModal
        visible={messageActions.showCreateProjectModal}
        pendingSendPayload={messageActions.pendingSendPayload}
        newProjectName={messageActions.newProjectName}
        onNewProjectNameChange={messageActions.setNewProjectName}
        onCreateBeforeSend={messageActions.handleCreateProjectBeforeSend}
        onCreateOnly={messageActions.handleCreateProjectOnly}
        onClose={() => {
          messageActions.setShowCreateProjectModal(false);
          messageActions.setShowProjectCreateConfirm(false);
          messageActions.setPendingSendPayload(null);
        }}
      />

      <Suspense fallback={null}>
        {detailModalVisible ? (
          <AgentDetailModal
            visible={detailModalVisible}
            agent={selectedAgent}
            onClose={handleCloseDetailModal}
            onEdit={handleEditAgent}
          />
        ) : null}
        {editModalVisible ? (
          <AgentEditModal
            visible={editModalVisible}
            agent={selectedAgent}
            onClose={handleCloseEditModal}
            onSave={handleSaveAgent}
          />
        ) : null}
      </Suspense>
    </div>
  );
};
