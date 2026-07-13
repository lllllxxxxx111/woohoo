import React, { useState, useCallback } from 'react';
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
  History,
  Loader2,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../store';
import { useToast } from '../../../../context/useToast';
import { ChatArea } from '../chat/ChatArea';
import { PipelineArea } from './PipelineArea';
import { AssetLibrary } from './AssetLibrary';
import { PipelinePreview } from './PipelinePreview';
import { AutomationArea } from './AutomationArea';
import { SkillsArea } from './SkillsArea';
import { ImageGenerationPanel } from '../../../../components/ImageGeneration/ImageGenerationPanel';
import { exportCoreProjectBundle, exportFullProjectBundle } from './workspaceMvp';
import { precheckExport, type PrecheckResponse, type ExportResult as ExportResultType } from './exportAudit';
import { ExportPrecheckDialog } from './ExportPrecheckDialog';
import { ExportResultDialog } from './ExportResultDialog';
import { ExportHistoryDialog } from './ExportHistoryDialog';
import styles from './Workspace.module.css';

const { Header, Content } = Layout;
const { Text } = Typography;

const TAB_LABELS = {
  chat: '创意对话',
  pipeline: '制作流程',
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

  // Export dialog state
  const [precheckVisible, setPrecheckVisible] = useState(false);
  const [precheckLoading, setPrecheckLoading] = useState(false);
  const [precheckData, setPrecheckData] = useState<PrecheckResponse | null>(null);
  const [precheckError, setPrecheckError] = useState<string | null>(null);
  const [resultVisible, setResultVisible] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResultType | null>(null);
  const [exporting, setExporting] = useState(false);
  const [pendingExportType, setPendingExportType] = useState<'full' | 'core' | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);

  const initiateExport = useCallback((type: 'full' | 'core') => {
    if (!activeProject) {
      showToast({
        type: 'warning',
        title: '请先选择项目',
        message: '只有在选中项目后才能导出。',
      });
      return;
    }
    setPendingExportType(type);
    setPrecheckVisible(true);
    setPrecheckLoading(true);
    setPrecheckData(null);
    setPrecheckError(null);

    precheckExport(activeProject.id)
      .then((data) => {
        setPrecheckData(data);
        setPrecheckLoading(false);
      })
      .catch((err) => {
        setPrecheckError(err instanceof Error ? err.message : '预检失败');
        setPrecheckLoading(false);
      });
  }, [activeProject, showToast]);

  const confirmExport = useCallback(async () => {
    if (!activeProject || !pendingExportType) return;
    setPrecheckVisible(false);
    setExporting(true);

    try {
      let result: ExportResultType;
      if (pendingExportType === 'full') {
        result = await exportFullProjectBundle({
          project: activeProject,
          script: activeScript,
          storyboard: activeStoryboard,
          assets: activeProjectAssets,
        });
      } else {
        result = await exportCoreProjectBundle({
          project: activeProject,
          script: activeScript,
          storyboard: activeStoryboard,
          assets: activeProjectAssets,
        });
      }

      setExportResult(result);
      setResultVisible(true);

      const isCore = result.exportType === 'core';
      if (result.missingAssets > 0) {
        showToast({
          type: 'warning',
          title: '导出完成（部分资产缺失）',
          message: `${result.filename} 已生成，${result.includedAssets}/${result.totalAssets} 个资产已打包，${result.missingAssets} 个资产下载失败。`,
        });
      } else if (isCore) {
        showToast({
          type: 'success',
          title: '导出成功',
          message: `${result.filename} 核心策划包已生成，项目共 ${result.totalAssets} 个资产（不含二进制文件），耗时 ${result.durationSeconds}s。`,
        });
      } else {
        showToast({
          type: 'success',
          title: '导出成功',
          message: `${result.filename} 已生成，包含 ${result.includedAssets} 个资产，耗时 ${result.durationSeconds}s。`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败';
      setExportResult({
        success: false,
        filename: '',
        exportType: pendingExportType,
        totalAssets: activeProjectAssets.length,
        includedAssets: 0,
        missingAssets: 0,
        bundleSizeBytes: 0,
        verification: {
          checkedAt: new Date().toISOString(),
          schemaVersion: '1.0',
          checks: [],
          totalChecks: 0,
          passedChecks: 0,
          warningChecks: 0,
          failedChecks: 1,
          allPassed: false,
        },
        sensitiveDataFindings: [],
        durationSeconds: 0,
        errorMessage: message,
      });
      setResultVisible(true);
      showToast({
        type: 'error',
        title: '导出失败',
        message,
      });
    } finally {
      setExporting(false);
      setPendingExportType(null);
    }
  }, [activeProject, activeScript, activeStoryboard, activeProjectAssets, pendingExportType, showToast]);

  const exportMenu = (
    <Menu>
      <Menu.Item key="full" onClick={() => initiateExport('full')}>
        <FileArchive size={14} style={{ marginRight: 8 }} /> 导出完整项目工程 (.tar)
      </Menu.Item>
      <Menu.Item key="optimized" onClick={() => initiateExport('core')}>
        <AISparkles size={14} style={{ marginRight: 8, color: 'var(--color-primary-light-4)' }} />{' '}
        导出核心策划包 (.md)
      </Menu.Item>
      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
      <Menu.Item key="history" onClick={() => setHistoryVisible(true)}>
        <History size={14} style={{ marginRight: 8 }} /> 导出历史记录
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
            <Dropdown droplist={exportMenu} position="bottom" disabled={exporting}>
              <Button
                shape="round"
                icon={exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                loading={exporting}
              >
                {exporting ? '导出中...' : ''}
              </Button>
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

      <ExportPrecheckDialog
        visible={precheckVisible}
        loading={precheckLoading}
        precheck={precheckData}
        error={precheckError}
        exportLabel={pendingExportType === 'full' ? '完整工程包 (.tar)' : '核心策划包 (.md)'}
        onCancel={() => {
          setPrecheckVisible(false);
          setPendingExportType(null);
        }}
        onConfirm={confirmExport}
      />

      <ExportResultDialog
        visible={resultVisible}
        result={exportResult}
        onClose={() => setResultVisible(false)}
      />

      <ExportHistoryDialog
        visible={historyVisible}
        projectId={activeProject?.id}
        projectName={activeProject?.name}
        onClose={() => setHistoryVisible(false)}
      />
    </Layout>
  );
};
