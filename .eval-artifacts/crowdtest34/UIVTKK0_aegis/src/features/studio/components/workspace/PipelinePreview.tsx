import React from 'react';
import { Clock, CheckCircle, Layers, XCircle, Loader2, WifiOff, RotateCw, Ban } from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@arco-design/web-react';
import type { AiTask } from '../../../../lib/serverApi';
import { normalizeUiStatus, isTerminalState, STATE_USER_MESSAGES } from '../../../../lib/taskEventOrdering';
import { ReviewQueue } from './ReviewQueue';
import styles from './PipelinePreview.module.css';

export const PipelinePreview: React.FC = () => {
  const {
    activeState,
    switchTab,
    aiTasks: tasks,
    isAuthenticated,
    isServerWorkspaceReady,
    isSseConnected: isConnected,
    sseError,
  } = useAppStore(
    useShallow((state) => ({
      activeState: state.activeState,
      switchTab: state.switchTab,
      aiTasks: state.aiTasks,
      isAuthenticated: state.isAuthenticated,
      isServerWorkspaceReady: state.isServerWorkspaceReady,
      isSseConnected: state.isSseConnected,
      sseError: state.sseError,
    })),
  );

  /**
   * 根据任务状态渲染对应的图标
   * Uses the unified UI status (including cancelled/blocked/missing) for consistent display.
   */
  const renderIcon = (task: AiTask) => {
    const uiStatus = normalizeUiStatus(task);
    switch (uiStatus) {
      case 'completed':
        return <CheckCircle size={14} style={{ color: 'var(--color-success-light-4)' }} />;
      case 'failed':
        return <XCircle size={14} style={{ color: 'var(--color-danger-light-4)' }} />;
      case 'cancelled':
        return <Ban size={14} style={{ color: 'var(--color-text-3)' }} />;
      case 'running':
        return (
          <Loader2
            size={14}
            className={styles.spin}
            style={{ color: 'var(--color-primary-light-4)' }}
          />
        );
      default:
        return <Clock size={14} style={{ color: 'var(--color-text-3)' }} />;
    }
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

  const getEmptyState = () => {
    if (!isAuthenticated) {
      return {
        title: '登录状态不可用',
        message: '请先登录或等待本地会话恢复后再查看生产管线任务。',
        action: '返回对话',
        reload: false,
      };
    }

    if (!isServerWorkspaceReady) {
      return {
        title: '本地后端未就绪',
        message: '请确认后端服务已经启动，或回到对话页重新触发一次本地后端探测。',
        action: '返回对话',
        reload: false,
      };
    }

    if (sseError) {
      return {
        title: '实时连接失败',
        message: sseError,
        action: '重试连接',
        reload: true,
      };
    }

    if (!isConnected) {
      return {
        title: '正在建立实时连接',
        message: '如果长时间停留在这里，请返回对话页确认后端和登录状态。',
        action: '返回对话',
        reload: false,
      };
    }

    return {
      title: '暂无生产管线任务',
      message: activeState.chatSessionId
        ? '当前会话下没有正在排队的生产管线任务。'
        : activeState.projectId
          ? '当前项目下没有正在排队的生产管线任务。'
          : '当前没有选中项目或会话。',
      action: '返回对话',
      reload: false,
    };
  };

  const emptyState = getEmptyState();

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.timeTag}>
          <Clock size={16} />
          <span style={{ fontWeight: 600 }}>
            服务端真实管线监控 {isConnected ? '' : '(连接中...)'}
          </span>
          {!isConnected && (
            <WifiOff size={14} style={{ marginLeft: 8, color: '#ef4444' }} />
          )}
        </div>
        <Button
          type="text"
          icon={<XCircle size={18} />}
          onClick={() => switchTab('chat')}
          className={styles.closeBtn}
          style={{ color: 'var(--text-muted)' }}
        >
          返回对话
        </Button>
      </div>

      {sseError && (
        <div
          style={{
            padding: '8px 16px',
            background: 'rgba(239, 68, 68, 0.1)',
            color: '#ef4444',
            fontSize: 12,
          }}
        >
          <span>{sseError}</span>
        </div>
      )}

      <ReviewQueue projectId={activeState.projectId} />

      <div className={styles.timeline}>
        {tasks.length === 0 ? (
          <div className={styles.emptyState}>
            {emptyState.reload ? (
              <WifiOff size={22} />
            ) : !isConnected && isAuthenticated && isServerWorkspaceReady ? (
              <Loader2 size={22} className={styles.spin} />
            ) : (
              <Clock size={22} />
            )}
            <strong>{emptyState.title}</strong>
            <span>{emptyState.message}</span>
            <Button
              size="small"
              type="outline"
              icon={emptyState.reload ? <RotateCw size={14} /> : <XCircle size={14} />}
              onClick={() => {
                if (emptyState.reload) {
                  window.location.reload();
                  return;
                }
                switchTab('chat');
              }}
            >
              {emptyState.action}
            </Button>
          </div>
        ) : (
          tasks.map((task, index) => (
            <div key={task.id} className={styles.entry}>
              {index < tasks.length - 1 && <div className={styles.entryLine}></div>}
              {index === tasks.length - 1 && ['queued', 'running'].includes(normalizeUiStatus(task)) ? (
                <div className={styles.currentDot}></div>
              ) : (
                <div
                  style={{
                    marginRight: 16,
                    position: 'relative',
                    zIndex: 2,
                    background: 'var(--color-bg-2)',
                    borderRadius: '50%',
                  }}
                >
                  {renderIcon(task)}
                </div>
              )}
              <div className={styles.entryContent}>
                <p
                  className={styles.agentMsg}
                  style={
                    ['queued', 'running'].includes(normalizeUiStatus(task))
                      ? { color: '#fbbf24', fontStyle: 'italic' }
                      : isTerminalState(normalizeUiStatus(task))
                        ? { color: 'var(--color-text-2)' }
                        : {}
                  }
                >
                  {['queued', 'running'].includes(normalizeUiStatus(task)) && '🤖 '}
                  {(task.outputKind || 'text').toUpperCase()} ({normalizeUiStatus(task)})
                </p>
                <div className={styles.actionRow} style={{ marginTop: 8 }}>
                  <span className={styles.actionType}>
                    <Layers size={14} /> 请求内容:
                  </span>
                  <span className={styles.fileName}>{task.content.slice(0, 50)}...</span>
                  {typeof task.attemptIndex === 'number' && task.attemptIndex > 0 && (
                    <div className={styles.metaStat}>
                      {task.isRedo
                        ? `重做第 ${task.attemptIndex} 次`
                        : `第 ${task.attemptIndex} 次`}
                    </div>
                  )}
                  {(typeof task.activeTasks === 'number' ||
                    typeof task.queuedTasks === 'number') && (
                    <div className={styles.metaStat}>
                      {getRuntimeLabel(task)}
                      {typeof task.activeTasks === 'number' ? ` · 执行中 ${task.activeTasks}` : ''}
                      {typeof task.queuedTasks === 'number' ? ` · 排队 ${task.queuedTasks}` : ''}
                    </div>
                  )}
                  {task.error && normalizeUiStatus(task) === 'failed' && (
                    <div
                      style={{ color: 'var(--color-danger-light-4)', marginLeft: 8, fontSize: 12 }}
                    >
                      错误: {task.error}
                    </div>
                  )}
                  {normalizeUiStatus(task) === 'cancelled' && (
                    <div style={{ color: 'var(--color-text-3)', marginLeft: 8, fontSize: 12 }}>
                      {STATE_USER_MESSAGES.cancelled.title}
                    </div>
                  )}
                  {!task.error && task.lastError && task.isRedo && (
                    <div style={{ color: '#fbbf24', marginLeft: 8, fontSize: 12 }}>
                      上次失败: {task.lastError}
                    </div>
                  )}
                  {task.finishedAt && task.startedAt && (
                    <div className={styles.metaStat} style={{ marginLeft: 'auto' }}>
                      耗时: {Math.floor((task.finishedAt - task.startedAt) / 1000)}s
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
