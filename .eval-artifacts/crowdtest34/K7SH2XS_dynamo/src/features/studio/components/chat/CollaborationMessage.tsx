/**
 * CollaborationMessage - 协同消息气泡组件
 *
 * 区分于普通用户消息，用于展示智能体间的协同消息，
 * 包括发送者、目标、意图标签（分派/提问/回答/确认/升级）。
 */
import React from 'react';
import { Tag, Space } from '@arco-design/web-react';
import type { CollaborationMessageKind } from '../../../../types';

/** 消息意图对应的标签颜色和文案 */
const KIND_DISPLAY: Record<CollaborationMessageKind, { color: string; label: string }> = {
  assign: { color: 'blue', label: '分派' },
  question: { color: 'orange', label: '提问' },
  answer: { color: 'green', label: '回答' },
  status: { color: 'gray', label: '状态' },
  escalation: { color: 'red', label: '升级' },
};

interface CollaborationMessageProps {
  sourceAgentId?: string;
  targetAgentId?: string;
  messageKind: CollaborationMessageKind;
  content: string;
  agentNameMap: Map<string, string>;
}

/** 协同消息气泡组件 */
export const CollaborationMessage: React.FC<CollaborationMessageProps> = ({
  sourceAgentId,
  targetAgentId,
  messageKind,
  content,
  agentNameMap,
}) => {
  const display = KIND_DISPLAY[messageKind] || { color: 'gray', label: messageKind };
  const sourceName = sourceAgentId ? (agentNameMap.get(sourceAgentId) || sourceAgentId) : '系统';
  const targetName = targetAgentId ? (agentNameMap.get(targetAgentId) || targetAgentId) : '';

  return (
    <div
      style={{
        padding: '8px 12px',
        margin: '4px 0',
        borderRadius: 6,
        backgroundColor: 'var(--color-fill-1)',
        borderLeft: '3px solid var(--color-border-3)',
      }}
    >
      <Space size="small" align="center" style={{ marginBottom: 4 }}>
        <Tag color={display.color} size="small">
          {display.label}
        </Tag>
        <span style={{ fontWeight: 600, fontSize: 12 }}>{sourceName}</span>
        {targetName && (
          <>
            <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>→</span>
            <span style={{ fontWeight: 600, fontSize: 12 }}>{targetName}</span>
          </>
        )}
      </Space>
      <div style={{ fontSize: 12, color: 'var(--color-text-2)' }}>{content}</div>
    </div>
  );
};
