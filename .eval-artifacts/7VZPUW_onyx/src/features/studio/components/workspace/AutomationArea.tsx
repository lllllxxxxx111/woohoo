import React, { useState } from 'react';
import {
  Search,
  Filter,
  Zap,
  Film,
  Bot,
  Image as ImageIcon,
  FileText,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { useToast } from '../../../../context/useToast';
import type { AiTask } from '../../../../lib/serverApi';
import styles from './AutomationArea.module.css';

export const AutomationArea: React.FC = () => {
  const { activeState, aiTasks: tasks, isSseConnected: isConnected, sseError } = useAppStore(
    useShallow((state) => ({
      activeState: state.activeState,
      aiTasks: state.aiTasks,
      isSseConnected: state.isSseConnected,
      sseError: state.sseError,
    })),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const { showToast } = useToast();

  const getStatusClass = (status: string) => {
    switch (status) {
      case 'queued':
        return styles.statusPending;
      case 'running':
        return styles.statusRunning;
      case 'completed':
        return styles.statusCompleted;
      case 'failed':
        return styles.statusFailed;
      default:
        return styles.statusPending;
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'queued':
        return '排队中';
      case 'running':
        return '执行中';
      case 'completed':
        return '已完成';
      case 'failed':
        return '失败';
      default:
        return '未知';
    }
  };

  /**
   * 根据任务的产出类型解析任务名称
   * @param task - AI任务对象
   * @returns 任务名称字符串
   */
  const parseTaskName = (task: AiTask) => {
    switch (task.outputKind) {
      case 'image':
        return '图片生成任务';
      case 'video':
        return '视频生成任务';
      case 'document':
        return '文档生成任务';
      default:
        return task.agentId ? '智能体推理任务' : '文本生成任务';
    }
  };

  /**
   * 根据任务的产出类型返回对应的图标组件
   * @param task - AI任务对象
   * @returns 图标JSX元素
   */
  const getTaskIcon = (task: AiTask) => {
    switch (task.outputKind) {
      case 'image':
        return <ImageIcon size={20} />;
      case 'video':
        return <Film size={20} />;
      case 'document':
        return <FileText size={20} />;
      default:
        return task.agentId ? <Bot size={20} /> : <Zap size={20} />;
    }
  };

  const formatDate = (timestamp?: number | null) => {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  /**
   * 计算任务的持续耗时
   * @param task - AI任务对象
   * @returns 格式化的耗时字符串
   */
  const calculateDuration = (task: AiTask) => {
    if (!task.startedAt) return '-';
    const start = task.startedAt;
    const end = task.finishedAt ?? Date.now();
    const diff = Math.floor((end - start) / 1000);
    if (diff < 60) return `${diff} 秒`;
    return `${Math.floor(diff / 60)} 分 ${diff % 60} 秒`;
  };

  /**
   * 获取智能体运行状态的中文标签
   * @param task - AI任务对象
   * @returns 状态标签字符串
   */
  const getRuntimeLabel = (task: AiTask) => {
    switch (task.agentStatus) {
      case 'busy':
        return '忙碌';
      case 'queued':
        return '排队';
      case 'idle':
        return '空闲';
      default:
        return '未知';
    }
  };

  const filteredTasks = tasks.filter((task) =>
    `${parseTaskName(task)} ${task.content}`.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className={styles.container}>
      <div className={styles.topToolbar}>
        <div className={styles.searchBox}>
          <Search size={16} className={styles.searchIcon} />
          <input
            type="text"
            placeholder="搜索后端运行的自动化任务..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className={styles.actions}>
          <button className={styles.toolBtn} onClick={() => {
            const next = statusFilter === null ? 'running' : statusFilter === 'running' ? 'completed' : null;
            setStatusFilter(next);
            showToast({ type: 'info', title: '筛选', message: next ? `显示：${next === 'running' ? '运行中' : '已完成'}` : '显示全部' });
          }}>
            <Filter size={16} /> 筛选
          </button>
          <div className={styles.sseStatus}>
            {isConnected ? (
              <Wifi size={14} style={{ color: '#22c55e' }} />
            ) : (
              <WifiOff size={14} style={{ color: '#ef4444' }} />
            )}
          </div>
        </div>
      </div>

      {sseError && (
        <div className={styles.sseErrorBar}>
          <span>{sseError}</span>
        </div>
      )}

      {!isConnected && !sseError && <div className={styles.connectingBar}>正在建立实时连接...</div>}

      {filteredTasks.length === 0 && isConnected ? (
        <div className={styles.emptyContainer}>
          <div className={styles.emptyIcon}>
            <AutomationEmpty />
          </div>
          <h3>暂无自动化任务</h3>
          <p>
            {activeState.chatSessionId
              ? '当前会话下没有排队或正在处理的后端任务。'
              : activeState.projectId
                ? '当前项目下没有排队或正在处理的后端任务。'
                : '当前没有选中项目或会话。'}
          </p>
        </div>
      ) : (
        <div className={styles.taskList}>
          {filteredTasks.map((task, index) => (
            <div
              key={task.id}
              className={styles.taskCard}
              style={{ animationDelay: `${index * 0.05}s` }}
            >
              <div className={styles.taskHeader}>
                <div className={styles.taskTitle}>
                  <div className={styles.taskIcon}>{getTaskIcon(task)}</div>
                  <span className={styles.taskName}>{parseTaskName(task)}</span>
                </div>
                <div className={`${styles.taskStatus} ${getStatusClass(task.status)}`}>
                  <div className={styles.statusDot}></div>
                  <span>{getStatusLabel(task.status)}</span>
                </div>
              </div>
              <div className={styles.taskBody}>
                <div className={styles.taskInfo}>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>创建时间</span>
                    <span className={styles.infoValue}>{formatDate(task.createdAt)}</span>
                  </div>
                  {task.startedAt && (
                    <div className={styles.infoItem}>
                      <span className={styles.infoLabel}>状态更新</span>
                      <span className={styles.infoValue}>{formatDate(task.startedAt)}</span>
                    </div>
                  )}
                  {task.startedAt && task.status !== 'queued' && (
                    <div className={styles.infoItem}>
                      <span className={styles.infoLabel}>持续耗时</span>
                      <span className={styles.infoValue}>{calculateDuration(task)}</span>
                    </div>
                  )}
                </div>

                <div
                  style={{
                    marginTop: 12,
                    color: 'var(--color-text-3)',
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  {task.content}
                </div>

                <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {typeof task.attemptIndex === 'number' && task.attemptIndex > 0 && (
                    <span
                      className={`${styles.taskStatus} ${task.isRedo ? styles.statusRunning : styles.statusPending}`}
                    >
                      {task.isRedo
                        ? `重做第 ${task.attemptIndex} 次`
                        : `第 ${task.attemptIndex} 次尝试`}
                    </span>
                  )}
                  {typeof task.previousFailures === 'number' && task.previousFailures > 0 && (
                    <span className={`${styles.taskStatus} ${styles.statusFailed}`}>
                      历史失败 {task.previousFailures}
                    </span>
                  )}
                  {task.outputKind && (
                    <span className={styles.taskStatus}>
                      产出 {task.outputKind}
                      {typeof task.outputItems === 'number' && task.outputItems > 1
                        ? ` ×${task.outputItems}`
                        : ''}
                    </span>
                  )}
                </div>

                {(task.agentStatus ||
                  typeof task.activeTasks === 'number' ||
                  typeof task.queuedTasks === 'number') && (
                  <div
                    style={{
                      marginTop: 10,
                      color: 'var(--color-text-3)',
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    运行态：{getRuntimeLabel(task)}
                    {typeof task.activeTasks === 'number' ? ` · 执行中 ${task.activeTasks}` : ''}
                    {typeof task.queuedTasks === 'number' ? ` · 排队 ${task.queuedTasks}` : ''}
                  </div>
                )}

                {task.error && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 8,
                      background: 'var(--color-danger-light-1)',
                      borderRadius: 4,
                      color: 'var(--color-danger-dark-2)',
                      fontSize: 13,
                    }}
                  >
                    {task.error}
                  </div>
                )}

                {!task.error && task.lastError && task.isRedo && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 8,
                      background: 'var(--color-fill-2)',
                      borderRadius: 4,
                      color: 'var(--color-text-2)',
                      fontSize: 13,
                    }}
                  >
                    上次失败：{task.lastError}
                  </div>
                )}

                <div className={styles.taskActions}>
                  <span style={{ fontSize: 12, color: 'var(--color-text-4)' }}>
                    任务 ID: {task.id.slice(0, 8)}... {task.model ? `· ${task.model}` : ''}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const AutomationEmpty = () => (
  <svg
    width="64"
    height="64"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="12 2 2 7 12 12 22 7 12 2"></polyline>
    <path d="M2 17l10 5 10-5"></path>
    <path d="M2 12l10 5 10-5"></path>
  </svg>
);
