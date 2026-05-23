/**
 * CollaborationStatus - 协同会话状态展示组件
 *
 * 在对话区顶部显示当前协同会话的状态标签，
 * 包括会话阶段、回复队列、阻塞问题清单。
 */
import React from 'react';
import { Tag, Space } from '@arco-design/web-react';
import type {
  CollaborationSession,
  CollaborationAssignment,
  CollaborationSessionState,
} from '../../../../types';

/** 协同会话状态对应的标签颜色和文案 */
const STATE_DISPLAY: Record<CollaborationSessionState, { color: string; label: string }> = {
  discovery: { color: 'arcoblue', label: '协同准备中' },
  delegating: { color: 'orange', label: '编导分派中' },
  resolving_questions: { color: 'gold', label: '正在解除阻塞' },
  workspace_admission: { color: 'cyan', label: '入场判定中' },
  workspace_execution: { color: 'green', label: '已入工作区' },
  completed: { color: 'green', label: '协同完成' },
  halted: { color: 'red', label: '已暂停' },
};

interface CollaborationStatusProps {
  session: CollaborationSession;
  assignments: CollaborationAssignment[];
}

/** 协同会话状态展示组件 */
export const CollaborationStatus: React.FC<CollaborationStatusProps> = ({
  session,
  assignments,
}) => {
  const display = STATE_DISPLAY[session.state] || { color: 'gray', label: session.state };
  const progressPreviewLabel =
    session.state === 'workspace_execution'
      ? '正在生成大纲中'
      : session.state === 'workspace_admission'
        ? '正在进入工作区'
        : null;
  const supervisionLabel = session.state === 'workspace_execution' ? '监管运行中' : null;

  const blockedCount = assignments.filter(
    (a) => a.status === 'blocked' || a.status === 'questioning',
  ).length;
  const readyCount = assignments.filter((a) => a.status === 'ready').length;

  let replyQueue: string[] = [];
  if (session.replyQueueJson) {
    try {
      const parsed = JSON.parse(session.replyQueueJson);
      if (Array.isArray(parsed)) {
        replyQueue = parsed
          .map((e: { agentId?: string; agent_id?: string }) => e.agentId || e.agent_id || '')
          .filter(Boolean);
      }
    } catch {
      // ignore parse error
    }
  }

  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-2)' }}>
      <Space size="small" align="center">
        <Tag color={display.color} size="small">
          {display.label}
        </Tag>
        {blockedCount > 0 && (
          <Tag color="red" size="small">
            {blockedCount} 个阻塞
          </Tag>
        )}
        {readyCount > 0 && (
          <Tag color="green" size="small">
            {readyCount} 个就绪
          </Tag>
        )}
        {progressPreviewLabel && (
          <Tag color="arcoblue" size="small">
            {progressPreviewLabel}
          </Tag>
        )}
        {supervisionLabel && (
          <Tag color="blue" size="small">
            {supervisionLabel}
          </Tag>
        )}
        {replyQueue.length > 0 && (
          <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>
            发言队列：{replyQueue.join(' → ')}
          </span>
        )}
        <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>
          第 {session.roundCount} 轮
        </span>
        {session.pipelineRunId && (
          <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>
            流程 {session.pipelineRunId.slice(0, 8)}
          </span>
        )}
      </Space>
    </div>
  );
};
