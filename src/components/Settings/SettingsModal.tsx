import React, { useEffect, useState } from 'react';
import {
  X,
  Network,
  Cpu,
  Bot,
  BarChart2,
  ShieldCheck,
  Palette,
  HelpCircle,
  Users,
  CreditCard,
  BellRing,
  BrainCircuit,
  LogOut,
} from 'lucide-react';
import {
  Button,
  Select,
  Input,
  Switch,
  Slider,
  Card,
  Space,
  Typography,
  Tag,
  Divider,
} from '@arco-design/web-react';
import { useAppStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';

import { useToast } from '../../context/useToast';
import type { AiSettings } from '../../types';
import { normalizeAiSettingsPayload, validateAiSettings } from '../../lib/ai';
import { listServerAiEndpoints, clearStoredSession } from '../../lib/serverApi';
import '../../styles/arco-async';
import styles from './SettingsModal.module.css';
import { AgentManagement } from './AgentManagement';
import { EndpointManagement } from './EndpointManagement';
import { NotificationSettings } from './NotificationSettings';
import { UsageDashboard } from './UsageDashboard';

const { Title, Text } = Typography;

/** 设置面板侧边栏导航项配置 */
interface TabConfig {
  id: string;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  badge?: string;
}

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
  const [activeTab, setActiveTab] = useState('model');
  const [draftAiSettings, setDraftAiSettings] = useState<AiSettings>(aiSettings);
  const [isSaving, setIsSaving] = useState(false);

  /** 切换界面语言并提示 */
  const handleLanguageChange = (val: string) => {
    setLanguage(val);
    showToast({ type: 'success', title: '界面语言设定已刷新', message: '核心组件已立即生效' });
  };

  /**
   * 登出当前账户，清除所有认证状态和本地缓存
   */
  const handleLogout = () => {
    clearStoredSession();
    setIsAuthenticated(false);
    setSettingsOpen(false);
    showToast({ type: 'success', title: '已退出登录', message: '请重新登录以继续使用' });
  };

  useEffect(() => {
    if (isSettingsOpen) {
      setDraftAiSettings(aiSettings);
    }
  }, [aiSettings, isSettingsOpen]);

  /** 检测服务端状态，读取端点列表 */
  const checkServerStatus = async () => {
    try {
      const endpoints = await listServerAiEndpoints(true);
      showToast({
        type: 'success',
        title: '服务端在线',
        message: `已读取 ${endpoints.length} 条 API 通道记录`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '服务端不可用',
        message: error instanceof Error ? error.message : '无法读取端点列表',
      });
    }
  };

  if (!isSettingsOpen) return null;

  const validationErrors = validateAiSettings(draftAiSettings);
  const normalizedDraftAiSettings = normalizeAiSettingsPayload(draftAiSettings);

  /** 更新草稿设置中的单个字段 */
  const updateDraftField = <K extends keyof AiSettings>(key: K, value: AiSettings[K]) => {
    setDraftAiSettings((prev) => ({ ...prev, [key]: value }));
  };

  const requiresGlobalSave = activeTab === 'model' || activeTab === 'advanced';

  /** 保存当前设置并关闭弹窗 */
  const handleSave = async () => {
    if (requiresGlobalSave) {
      if (validationErrors.length > 0) {
        showToast({ type: 'error', title: '配置不完整', message: validationErrors[0] });
        return;
      }
      setIsSaving(true);
      try {
        updateAiSettings(normalizedDraftAiSettings);
        showToast({
          type: 'success',
          title: '配置已保存',
          message: `当前模型：${normalizedDraftAiSettings.model || '未设置'}`,
        });
        setSettingsOpen(false);
      } finally {
        setIsSaving(false);
      }
      return;
    }

    if (['account', 'notifications', 'dashboard', 'agents', 'proxy', 'theme'].includes(activeTab)) {
      if (['theme', 'notifications', 'agents'].includes(activeTab)) {
        showToast({ type: 'success', title: '当前页设置已即时生效' });
      }
      setSettingsOpen(false);
      return;
    }

    setSettingsOpen(false);
  };

  return (
    <div className={styles.overlay} onClick={() => setSettingsOpen(false)}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        style={{
          borderRadius: '12px',
          background: 'var(--color-bg-2)',
          border: '1px solid var(--color-border)',
        }}
      >
        <div className={styles.sidebar}>
          <div style={{ marginBottom: 24 }}>
            <Title heading={5} style={{ margin: 0, color: 'var(--color-primary-light-4)' }}>
              全局配置台
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              系统环境与模型接入
            </Text>
          </div>
          <div className={styles.navConfig}>
            {([
              { id: 'account', icon: <Users size={16} />, label: '账户' },
              { id: 'dashboard', icon: <BarChart2 size={16} />, label: '全站数据监控' },
              { id: 'model', icon: <Cpu size={16} />, label: 'AI 模型引擎' },
              { id: 'agents', icon: <Users size={16} />, label: '智能体团队' },
              { id: 'advanced', icon: <Bot size={16} />, label: '高级解码参数' },
              { id: 'notifications', icon: <BellRing size={16} />, label: '多平台通知' },
              { id: 'theme', icon: <Palette size={16} />, label: '界面与外观' },
              { id: 'proxy', icon: <Network size={16} />, label: '服务路由' },
              {
                id: 'memory',
                icon: <BrainCircuit size={16} />,
                label: '长效智能记忆',
                disabled: true,
                badge: '开发中',
              },
              {
                id: 'audio',
                icon: <HelpCircle size={16} />,
                label: '语音交互',
                disabled: true,
                badge: '开发中',
              },
              {
                id: 'audit',
                icon: <ShieldCheck size={16} />,
                label: '安全合规风控',
                disabled: true,
                badge: '开发中',
              },
              {
                id: 'subscription',
                icon: <CreditCard size={16} />,
                label: '订阅与权益',
                disabled: true,
                badge: '即将上线',
              },
            ] as TabConfig[]).map((tab) => (
              <button
                key={tab.id}
                className={`${styles.navBtn} ${activeTab === tab.id ? styles.active : ''} ${tab.disabled ? styles.navDisabled : ''}`}
                onClick={() => !tab.disabled && setActiveTab(tab.id)}
                title={
                  tab.disabled ? `${tab.badge || '该功能'}暂未开放` : undefined
                }
              >
                {tab.icon} {tab.label}
                {tab.badge && (
                  <span className={styles.navBadge}>{tab.badge}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.content}>
          <div className={styles.header}>
            <Title heading={4} style={{ margin: 0 }}>
              {activeTab === 'account' && '账户管理'}
              {activeTab === 'dashboard' && 'API 用量与统计面板'}
              {activeTab === 'subscription' && '您的服务订阅与权益'}
              {activeTab === 'model' && '模型与提供商'}
              {activeTab === 'agents' && '智能体配置与协作管理'}
              {activeTab === 'memory' && '记忆系统与知识库'}
              {activeTab === 'advanced' && '大模型解码与高级控制'}
              {activeTab === 'audio' && '文字合成语音 (TTS) 测试参数'}
              {activeTab === 'notifications' && 'IM 平台通知与偏好'}
              {activeTab === 'theme' && '界面偏好与字体定制'}
              {activeTab === 'proxy' && '网络与路由转发策略'}
              {activeTab === 'audit' && '内容审核机制'}
            </Title>
            <Button
              shape="circle"
              icon={<X size={18} />}
              onClick={() => setSettingsOpen(false)}
              type="text"
            />
          </div>

          <div className={styles.scrollArea}>
            {activeTab === 'account' && (
              <div style={{ paddingRight: 16 }}>
                <Card
                  bordered={false}
                  title="当前登录状态"
                  style={{ background: 'var(--color-bg-2)', marginBottom: 16 }}
                >
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>认证状态</span>
                      <Tag color={isAuthenticated ? 'green' : 'red'}>
                        {isAuthenticated ? '已登录' : '未登录'}
                      </Tag>
                    </div>
                    {isAuthenticated && (
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        当前已通过服务端认证，所有数据操作将同步至远程服务器。
                      </Text>
                    )}
                  </Space>
                </Card>

                <Card bordered={false} title="安全操作" style={{ background: 'var(--color-bg-2)' }}>
                  <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      退出登录后将清除本地认证信息，需要重新输入账号密码才能继续使用。
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
              </div>
            )}

            {activeTab === 'dashboard' && <UsageDashboard />}

            {activeTab === 'subscription' && (
              <div style={{ paddingRight: 16, textAlign: 'center', padding: '60px 20px' }}>
                <CreditCard size={48} style={{ color: 'var(--color-text-4)', marginBottom: 16 }} />
                <Title heading={5} style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
                  订阅与权益
                </Title>
                <Text
                  type="secondary"
                  style={{
                    fontSize: 14,
                    lineHeight: 1.6,
                    maxWidth: 360,
                    margin: '0 auto',
                    display: 'block',
                  }}
                >
                  该功能即将上线。届时将支持订阅管理、配额查看、权益兑换等能力。
                </Text>
                <Tag color="arcoblue" style={{ marginTop: 16 }}>
                  Coming Soon
                </Tag>
              </div>
            )}

            {activeTab === 'notifications' && (
              <NotificationSettings language={language} onLanguageChange={handleLanguageChange} />
            )}

            {activeTab === 'memory' && (
              <div style={{ paddingRight: 16, textAlign: 'center', padding: '60px 20px' }}>
                <BrainCircuit
                  size={48}
                  style={{ color: 'var(--color-text-4)', marginBottom: 16 }}
                />
                <Title heading={5} style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
                  长效智能记忆
                </Title>
                <Text
                  type="secondary"
                  style={{
                    fontSize: 14,
                    lineHeight: 1.6,
                    maxWidth: 400,
                    margin: '0 auto',
                    display: 'block',
                  }}
                >
                  该功能正在开发中。将支持对话记忆压缩、知识库持久化、个性化指令等能力。
                </Text>
                <Tag color="orange" style={{ marginTop: 16 }}>
                  开发中
                </Tag>
              </div>
            )}

            {activeTab === 'model' && (
              <div style={{ paddingRight: 16 }}>
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
                    title="默认全局回退提示词 (Fallback System Prompt)"
                    style={{ background: 'var(--color-bg-2)' }}
                  >
                    <Input.TextArea
                      autoSize={{ minRows: 3 }}
                      value={draftAiSettings.systemPrompt}
                      onChange={(val) => updateDraftField('systemPrompt', val)}
                      placeholder="作为全局角色设定，用于没有关联智能体的裸聊对话..."
                    />
                  </Card>
                </Space>
              </div>
            )}

            {activeTab === 'agents' && (
              <div style={{ paddingRight: 16 }}>
                <AgentManagement />
              </div>
            )}

            {activeTab === 'advanced' && (
              <div style={{ paddingRight: 16 }}>
                <Space direction="vertical" size="large" style={{ width: '100%' }}>
                  <Typography.Paragraph type="secondary">
                    这部分的参数用于微调底层文字生成策略的质量，对大多数开发者而言使用默认参数即可。
                  </Typography.Paragraph>

                  <Card
                    bordered={false}
                    title="流程实验功能（Beta）"
                    style={{ background: 'var(--color-bg-2)' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <Text bold>启用多智能体自动编排（Beta）</Text>
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            关闭时将禁用新版大纲编排流程，避免误触实验能力。
                          </Text>
                        </div>
                      </div>
                      <Switch
                        checked={draftAiSettings.multiAgentBetaEnabled}
                        onChange={(checked) => updateDraftField('multiAgentBetaEnabled', checked)}
                      />
                    </div>
                    <Divider style={{ margin: '16px 0' }} />
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <Text bold>启用流程后 Prompt 自优化（Beta）</Text>
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            开启后会在每次设计/审核完成后生成 Prompt
                            优化建议（默认仅建议，不自动应用）。
                          </Text>
                        </div>
                      </div>
                      <Switch
                        checked={draftAiSettings.promptOptimizerBetaEnabled}
                        onChange={(checked) =>
                          updateDraftField('promptOptimizerBetaEnabled', checked)
                        }
                      />
                    </div>
                  </Card>

                  <Card
                    bordered={false}
                    title="输出模式"
                    style={{ background: 'var(--color-bg-2)' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <Text bold>默认优先流式输出</Text>
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            建议保持开启。可兼容“非流式无内容/空响应”的网关行为。
                          </Text>
                        </div>
                      </div>
                      <Switch
                        checked={draftAiSettings.forceStreamFallback}
                        onChange={(checked) => updateDraftField('forceStreamFallback', checked)}
                      />
                    </div>
                  </Card>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text bold>发散度 Temperature ({draftAiSettings.temperature})</Text>
                    </div>
                    <Slider
                      value={draftAiSettings.temperature}
                      onChange={(val) => updateDraftField('temperature', val as number)}
                      min={0}
                      max={2}
                      step={0.1}
                      style={{ marginTop: 8 }}
                    />
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text bold>截断度 Top P ({draftAiSettings.topP})</Text>
                    </div>
                    <Slider
                      value={draftAiSettings.topP}
                      onChange={(val) => updateDraftField('topP', val as number)}
                      min={0}
                      max={1}
                      step={0.05}
                      style={{ marginTop: 8 }}
                    />
                  </div>

                  <div>
                    <Text bold>单次回复字数上限 (Max Tokens)</Text>
                    <Input
                      type="number"
                      style={{ marginTop: 8 }}
                      value={draftAiSettings.maxTokens.toString()}
                      onChange={(val) => updateDraftField('maxTokens', parseInt(val || '1024'))}
                    />
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text bold>
                        话题重复度惩罚 Frequency Penalty ({draftAiSettings.frequencyPenalty})
                      </Text>
                    </div>
                    <Slider
                      value={draftAiSettings.frequencyPenalty}
                      onChange={(val) => updateDraftField('frequencyPenalty', val as number)}
                      min={-2}
                      max={2}
                      step={0.1}
                      style={{ marginTop: 8 }}
                    />
                  </div>
                </Space>
              </div>
            )}

            {activeTab === 'theme' && (
              <div style={{ paddingRight: 16 }}>
                <Space direction="vertical" size="large" style={{ width: '100%' }}>
                  <Card title="工作空间基础设置">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>自动本地保存历史</span>
                      <Switch checked={autoSaveEnabled} onChange={setAutoSaveEnabled} />
                    </div>
                    <Divider />
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>系统界面语言</span>
                      <Select
                        style={{ width: 140 }}
                        value={language}
                        onChange={handleLanguageChange}
                      >
                        <Select.Option value="zh-CN">简体中文</Select.Option>
                        <Select.Option value="en-US">English</Select.Option>
                      </Select>
                    </div>
                  </Card>

                  <Card title="阅读与排版偏好">
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <Text bold>全局显示字号放大 (Global Text Scaling)</Text>
                        <Text type="secondary">14px</Text>
                      </div>
                      <Slider
                        defaultValue={14}
                        min={12}
                        max={20}
                        step={1}
                        style={{ marginTop: 8, padding: '0 8px' }}
                      />
                    </div>
                    <Divider />
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <Text bold>剧本/代码块等宽字体 (Monospace Font)</Text>
                      </div>
                      <Select defaultValue="Fira Code" style={{ marginTop: 8 }}>
                        <Select.Option value="Fira Code">Fira Code (推荐)</Select.Option>
                        <Select.Option value="JetBrains Mono">JetBrains Mono</Select.Option>
                        <Select.Option value="Source Code Pro">Source Code Pro</Select.Option>
                        <Select.Option value="Consolas">Consolas</Select.Option>
                      </Select>
                    </div>
                  </Card>

                  <div className={styles.themeOptions}>
                    <button
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
              </div>
            )}

            {activeTab === 'audio' && (
              <div style={{ paddingRight: 16, textAlign: 'center', padding: '60px 20px' }}>
                <HelpCircle size={48} style={{ color: 'var(--color-text-4)', marginBottom: 16 }} />
                <Title heading={5} style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
                  语音交互 (TTS)
                </Title>
                <Text
                  type="secondary"
                  style={{
                    fontSize: 14,
                    lineHeight: 1.6,
                    maxWidth: 400,
                    margin: '0 auto',
                    display: 'block',
                  }}
                >
                  该功能正在开发中。将支持文本转语音、语音音量调节、多发音人选择等能力。
                </Text>
                <Tag color="orange" style={{ marginTop: 16 }}>
                  开发中
                </Tag>
              </div>
            )}

            {activeTab === 'audit' && (
              <div style={{ paddingRight: 16, textAlign: 'center', padding: '60px 20px' }}>
                <ShieldCheck size={48} style={{ color: 'var(--color-text-4)', marginBottom: 16 }} />
                <Title heading={5} style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
                  安全合规风控
                </Title>
                <Text
                  type="secondary"
                  style={{
                    fontSize: 14,
                    lineHeight: 1.6,
                    maxWidth: 400,
                    margin: '0 auto',
                    display: 'block',
                  }}
                >
                  该功能正在开发中。将支持内容审核、敏感信息过滤、安全策略配置等能力。
                </Text>
                <Tag color="orange" style={{ marginTop: 16 }}>
                  开发中
                </Tag>
              </div>
            )}

            {activeTab === 'proxy' && (
              <Space direction="vertical" size="large" style={{ width: '100%', paddingRight: 16 }}>
                <Card bordered={false} title="路由转发策略">
                  <Text type="secondary">
                    在企业防火墙或浏览器 CORS 受限环境下，Woohoo 默认尝试通过您本地的 8080
                    后端（如果已启动）构建代理通道，让客户端能够无感突破拦截。
                    <br />
                    <br />
                    如果后端关闭，通讯会自动平滑降级为在浏览器中通过 fetch 直连 AI API 接口。
                  </Text>
                </Card>
                <Space>
                  <Button type="outline" onClick={() => void checkServerStatus()}>
                    检测本地服务状态
                  </Button>
                </Space>
              </Space>
            )}
          </div>

          <div className={styles.footer} style={{ borderTop: '1px solid var(--color-border)' }}>
            <Button size="large" onClick={() => setSettingsOpen(false)} style={{ marginRight: 16 }}>
              取消
            </Button>
            <Button size="large" type="primary" onClick={handleSave} loading={isSaving}>
              {requiresGlobalSave ? '保存并应用全局设置' : '完成'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
