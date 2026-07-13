/**
 * ChatInputArea - 聊天输入区域组件
 *
 * 包含项目创建确认条、编辑提示条、附件预览、资源引用标签、文件上传按钮、
 * Mentions 输入框和发送按钮。
 */
import React from 'react';
import { Send, X } from 'lucide-react';
import { Button, Tag, Space, Mentions } from '@arco-design/web-react';
import type { ResourceRef, MessageAttachment } from '../../../../types';
import type { SendPayload } from './hooks/useMessageActions';
import FileUploadButton from './FileUploadButton';
import AttachmentPreview from './AttachmentPreview';
import { formatAssetTypeLabel } from './chatAreaUtils';
import styles from './ChatArea.module.css';

/** Mentions 组件的选项类型 */
type MentionOption = string | number | {
  label: React.ReactNode;
  value: string | number;
  disabled?: boolean;
  [key: string]: unknown;
};

/** ChatInputArea 组件的 Props */
export type ChatInputAreaProps = {
  /** 输入框当前值 */
  inputValue: string;
  /** 输入框内容变化回调 */
  onInputChange: (value: string) => void;
  /** 键盘按下事件回调 */
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** 发送消息回调 */
  onSend: () => void;
  /** @/# 提及选项 */
  mentionOptions: MentionOption[];
  /** 提及前缀变化回调 */
  onMentionPrefixChange: (prefix: string) => void;
  /** 提及搜索文本变化回调 */
  onMentionSearchTextChange: (text: string) => void;
  /** 当前正在编辑的消息 */
  editingMessage: { messageId: string; agentId?: string } | null;
  /** 取消编辑回调 */
  onCancelEditing: () => void;
  /** 待发送附件列表 */
  pendingAttachments: MessageAttachment[];
  /** 移除附件回调 */
  onRemoveAttachment: (index: number) => void;
  /** 文件选择回调 */
  onFilesSelected: (files: File[]) => void;
  /** 草稿资源引用列表 */
  draftResourceRefs: ResourceRef[];
  /** 项目名称映射（按 ID） */
  projectNameById: Map<string, string>;
  /** AI 是否正在响应 */
  isAiResponding: boolean;
  /** AI 是否已配置 */
  isAiConfigured: boolean;
  /** 当前活跃项目 */
  activeProject: { id: string; name: string } | undefined;
  /** 是否显示项目创建确认 */
  showProjectCreateConfirm: boolean;
  /** 待发送的消息载荷 */
  pendingSendPayload: SendPayload | null;
  /** 确认创建项目回调 */
  onCreateProjectConfirm: () => void;
  /** 拒绝创建项目回调 */
  onDeclineProjectCreation: () => void;
  /** 取消项目创建确认回调 */
  onCancelProjectCreation: () => void;
  /** 正在撤回的消息 ID */
  rewindingMessageId: string | null;
  /** 正在删除的消息 ID */
  deletingMessageId: string | null;
};

/**
 * 聊天输入区域组件
 *
 * 渲染项目创建确认条、编辑提示条、附件预览、资源引用标签、
 * 文件上传按钮、Mentions 输入框和发送按钮。
 *
 * @param props - 输入区域所需的全部 props
 * @returns 输入区域 JSX
 */
export const ChatInputArea: React.FC<ChatInputAreaProps> = ({
  inputValue,
  onInputChange,
  onKeyDown,
  onSend,
  mentionOptions,
  onMentionPrefixChange,
  onMentionSearchTextChange,
  editingMessage,
  onCancelEditing,
  pendingAttachments,
  onRemoveAttachment,
  onFilesSelected,
  draftResourceRefs,
  projectNameById,
  isAiResponding,
  isAiConfigured,
  activeProject,
  showProjectCreateConfirm,
  pendingSendPayload,
  onCreateProjectConfirm,
  onDeclineProjectCreation,
  onCancelProjectCreation,
  rewindingMessageId,
  deletingMessageId,
}) => {
  return (
    <div className={styles.inputArea}>
      {/* 项目创建确认条 */}
      {showProjectCreateConfirm && pendingSendPayload && !activeProject && (
        <div className={styles.projectCreateConfirm}>
          <div className={styles.projectCreateConfirmTitle}>创建项目确认</div>
          <div className={styles.projectCreateConfirmText}>
            当前是全局对话。是否先创建项目并进入项目工作流？
          </div>
          <div className={styles.projectCreateConfirmActions}>
            <Button type="primary" size="small" onClick={onCreateProjectConfirm}>
              是，先创建项目
            </Button>
            <Button size="small" onClick={() => void onDeclineProjectCreation()}>
              否，继续全局对话
            </Button>
            <Button size="small" type="text" onClick={onCancelProjectCreation}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* 编辑提示条 */}
      {editingMessage && (
        <div className={styles.editingBanner}>
          <div className={styles.editingBannerText}>
            正在编辑已发送消息。发送后会先撤回该条及后续内容，再按新内容重发。
          </div>
          <button type="button" className={styles.editingBannerClose} onClick={onCancelEditing}>
            <X size={14} />
            取消编辑
          </button>
        </div>
      )}

      {/* 附件预览 */}
      {pendingAttachments.length > 0 && (
        <AttachmentPreview
          attachments={pendingAttachments}
          onRemove={onRemoveAttachment}
          source="pending"
        />
      )}

      {/* 资源引用标签 */}
      {draftResourceRefs.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <Space size={6} wrap>
            {draftResourceRefs.map((resourceRef) => (
              <Tag key={resourceRef.id} size="small" color="green">
                #
                {resourceRef.projectName ||
                  projectNameById.get(resourceRef.projectId || '') ||
                  '当前项目'}
                ：{formatAssetTypeLabel(resourceRef.type)}：{resourceRef.name}：
                {resourceRef.versionLabel || '当前版'}· {resourceRef.id.slice(-6)}
              </Tag>
            ))}
          </Space>
        </div>
      )}

      {/* 输入框与发送按钮 */}
      <div className={styles.inputBox}>
        <FileUploadButton
          onFilesSelected={onFilesSelected}
          disabled={!activeProject || isAiResponding}
        />
        <Mentions
          prefix={['@', '#']}
          onSearch={(text, prefix) => {
            onMentionPrefixChange(prefix);
            onMentionSearchTextChange(prefix === '#' ? text : '');
          }}
          value={inputValue}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          options={mentionOptions}
          filterOption={false}
          placeholder={
            isAiConfigured
              ? editingMessage
                ? '修改后发送将先回退该消息及后续内容...'
                : activeProject
                  ? '描述您的需求，或输入 @ 智能体、# 资源引用（默认当前项目，也可搜索其他项目）...'
                  : '当前为全局对话模式，可直接沟通或先创建项目...'
              : '请先完成 AI 接入配置'
          }
          style={{
            flex: 1,
            border: 'none',
            backgroundColor: 'transparent',
            boxShadow: 'none',
            fontSize: '14px',
          }}
          autoSize={{ minRows: 1, maxRows: 6 }}
          maxLength={5000}
        />
        <Button
          type="primary"
          shape="circle"
          icon={<Send size={16} />}
          onClick={onSend}
          disabled={
            isAiResponding ||
            rewindingMessageId !== null ||
            deletingMessageId !== null ||
            (!inputValue.trim() && pendingAttachments.length === 0)
          }
          style={{ marginLeft: 8, flexShrink: 0 }}
        />
      </div>
    </div>
  );
};
