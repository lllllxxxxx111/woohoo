import React from 'react';
import {
  Modal,
  Tag,
  Avatar,
  Typography,
  Space,
  Divider,
  Empty,
  Tooltip,
} from '@arco-design/web-react';
import {
  X,
  Edit3,
  Bot,
  Clock,
  CheckCircle2,
  RefreshCw,
  Briefcase,
  Target,
  TrendingUp,
  Calendar,
  Activity,
  Image as ImageIcon,
  Film,
  Music,
  FileText,
  Package,
} from 'lucide-react';
import type { AgentContact } from '../../../../types';
import '../../../../styles/arco-async';
import styles from './AgentDetailModal.module.css';

const { Title, Text, Paragraph } = Typography;

/** AgentDetailModal组件属性接口定义 */
interface AgentDetailModalProps {
  /** 控制模态框显示/隐藏 */
  visible: boolean;
  /** 当前查看的智能体数据，为null时不显示 */
  agent: AgentContact | null;
  /** 关闭模态框的回调函数 */
  onClose: () => void;
  /** 点击编辑按钮的回调函数 */
  onEdit: (agent: AgentContact) => void;
}

/**
 * 获取状态对应的颜色和文本
 * @param status - 智能体状态
 * @returns 包含颜色、文本和图标的对象
 */
const getStatusConfig = (status?: string) => {
  switch (status) {
    case 'busy':
      return { color: 'orange', text: '忙碌中', icon: <Activity size={12} /> };
    case 'queued':
      return { color: 'blue', text: '排队中', icon: <Clock size={12} /> };
    case 'idle':
    default:
      return { color: 'green', text: '空闲', icon: <CheckCircle2 size={12} /> };
  }
};

/**
 * 根据能力索引生成不同的标签颜色
 * @param index - 能力标签的索引位置
 * @returns Arco Design 的颜色名称
 */
const getCapabilityColor = (index: number): string => {
  const colors = ['arcoblue', 'green', 'orangered', 'purple', 'cyan', 'magenta', 'lime', 'gold'];
  return colors[index % colors.length];
};

/**
 * 根据资产类型获取对应的图标组件
 * @param type - 资产类型
 * @returns 对应的图标组件
 */
const getAssetIcon = (type: string) => {
  switch (type) {
    case 'image':
      return <ImageIcon size={14} />;
    case 'video':
      return <Film size={14} />;
    case 'audio':
      return <Music size={14} />;
    case 'document':
      return <FileText size={14} />;
    default:
      return <Package size={14} />;
  }
};

/**
 * 根据资产类型获取对应的中文标签
 * @param type - 资产类型
 * @returns 类型的中文显示名称
 */
const getAssetTypeLabel = (type: string): string => {
  const typeMap: Record<string, string> = {
    image: '图片',
    video: '视频',
    audio: '音频',
    document: '文档',
  };
  return typeMap[type] || type;
};

/**
 * 格式化日期字符串为可读格式
 * @param dateStr - ISO格式的日期字符串
 * @returns 格式化后的日期文本
 */
const formatDate = (dateStr?: string): string => {
  if (!dateStr) return '暂无记录';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
};

/**
 * 智能体详情模态框组件
 * 用于展示智能体的完整信息和履历数据
 */
