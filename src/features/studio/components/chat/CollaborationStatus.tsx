/**
 * CollaborationStatus - 协同会话状态展示组件
 *
 * 在对话区顶部显示当前协同会话的状态标签、发言队列、当前发言者、
 * 已完成成员、阻塞成员及阻塞原因、待回答问题。
 * 数据来源：后端持久化的 reply_queue_json + queue 可视化 API。
 */
import React, { useEffect, useState } from 'react';
import { Tag, Space, Button, Modal, Input, Message } from '@arco-design/web-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../../store';
import { getCollaborationQueue, resumeCollaboration } from '../../../../lib/serverApi';
import { logger } from '../../../../lib/logger';
import type {
  CollaborationSession,
  CollaborationAssignment,
  CollaborationSessionState,
  QueueVisualization,
  ResumeReq,
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
  const pendingQuestions = useAppStore(
    useShallow((state) => state.collaborationPendingQuestions),
  );
  const [queueViz, setQueueViz] = useState<QueueVisualization | null>(null);
  const [resumeModalOpen, setResumeModalOpen] = useState(false);
  const [resumeAction, setResumeAction] = useState<ResumeReq['action']>('resume');
  const [resumeNote, setResumeNote] = useState('');
  const [resuming, setResuming] = useState(false);

  /** 拉取队列可视化（当前发言者/已完成/阻塞） */
  useEffect(() => {
    if (!session.id) {
      setQueueViz(null);
      return;
    }
    let cancelled = false;
    const fetchQueue = async () => {
      try {
        const viz = await getCollaborationQueue(session.id);
        if (!cancelled) setQueueViz(viz);
      } catch (error) {
        if (!cancelled) logger.warn('[CollaborationStatus] 获取队列可视化失败', error);
      }
    };
    void fetchQueue();
    // 当会话状态或更新时间变化时刷新（避免轮询）
  }, [session.id, session.state, session.updatedAt]);

  /** 提交恢复请求 */
  const handleResume = async () => {
    setResuming(true);
    try {
      await resumeCollaboration(session.id, { action: resumeAction, note: resumeNote });
      Message.success('协同会话已恢复');
      setResumeModalOpen(false);
      setResumeNote('');
    } catch (error) {
      Message.error(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setResuming(false);
    }
  };

  const display = STATE_DISPLAY[session.state] || { color: 'gray', label: session.state };
  const progressPreviewLabel =
    session.state === 'workspace_execution'
      ? '正在生成大纲中'
      : session.state === 'workspace_admission'
        ? '正在进入工作区'
        : null;
  const supervisionLabel = session.state === 'workspace_execution' ? '监管运行中' : null;

  // 阻塞/就绪统计（来自 assignments）
  const blockedCount = assignments.filter(
    (a) => a.status === 'blocked' || a.status === 'questioning',
  ).length;
  const readyCount = assignments.filter((a) => a.status === 'ready').length;
  const completedCount = assignments.filter((a) => a.status === 'done').length;
  const failedCount = assignments.filter((a) => a.status === 'failed').length;

  // 当前发言者 + 待发言队列（优先使用后端可视化数据）
  const currentSpeaker = queueViz?.currentSpeaker;
  const pendingQueue = queueViz?.pendingQueue ?? [];
  const completedMembers = queueViz?.completedMembers ?? [];
  const blockedMembers = queueViz?.blockedMembers ?? [];

  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-2)' }}>
      <Space size="small" align="center" wrap>
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
        {completedCount > 0 && (
          <Tag color="gray" size="small">
            {completedCount} 个完成
          </Tag>
        )}
        {failedCount > 0 && (
          <Tag color="red" size="small">
            {failedCount} 个失败
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
        <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>
          第 {session.roundCount} 轮
          {session.maxRoundLimit && session.maxRoundLimit > 0
            ? ` / ${session.maxRoundLimit}`
            : ''}
        </span>
        {session.pipelineRunId && (
          <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>
            流程 {session.pipelineRunId.slice(0, 8)}
          </span>
        )}
        {session.state === 'halted' && (
          <Button
            size="mini"
            type="primary"
            status="warning"
            onClick={() => setResumeModalOpen(true)}
          >
            人工恢复
          </Button>
        )}
      </Space>

      {/* 当前发言者 + 待发言队列 */}
      {currentSpeaker && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <span style={{ color: 'var(--color-text-3)' }}>当前发言：</span>
          <Tag color="arcoblue" size="small" style={{ marginLeft: 4 }}>
            {currentSpeaker.agentId.slice(0, 8)}
          </Tag>
          <span style={{ color: 'var(--color-text-2)', marginLeft: 4 }}>
            {currentSpeaker.intent}
          </span>
          {pendingQueue.length > 0 && (
            <span style={{ color: 'var(--color-text-3)', marginLeft: 8 }}>
              待发言：
              {pendingQueue.map((p) => p.agentId.slice(0, 8)).join(' → ')}
            </span>
          )}
        </div>
      )}

      {/* 已完成成员 */}
      {completedMembers.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-3)' }}>
          已完成：
          {completedMembers.map((m, i) => (
            <Tag key={m.agentId} color="green" size="small" style={{ marginLeft: i === 0 ? 4 : 2 }}>
              {m.agentId.slice(0, 8)}
            </Tag>
          ))}
        </div>
      )}

      {/* 阻塞成员及原因 */}
      {blockedMembers.length > 0 && (
        <div
          style={{
            marginTop: 6,
            padding: '6px 10px',
            background: 'var(--color-danger-light-1)',
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--color-danger-6)' }}>
            阻塞成员 ({blockedMembers.length})
          </div>
          {blockedMembers.map((m) => (
            <div key={m.agentId} style={{ marginBottom: 2, color: 'var(--color-text-2)' }}>
              <span style={{ color: 'var(--color-text-3)' }}>[{m.agentId.slice(0, 8)}]</span>{' '}
              <span style={{ color: 'var(--color-text-2)' }}>{m.goal}</span>
              <div style={{ color: 'var(--color-danger-6)', marginLeft: 12 }}>
                原因：{m.blockingReason}
                {m.blockingQuestionCount > 0 && `（${m.blockingQuestionCount} 个未解决问题）`}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Halt 审计信息 */}
      {session.state === 'halted' && session.haltReason && (
        <div
          style={{
            marginTop: 6,
            padding: '6px 10px',
            background: 'var(--color-fill-2)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--color-text-2)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>暂停原因</div>
          <div>{session.haltReason}</div>
          {session.haltedBy && (
            <div style={{ color: 'var(--color-text-3)', marginTop: 2 }}>
              处理人：{session.haltedBy === 'system' ? '系统自动' : session.haltedBy.slice(0, 8)}
              {session.haltedAt && ` · ${session.haltedAt}`}
            </div>
          )}
          {session.recoveryAudited === 1 && (
            <div style={{ color: 'var(--color-text-3)', marginTop: 2 }}>
              恢复记录：动作={session.recoveryAction || '-'}，操作人=
              {session.recoveryOperatorUserId
                ? session.recoveryOperatorUserId.slice(0, 8)
                : '-'}
              {session.recoveryNote ? `，备注=${session.recoveryNote}` : ''}
            </div>
          )}
        </div>
      )}

      {/* 待回答问题 */}
      {pendingQuestions.length > 0 && (
        <div
          style={{
            marginTop: 6,
            padding: '6px 10px',
            background: 'var(--color-warning-light-1)',
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--color-warning-6)' }}>
            待回答问题 ({pendingQuestions.length})
          </div>
          {pendingQuestions.map((q) => (
            <div key={q.fingerprint} style={{ marginBottom: 2, color: 'var(--color-text-2)' }}>
              <span style={{ color: 'var(--color-text-3)' }}>[{q.agentId.slice(0, 8)}]</span>{' '}
              {q.question}
            </div>
          ))}
        </div>
      )}

      {/* 人工恢复模态框 */}
      <Modal
        title="恢复协同会话"
        visible={resumeModalOpen}
        onCancel={() => setResumeModalOpen(false)}
        onOk={handleResume}
        confirmLoading={resuming}
        okText="确认恢复"
        cancelText="取消"
      >
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 4, fontSize: 13 }}>恢复动作：</div>
          <Space>
            <Button
              size="small"
              type={resumeAction === 'resume' ? 'primary' : 'default'}
              onClick={() => setResumeAction('resume')}
            >
              resume（继续当前阶段）
            </Button>
            <Button
              size="small"
              type={resumeAction === 'restart' ? 'primary' : 'default'}
              status="warning"
              onClick={() => setResumeAction('restart')}
            >
              restart（回到 discovery 重新开始）
            </Button>
          </Space>
        </div>
        <div>
          <div style={{ marginBottom: 4, fontSize: 13 }}>备注（可选）：</div>
          <Input.TextArea
            value={resumeNote}
            onChange={setResumeNote}
            placeholder="记录本次恢复的决策依据"
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </div>
      </Modal>
    </div>
  );
};
