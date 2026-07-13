import React from 'react';
import { Layout, Menu, Dropdown, Button, Tooltip, Space, Typography } from '@arco-design/web-react';
import {
  MonitorPlay,
  Download,
  FileArchive,
  HelpCircle,
  Rocket,
  Bell,
  ArrowUpCircle,
  Sparkles as AISparkles,
  Menu as MenuIcon,
  XCircle,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../store';
import { useToast } from '../../../../context/useToast';
import { ChatArea } from '../chat/ChatArea';
import { PipelineArea } from './PipelineArea';
import { AssetLibrary } from './AssetLibrary';
import { PipelinePreview } from './PipelinePreview';
import { PipelineReviewWorkbench } from './PipelineReviewWorkbench';
import { AutomationArea } from './AutomationArea';
import { SkillsArea } from './SkillsArea';
import { ImageGenerationPanel } from '../../../../components/ImageGeneration/ImageGenerationPanel';
import { exportCoreProjectBundle, exportFullProjectBundle } from './workspaceMvp';
import styles from './Workspace.module.css';

const { Header, Content } = Layout;
const { Text } = Typography;

const TAB_LABELS = {
  chat: '创意对话',
  pipeline: '制作流程',
  review: '人工复核',
  imageGeneration: '图片生成',
  assets: '资产库',
  automation: '自动化',
  skills: '技能',
  preview: '预览视图',
} as const;

export const Workspace: React.FC = () => {
  const {
    activeState,
    switchTab,
    projects,
    scripts,
    storyboards,
    assets,
    setHelpOpen,
    isSidebarCollapsed,
    setSidebarCollapsed,
  } = useAppStore(
    useShallow((state) => ({
      activeState: state.activeState,
      switchTab: state.switchTab,
      projects: state.projects,
      scripts: state.scripts,
      storyboards: state.storyboards,
      assets: state.assets,
      setHelpOpen: state.setHelpOpen,
      isSidebarCollapsed: state.isSidebarCollapsed,
      setSidebarCollapsed: state.setSidebarCollapsed,
    })),
  );
  const { showToast } = useToast();

  const activeProject = projects.find((project) => project.id === activeState.projectId) ?? null;
  const activeScript = scripts.find((script) => script.projectId === activeState.projectId) ?? null;
  const activeStoryboard =
    storyboards.find((storyboard) => storyboard.projectId === activeState.projectId) ?? null;
  const activeProjectAssets = assets.filter((asset) => asset.projectId === activeState.projectId);
  const activeViewLabel = TAB_LABELS[activeState.currentTab] ?? '工作区';

  const handleExportFull = async () => {
    if (!activeProject) {
      showToast({
        type: 'warning',
        title: '请先选择项目',
        message: '只有在选中项目后才能导出完整工程包。',
      });
      return;
    }

    try {
      const result = await exportFullProjectBundle({
        project: activeProject,
        script: activeScript,
        storyboard: activeStoryboard,
        assets: activeProjectAssets,
      });

      showToast({
        type: result.missingAssets > 0 ? 'warning' : 'success',
        title: '完整工程包已导出',
        message:
          result.missingAssets > 0
            ? `${result.filename} 已生成，成功打包 ${result.downloadedAssets} 个资产，另有 ${result.missingAssets} 个资产未能下载。`
            : `${result.filename} 已生成，包含 ${result.downloadedAssets} 个资产文件。`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '导出失败',
        message: error instanceof Error ? error.message : '无法生成完整工程包。',
      });
    }
  };

  const handleExportOptimized = async () => {
    if (!activeProject) {
      showToast({
        type: 'warning',
        title: '请先选择项目',
        message: '只有在选中项目后才能导出核心策划包。',
      });
      return;
    }

    try {
      const result = await exportCoreProjectBundle({
        project: activeProject,
        script: activeScript,
        storyboard: activeStoryboard,
        assets: activeProjectAssets,
      });

      showToast({
        type: 'success',
        title: '核心策划包已导出',
        message: `${result.filename} 已生成，包含 ${result.chapterCount} 个章节和 ${result.shotCount} 个镜头。`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '导出失败',
        message: error instanceof Error ? error.message : '无法生成核心策划包。',
      });
    }
  };

  const exportMenu = (
    <Menu>
      <Menu.Item key="full" onClick={() => void handleExportFull()}>
        <FileArchive size={14} style={{ marginRight: 8 }} /> 导出完整项目工程 (.tar)
      </Menu.Item>
      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
      <Menu.Item key="optimized" onClick={() => void handleExportOptimized()}>
        <AISparkles size={14} style={{ marginRight: 8, color: 'var(--color-primary-light-4)' }} />{' '}
        导出核心策划包 (.md)
      </Menu.Item>
    </Menu>
  );

  const renderContent = () => {
    switch (activeState.currentTab) {
      case 'chat':
        return <ChatArea />;
      case 'pipeline':
        return <PipelineArea />;
      case 'review':
        return <PipelineReviewWorkbench />;
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
                {activeProject ? activeViewLabel : 'Ready'}
              </Text>
            </div>
          </div>
        </div>

        <div className={styles.viewContext}>
          <span>当前视图</span>
          <strong>{activeViewLabel}</strong>
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
              activeState.currentTab === 'preview' ? <XCircle size={16} /> : <MonitorPlay size={16} />
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
          </div>
        ) : (
          <div className={styles.bentoCardFull}>{renderContent()}</div>
        )}
      </Content>
    </Layout>
  );
};
