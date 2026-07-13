import React, { useState, useCallback, useEffect } from 'react';
import {
  Layout,
  Menu,
  Dropdown,
  Button,
  Tooltip,
  Space,
  Typography,
  Modal,
  Progress,
  Tag,
  Alert,
  Descriptions,
  List,
  Spin,
  Message,
  Empty,
} from '@arco-design/web-react';
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
  CheckCircle,
  AlertTriangle,
  Shield,
  Info,
  History,
  FileCheck,
  RefreshCw,
  Clock,
  User,
  HardDrive,
  Hash,
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
import {
  exportCoreProjectBundle,
  exportFullProjectBundle,
  exportAuditableProjectBundle,
  precheckExport,
  type ExportPrecheckResult,
  type AuditableExportResult,
  type PrecheckIssue,
} from './workspaceMvp';
import {
  listProjectExports,
  listMyExports,
  downloadServerExport,
  type ExportAuditRecord,
} from '../../../../lib/serverApi';
import styles from './Workspace.module.css';

const { Header, Content } = Layout;
const { Text, Title } = Typography;

const TAB_LABELS = {
  chat: '创意对话',
  pipeline: '制作流程',
  imageGeneration: '图片生成',
  assets: '资产库',
  automation: '自动化',
  skills: '技能',
  preview: '预览视图',
} as const;

type ExportPhase = 'idle' | 'prechecking' | 'precheck-done' | 'exporting' | 'export-done';

type ExportProgress = {
  phase: string;
  current: number;
  total: number;
};

const IconCheck = () => <CheckCircle size={16} color="var(--color-success)" />;
const IconWarn = () => <AlertTriangle size={16} color="var(--color-warning)" />;
const IconError = () => <XCircle size={16} color="var(--color-danger)" />;
const IconInfo = () => <Info size={16} color="var(--color-primary-6)" />;

function severityIcon(severity: PrecheckIssue['severity']) {
  switch (severity) {
    case 'error':
      return <IconError />;
    case 'warning':
      return <IconWarn />;
    default:
      return <IconInfo />;
  }
}

function severityTag(severity: PrecheckIssue['severity']) {
  const colorMap = { error: 'red', warning: 'orange', info: 'arcoblue' } as const;
  const labelMap = { error: '阻塞', warning: '警告', info: '提示' } as const;
  return <Tag size="small" color={colorMap[severity]}>{labelMap[severity]}</Tag>;
}

function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function shortSha(sha: string | undefined, len = 10): string {
  if (!sha) return '-';
  return sha.slice(0, len);
}

function exportStatusTag(status: ExportAuditRecord['status']) {
  const map = {
    completed: { color: 'green', label: '成功' },
    partial:   { color: 'orange', label: '部分完成' },
    failed:    { color: 'red', label: '失败' },
    in_progress: { color: 'arcoblue', label: '进行中' },
  } as const;
  const cfg = map[status] ?? { color: 'gray', label: status };
  return <Tag size="small" color={cfg.color}>{cfg.label}</Tag>;
}

