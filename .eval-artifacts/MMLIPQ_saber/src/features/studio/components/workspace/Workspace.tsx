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
import { exportCoreProjectBundle } from './workspaceMvp';
import {
  runPreflightCheck,
  exportAuditableProject,
  type ExportResult,
  type PreflightResult,
  type ExportType,
} from './workspaceExport';
import { recordExport } from '../../../../lib/serverApi';
import { ExportPreflightModal } from './ExportPreflightModal';
import { ExportResultModal } from './ExportResultModal';
import { ExportHistoryPanel } from './ExportHistoryPanel';
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

type PendingExport = {
  type: ExportType;
  label: string;
};

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

  // ─── Auditable export state ──────────────────────────────────
  const [preflightVisible, setPreflightVisible] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [pendingExport, setPendingExport] = useState<PendingExport | null>(null);
  const [resultVisible, setResultVisible] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [exporting, setExporting] = useState(false);

  const startExportFlow = useCallback(async (type: ExportType, label: string) => {
    if (!activeProject) {
      showToast({
        type: 'warning',
        title: '请先选择项目',
        message: '只有在选中项目后才能导出。',
      });
      return;
    }

    setPendingExport({ type, label });
    setPreflightLoading(true);
    setPreflightVisible(true);
    setPreflightResult(null);

    try {
      const result = await runPreflightCheck({
        project: activeProject,
        script: activeScript,
        storyboard: activeStoryboard,
        assets: activeProjectAssets,
      });
      setPreflightResult(result);
    } catch (error) {
      showToast({
        type: 'error',
        title: '预检失败',
        message: error instanceof Error ? error.message : '无法执行导出预检。',
      });
      setPreflightVisible(false);
    } finally {
      setPreflightLoading(false);
    }
  }, [activeProject, activeScript, activeStoryboard, activeProjectAssets, showToast]);

  const confirmExport = useCallback(async () => {
    if (!activeProject || !pendingExport) return;

    setPreflightVisible(false);
    setExporting(true);

    try {
      const result = await exportAuditableProject({
        project: activeProject,
        script: activeScript,
        storyboard: activeStoryboard,
        assets: activeProjectAssets,
        exportType: pendingExport.type,
        includeConversations: true,
        onProgress: (stage, current, total) => {
          // Could add progress bar in future
          if (stage === 'loading-assets' && total > 0 && current % 5 === 0) {
            // silent progress for now
          }
        },
      });

      setExportResult(result);
      setResultVisible(true);

      // Record to backend audit log (fire and forget, non-blocking)
      try {
        await recordExport(activeProject.id, {
          exportType: result.exportType,
          packageFormat: 'tar',
          status: result.status,
          filename: result.filename,
          totalAssets: result.manifest.assets.length + result.missingAssets,
          includedAssets: result.downloadedAssets,
          missingAssets: result.missingAssets,
          totalSizeBytes: result.totalSizeBytes,
          manifestJson: JSON.stringify(result.manifest),
          verificationJson: JSON.stringify(result.verification),
          clientInfo: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : undefined,
        });
      } catch (err) {
        // Audit recording failure should not block user from getting their file
        console.warn('Failed to record export audit:', err);
      }

      showToast({
        type: result.status === 'completed' ? 'success' : result.status === 'partial' ? 'warning' : 'error',
        title:
          result.status === 'completed'
            ? '导出完成'
            : result.status === 'partial'
              ? '导出完成（部分资产缺失）'
              : '导出失败',
        message:
          result.status === 'failed'
            ? `未成功打包任何文件，${result.filename} 未能生成。`
            : result.missingAssets > 0
              ? `${result.filename} 已下载，${result.downloadedAssets} 个资产成功打包，${result.missingAssets} 个资产下载失败，共 ${result.manifest.files.length} 个文件。`
              : `${result.filename} 已下载，${result.downloadedAssets} 个资产全部成功打包，共 ${result.manifest.files.length} 个文件。`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '导出失败',
        message: error instanceof Error ? error.message : '无法生成导出包。',
      });
    } finally {
      setExporting(false);
      setPendingExport(null);
    }
  }, [activeProject, activeScript, activeStoryboard, activeProjectAssets, pendingExport, showToast]);

  const handleExportFull = () => {
    void startExportFlow('full', '完整工程包 (.tar)');
  };

  const handleExportCore = () => {
    // Core markdown export uses legacy flow (lightweight)
    if (!activeProject) {
      showToast({
        type: 'warning',
        title: '请先选择项目',
        message: '只有在选中项目后才能导出核心策划包。',
      });
      return;
    }
    void (async () => {
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
    })();
  };

  const exportMenu = (
    <Menu>
      <Menu.Item key="auditable-full" onClick={handleExportFull}>
        <FileArchive size={14} style={{ marginRight: 8 }} />
        可审计完整工程包 (.tar)
        <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>含校验清单</Text>
      </Menu.Item>
      <Menu.Item key="core" onClick={handleExportCore}>
        <AISparkles size={14} style={{ marginRight: 8, color: 'var(--color-primary-light-4)' }} />
        核心策划包 (.md)
      </Menu.Item>
      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
      <Menu.Item key="history" onClick={() => setHistoryVisible(true)}>
        <History size={14} style={{ marginRight: 8 }} />
        导出历史记录
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
            <Dropdown droplist={exportMenu} position="bottom">
              <Button
                shape="round"
                icon={<Download size={15} />}
                loading={exporting}
              />
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

      {/* Preflight check modal */}
      <ExportPreflightModal
        visible={preflightVisible}
        loading={preflightLoading}
        preflight={preflightResult}
        onCancel={() => {
          setPreflightVisible(false);
          setPendingExport(null);
        }}
        onConfirm={confirmExport}
        exportType={pendingExport?.label}
      />

      {/* Export result modal */}
      <ExportResultModal
        visible={resultVisible}
        result={exportResult}
        onClose={() => setResultVisible(false)}
        onViewHistory={() => {
          setResultVisible(false);
          setHistoryVisible(true);
        }}
      />

      {/* Export history panel */}
      <ExportHistoryPanel
        visible={historyVisible}
        projectId={activeProject?.id}
        onClose={() => setHistoryVisible(false)}
      />
    </Layout>
  );
};
