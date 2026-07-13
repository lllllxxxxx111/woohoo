/**
 * AgentSidePanel - 智能体侧边栏组件
 *
 * 显示当前项目的智能体小组成员列表、项目工作流状态卡片和底部提示信息。
 */
import React from 'react';
import { Bot, Eye, Edit3 } from 'lucide-react';
import { Avatar, Tag, Typography, Card, Space } from '@arco-design/web-react';
import type { AgentContact } from '../../../../types';
import styles from './ChatArea.module.css';

const { Text } = Typography;
const { Title } = Typography;

/** AgentSidePanel 组件的 Props */
export type AgentSidePanelProps = {
  /** 智能体联系人列表 */
  agentContacts: AgentContact[];
  /** 当前活跃项目 */
  activeProject: {
    id: string;
    name: string;
    workflow?: {
      phase: string;
      progressPercent: number;
      assetCount: number;
      storyboardLineCount: number;
      queuedTaskCount: number;
      runningTaskCount: number;
      completedTaskCount: number;
      failedTaskCount: number;
      roleCounts?: {
        design?: number;
        review?: number;
        editor?: number;
        manager?: number;
      };
    };
  } | undefined;
  /** @提及点击回调 */
  onMentionClick: (agentName: string) => void;
  /** 查看智能体详情回调 */
  onViewAgentDetail: (agent: AgentContact) => void;
  /** 编辑智能体回调 */
  onEditAgent: (agent: AgentContact) => void;
};

/**
 * 智能体侧边栏组件
 *
 * 渲染项目工作流状态卡片、智能体列表和底部提示。
 *
 * @param props - 侧边栏所需的全部 props
 * @returns 侧边栏 JSX
 */
export const AgentSidePanel: React.FC<AgentSidePanelProps> = ({
  agentContacts,
  activeProject,
  onMentionClick,
  onViewAgentDetail,
  onEditAgent,
}) => {
  const projectWorkflow = activeProject?.workflow;
  const projectRoleCounts = projectWorkflow?.roleCounts;

  return (
    <div className={styles.agentsSidePanel}>
      {/* 标题栏 */}
      <div className={styles.agentsHeader}>
        <Title heading={6} style={{ margin: 0, color: 'var(--text-primary)', fontSize: '13px' }}>
          智能体小组
        </Title>
        <div className={styles.agentCountBadge}>{agentContacts.length}</div>
      </div>

      {/* 项目工作流状态卡片 */}
      {activeProject && projectWorkflow && (
        <Card
          size="small"
          bordered={false}
          style={{ marginBottom: 12, background: 'var(--color-fill-2)' }}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontWeight: 600, fontSize: '12px' }}>{activeProject.name}</Text>
              <Tag size="small" color="arcoblue">
                {projectWorkflow.phase}
              </Tag>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Tag size="small">设计 {projectRoleCounts?.design ?? 0}</Tag>
              <Tag size="small">审核 {projectRoleCounts?.review ?? 0}</Tag>
              <Tag size="small">主编 {projectRoleCounts?.editor ?? 0}</Tag>
              <Tag size="small">管理 {projectRoleCounts?.manager ?? 0}</Tag>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Tag size="small" color="green">
                进度 {projectWorkflow.progressPercent}%
              </Tag>
              <Tag size="small">资产 {projectWorkflow.assetCount}</Tag>
              <Tag size="small">分镜 {projectWorkflow.storyboardLineCount}</Tag>
              <Tag size="small">
                任务 {projectWorkflow.queuedTaskCount}/{projectWorkflow.runningTaskCount}/
                {projectWorkflow.completedTaskCount}/{projectWorkflow.failedTaskCount}
              </Tag>
            </div>
          </Space>
        </Card>
      )}

      {/* 智能体列表 */}
      <div className={styles.agentsList}>
        {agentContacts.map((agent) => (
          <div key={agent.id} className={styles.contactItem}>
            <div className={styles.avatarWrapper} onClick={() => onViewAgentDetail(agent)}>
              <Avatar shape="circle" size={40} className={styles.contactAvatar}>
                {agent.avatar ? <img src={agent.avatar} alt={agent.name} /> : <Bot size={18} />}
              </Avatar>
              <div className={`${styles.statusDotRing} ${styles[agent.status || 'idle']}`} />
            </div>

            <div className={styles.contactInfo} onClick={() => onMentionClick(agent.name)}>
              <div className={styles.contactNameRow}>
                <span className={styles.contactName} style={{ fontSize: '13px' }}>
                  {agent.name}
                </span>
                {agent.badge && (
                  <span className={styles.contactTime} style={{ fontSize: '10px' }}>
                    {agent.badge}
                  </span>
                )}
              </div>
              <div className={styles.contactStatusRow}>
                <span className={styles.contactRole} style={{ fontSize: '11px' }}>
                  {agent.responsibilityLabel || agent.role}
                </span>
                {agent.activeTasks !== undefined && agent.activeTasks > 0 && (
                  <span className={styles.activeTaskCount}>· {agent.activeTasks} 任务</span>
                )}
              </div>
            </div>

            <div className={styles.contactHoverActions}>
              <button
                className={styles.contactActionBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onViewAgentDetail(agent);
                }}
                title="查看详情"
              >
                <Eye size={13} />
              </button>
              <button
                className={styles.contactActionBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditAgent(agent);
                }}
                title="编辑"
              >
                <Edit3 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 底部提示 */}
      <div className={styles.agentsFooter}>
        <div className={styles.footerHint}>
          <Text type="secondary" style={{ fontSize: '11px' }}>
            {activeProject
              ? '当前只显示本项目成员；切换项目不会串成员和进度。'
              : '输入 @ 或点击头像提及'}
          </Text>
        </div>
      </div>
    </div>
  );
};