function exportTypeLabel(t: string) {
  const map: Record<string, string> = { full: '完整工程包', core: '核心策划包', snapshot: '快照包' };
  return map[t] ?? t;
}

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

  // 导出相关状态
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [exportPhase, setExportPhase] = useState<ExportPhase>('idle');
  const [precheckResult, setPrecheckResult] = useState<ExportPrecheckResult | null>(null);
  const [exportResult, setExportResult] = useState<AuditableExportResult | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress>({ phase: '', current: 0, total: 0 });
  const [exportHistoryVisible, setExportHistoryVisible] = useState(false);
  const [exportHistoryLoading, setExportHistoryLoading] = useState(false);
  const [exportHistoryRecords, setExportHistoryRecords] = useState<ExportAuditRecord[]>([]);
  const [exportHistoryError, setExportHistoryError] = useState<string | null>(null);
  const [downloadingAuditId, setDownloadingAuditId] = useState<string | null>(null);

  const fetchExportHistory = useCallback(async () => {
    if (!activeProject) {
      setExportHistoryError('当前没有活动项目');
      return;
    }
    setExportHistoryLoading(true);
    setExportHistoryError(null);
    try {
      // 优先拉取当前项目的导出历史；若失败则退回"我的全部导出"
      let records: ExportAuditRecord[] = [];
      try {
        const res = await listProjectExports(activeProject.id, { limit: 20 });
        records = res.records;
      } catch {
        const res = await listMyExports({ limit: 20 });
        records = res.records;
      }
      setExportHistoryRecords(records);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '无法加载导出历史';
      // 识别"后端不可达"
      if (msg.includes('不可达') || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setExportHistoryError('后端服务未连接，无法获取导出审计历史。请先启动后端服务。');
      } else {
        setExportHistoryError(msg);
      }
      setExportHistoryRecords([]);
    } finally {
      setExportHistoryLoading(false);
    }
  }, [activeProject]);

  // 打开历史对话框时自动拉取
  useEffect(() => {
    if (exportHistoryVisible) {
      fetchExportHistory();
    }
  }, [exportHistoryVisible, fetchExportHistory]);

  const handleDownloadPastExport = useCallback(async (auditId: string, packageName: string) => {
    setDownloadingAuditId(auditId);
    try {
      const blob = await downloadServerExport(auditId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = packageName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast({ type: 'success', title: '下载开始', message: `正在下载 ${packageName}` });
    } catch (err) {
      showToast({
        type: 'error',
        title: '下载失败',
        message: err instanceof Error ? err.message : '无法下载导出包',
      });
    } finally {
      setDownloadingAuditId(null);
    }
  }, [showToast]);

  const runPrecheck = useCallback(async () => {
    if (!activeProject) return;
    setExportPhase('prechecking');
    try {
      const result = await precheckExport({
        project: activeProject,
        script: activeScript,
        storyboard: activeStoryboard,
        assets: activeProjectAssets,
      });
      setPrecheckResult(result);
      setExportPhase('precheck-done');
    } catch (error) {
      showToast({
        type: 'error',
        title: '预检失败',
        message: error instanceof Error ? error.message : '无法完成导出预检',
      });
      setExportPhase('idle');
    }
  }, [activeProject, activeScript, activeStoryboard, activeProjectAssets, showToast]);

  const openAuditableExport = useCallback(() => {
    if (!activeProject) {
      showToast({ type: 'warning', title: '请先选择项目', message: '选中项目后才能导出。' });
      return;
    }
    setExportResult(null);
    setPrecheckResult(null);
    setExportModalVisible(true);
    void runPrecheck();
  }, [activeProject, showToast, runPrecheck]);

  const startAuditableExport = useCallback(async () => {
    if (!activeProject) return;
    setExportPhase('exporting');
    setExportProgress({ phase: '开始导出...', current: 0, total: 5 });
    try {
      const result = await exportAuditableProjectBundle({
        project: activeProject,
        script: activeScript,
        storyboard: activeStoryboard,
        assets: activeProjectAssets,
        onProgress: (phase, current, total) => {
          setExportProgress({ phase, current, total });
        },
      });
      setExportResult(result);
      setExportPhase('export-done');

      const hasIssues = result.missingAssets > 0 || result.corruptedAssets > 0;
      const totalKnown = result.downloadedAssets + result.missingAssets + result.corruptedAssets;
      showToast({
        type: hasIssues ? 'warning' : result.verification.overallStatus === 'fail' ? 'error' : 'success',
        title: hasIssues ? '导出完成（有问题）' : '可审计导出包已生成',
        message: hasIssues
          ? `${result.filename} 已下载：项目共 ${totalKnown} 个资产，成功 ${result.downloadedAssets} 个，缺失 ${result.missingAssets} 个，损坏 ${result.corruptedAssets} 个。包内含manifest、SHA-256校验和与验证报告。`
          : `${result.filename} 已下载：共 ${result.downloadedAssets} 个资产全部打包完成，无缺失；包含manifest、SHA-256校验和与验证报告。`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '导出失败',
        message: error instanceof Error ? error.message : '无法生成可审计导出包',
      });
      setExportPhase('precheck-done');
    }
  }, [activeProject, activeScript, activeStoryboard, activeProjectAssets, showToast]);

  const handleExportFull = async () => {
    if (!activeProject) {
      showToast({ type: 'warning', title: '请先选择项目', message: '只有在选中项目后才能导出完整工程包。' });
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
        message: result.missingAssets > 0
          ? `${result.filename} 已生成：项目共 ${activeProjectAssets.length} 个资产，成功打包 ${result.downloadedAssets} 个，缺失 ${result.missingAssets} 个。`
          : `${result.filename} 已生成：共 ${result.downloadedAssets} 个资产，全部打包完成，无缺失。`,
      });
    } catch (error) {
      showToast({ type: 'error', title: '导出失败', message: error instanceof Error ? error.message : '无法生成完整工程包。' });
    }
  };

  const handleExportOptimized = async () => {
    if (!activeProject) {
      showToast({ type: 'warning', title: '请先选择项目', message: '只有在选中项目后才能导出核心策划包。' });
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
        message: `${result.filename} 已生成：引用 ${result.totalAssets} 个资产（仅输出 Markdown，无二进制文件），包含 ${result.chapterCount} 个章节和 ${result.shotCount} 个镜头，无缺失。`,
      });
    } catch (error) {
      showToast({ type: 'error', title: '导出失败', message: error instanceof Error ? error.message : '无法生成核心策划包。' });
    }
  };

  const closeExportModal = () => {
    if (exportPhase === 'exporting') {
      Message.warning('正在导出中，请稍候...');
      return;
    }
    setExportModalVisible(false);
    setExportPhase('idle');
    setPrecheckResult(null);
    setExportResult(null);
  };

  const exportMenu = (
    <Menu>
      <Menu.Item key="auditable" onClick={() => void openAuditableExport()}>
        <Shield size={14} style={{ marginRight: 8, color: 'var(--color-success)' }} />
        可审计导出包（推荐）
      </Menu.Item>
      <div style={{ height: 1, backgroundColor: 'var(--color-border-2)', margin: '4px 0' }} />
      <Menu.Item key="full" onClick={() => void handleExportFull()}>
        <FileArchive size={14} style={{ marginRight: 8 }} /> 导出完整项目工程 (.tar)
      </Menu.Item>
      <Menu.Item key="optimized" onClick={() => void handleExportOptimized()}>
        <AISparkles size={14} style={{ marginRight: 8, color: 'var(--color-primary-light-4)' }} />
        导出核心策划包 (.md)
      </Menu.Item>
      <div style={{ height: 1, backgroundColor: 'var(--color-border-2)', margin: '4px 0' }} />
      <Menu.Item key="history" onClick={() => setExportHistoryVisible(true)}>
        <History size={14} style={{ marginRight: 8 }} /> 导出历史
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

  const renderPrecheckContent = () => {
    if (exportPhase === 'prechecking') {
      return (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin size={40} />
          <div style={{ marginTop: 16, color: 'var(--color-text-2)' }}>正在检查项目资产状态...</div>
          <div style={{ marginTop: 8, color: 'var(--color-text-3)', fontSize: 12 }}>
            检测脚本、分镜、资产URL、重复文件名、文件可达性...
          </div>
        </div>
      );
    }

    if (exportPhase === 'precheck-done' && precheckResult) {
      const { summary, issues } = precheckResult;
      const errors = issues.filter((i) => i.severity === 'error');
      const warnings = issues.filter((i) => i.severity === 'warning');
      const infos = issues.filter((i) => i.severity === 'info');

      // 按字段分组展示：先阻塞，再警告，最后提示
      const orderedIssues = [...errors, ...warnings, ...infos];

      // 生成Alert标题和content
      let alertType: 'success' | 'warning' | 'error' = 'success';
      let alertTitle = '项目已就绪，可以导出';
      let alertContent: string | undefined;

      if (errors.length > 0) {
        alertType = 'error';
        alertTitle = `存在 ${errors.length} 个阻塞问题，无法导出`;
        alertContent = '请修复以下红色标记的问题后再重试导出：';
      } else if (warnings.length > 0) {
        alertType = 'warning';
        alertTitle = '可以导出，但有一些警告';
        alertContent = '导出可继续，但以下警告可能影响交付质量：';
      }

      return (
        <div>
          <Alert
            type={alertType}
            title={alertTitle}
            content={alertContent}
            style={{ marginBottom: 16 }}
          />

          {/* 问题计数概览 */}
          {issues.length > 0 && (
            <Space style={{ marginBottom: 12, flexWrap: 'wrap' }}>
              {summary.blockingCount > 0 && (
                <Tag color="red" size="large">
                  <XCircle size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                  阻塞 {summary.blockingCount}
                </Tag>
              )}
              {summary.warningCount > 0 && (
                <Tag color="orange" size="large">
                  <AlertTriangle size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                  警告 {summary.warningCount}
                </Tag>
              )}
              {summary.infoCount > 0 && (
                <Tag color="arcoblue" size="large">
                  <Info size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                  提示 {summary.infoCount}
                </Tag>
              )}
            </Space>
          )}

          <Descriptions
            column={2}
            size="small"
            border
            data={[
              { label: '项目名称', value: precheckResult.projectName },
              { label: '预计大小', value: summary.estimatedSizeHuman },
              { label: '资产总数', value: summary.totalAssets },
              { label: '就绪资产', value: <Tag color="green">{summary.readyAssets}</Tag> },
              { label: '缺失/损坏', value: summary.missingAssets + summary.corruptedAssets > 0
                ? <Tag color="red">{summary.missingAssets + summary.corruptedAssets}</Tag> : '0' },
              { label: '外部资产', value: summary.externalAssets > 0 ? <Tag color="blue">{summary.externalAssets}</Tag> : '0' },
              { label: '重复文件名', value: summary.duplicateNames > 0 ? <Tag color="orange">{summary.duplicateNames}</Tag> : '0' },
              { label: '空镜头', value: summary.emptyLines > 0 ? <Tag color="orange">{summary.emptyLines}</Tag> : '0' },
              { label: '剧本', value: summary.scriptPresent ? <Tag color="green" size="small">有</Tag> : <Tag color="orange" size="small">无</Tag> },
              { label: '分镜', value: summary.storyboardPresent ? <Tag color="green" size="small">有</Tag> : <Tag color="orange" size="small">无</Tag> },
              { label: '镜头数', value: summary.shotCount },
              { label: '关键帧数', value: summary.keyframeCount },
            ]}
            style={{ marginBottom: 16 }}
          />

          {orderedIssues.length > 0 && (
            <div>
              <Title heading={6} style={{ margin: '12px 0 8px' }}>
                检查详情 ({orderedIssues.length})
              </Title>
              <List
                size="small"
                dataSource={orderedIssues}
                render={(issue) => (
                  <List.Item
                    style={{
                      padding: '8px 4px',
                      borderLeft: issue.severity === 'error'
                        ? '3px solid rgb(var(--red-6))'
                        : issue.severity === 'warning'
                          ? '3px solid rgb(var(--orange-6))'
                          : '3px solid rgb(var(--arcoblue-6))',
                      paddingLeft: 12,
                      background: issue.severity === 'error' ? 'rgb(var(--red-1))' : 'transparent',
                    }}
                  >
                    <Space wrap>
                      {severityIcon(issue.severity)}
                      {severityTag(issue.severity)}
                      {issue.field && (
                        <Tag size="small" color="gray">{issue.field}</Tag>
                      )}
                      <Text style={{ fontSize: 13 }}>{issue.message}</Text>
                      {issue.assetName && (
                        <Text type="secondary" style={{ fontSize: 12 }}>— {issue.assetName}</Text>
                      )}
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          )}

          {orderedIssues.length === 0 && (
            <Alert type="success" content="所有检查项均已通过，项目准备就绪。" style={{ marginBottom: 16 }} />
          )}

          <div style={{ marginTop: 16, padding: 12, background: 'var(--color-fill-2)', borderRadius: 6 }}>
            <Space direction="vertical" size={4}>
              <Text bold style={{ fontSize: 13 }}><FileCheck size={14} style={{ marginRight: 6, verticalAlign: -2 }} />可审计导出包包含：</Text>
              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>
                • manifest.json — 完整清单索引（项目、版本、资产、文件校验和）<br />
                • checksums.json — 每个文件的SHA-256校验和<br />
                • missing-assets.json — 缺失/损坏资产明细（含原因）<br />
                • verification-report.json — 验证报告（敏感信息扫描、复现性评估）<br />
                • project-snapshot.json — 项目状态快照（剧本/分镜/角色/场景/终剪）<br />
                • generation-params.json — AI生成参数摘要<br />
                • 完整资产文件 + 剧本 + 分镜 + 对话记录
              </Text>
            </Space>
          </div>
        </div>
      );
    }

    if (exportPhase === 'exporting') {
      const percent = Math.round((exportProgress.current / exportProgress.total) * 100);
      return (
        <div style={{ padding: '20px 0' }}>
          <Progress percent={percent} animation formatText={() => `${exportProgress.current}/${exportProgress.total}`} />
          <div style={{ textAlign: 'center', marginTop: 16, color: 'var(--color-text-2)' }}>
            {exportProgress.phase}
          </div>
        </div>
      );
    }

    if (exportPhase === 'export-done' && exportResult) {
      const { verification, missing, packageSha256, totalSizeBytes } = exportResult;
      const passed = verification.overallStatus !== 'fail';

      return (
        <div>
          <Alert
            type={passed ? (verification.overallStatus === 'pass' ? 'success' : 'warning') : 'error'}
            title={passed
              ? (verification.overallStatus === 'pass' ? '导出成功！' : '导出完成，但需关注以下问题')
              : '导出完成，但存在错误'
            }
            style={{ marginBottom: 16 }}
          />

          <Descriptions
            column={1}
            size="small"
            border
            data={[
              {
                label: '文件',
                value: <Text code>{exportResult.filename}</Text>,
              },
              {
                label: '大小',
                value: `${(totalSizeBytes / 1024 / 1024).toFixed(2)} MB (${totalSizeBytes.toLocaleString()} 字节)`,
              },
              {
                label: 'SHA-256 包校验和',
                value: <Text code copyable style={{ fontSize: 11, wordBreak: 'break-all' }}>{packageSha256 || '(计算中)'}</Text>,
              },
              {
                label: '资产',
                value: (
                  <Space>
                    <Tag color="green">成功: {exportResult.downloadedAssets}</Tag>
                    {exportResult.missingAssets > 0 && <Tag color="red">缺失: {exportResult.missingAssets}</Tag>}
                    {exportResult.corruptedAssets > 0 && <Tag color="orange">损坏: {exportResult.corruptedAssets}</Tag>}
                  </Space>
                ),
              },
              {
                label: '验证状态',
                value: (
                  <Tag color={passed ? (verification.overallStatus === 'pass' ? 'green' : 'orange') : 'red'}>
                    {verification.overallStatus === 'pass' ? '全部通过' :
                     verification.overallStatus === 'pass_with_warnings' ? '通过（有警告）' : '存在错误'}
                  </Tag>
                ),
              },
            ]}
            style={{ marginBottom: 16 }}
          />

          {verification.checksPerformed.length > 0 && (
            <div>
              <Title heading={6} style={{ margin: '12px 0 8px' }}>验证检查项</Title>
              <List
                size="small"
                dataSource={verification.checksPerformed}
                render={(check) => (
                  <List.Item>
                    <Space>
                      {check.status === 'pass' ? <IconCheck /> : check.status === 'warn' ? <IconWarn /> : <IconError />}
                      <Text bold>{check.name}:</Text>
                      <Text type="secondary">{check.message}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          )}

          {(verification.warnings.length > 0 || verification.errors.length > 0) && (
            <div style={{ marginTop: 12 }}>
              {verification.warnings.length > 0 && (
                <Alert
                  type="warning"
                  title="警告"
                  style={{ marginBottom: 8 }}
                  content={
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {verification.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  }
                />
              )}
              {verification.errors.length > 0 && (
                <Alert
                  type="error"
                  title="错误"
                  content={
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {verification.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  }
                />
              )}
            </div>
          )}

          {verification.sensitiveFindings.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Alert
                type="warning"
                title={`检测到 ${verification.sensitiveFindings.length} 处敏感信息`}
                content={
                  <List
                    size="small"
                    dataSource={verification.sensitiveFindings}
                    render={(f) => (
                      <List.Item>
                        <Space>
                          <Tag size="small" color={f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'orange' : 'blue'}>
                            {f.category}
                          </Tag>
                          <Text style={{ marginLeft: 8 }}>{f.description}</Text>
                          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>@{f.file}</Text>
                        </Space>
                      </List.Item>
                    )}
                  />
                }
              />
            </div>
          )}

          {missing.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Title heading={6} style={{ margin: '12px 0 8px' }}>缺失资产清单 ({missing.length})</Title>
              <List
                size="small"
                dataSource={missing.slice(0, 20)}
                render={(m) => (
                  <List.Item>
                    <Space>
                      <IconError />
                      <Text>{m.assetName}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>{m.reason}</Text>
                    </Space>
                  </List.Item>
                )}
                footer={missing.length > 20 ? <Text type="secondary">... 还有 {missing.length - 20} 项，请查看包内 missing-assets.json</Text> : null}
              />
            </div>
          )}

          <div style={{ marginTop: 16, padding: 12, background: 'var(--color-success-light-1)', borderRadius: 6, fontSize: 12 }}>
            <Text type="secondary">
              提示：导出包已自动下载。交付前请核对 verification-report.json 中的校验和与敏感信息扫描结果。
              包内 manifest.json 包含完整的资产版本信息，可用于复现项目状态。
            </Text>
          </div>
        </div>
      );
    }

    return null;
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
                  <Menu.Item key="msgs">暂无通知</Menu.Item>
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

      {/* 可审计导出对话框 */}
      <Modal
        title={
          <Space>
            <Shield size={18} color="var(--color-success)" />
            <span>可审计导出</span>
          </Space>
        }
        visible={exportModalVisible}
        onCancel={closeExportModal}
        footer={
          (exportPhase as string) === 'precheck-done' && precheckResult ? (
            <Space>
              <Button onClick={closeExportModal}>取消</Button>
              {precheckResult.canExport ? (
                <Button
                  type="primary"
                  icon={<Download size={14} />}
                  onClick={() => void startAuditableExport()}
                  loading={(exportPhase as string) === 'exporting'}
                >
                  开始导出
                </Button>
              ) : (
                <Tooltip content={`存在 ${precheckResult.summary.blockingCount} 个阻塞问题，请先修复后再导出`}>
                  <Button
                    type="primary"
                    icon={<XCircle size={14} />}
                    disabled
                    status="danger"
                  >
                    无法导出（{precheckResult.summary.blockingCount}个阻塞）
                  </Button>
                </Tooltip>
              )}
            </Space>
          ) : exportPhase === 'export-done' ? (
            <Button type="primary" onClick={closeExportModal}>
              完成
            </Button>
          ) : (
            <Button onClick={closeExportModal} disabled={exportPhase === 'exporting'}>
              {exportPhase === 'exporting' ? '导出中...' : '关闭'}
            </Button>
          )
        }
        style={{ width: 680 }}
        unmountOnExit
      >
        {renderPrecheckContent()}
      </Modal>

      {/* 导出历史对话框 */}
      <Modal
        title={
          <Space>
            <History size={18} />
            <span>导出历史</span>
            <Tag size="small" color="arcoblue">审计记录</Tag>
          </Space>
        }
        visible={exportHistoryVisible}
        onCancel={() => setExportHistoryVisible(false)}
        footer={
          <Space>
            <Button
              icon={<RefreshCw size={14} />}
              loading={exportHistoryLoading}
              onClick={fetchExportHistory}
            >
              刷新
            </Button>
            <Button onClick={() => setExportHistoryVisible(false)}>关闭</Button>
          </Space>
        }
        style={{ width: 820 }}
      >
        {exportHistoryLoading && (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <Spin tip="加载导出历史..." />
          </div>
        )}

        {!exportHistoryLoading && exportHistoryError && (
          <Alert
            type="warning"
            title="无法加载导出历史"
            content={exportHistoryError}
            style={{ marginBottom: 12 }}
          />
        )}

        {!exportHistoryLoading && !exportHistoryError && exportHistoryRecords.length === 0 && (
          <Empty
            description="暂无导出记录"
            style={{ padding: '48px 0' }}
          />
        )}

        {!exportHistoryLoading && !exportHistoryError && exportHistoryRecords.length > 0 && (
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            <List
              dataSource={exportHistoryRecords}
              render={(record: ExportAuditRecord) => {
                const canDownload = record.status !== 'failed'
                  && record.status !== 'in_progress'
                  && !!record.packageSizeBytes;
                const isDownloading = downloadingAuditId === record.id;
                return (
                  <div
                    key={record.id}
                    style={{
                      border: '1px solid var(--color-border-2)',
                      borderRadius: 6,
                      padding: '12px 14px',
                      marginBottom: 10,
                      background: 'var(--color-fill-1)',
                    }}
                  >
                    {/* 顶部：状态 + 包名 + 下载 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <Space wrap>
                        {exportStatusTag(record.status)}
                        <Text bold style={{ fontSize: 14 }}>{record.packageName}</Text>
                        <Tag size="small">{exportTypeLabel(record.exportType)}</Tag>
                        <Tag size="small" color="gray">{record.exportFormat}</Tag>
                      </Space>
                      {canDownload && (
                        <Button
                          type="primary"
                          size="small"
                          icon={<Download size={13} />}
                          loading={isDownloading}
                          onClick={() => handleDownloadPastExport(record.id, record.packageName)}
                        >
                          下载
                        </Button>
                      )}
                    </div>

                    {/* 错误信息 */}
                    {record.status === 'failed' && record.errorMessage && (
                      <Alert
                        type="error"
                        style={{ marginBottom: 8, padding: '6px 10px' }}
                        content={<Text type="error" style={{ fontSize: 12 }}>{record.errorMessage}</Text>}
                      />
                    )}

                    {/* 关键信息行 */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 20px', fontSize: 12, color: 'var(--color-text-2)' }}>
                      <span title="导出时间">
                        <Clock size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                        {formatDateTime(record.createdAt)}
                        {record.durationMs != null && (
                          <Text type="secondary" style={{ marginLeft: 4 }}>
                            ({(record.durationMs / 1000).toFixed(1)}s)
                          </Text>
                        )}
                      </span>
                      <span title="导出者">
                        <User size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                        <code style={{ fontSize: 11 }}>{record.userId?.slice(0, 8)}…</code>
                      </span>
                      <span title="导出包大小">
                        <HardDrive size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                        {formatBytes(record.packageSizeBytes)}
                      </span>
                      <span title="manifest 校验和">
                        <Hash size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                        manifest
                        <code style={{ fontSize: 11, marginLeft: 4 }} title={record.manifestSha256}>
                          {shortSha(record.manifestSha256)}
                        </code>
                      </span>
                    </div>

                    {/* 资产统计 */}
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <Tag size="small" color="blue">共 {record.totalAssets} 资产</Tag>
                      <Tag size="small" color="green">已打包 {record.includedAssets}</Tag>
                      {record.missingAssets > 0 && (
                        <Tag size="small" color="orange">缺失 {record.missingAssets}</Tag>
                      )}
                      {record.corruptedAssets > 0 && (
                        <Tag size="small" color="red">损坏 {record.corruptedAssets}</Tag>
                      )}
                      {record.shotCount > 0 && (
                        <Tag size="small" color="gray">{record.shotCount} 镜头</Tag>
                      )}
                      {record.keyframeCount > 0 && (
                        <Tag size="small" color="gray">{record.keyframeCount} 关键帧</Tag>
                      )}
                      {record.sanitizationFindings > 0 && (
                        <Tag size="small" color="purple">
                          脱敏 {record.sanitizationFindings}
                        </Tag>
                      )}
                      {record.verificationPassed ? (
                        <Tag size="small" color="green">校验通过</Tag>
                      ) : (
                        <Tag size="small" color="red">校验失败</Tag>
                      )}
                    </div>
                  </div>
                );
              }}
            />
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              最近 {exportHistoryRecords.length} 条记录（最多显示20条）。审计字段包含：导出类型、项目、用户、manifest SHA-256、资产/缺失/损坏数量、包大小、校验结果、脱敏计数、耗时与时间戳。
            </Text>
          </div>
        )}
      </Modal>
    </Layout>
  );
};
