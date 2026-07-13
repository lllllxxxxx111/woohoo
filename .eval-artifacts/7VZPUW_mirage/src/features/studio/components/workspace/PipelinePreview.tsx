import React, { useState } from 'react';
import { Clock, CheckCircle, Layers, XCircle, Loader2, WifiOff, RotateCw, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@arco-design/web-react';
import type { AiTask } from '../../../../lib/serverApi';
import { ReviewQueueWorkbench } from './ReviewQueueWorkbench';
import styles from './PipelinePreview.module.css';

type ViewMode = 'timeline' | 'review';

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

  const [viewMode, setViewMode] = useState<ViewMode>('timeline');

  /**
   * 根据任务状态渲染对应的图标
   */
  const renderIcon = (task: AiTask) => {
    switch (task.status) {
      case 'completed':
        return <CheckCircle size={14} style={{ color: 'var(--color-success-light-4)' }} />;
      case 'failed':
        return <XCircle size={14} style={{ color: 'var(--color-danger-light-4)' }} />;
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

  // Render the review queue workbench when that tab is active
  if (viewMode === 'review') {
    return (
      <div className={styles.container} style={{ padding: 0, maxWidth: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 20px',
          borderBottom: '1px solid var(--border-color)',
          gap: 8,
          flexShrink: 0,
        }}>
          <Button
            size="small"
            type="text"
            icon={<Clock size={14} />}
            onClick={() => setViewMode('timeline')}
          >
            任务时间线
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<AlertTriangle size={14} />}
            onClick={() => setViewMode('review')}
          >
            人工复核
          </Button>
          <div style={{ marginLeft: 'auto' }}>
            <Button
              type="text"
              icon={<XCircle size={18} />}
              onClick={() => switchTab('chat')}
              size="small"
              style={{ color: 'var(--text-muted)' }}
            >
              返回对话
            </Button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <ReviewQueueWorkbench projectId={activeState.projectId || undefined} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, zIndex: 1 }}>
          <button
            onClick={() => setViewMode('timeline')}
            style={{
              background: 'transparent',
              cursor: 'pointer',
              padding: '6px 12px',
              borderRadius: 20,
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--text-primary)',
              fontWeight: 600,
              backgroundColor: 'var(--bg-tertiary)',
              border: '1px solid var(--border-color)',
            }}
          >
            <Clock size={16} />
            时间线
          </button>
          <button
            onClick={() => setViewMode('review')}
            style={{
              background: 'transparent',
              cursor: 'pointer',
              padding: '6px 12px',
              borderRadius: 20,
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-color)',
            }}
            title="查看失败/阻塞步骤的人工复核队列"
          >
            <AlertTriangle size={16} />
            人工复核
          </button>
        </div>
        <Button
          type="text"
          icon={<XCircle size={18} />}
          onClick={() => switchTab('chat')}
          className={styles.closeBtn}
          style={{ color: 'var(--text-muted)', zIndex: 1 }}
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
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Button
                size="small"
                type="outline"
                icon={<AlertTriangle size={14} />}
                onClick={() => setViewMode('review')}
              >
                查看复核队列
              </Button>
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
          </div>
        ) : (
          tasks.map((task, index) => (
            <div key={task.id} className={styles.entry}>
              {index < tasks.length - 1 && <div className={styles.entryLine}></div>}
              {index === tasks.length - 1 && ['queued', 'running'].includes(task.status) ? (
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
                    ['queued', 'running'].includes(task.status)
                      ? { color: '#fbbf24', fontStyle: 'italic' }
                      : {}
                  }
                >
                  {['queued', 'running'].includes(task.status) && '🤖 '}
                  {(task.outputKind || 'text').toUpperCase()} ({task.status})
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
                  {task.error && (
                    <div
                      style={{ color: 'var(--color-danger-light-4)', marginLeft: 8, fontSize: 12 }}
                    >
                      错误: {task.error}
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