const AgentDetailModal: React.FC<AgentDetailModalProps> = ({ visible, agent, onClose, onEdit }) => {
  /**
   * 渲染头部区域（头像、名称、状态等）
   */
  const renderHeader = () => {
    if (!agent) return null;

    const statusConfig = getStatusConfig(agent.status);

    return (
      <div className={styles.header}>
        <div className={styles.avatarSection}>
          <Avatar size={80} className={styles.avatar}>
            {agent.avatar ? <img src={agent.avatar} alt={agent.name} /> : <Bot size={36} />}
          </Avatar>
          <div className={`${styles.statusIndicator} ${styles[agent.status || 'idle']}`} />
        </div>

        <div className={styles.headerInfo}>
          <div className={styles.titleRow}>
            <Title heading={4} style={{ margin: 0, fontSize: '22px' }}>
              {agent.name}
            </Title>
            <Tooltip content="编辑智能体">
              <button className={styles.editButton} onClick={() => onEdit(agent)} aria-label="编辑">
                <Edit3 size={16} />
              </button>
            </Tooltip>
          </div>

          <Space size="small" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            {agent.badge && (
              <Tag color="gold" bordered className={styles.badgeTag}>
                {agent.badge}
              </Tag>
            )}
            <Tag color={statusConfig.color} bordered className={styles.statusTag}>
              {statusConfig.icon}
              <span style={{ marginLeft: 4 }}>{statusConfig.text}</span>
            </Tag>
            <Tag bordered className={styles.roleTag}>
              {agent.role}
            </Tag>
          </Space>

          {agent.description && (
            <Paragraph className={styles.description} ellipsis={{ rows: 2 }}>
              {agent.description}
            </Paragraph>
          )}
        </div>
      </div>
    );
  };

  /**
   * 渲染基本信息区域（系统提示词、模型配置）
   */
  const renderBasicInfo = () => {
    if (!agent) return null;

    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>基本信息</h3>
        <div className={styles.infoGrid}>
          {agent.systemPrompt && (
            <div className={styles.infoItem}>
              <Text className={styles.infoLabel}>系统提示词</Text>
              <Paragraph className={styles.infoValue} ellipsis={{ rows: 3, expandable: true }}>
                {agent.systemPrompt}
              </Paragraph>
            </div>
          )}

          {(agent.model || agent.temperature !== undefined || agent.maxTokens !== undefined) && (
            <div className={styles.modelConfig}>
              <Text className={styles.infoLabel}>模型配置</Text>
              <Space size="small" wrap>
                {agent.model && (
                  <Tag color="arcoblue" bordered>
                    {agent.model}
                  </Tag>
                )}
                {agent.temperature !== undefined && <Tag bordered>温度: {agent.temperature}</Tag>}
                {agent.maxTokens !== undefined && <Tag bordered>输出上限: {agent.maxTokens}</Tag>}
              </Space>
            </div>
          )}

          {agent.activeTasks !== undefined && agent.queuedTasks !== undefined && (
            <div className={styles.taskStatus}>
              <Text className={styles.infoLabel}>当前任务</Text>
              <Space size="medium">
                <div className={styles.taskStat}>
                  <Activity size={14} className={styles.taskIcon} />
                  <span>
                    进行中: <strong>{agent.activeTasks}</strong>
                  </span>
                </div>
                <div className={styles.taskStat}>
                  <Clock size={14} className={styles.taskIcon} />
                  <span>
                    排队中: <strong>{agent.queuedTasks}</strong>
                  </span>
                </div>
              </Space>
            </div>
          )}
        </div>
      </section>
    );
  };

  /**
   * 渲染能力标签区域
   */
  const renderCapabilities = () => {
    if (!agent?.mainCapabilities || agent.mainCapabilities.length === 0) {
      return null;
    }

    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>核心能力</h3>
        <div className={styles.capabilitiesContainer}>
          <Space size="small" wrap>
            {agent.mainCapabilities.map((capability, index) => (
              <Tag key={index} color={getCapabilityColor(index)} className={styles.capabilityTag}>
                {capability}
              </Tag>
            ))}
          </Space>
        </div>
      </section>
    );
  };

  /**
   * 渲染统计数据卡片区域
   */
  const renderStatistics = () => {
    if (!agent) return null;

    const stats = [
      {
        label: '总完成任务',
        value: agent.totalTasksCompleted ?? 0,
        icon: <Target size={18} />,
        color: '#667eea',
      },
      {
        label: '成功率',
        value: `${(agent.successRate ?? 0).toFixed(1)}%`,
        icon: <TrendingUp size={18} />,
        color: '#22c55e',
      },
      {
        label: '重做次数',
        value: agent.redoCount ?? 0,
        icon: <RefreshCw size={18} />,
        color: '#f59e0b',
      },
      {
        label: '工作数量',
        value: agent.workCount ?? 0,
        icon: <Briefcase size={18} />,
        color: '#3b82f6',
      },
      {
        label: '通过率',
        value: `${((agent.passRate ?? 0) * 100).toFixed(1)}%`,
        icon: <CheckCircle2 size={18} />,
        color: '#8b5cf6',
      },
    ];

    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>数据统计</h3>
        <div className={styles.statsGrid}>
          {stats.map((stat, index) => (
            <div key={index} className={styles.statCard}>
              <div
                className={styles.statIcon}
                style={{ backgroundColor: `${stat.color}15`, color: stat.color }}
              >
                {stat.icon}
              </div>
              <div className={styles.statContent}>
                <Text className={styles.statValue}>{stat.value}</Text>
                <Text className={styles.statLabel}>{stat.label}</Text>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  };

  /**
   * 渲染项目履历列表区域
   */
  const renderProjectHistory = () => {
    if (!agent?.projectHistories || agent.projectHistories.length === 0) {
      return null;
    }

    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          项目履历
          <Tag className={styles.countBadge}>{agent.projectHistories.length}</Tag>
        </h3>
        <div className={styles.historyList}>
          {agent.projectHistories.map((project, index) => (
            <div key={`${project.projectId}-${index}`} className={styles.historyItem}>
              <div className={styles.historyHeader}>
                <Text className={styles.projectName} style={{ fontWeight: 600 }}>
                  {project.projectName}
                </Text>
                <Tag size="small" color="arcoblue" bordered>
                  {project.role}
                </Tag>
              </div>
              <div className={styles.historyMeta}>
                <span className={styles.metaItem}>
                  <CheckCircle2 size={12} />
                  完成 {project.completedTasks} 个任务
                </span>
                <span className={styles.metaItem}>
                  <Calendar size={12} />
                  {formatDate(project.joinedAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  };

  /**
   * 渲染素材资产列表区域（按类型分组）
   */
  const renderAssets = () => {
    if (!agent?.assets || agent.assets.length === 0) {
      return null;
    }

    // 按类型分组资产
    const groupedAssets = agent.assets.reduce(
      (acc, asset) => {
        if (!acc[asset.type]) {
          acc[asset.type] = [];
        }
        acc[asset.type].push(asset);
        return acc;
      },
      {} as Record<string, typeof agent.assets>,
    );

    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          素材资产
          <Tag className={styles.countBadge}>{agent.assets.length}</Tag>
        </h3>
        <div className={styles.assetsContainer}>
          {Object.entries(groupedAssets).map(([type, assets]) => (
            <div key={type} className={styles.assetGroup}>
              <div className={styles.assetGroupHeader}>
                {getAssetIcon(type)}
                <Text style={{ fontWeight: 600 }}>{getAssetTypeLabel(type)}</Text>
                <Tag size="small">{assets.length}</Tag>
              </div>
              <div className={styles.assetList}>
                {assets.map((asset) => (
                  <div key={asset.id} className={styles.assetItem}>
                    <span className={styles.assetIcon}>{getAssetIcon(asset.type)}</span>
                    <Tooltip content={asset.name}>
                      <Text className={styles.assetName} ellipsis>
                        {asset.name}
                      </Text>
                    </Tooltip>
                    <Text className={styles.assetDate} type="secondary">
                      {formatDate(asset.createdAt)}
                    </Text>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  };

  /**
   * 渲染时间信息区域
   */
  const renderTimeInfo = () => {
    if (!agent) return null;

    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>时间记录</h3>
        <div className={styles.timeInfo}>
          <div className={styles.timeItem}>
            <Calendar size={14} className={styles.timeIcon} />
            <Text type="secondary">创建时间：</Text>
            <Text>{formatDate(agent.createdAt)}</Text>
          </div>
          <div className={styles.timeItem}>
            <Activity size={14} className={styles.timeIcon} />
            <Text type="secondary">最后活跃：</Text>
            <Text>{formatDate(agent.lastActiveAt)}</Text>
          </div>
        </div>
      </section>
    );
  };

  return (
    <Modal
      title={null}
      footer={null}
      visible={visible}
      onCancel={onClose}
      className={styles.modal}
      style={{ width: 720 }}
      maskClosable
    >
      <div className={styles.container}>
        {/* 自定义关闭按钮 */}
        <button className={styles.closeButton} onClick={onClose} aria-label="关闭">
          <X size={20} />
        </button>

        {agent ? (
          <>
            {renderHeader()}
            <Divider className={styles.divider} />

            <div className={styles.content}>
              {renderBasicInfo()}
              {renderCapabilities()}
              {renderStatistics()}
              <Divider className={styles.divider} />
              {renderProjectHistory()}
              {renderAssets()}
              {renderTimeInfo()}
            </div>
          </>
        ) : (
          <Empty description="未选择智能体" />
        )}
      </div>
    </Modal>
  );
};

export default AgentDetailModal;
