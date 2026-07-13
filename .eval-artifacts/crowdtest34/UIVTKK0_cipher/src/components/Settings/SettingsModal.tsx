import React, { useEffect, useState } from 'react';
import {
  Activity,
  BadgeDollarSign,
  BellRing,
  Cpu,
  Gauge,
  GitBranch,
  LogOut,
  Palette,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import {
  Button,
  Card,
  Divider,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store';
import { useToast } from '../../context/useToast';
import type { AiSettings } from '../../types';
import { normalizeAiSettingsPayload, validateAiSettings } from '../../lib/ai';
import { formatCreditAmount } from '../../lib/credits';
import {
  clearStoredSession,
  getStoredServerProfile,
  listServerAiEndpoints,
} from '../../lib/serverApi';
import { useBillingCredits } from '../../hooks/useBillingCredits';
import '../../styles/arco-async';
import styles from './SettingsModal.module.css';
import { AgentManagement } from './AgentManagement';
import { ActionAuditLog } from './ActionAuditLog';
import { EndpointManagement } from './EndpointManagement';
import { NotificationSettings } from './NotificationSettings';
import { OpsMonitorPanel } from './OpsMonitorPanel';
import { UsageDashboard } from './UsageDashboard';
import { BudgetControl } from './BudgetControl';

const { Title, Text } = Typography;

type SettingsTab =
  | 'overview'
  | 'account'
  | 'budget'
  | 'dashboard'
  | 'model'
  | 'workflow'
  | 'agents'
  | 'notifications'
  | 'theme'
  | 'policy'
  | 'diagnostics';

type NavItem = {
  id: SettingsTab;
  icon: React.ReactNode;
  label: string;
};

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', icon: <Sparkles size={16} />, label: '概览' },
  { id: 'account', icon: <User size={16} />, label: '账户与余额' },
  { id: 'budget', icon: <Gauge size={16} />, label: '预算控制' },
  { id: 'dashboard', icon: <Activity size={16} />, label: '用量统计' },
  { id: 'model', icon: <Server size={16} />, label: 'API 通道' },
  { id: 'workflow', icon: <GitBranch size={16} />, label: '制作流程' },
  { id: 'agents', icon: <Users size={16} />, label: '智能体' },
  { id: 'notifications', icon: <BellRing size={16} />, label: '通知' },
  { id: 'theme', icon: <Palette size={16} />, label: '偏好设置' },
  { id: 'policy', icon: <ShieldCheck size={16} />, label: '安全策略' },
  { id: 'diagnostics', icon: <Wrench size={16} />, label: '高级诊断' },
];

const TAB_TITLES: Record<SettingsTab, string> = {
  overview: '概览',
  account: '账户与余额',
  budget: '预算控制',
  dashboard: '用量统计',
  model: 'API 通道',
  workflow: '制作流程',
  agents: '智能体',
  notifications: '通知',
  theme: '偏好设置',
  policy: '安全策略',
  diagnostics: '高级诊断',
};

export const SettingsModal: React.FC = () => {
  const {
    isSettingsOpen,
    setSettingsOpen,
    theme,
    setTheme,
    language,
    setLanguage,
    autoSaveEnabled,
    setAutoSaveEnabled,
    aiSettings,
    serverAiEndpointId,
    updateAiSettings,
    setServerAiEndpointId,
    isAuthenticated,
    setIsAuthenticated,
  } = useAppStore(
    useShallow((state) => ({
      isSettingsOpen: state.isSettingsOpen,
      setSettingsOpen: state.setSettingsOpen,
      theme: state.theme,
      setTheme: state.setTheme,
      language: state.language,
      setLanguage: state.setLanguage,
      autoSaveEnabled: state.autoSaveEnabled,
      setAutoSaveEnabled: state.setAutoSaveEnabled,
      aiSettings: state.aiSettings,
      serverAiEndpointId: state.serverAiEndpointId,
      updateAiSettings: state.updateAiSettings,
      setServerAiEndpointId: state.setServerAiEndpointId,
      isAuthenticated: state.isAuthenticated,
      setIsAuthenticated: state.setIsAuthenticated,
    })),
  );
  const { showToast } = useToast();
  const { credits, loading: creditsLoading, error: creditsError, reload: reloadCredits } =
    useBillingCredits();
  const [profile, setProfile] = useState(() => getStoredServerProfile());
  const [activeTab, setActiveTab] = useState<SettingsTab>('overview');
  const [draftAiSettings, setDraftAiSettings] = useState<AiSettings>(aiSettings);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isSettingsOpen) {
      setProfile(getStoredServerProfile());
      setDraftAiSettings(aiSettings);
    }
  }, [aiSettings, isSettingsOpen]);

  if (!isSettingsOpen) {
    return null;
  }

  const validationErrors = validateAiSettings(draftAiSettings);
  const normalizedDraftAiSettings = normalizeAiSettingsPayload(draftAiSettings);
  const displayName = profile?.username || profile?.email || '未登录账户';
  const accountMeta = profile?.email || (isAuthenticated ? '已登录' : '未登录');
  const userId = profile?.id || '暂无 UUID';
  const accountInitial = displayName.trim().slice(0, 1).toUpperCase() || 'W';
  const creditsText = creditsLoading
    ? '读取中'
    : creditsError
      ? '读取失败'
      : `${formatCreditAmount(credits?.balance ?? 0)} 积分`;
  const currentModelText = draftAiSettings.model || '未配置模型';
  const currentProviderText = draftAiSettings.provider || '未配置';
  const requiresGlobalSave = activeTab === 'model' || activeTab === 'workflow';
  const shouldValidateAiSettings = activeTab === 'model' && !serverAiEndpointId;

  const updateDraftField = <K extends keyof AiSettings>(key: K, value: AiSettings[K]) => {
    setDraftAiSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleLanguageChange = (value: string) => {
    setLanguage(value);
    showToast({ type: 'success', title: '语言已更新', message: '界面语言偏好已保存' });
  };

  const handleLogout = () => {
    clearStoredSession();
    setIsAuthenticated(false);
    setSettingsOpen(false);
    showToast({ type: 'success', title: '已退出登录', message: '请重新登录后继续使用' });
  };

  const checkServerStatus = async () => {
    try {
      const endpoints = await listServerAiEndpoints(true);
      showToast({
        type: 'success',
        title: '本地后端在线',
        message: `已读取 ${endpoints.length} 条 API 通道记录`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '本地后端不可用',
        message: error instanceof Error ? error.message : '无法读取 API 通道列表',
      });
    }
  };

  const handleSave = async () => {
    if (requiresGlobalSave) {
      if (shouldValidateAiSettings && validationErrors.length > 0) {
        showToast({ type: 'error', title: '配置不完整', message: validationErrors[0] });
        return;
      }
      setIsSaving(true);
      try {
        updateAiSettings(normalizedDraftAiSettings);
        const successMessage =
          activeTab === 'workflow'
            ? `制作流程参数已保存：${normalizedDraftAiSettings.multiAgentBetaEnabled ? '已开启编排' : '编排未开启'}`
            : `当前默认模型：${normalizedDraftAiSettings.model || '未设置'}`;
        showToast({
          type: 'success',
          title: '配置已保存',
          message: successMessage,
        });
        setSettingsOpen(false);
      } finally {
        setIsSaving(false);
      }
      return;
    }

    setSettingsOpen(false);
  };

  return (
    <div className={styles.overlay} onClick={() => setSettingsOpen(false)}>
      <div className={styles.modal} onClick={(event) => event.stopPropagation()}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div className={styles.brandMark}>
              <Sparkles size={18} />
            </div>
            <div>
              <Title heading={5} style={{ margin: 0 }}>
                设置中心
              </Title>
              <Text type="secondary" style={{ fontSize: 13 }}>
                账户、API、用量与偏好
              </Text>
            </div>
          </div>

          <button
            className={styles.accountPill}
            onClick={() => setActiveTab('account')}
            title={userId}
            type="button"
          >
            <span className={styles.avatar}>{accountInitial}</span>
            <span className={styles.accountText}>
              <strong>{displayName}</strong>
              <span>{accountMeta}</span>
            </span>
            <Tag color={isAuthenticated ? 'green' : 'red'} size="small">
              {isAuthenticated ? '在线' : '未登录'}
            </Tag>
          </button>

          <div className={styles.sidebarMetric}>
            <span>
              <BadgeDollarSign size={14} />
              余额积分
            </span>
            <strong>{creditsText}</strong>
          </div>

          <nav className={styles.navConfig}>
            {NAV_ITEMS.map((tab) => (
              <button
                key={tab.id}
                className={`${styles.navBtn} ${activeTab === tab.id ? styles.active : ''}`}
                onClick={() => setActiveTab(tab.id)}
                title={tab.label}
                type="button"
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className={styles.content}>
          <div className={styles.header}>
            <div>
              <div className={styles.headerEyebrow}>Woohoo Studio</div>
              <Title heading={4} style={{ margin: 0 }}>
                {TAB_TITLES[activeTab]}
              </Title>
            </div>
            <Button
              shape="circle"
              icon={<X size={18} />}
              onClick={() => setSettingsOpen(false)}
              type="text"
            />
          </div>

          <div className={styles.scrollArea}>
            {activeTab === 'overview' && (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <section className={styles.overviewHero}>
                  <div className={styles.heroStatus}>
                    <span>{isAuthenticated ? '账户已登录' : '账户未登录'}</span>
                    <strong>{draftAiSettings.baseUrl ? 'API 通道已配置' : 'API 通道待配置'}</strong>
                  </div>
                </section>

                <div className={styles.overviewGrid}>
                  <button
                    type="button"
                    className={styles.overviewCard}
                    onClick={() => setActiveTab('account')}
                  >
                    <span className={styles.cardIcon}>
                      <User size={17} />
                    </span>
                    <span className={styles.cardLabel}>当前账户</span>
                    <strong>{displayName}</strong>
                    <span>{accountMeta}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.overviewCard}
                    onClick={() => setActiveTab('account')}
                  >
                    <span className={styles.cardIcon}>
                      <BadgeDollarSign size={17} />
                    </span>
                    <span className={styles.cardLabel}>余额积分</span>
                    <strong>{creditsText}</strong>
                    <span>
                      {credits?.totalSpent != null
                        ? `累计消耗 ${formatCreditAmount(credits.totalSpent)} 积分`
                        : '全局统一余额'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.overviewCard}
                    onClick={() => setActiveTab('model')}
                  >
                    <span className={styles.cardIcon}>
                      <Cpu size={17} />
                    </span>
                    <span className={styles.cardLabel}>默认模型</span>
                    <strong>{currentModelText}</strong>
                    <span>{currentProviderText}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.overviewCard}
                    onClick={() => setActiveTab('diagnostics')}
                  >
                    <span className={styles.cardIcon}>
                      <Server size={17} />
                    </span>
                    <span className={styles.cardLabel}>API 状态</span>
                    <strong>{draftAiSettings.baseUrl ? '已配置' : '未配置'}</strong>
                    <span>{draftAiSettings.provider || '默认通道'}</span>
                  </button>
                </div>

                <div className={styles.quickActions}>
                  <button type="button" className={styles.actionTile} onClick={() => setActiveTab('model')}>
                    <Server size={18} />
                    <span>
                      <strong>管理 API 通道</strong>
                      <small>新增、测试或切换默认通道</small>
                    </span>
                  </button>
                  <button type="button" className={styles.actionTile} onClick={() => setActiveTab('workflow')}>
                    <GitBranch size={18} />
                    <span>
                      <strong>制作流程</strong>
                      <small>编排、审核和自动重试参数</small>
                    </span>
                  </button>
                  <button type="button" className={styles.actionTile} onClick={() => setActiveTab('dashboard')}>
                    <Activity size={18} />
                    <span>
                      <strong>查看用量统计</strong>
                      <small>追踪积分和失败来源</small>
                    </span>
                  </button>
                  <button type="button" className={styles.actionTile} onClick={() => setActiveTab('theme')}>
                    <Palette size={18} />
                    <span>
                      <strong>偏好设置</strong>
                      <small>主题、语言和本地保存</small>
                    </span>
                  </button>
                </div>

                <div />
              </Space>
            )}

            {activeTab === 'account' && (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <section className={styles.accountSummary}>
                  <span className={styles.avatarLarge}>{accountInitial}</span>
                  <div>
                    <h3>{displayName}</h3>
                    <p>{accountMeta}</p>
                    <Text type="secondary" copyable>
                      {userId}
                    </Text>
                  </div>
                  <Tag color={isAuthenticated ? 'green' : 'red'}>
                    {isAuthenticated ? '已登录' : '未登录'}
                  </Tag>
                </section>

                <Card bordered={false} title="当前账户" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <div className={styles.settingRow}>
                      <span>登录状态</span>
                      <Tag color={isAuthenticated ? 'green' : 'red'}>
                        {isAuthenticated ? '已登录' : '未登录'}
                      </Tag>
                    </div>
                    <div className={styles.settingRow}>
                      <span>账户名称</span>
                      <strong>{displayName}</strong>
                    </div>
                    <div className={styles.settingRow}>
                      <span>UUID</span>
                      <Text type="secondary" copyable>
                        {userId}
                      </Text>
                    </div>
                  </Space>
                </Card>

                <Card bordered={false} title="余额积分" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <div className={styles.settingRow}>
                      <span>当前余额</span>
                      <strong>{creditsText}</strong>
                    </div>
                    <div className={styles.settingRow}>
                      <span>累计获得</span>
                      <span>{formatCreditAmount(credits?.totalEarned ?? 0)} 积分</span>
                    </div>
                    <div className={styles.settingRow}>
                      <span>累计消耗</span>
                      <span>{formatCreditAmount(credits?.totalSpent ?? 0)} 积分</span>
                    </div>
                    <Button
                      icon={<RefreshCw size={16} />}
                      loading={creditsLoading}
                      onClick={() => void reloadCredits()}
                    >
                      刷新余额
                    </Button>
                  </Space>
                </Card>

                <Card bordered={false} title="安全操作" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      退出登录后会清除本地认证信息，需要重新登录后才能继续使用。
                    </Text>
                    <Button
                      type="primary"
                      status="danger"
                      long
                      icon={<LogOut size={16} />}
                      onClick={handleLogout}
                    >
                      退出登录
                    </Button>
                  </Space>
                </Card>
              </Space>
            )}

            {activeTab === 'budget' && <BudgetControl />}

            {activeTab === 'dashboard' && (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Card bordered={false} title="统计说明" className={styles.sectionCard}>
                  <Text type="secondary">这里展示最近请求和用量统计。</Text>
                </Card>
                <UsageDashboard />
              </Space>
            )}

            {activeTab === 'model' && (
              <div>
                <EndpointManagement
                  currentSettings={draftAiSettings}
                  currentEndpointId={serverAiEndpointId}
                  onApplySettings={(settings, endpointId) => {
                    const normalizedSettings = normalizeAiSettingsPayload(settings);
                    setDraftAiSettings(normalizedSettings);
                    updateAiSettings(normalizedSettings);
                    if (endpointId) {
                      setServerAiEndpointId(endpointId);
                    }
                  }}
                />

                <Space direction="vertical" style={{ width: '100%', marginTop: 24 }}>
                  <Card
                    bordered={false}
                    title="默认对话提示词（可选）"
                    className={styles.sectionCard}
                  >
                    <Input.TextArea
                      autoSize={{ minRows: 3 }}
                      value={draftAiSettings.systemPrompt}
                      onChange={(value) => updateDraftField('systemPrompt', value)}
                      placeholder="可选"
                    />
                  </Card>
                </Space>
              </div>
            )}

            {activeTab === 'workflow' && (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Card bordered={false} title="流程开关" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <div className={styles.settingRow}>
                      <span>多智能体自动编排</span>
                      <Switch
                        checked={draftAiSettings.multiAgentBetaEnabled === true}
                        onChange={(checked) => updateDraftField('multiAgentBetaEnabled', checked)}
                      />
                    </div>
                    <div className={styles.settingRow}>
                      <span>Prompt 优化</span>
                      <Switch
                        checked={draftAiSettings.promptOptimizerBetaEnabled === true}
                        onChange={(checked) => updateDraftField('promptOptimizerBetaEnabled', checked)}
                      />
                    </div>
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      这些开关会直接影响大纲生成、审核和失败后的自动优化。
                    </Text>
                  </Space>
                </Card>

                <Card bordered={false} title="自动重试策略" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <div className={styles.settingRow}>
                      <span>基础退避秒数</span>
                      <InputNumber
                        min={1}
                        max={300}
                        step={1}
                        value={draftAiSettings.pipelineRetryBackoffSec}
                        onChange={(value) =>
                          updateDraftField('pipelineRetryBackoffSec', Number(value ?? 4))
                        }
                        style={{ width: 160 }}
                      />
                    </div>
                    <div className={styles.settingRow}>
                      <span>最大退避秒数</span>
                      <InputNumber
                        min={1}
                        max={900}
                        step={1}
                        value={draftAiSettings.pipelineRetryMaxBackoffSec}
                        onChange={(value) =>
                          updateDraftField('pipelineRetryMaxBackoffSec', Number(value ?? 90))
                        }
                        style={{ width: 160 }}
                      />
                    </div>
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      流程中的设计和审核步骤会沿用这里的退避策略。
                    </Text>
                  </Space>
                </Card>
              </Space>
            )}

            {activeTab === 'agents' && (
              <div>
                <AgentManagement />
              </div>
            )}

            {activeTab === 'notifications' && (
              <NotificationSettings language={language} onLanguageChange={handleLanguageChange} />
            )}

            {activeTab === 'theme' && (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Card title="工作区偏好" className={styles.sectionCard}>
                  <div className={styles.settingRow}>
                    <span>自动本地保存历史</span>
                    <Switch checked={autoSaveEnabled} onChange={setAutoSaveEnabled} />
                  </div>
                  <Divider />
                  <div className={styles.settingRow}>
                    <span>界面语言</span>
                    <Select style={{ width: 140 }} value={language} onChange={handleLanguageChange}>
                      <Select.Option value="zh-CN">简体中文</Select.Option>
                      <Select.Option value="en-US">English</Select.Option>
                    </Select>
                  </div>
                </Card>

                <div className={styles.themeOptions}>
                  <button
                    type="button"
                    className={`${styles.themeOption} ${theme === 'dark' ? styles.themeActive : ''}`}
                    onClick={() => setTheme('dark')}
                  >
                    <div className={styles.themePreviewDark}>
                      <div className={styles.themeSidebarPreview}></div>
                      <div className={styles.themeContent}></div>
                    </div>
                    <div className={styles.themeLabel}>深色模式</div>
                  </button>
                  <button
                    type="button"
                    className={`${styles.themeOption} ${theme === 'light' ? styles.themeActive : ''}`}
                    onClick={() => setTheme('light')}
                  >
                    <div className={styles.themePreviewLight}>
                      <div className={styles.themeSidebarPreview}></div>
                      <div className={styles.themeContent}></div>
                    </div>
                    <div className={styles.themeLabel}>浅色模式</div>
                  </button>
                </div>
              </Space>
            )}

            {activeTab === 'policy' && (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Card bordered={false} title="助理动作策略" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <div className={styles.settingRow}>
                      <span>允许助理动作</span>
                      <Switch
                        checked={draftAiSettings.assistantActionsEnabled ?? true}
                        onChange={(v) =>
                          setDraftAiSettings((s) => ({ ...s, assistantActionsEnabled: v }))
                        }
                      />
                    </div>
                    <div className={styles.settingRow}>
                      <span>单次最大动作数</span>
                      <InputNumber
                        min={1}
                        max={20}
                        value={draftAiSettings.maxActionsPerResponse ?? 5}
                        onChange={(v) =>
                          setDraftAiSettings((s) => ({ ...s, maxActionsPerResponse: v ?? 5 }))
                        }
                        style={{ width: 100 }}
                      />
                    </div>
                    <div className={styles.settingRow}>
                      <span>项目作用域</span>
                      <Select
                        value={draftAiSettings.actionProjectScope ?? 'current_only'}
                        onChange={(v) =>
                          setDraftAiSettings((s) => ({ ...s, actionProjectScope: v }))
                        }
                        style={{ width: 180 }}
                      >
                        <Select.Option value="current_only">仅当前项目</Select.Option>
                        <Select.Option value="user_projects">用户所有项目</Select.Option>
                        <Select.Option value="all_accessible">所有可访问项目</Select.Option>
                      </Select>
                    </div>
                  </Space>
                </Card>

                <Card bordered={false} title="需要确认的动作" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    {[
                      { key: 'remove_project_agent', label: '移除智能体' },
                      { key: 'create_project_agent', label: '创建智能体' },
                      { key: 'delete_project_path', label: '删除文件/目录' },
                      { key: 'move_project_path', label: '移动文件/目录' },
                    ].map((item) => (
                      <div key={item.key} className={styles.settingRow}>
                        <span>{item.label}</span>
                        <Switch
                          checked={
                            draftAiSettings.requireConfirmationFor?.includes(item.key) ?? true
                          }
                          onChange={(v) =>
                            setDraftAiSettings((s) => {
                              const current = s.requireConfirmationFor ?? [
                                'remove_project_agent',
                                'create_project_agent',
                                'delete_project_path',
                                'move_project_path',
                              ];
                              return {
                                ...s,
                                requireConfirmationFor: v
                                  ? [...current, item.key]
                                  : current.filter((k) => k !== item.key),
                              };
                            })
                          }
                        />
                      </div>
                    ))}
                  </Space>
                </Card>

                <Card bordered={false} title="动作审计日志" className={styles.sectionCard}>
                  <ActionAuditLog />
                </Card>
              </Space>
            )}

            {activeTab === 'diagnostics' && (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Card bordered={false} title="本地后端诊断" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <Button type="outline" icon={<ShieldCheck size={16} />} onClick={() => void checkServerStatus()}>
                      检测本地服务状态
                    </Button>
                  </Space>
                </Card>

                <Card bordered={false} title="当前调用配置" className={styles.sectionCard}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <div className={styles.settingRow}>
                      <span>默认服务商</span>
                      <strong>{currentProviderText}</strong>
                    </div>
                    <div className={styles.settingRow}>
                      <span>默认模型</span>
                      <span>{currentModelText}</span>
                    </div>
                    <div className={styles.settingRow}>
                      <span>请求模式</span>
                      <Tag color="arcoblue">后端统一处理</Tag>
                    </div>
                  </Space>
                </Card>

                <Card bordered={false} title="运维监控" className={styles.sectionCard}>
                  <OpsMonitorPanel />
                </Card>
              </Space>
            )}
          </div>

          <div className={styles.footer}>
            <Button size="large" onClick={() => setSettingsOpen(false)} style={{ marginRight: 16 }}>
              取消
            </Button>
            <Button size="large" type="primary" onClick={handleSave} loading={isSaving}>
              {requiresGlobalSave ? '保存并应用全局设置' : '完成'}
            </Button>
          </div>
        </main>
      </div>
    </div>
  );
};
