import React from 'react';
import { Layout, Menu, Dropdown, Button, Tooltip, Space, Typography } from '@arco-design/web-react';
import {
  MessageSquare,
  Clapperboard,
  Image,
  Folders,
  MonitorPlay,
  Download,
  FileArchive,
  HelpCircle,
  Zap,
  Palette,
  Rocket,
  Bell,
  ArrowUpCircle,
  Sparkles as AISparkles,
  Menu as MenuIcon,
  XCircle,
} from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import type { ActiveState } from '../../../../types';

import { useToast } from '../../../../context/useToast';
import { ChatArea } from '../chat/ChatArea';
import { PipelineArea } from './PipelineArea';
import { AssetLibrary } from './AssetLibrary';
import { PipelinePreview } from './PipelinePreview';
import { AutomationArea } from './AutomationArea';
import { SkillsArea } from './SkillsArea';
import { ImageGenerationPanel } from '../../../../components/ImageGeneration/ImageGenerationPanel';
import styles from './Workspace.module.css';

const { Header, Content } = Layout;
const { Text } = Typography;

export const Workspace: React.FC = () => {
  const { activeState, switchTab, projects, setHelpOpen, isSidebarCollapsed, setSidebarCollapsed } =
    useAppStore(
      useShallow((state) => ({
        activeState: state.activeState,
        switchTab: state.switchTab,
        projects: state.projects,
        setHelpOpen: state.setHelpOpen,
        isSidebarCollapsed: state.isSidebarCollapsed,
        setSidebarCollapsed: state.setSidebarCollapsed,
      })),
    );
  const { showToast } = useToast();

  const activeProject = projects.find((p) => p.id === activeState.projectId);

  /**
   * 根据标签页名称返回对应的图标组件
   * @param tab - 标签页标识
   * @returns 图标JSX元素
   */
  const getTabIcon = (tab: ActiveState['currentTab']) => {
    switch (tab) {
      case 'chat':
        return <MessageSquare size={16} />;
      case 'pipeline':
        return <Clapperboard size={16} />;
      case 'imageGeneration':
        return <Image size={16} />;
      case 'assets':
        return <Folders size={16} />;
      case 'automation':
        return <Zap size={16} />;
      case 'skills':
        return <Palette size={16} />;
      default:
        return <MessageSquare size={16} />;
    }
  };

  /**
   * 根据标签页名称返回对应的中文标签
   * @param tab - 标签页标识
   * @returns 标签文本
   */
  const getTabLabel = (tab: ActiveState['currentTab']) => {
    switch (tab) {
      case 'chat':
        return '创意对话';
      case 'pipeline':
        return '制作流程';
      case 'imageGeneration':
        return '图片生成';
      case 'assets':
        return '素材库';
      case 'automation':
        return '自动化';
      case 'skills':
        return '技能';
      default:
        return '对话';
    }
  };

  const handleExportFull = () => {
    showToast({
      type: 'success',
      title: '导出成功',
      message: `项目 "${activeProject?.name || 'Untitled'}" 的完整资产已导出 (ZIP)`,
    });
  };

  const handleExportOptimized = () => {
    showToast({
      type: 'success',
      title: '导出成功',
      message: `AI筛选优化后的 "${activeProject?.name || 'Untitled'}" 核心文件已导出`,
    });
  };

  const exportMenu = (
    <Menu>
      <Menu.Item key="full" onClick={handleExportFull}>
        <FileArchive size={14} style={{ marginRight: 8 }} /> 导出完整项目工程 (ZIP)
      </Menu.Item>
      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
      <Menu.Item key="optimized" onClick={handleExportOptimized}>
        <AISparkles size={14} style={{ marginRight: 8, color: 'var(--color-primary-light-4)' }} />{' '}
        导出 AI 筛选优化后项目
      </Menu.Item>
    </Menu>
  );

  const renderContent = () => {
    switch (activeState.currentTab) {
      case 'chat':
        return <ChatArea />;
      case 'pipeline':
        return <PipelineArea />;
      case 'imageGeneration':
        return <ImageGenerationPanel />;
      case 'assets':
        return <AssetLibrary />;
      case 'preview':
        return <PipelinePreview />;
      case 'automation':
        return <AutomationArea />;
      case 'skills':
        return <SkillsArea />;
      default:
        return <ChatArea />;
    }
  };

  /** 工作区标签页列表，类型约束为 ActiveState['currentTab'] 联合类型 */
  const tabs: ActiveState['currentTab'][] = [
    'chat',
    'pipeline',
    'imageGeneration',
    'assets',
    'automation',
    'skills',
  ];

  return (
    <Layout className={styles.workspace}>
      <Header className={styles.bentoHeader}>
        <div className={styles.projectInfo}>
          <Button
            className={styles.mobileMenuBtn}
            icon={<MenuIcon size={18} />}
            onClick={() => setSidebarCollapsed(!isSidebarCollapsed)}
            type="text"
          />
          <div
            className={styles.projectLogo}
            style={{
              background: 'var(--bg-glow)',
              boxShadow: '0 0 20px rgba(var(--arcoblue-6), 0.2)',
            }}
          >
            <Rocket size={18} color="white" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Text bold style={{ fontSize: '15px', color: 'var(--text-primary)', lineHeight: 1.2 }}>
              {activeProject ? activeProject.name : 'Woohoo Workspace'}
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
              <span
                className={styles.statusDot}
                style={{ background: activeProject ? 'var(--bg-accent)' : 'var(--text-muted)' }}
              ></span>
              <Text
                type="secondary"
                style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.02em' }}
              >
                {activeProject ? 'Active Project' : 'Ready'}
              </Text>
            </div>
          </div>
        </div>

        <div className={styles.tabsContainer}>
          {tabs.map((tab) => (
            <Button
              key={tab}
              type={activeState.currentTab === tab ? 'primary' : 'secondary'}
              shape="round"
              icon={getTabIcon(tab)}
              onClick={() => switchTab(tab)}
              className={activeState.currentTab === tab ? styles.activeTabBtn : styles.tabBtn}
            >
              {getTabLabel(tab)}
            </Button>
          ))}
        </div>

        <Space size={12} className={styles.actions}>
          <Button.Group>
            <Tooltip content="检查更新">
              <Button shape="round" icon={<ArrowUpCircle size={15} />} />
            </Tooltip>
            <Dropdown
              droplist={
                <Menu>
                  <Menu.Item key="msgs">No notifications</Menu.Item>
                </Menu>
              }
              position="bottom"
            >
              <Button shape="round" icon={<Bell size={15} />} />
            </Dropdown>
          </Button.Group>

          <Button.Group>
            <Tooltip content="帮助中心">
              <Button
                shape="round"
                icon={<HelpCircle size={15} />}
                onClick={() => setHelpOpen(true)}
              />
            </Tooltip>
            <Dropdown droplist={exportMenu} position="bottom">
              <Button shape="round" icon={<Download size={15} />} />
            </Dropdown>
          </Button.Group>

          <Button
            type={activeState.currentTab === 'preview' ? 'primary' : 'outline'}
            icon={
              activeState.currentTab === 'preview' ? (
                <XCircle size={16} />
              ) : (
                <MonitorPlay size={16} />
              )
            }
            onClick={() => switchTab(activeState.currentTab === 'preview' ? 'chat' : 'preview')}
            shape="round"
            style={{
              background: activeState.currentTab === 'preview' ? 'var(--bg-accent)' : 'transparent',
              borderColor: 'var(--bg-accent)',
              color: activeState.currentTab === 'preview' ? 'white' : 'var(--bg-accent)',
              paddingLeft: '20px',
              paddingRight: '20px',
            }}
          >
            {activeState.currentTab === 'preview' ? '关闭预览' : '预览视图'}
          </Button>
        </Space>
      </Header>

      <Content className={styles.bentoContent}>
        {activeState.currentTab === 'chat' ? (
          <div className={styles.bentoGrid}>
            <div className={styles.bentoCardMain}>{renderContent()}</div>
            {/* Can add another bento block on the side if needed, but chat has its own sidepanel */}
          </div>
        ) : (
          <div className={styles.bentoCardFull}>{renderContent()}</div>
        )}
      </Content>
    </Layout>
  );
};
