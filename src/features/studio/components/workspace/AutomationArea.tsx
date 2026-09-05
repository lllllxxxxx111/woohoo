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
  Square,
  Copy,
  RotateCw,
} from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { useToast } from '../../../../context/useToast';
import { cancelTask, retryTask } from '../../../../lib/ai';
import type { AiTask } from '../../../../lib/serverApi';
import styles from './AutomationArea.module.css';

/** 复制文本到剪贴板：优先 Clipboard API，不可用时回退 execCommand */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 忽略并回退到 execCommand
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const succeeded = document.execCommand('copy');
    document.body.removeChild(textarea);
    return succeeded;
  } catch {
    return false;
  }
}

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
  const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(new Set());
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(new Set());
  const { showToast } = useToast();

  const handleCancelTask = async (taskId: string) => {
    if (cancellingIds.has(taskId)) {
      return;
    }
    setCancellingIds((prev) => new Set(prev).add(taskId));
    try {
      await cancelTask(taskId);
      showToast({ type: 'success', title: '已请求取消', message: '取消指令已发送，等待任务终止' });
    } catch (error) {
      showToast({
        type: 'error',
        title: '取消失败',
        message: error instanceof Error ? error.message : '无法取消该任务',
      });
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  /**
   * 重试失败任务：服务端以原任务的会话/内容/端点偏好重新发起并计费，
   * 新任务经 SSE 快照回流到本列表
   */
  const handleRetryTask = async (taskId: string) => {
    if (retryingIds.has(taskId)) {
      return;
    }
    setRetryingIds((prev) => new Set(prev).add(taskId));
    try {
      const next = await retryTask(taskId);
      showToast({
        type: 'success',
        title: '已重新发起',
        message: `新任务 ${next.id.slice(0, 8)} 已排队，按原参数重新计费。`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '重试失败',
        message:
          error instanceof Error
            ? error.message
            : '无法重试该任务（服务重启后历史任务不可重试，请回会话重新发起）',
      });
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  /**
   * 服务端没有针对历史任务的复制场景时，提供原始请求复制，
   * 方便回到对应会话/入口重新发起
   */
  const handleCopyTaskRequest = async (task: AiTask) => {
    const succeeded = await copyTextToClipboard(task.content);
    showToast({
      type: succeeded ? 'success' : 'error',
      title: succeeded ? '原始请求已复制' : '复制失败',
      message: succeeded
        ? '已复制失败任务的原始请求，可到对应会话或功能入口重新发起。'
        : '当前环境不支持自动复制，请手动记录任务内容。',
    });
  };

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

  const filteredTasks = tasks.filter((task) => {
    const matchesStatus = !statusFilter || task.status === statusFilter;
    const matchesSearch = `${parseTaskName(task)} ${task.content}`
      .toLowerCase()
      .includes(searchQuery.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  const statusFilterLabel = (value: string) =>
    value === 'running' ? '运行中' : value === 'completed' ? '已完成' : '失败';

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
            const next =
              statusFilter === null
                ? 'running'
                : statusFilter === 'running'
                  ? 'completed'
                  : statusFilter === 'completed'
                    ? 'failed'
                    : null;
            setStatusFilter(next);
            showToast({ type: 'info', title: '筛选', message: next ? `显示：${statusFilterLabel(next)}` : '显示全部' });
          }}>
            <Filter size={16} /> 筛选{statusFilter ? `（${statusFilterLabel(statusFilter)}）` : ''}
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

      {filteredTasks.length === 0 ? (
        <div className={styles.emptyContainer}>
          <div className={styles.emptyIcon}>
            <AutomationEmpty />
          </div>
          <h3>{isConnected ? '暂无自动化任务' : '暂时无法获取任务'}</h3>
          <p>
            {!isConnected
              ? '与后端的实时连接未建立，任务列表可能不完整。请确认本地服务已启动后重试。'
              : statusFilter
                ? `没有${statusFilterLabel(statusFilter)}的任务，可切换筛选或清除搜索条件。`
                : activeState.chatSessionId
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
                  {(task.status === 'queued' || task.status === 'running') && (
                    <button
                      className={styles.toolBtn}
                      disabled={cancellingIds.has(task.id)}
                      onClick={() => void handleCancelTask(task.id)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        opacity: cancellingIds.has(task.id) ? 0.6 : 1,
                      }}
                    >
                      <Square size={12} /> {cancellingIds.has(task.id) ? '取消中' : '取消任务'}
                    </button>
                  )}
                  {task.status === 'failed' && (
                    <>
                      <button
                        className={styles.toolBtn}
                        disabled={retryingIds.has(task.id)}
                        onClick={() => void handleRetryTask(task.id)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          opacity: retryingIds.has(task.id) ? 0.6 : 1,
                        }}
                      >
                        <RotateCw size={12} /> {retryingIds.has(task.id) ? '重试中' : '重试任务'}
                      </button>
                      <button
                        className={styles.toolBtn}
                        onClick={() => void handleCopyTaskRequest(task)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <Copy size={12} /> 复制原始请求
                      </button>
                    </>
                  )}
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
