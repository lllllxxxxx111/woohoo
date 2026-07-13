/**
 * ProjectCreateModal - 项目创建弹窗组件
 *
 * 显示创建项目的模态弹窗，支持"创建并继续"和"仅创建"两种模式。
 */
import React from 'react';
import { X } from 'lucide-react';
import type { SendPayload } from './hooks/useMessageActions';
import styles from './ChatArea.module.css';

/** ProjectCreateModal 组件的 Props */
export type ProjectCreateModalProps = {
  /** 弹窗是否可见 */
  visible: boolean;
  /** 待发送的消息载荷（决定"创建并继续"模式） */
  pendingSendPayload: SendPayload | null;
  /** 新项目名称 */
  newProjectName: string;
  /** 项目名称变化回调 */
  onNewProjectNameChange: (name: string) => void;
  /** 创建项目并发送消息回调 */
  onCreateBeforeSend: () => void;
  /** 仅创建项目回调 */
  onCreateOnly: () => void;
  /** 关闭弹窗回调 */
  onClose: () => void;
};

/**
 * 项目创建弹窗组件
 *
 * 渲染项目创建模态弹窗，包含项目名称输入框和操作按钮。
 * 当存在 pendingSendPayload 时显示"创建并继续"，否则显示"创建"。
 *
 * @param props - 弹窗所需的全部 props
 * @returns 弹窗 JSX，visible 为 false 时返回 null
 */
export const ProjectCreateModal: React.FC<ProjectCreateModalProps> = ({
  visible,
  pendingSendPayload,
  newProjectName,
  onNewProjectNameChange,
  onCreateBeforeSend,
  onCreateOnly,
  onClose,
}) => {
  if (!visible) {
    return null;
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={(event) => event.stopPropagation()}>
        {/* 弹窗标题 */}
        <div className={styles.modalHeader}>
          <h3>{pendingSendPayload ? '先创建项目' : '创建项目'}</h3>
          <button type="button" className={styles.iconBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* 项目名称输入 */}
        <div className={styles.modalBody}>
          <label className={styles.modalLabel}>项目名称</label>
          <input
            className={styles.modalInput}
            type="text"
            value={newProjectName}
            onChange={(event) => onNewProjectNameChange(event.target.value)}
            placeholder="请输入项目名称"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                if (pendingSendPayload) {
                  void onCreateBeforeSend();
                } else {
                  void onCreateOnly();
                }
              }
            }}
          />
        </div>

        {/* 操作按钮 */}
        <div className={styles.modalFooter}>
          <button type="button" className={styles.modalBtnCancel} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={styles.modalBtnConfirm}
            onClick={() => {
              if (pendingSendPayload) {
                void onCreateBeforeSend();
              } else {
                void onCreateOnly();
              }
            }}
          >
            {pendingSendPayload ? '创建并继续' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
};
