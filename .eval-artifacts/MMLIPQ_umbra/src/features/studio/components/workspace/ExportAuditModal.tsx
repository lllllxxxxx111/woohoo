import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Button,
  Space,
  Tag,
  Typography,
  Progress,
  Alert,
  Table,
  Tabs,
  Empty,
  Spin,
  Message,
} from '@arco-design/web-react';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Download,
  Shield,
  FileCheck,
  History,
  Loader2,
  RefreshCw,
  Clock,
  HardDrive,
} from 'lucide-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table/interface';
import {
  preflightExport,
  createAuditedExport,
  listExportAudits,
  downloadExportArchive,
  getExportAudit,
  type ExportPreflightResult,
  type ExportAuditDetail,
  type ExportAuditListItem,
} from '../../../../lib/serverApi';

const { Text, Title, Paragraph } = Typography;
const TabPane = Tabs.TabPane;

export type ExportType = 'full' | 'core';

interface ExportAuditModalProps {
  visible: boolean;
  projectId: string | null;
  projectName?: string;
  onClose: () => void;
  onExported?: (detail: {
    filename: string;
    assetIncluded: number;
    assetTotal: number;
    assetMissing: number;
    fileSize: number;
  }) => void;
}

type Step = 'preflight' | 'exporting' | 'result' | 'history';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function shortSha(sha?: string): string {
  if (!sha) return '-';
  return sha.slice(0, 12) + '…';
}

export const ExportAuditModal: React.FC<ExportAuditModalProps> = ({
  visible,
  projectId,
  projectName,
  onClose,
  onExported,
}) => {
  const [step, setStep] = useState<Step>('preflight');
  const [exportType, setExportType] = useState<ExportType>('full');
  const [preflight, setPreflight] = useState<ExportPreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportAuditDetail | null>(null);
  const [exporting, setExporting] = useState(false);
  const [historyItems, setHistoryItems] = useState<ExportAuditListItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryDetail, setSelectedHistoryDetail] = useState<ExportAuditDetail | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const runPreflight = useCallback(async () => {
    if (!projectId) return;
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const result = await preflightExport(projectId);
      setPreflight(result);
    } catch (error) {
      setPreflightError(error instanceof Error ? error.message : '预检失败');
    } finally {
      setPreflightLoading(false);
    }
  }, [projectId]);

  const runExport = async () => {
    if (!projectId) return;
    setExporting(true);
    setExportResult(null);
    try {
      const result = await createAuditedExport(projectId, exportType);
      setExportResult(result);
      setStep('result');
      onExported?.({
        filename: result.filename,
        assetIncluded: result.assetIncluded,
        assetTotal: result.assetTotal,
        assetMissing: result.assetMissing,
        fileSize: result.fileSize,
      });
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const resp = await listExportAudits(projectId ?? undefined, 50, 0);
      setHistoryItems(resp.items);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '加载历史失败');
    } finally {
      setHistoryLoading(false);
    }
  }, [projectId]);

  const handleDownload = async (auditId: string, filename: string) => {
    setDownloadingId(auditId);
    try {
      const blob = await downloadExportArchive(auditId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      Message.success('下载已开始');
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '下载失败');
    } finally {
      setDownloadingId(null);
    }
  };

  const viewHistoryDetail = async (auditId: string) => {
    try {
      const detail = await getExportAudit(auditId);
      setSelectedHistoryDetail(detail);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '加载详情失败');
    }
  };

  // Reset on open
  useEffect(() => {
    if (visible && projectId) {
      setStep('preflight');
      setExportResult(null);
      setSelectedHistoryDetail(null);
      runPreflight();
    }
  }, [visible, projectId, runPreflight]);

  // Load history when tab changes
  useEffect(() => {
    if (visible && step === 'history') {
      loadHistory();
    }
  }, [visible, step, loadHistory]);

  const missingAssetColumns: ColumnProps<ExportPreflightResult['missingAssets'][number]>[] = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (t: string) => <Tag size="small">{t}</Tag>,
    },
    { title: '原因', dataIndex: 'reason', key: 'reason' },
  ];

  const historyColumns: ColumnProps<ExportAuditListItem>[] = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 150,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{formatDate(v)}</Text>,
    },
    {
      title: '类型',
      dataIndex: 'exportType',
      key: 'exportType',
      width: 80,
      render: (t: string) => (
        <Tag color={t === 'full' ? 'arcoblue' : 'green'} size="small">
          {t === 'full' ? '完整工程' : '核心策划'}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: string) => {
        if (s === 'completed') return <Tag color="green" size="small"><CheckCircle size={12} /> 通过</Tag>;
        if (s === 'partial') return <Tag color="orange" size="small"><AlertTriangle size={12} /> 部分</Tag>;
        return <Tag color="red" size="small"><XCircle size={12} /> 失败</Tag>;
      },
    },
    {
      title: '资产',
      key: 'assets',
      width: 120,
      render: (_: unknown, r: ExportAuditListItem) => (
        <Text style={{ fontSize: 12 }}>
          {r.assetIncluded}/{r.assetTotal} 打包
        </Text>
      ),
    },
    { title: '文件名', dataIndex: 'filename', key: 'filename', render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
    {
      title: 'Manifest Hash',
      dataIndex: 'manifestSha256',
      key: 'manifestSha256',
      width: 110,
      render: (v: string | undefined) => v ? <Text code style={{ fontSize: 10 }} title={v}>{v.slice(0, 10)}…</Text> : <Text type="secondary" style={{ fontSize: 11 }}>-</Text>,
    },
    { title: '大小', dataIndex: 'fileSize', key: 'fileSize', width: 80, render: (v: number) => formatBytes(v) },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_: unknown, r: ExportAuditListItem) => (
        <Space size={4}>
          <Button
            type="text"
            size="mini"
            icon={<FileCheck size={12} />}
            onClick={() => viewHistoryDetail(r.id)}
          >
            详情
          </Button>
          <Button
            type="text"
            size="mini"
            icon={<Download size={12} />}
            loading={downloadingId === r.id}
            onClick={() => handleDownload(r.id, r.filename)}
          >
            下载
          </Button>
        </Space>
      ),
    },
  ];

  // Render verification report for a completed export
  const renderResult = (detail: ExportAuditDetail) => {
    const { verificationReport: report } = detail;
    return (
      <div>
        <Alert
          type={report.passed ? 'success' : detail.assetMissing > 0 ? 'warning' : 'error'}
          icon={report.passed ? <CheckCircle /> : <AlertTriangle />}
          title={
            report.passed
              ? detail.assetMissing > 0
                ? '导出完成（部分资产缺失）'
                : '导出完成，验证通过'
              : '导出完成但验证未通过'
          }
          style={{ marginBottom: 16 }}
          content={
            <div>
              <Paragraph style={{ margin: '4px 0' }}>
                文件: <Text code>{detail.filename}</Text>
              </Paragraph>
              <Paragraph style={{ margin: '4px 0' }}>
                大小: {formatBytes(detail.fileSize)} | 归档 SHA-256: <Text code style={{ fontSize: 11 }}>{shortSha(detail.fileSha256)}</Text>
              </Paragraph>
              {detail.manifestSha256 && (
                <Paragraph style={{ margin: '4px 0' }}>
                  Manifest SHA-256: <Text code style={{ fontSize: 11 }} title={detail.manifestSha256}>{shortSha(detail.manifestSha256)}</Text>
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>（审计记录可独立校验清单完整性）</Text>
                </Paragraph>
              )}
              <Paragraph style={{ margin: '4px 0' }}>
                打包资产: {detail.assetIncluded}/{detail.assetTotal} | 缺失: {detail.assetMissing}
              </Paragraph>
            </div>
          }
        />

        <Space size={16} wrap style={{ marginBottom: 16 }}>
          <div style={{ textAlign: 'center', minWidth: 90 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-success)' }}>
              {report.assetChecksumsVerified}
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>校验和通过</Text>
          </div>
          <div style={{ textAlign: 'center', minWidth: 90 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: report.assetChecksumsFailed > 0 ? 'var(--color-danger)' : 'var(--color-text-3)' }}>
              {report.assetChecksumsFailed}
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>校验失败</Text>
          </div>
          <div style={{ textAlign: 'center', minWidth: 90 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: report.missingAssets.length > 0 ? 'var(--color-warning)' : 'var(--color-text-3)' }}>
              {report.missingAssets.length}
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>缺失资产</Text>
          </div>
          <div style={{ textAlign: 'center', minWidth: 90 }}>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{report.fileCount}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>归档文件数</Text>
          </div>
          {report.redaction && (report.redaction.keyHits + report.redaction.patternHits > 0) && (
            <div style={{ textAlign: 'center', minWidth: 130 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-warning)' }}>
                {report.redaction.keyHits + report.redaction.patternHits}
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}>敏感信息已剔除</Text>
            </div>
          )}
        </Space>

        {report.redaction && (report.redaction.keyHits + report.redaction.patternHits > 0) && (
          <Alert
            type="warning"
            icon={<Shield />}
            style={{ marginBottom: 12 }}
            title="自动敏感信息剔除"
            content={
              <div style={{ fontSize: 12 }}>
                <div>命中敏感字段 key: <Text code>{report.redaction.matchedKeys.join(', ') || '无'}</Text></div>
                <div>命中敏感模式: <Text code>{report.redaction.matchedPatterns.join(', ') || '无'}</Text></div>
                <div>共替换 {report.redaction.keyHits} 处字段值、{report.redaction.patternHits} 处字符串内容为 <Text code>[REDACTED]</Text></div>
              </div>
            }
          />
        )}

        {report.issues.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Title heading={6} style={{ fontSize: 13, marginBottom: 8 }}>
              <Shield size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              验证报告
            </Title>
            {report.issues.map((issue, idx) => (
              <Alert
                key={idx}
                type={issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info'}
                style={{ marginBottom: 6 }}
                content={
                  <div>
                    <Text bold>[{issue.code}] </Text>
                    {issue.message}
                    {issue.path && <Text type="secondary" style={{ marginLeft: 8, fontSize: 11 }}>{issue.path}</Text>}
                  </div>
                }
              />
            ))}
          </div>
        )}

        <div style={{ background: 'var(--color-fill-1)', borderRadius: 6, padding: 12, fontSize: 12 }}>
          <div style={{ marginBottom: 6 }}>
            <Text type="secondary">归档包包含：</Text>
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, lineHeight: 1.8 }}>
            <li><Text code>manifest.json</Text> — 清单（项目元数据、版本、资产索引）</li>
            <li><Text code>checksums.json</Text> — 每个资产文件 SHA-256 校验和</li>
            <li><Text code>missing-assets.json</Text> — 缺失资产清单及原因</li>
            <li><Text code>project-snapshot.json</Text> — 导出时工作区完整快照（可复现）</li>
            <li><Text code>generation-params.json</Text> — AI 生成参数摘要（模型、prompt hash）</li>
            <li><Text code>verification-report.json</Text> — 自动完整性验证报告</li>
            <li><Text code>core-bundle.md</Text> — 人类可读的核心策划文档</li>
            {exportType === 'full' && <li><Text code>assets/</Text> — 所有二进制资产文件</li>}
            <li><Text code>script/ storyboard/ timeline/ conversations/</Text> — 文字内容</li>
          </ul>
        </div>
      </div>
    );
  };

  const renderPreflight = () => {
    if (preflightLoading) {
      return (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin size={32} />
          <div style={{ marginTop: 12 }}><Text type="secondary">正在执行预检（脚本/分镜/资产/敏感文件）...</Text></div>
        </div>
      );
    }

    if (preflightError) {
      return (
        <Alert type="error" title="预检失败" content={preflightError} style={{ marginBottom: 16 }} />
      );
    }

    if (!preflight) return null;

    const blockingFindings = preflight.findings.filter((f) => f.severity === 'blocking');
    const warningFindings = preflight.findings.filter((f) => f.severity === 'warning');
    const infoFindings = preflight.findings.filter((f) => f.severity === 'info');

    return (
      <div>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          预检结果 — 项目 <Text bold>{preflight.projectName}</Text>
        </Paragraph>

        {/* 顶部状态徽标 */}
        <Space size={16} wrap style={{ marginBottom: 16 }}>
          <div style={{ textAlign: 'center', minWidth: 80 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-success)' }}>
              {preflight.assetOnDisk}
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>磁盘就绪</Text>
          </div>
          <div style={{ textAlign: 'center', minWidth: 80 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: preflight.assetMissing > 0 ? 'var(--color-warning)' : 'var(--color-text-3)' }}>
              {preflight.assetMissing}
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>不可下载</Text>
          </div>
          {preflight.assetEmpty > 0 && (
            <div style={{ textAlign: 'center', minWidth: 80 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-warning)' }}>
                {preflight.assetEmpty}
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}>0 字节文件</Text>
            </div>
          )}
          {preflight.assetExternalUrl > 0 && (
            <div style={{ textAlign: 'center', minWidth: 80 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-3)' }}>
                {preflight.assetExternalUrl}
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}>外部 URL</Text>
            </div>
          )}
          <div style={{ textAlign: 'center', minWidth: 100 }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {formatBytes(preflight.estimatedSizeBytes)}
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>预计大小</Text>
          </div>
          <div style={{ textAlign: 'center', minWidth: 80 }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{preflight.conversationCount}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>对话记录</Text>
          </div>
        </Space>

        {/* 剧本/分镜状态 */}
        <Space style={{ marginBottom: 16 }} wrap>
          <Tag
            color={preflight.scriptPresent && !preflight.scriptEmpty ? 'green' : 'orange'}
            icon={preflight.scriptPresent && !preflight.scriptEmpty ? <CheckCircle size={10} /> : <AlertTriangle size={10} />}
          >
            剧本 {preflight.scriptPresent ? (preflight.scriptEmpty ? '空' : `${preflight.scriptSizeBytes}B`) : '缺失'}
          </Tag>
          <Tag
            color={preflight.storyboardPresent ? 'green' : 'gray'}
            icon={preflight.storyboardPresent ? <CheckCircle size={10} /> : <XCircle size={10} />}
          >
            分镜 {preflight.storyboardPresent ? `已就绪${preflight.storyboardEmptyScenes > 0 ? `（${preflight.storyboardEmptyScenes}空场景）` : ''}` : '缺失'}
          </Tag>
          {preflight.duplicateFilenames.length > 0 && (
            <Tag color="orange" icon={<AlertTriangle size={10} />}>
              {preflight.duplicateFilenames.length} 组重名资产
            </Tag>
          )}
          {preflight.storyboardDuplicateScenes.length > 0 && (
            <Tag color="orange" icon={<AlertTriangle size={10} />}>
              {preflight.storyboardDuplicateScenes.length} 个重复场次号
            </Tag>
          )}
        </Space>

        {/* Blocking 问题 */}
        {blockingFindings.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Alert
              type="error"
              icon={<XCircle />}
              title={`${blockingFindings.length} 个阻断问题`}
              content={
                <ul style={{ margin: '4px 0 0 0', paddingLeft: 18 }}>
                  {blockingFindings.map((f, i) => (
                    <li key={i}>
                      <Text code style={{ fontSize: 11 }}>{f.code}</Text> {f.message}
                    </li>
                  ))}
                </ul>
              }
            />
          </div>
        )}

        {/* Warning 问题 */}
        {warningFindings.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Title heading={6} style={{ fontSize: 13, margin: '8px 0' }}>
              <AlertTriangle size={13} style={{ marginRight: 6, verticalAlign: 'middle', color: 'var(--color-warning)' }} />
              警告 ({warningFindings.length})
            </Title>
            {warningFindings.map((f, i) => (
              <Alert
                key={i}
                type="warning"
                style={{ marginBottom: 4 }}
                content={
                  <div>
                    <Text code style={{ fontSize: 11, marginRight: 6 }}>{f.code}</Text>
                    {f.message}
                  </div>
                }
              />
            ))}
          </div>
        )}

        {/* Info */}
        {infoFindings.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Title heading={6} style={{ fontSize: 13, margin: '8px 0' }}>
              信息 ({infoFindings.length})
            </Title>
            <div style={{ background: 'var(--color-fill-1)', borderRadius: 6, padding: '8px 12px' }}>
              {infoFindings.map((f, i) => (
                <div key={i} style={{ fontSize: 12, lineHeight: 1.8 }}>
                  <Text code style={{ fontSize: 10, marginRight: 6, opacity: 0.7 }}>{f.code}</Text>
                  {f.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 缺失资产详情表 */}
        {preflight.missingAssets.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Title heading={6} style={{ fontSize: 13, marginBottom: 8 }}>
              不可打包资产明细 ({preflight.missingAssets.length})
            </Title>
            <Table
              size="small"
              columns={missingAssetColumns}
              data={preflight.missingAssets}
              pagination={false}
              rowKey="assetId"
              scroll={{ y: 160 }}
            />
          </div>
        )}

        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>导出类型：</Text>
        </div>
        <Space style={{ marginBottom: 8 }}>
          <Button
            type={exportType === 'full' ? 'primary' : 'default'}
            onClick={() => setExportType('full')}
          >
            <HardDrive size={14} style={{ marginRight: 6 }} />
            完整工程包 (.tar.gz)
          </Button>
          <Button
            type={exportType === 'core' ? 'primary' : 'default'}
            onClick={() => setExportType('core')}
          >
            <FileCheck size={14} style={{ marginRight: 6 }} />
            核心策划包 (.tar.gz)
          </Button>
        </Space>

        {!preflight.ready && (
          <Alert
            type="error"
            style={{ marginTop: 12 }}
            content="存在阻断问题，请修复后再导出"
          />
        )}
      </div>
    );
  };

  const renderExporting = () => (
    <div style={{ textAlign: 'center', padding: '50px 0' }}>
      <Loader2 size={40} className="animate-spin" style={{ animation: 'spin 1.5s linear infinite', color: 'var(--color-primary)' }} />
      <div style={{ marginTop: 20, fontSize: 16, fontWeight: 600 }}>正在构建可审计导出包...</div>
      <div style={{ marginTop: 8 }}>
        <Text type="secondary">
          正在收集数据、计算校验和、打包资产并生成验证报告
        </Text>
      </div>
      <Progress
        style={{ marginTop: 24, maxWidth: 300, margin: '24px auto 0' }}
        percent={100}
        animation
        showText={false}
        status="normal"
      />
    </div>
  );

  const renderHistory = () => (
    <div>
      {selectedHistoryDetail ? (
        <div>
          <Button
            type="text"
            size="small"
            icon={<RefreshCw size={12} style={{ transform: 'scaleX(-1)' }} />}
            onClick={() => setSelectedHistoryDetail(null)}
            style={{ marginBottom: 12 }}
          >
            返回列表
          </Button>
          {renderResult(selectedHistoryDetail)}
        </div>
      ) : historyLoading ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin size={24} />
        </div>
      ) : historyItems.length === 0 ? (
        <Empty description="暂无导出记录" />
      ) : (
        <Table
          size="small"
          columns={historyColumns}
          data={historyItems}
          pagination={{ pageSize: 10, size: 'small' }}
          rowKey="id"
        />
      )}
    </div>
  );

  const footer = () => {
    if (step === 'preflight') {
      return (
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button onClick={runPreflight} icon={<RefreshCw size={13} />}>
            重新检查
          </Button>
          <Button
            type="primary"
            icon={<Shield size={14} />}
            loading={exporting}
            disabled={!preflight?.ready}
            onClick={() => {
              setStep('exporting');
              setTimeout(() => void runExport(), 100);
            }}
          >
            开始可审计导出
          </Button>
        </Space>
      );
    }
    if (step === 'result') {
      return (
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button
            onClick={() => {
              setStep('history');
            }}
            icon={<History size={13} />}
          >
            查看历史
          </Button>
          {exportResult && (
            <Button
              type="primary"
              icon={<Download size={14} />}
              loading={downloadingId === exportResult.id}
              onClick={() => handleDownload(exportResult.id, exportResult.filename)}
            >
              下载导出包
            </Button>
          )}
        </Space>
      );
    }
    if (step === 'history') {
      return (
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button onClick={loadHistory} icon={<RefreshCw size={13} />}>刷新</Button>
        </Space>
      );
    }
    return <Button onClick={onClose}>取消</Button>;
  };

  return (
    <Modal
      title={
        <Space>
          <Shield size={18} style={{ color: 'var(--color-primary)' }} />
          <span>可审计导出包</span>
          {projectName && <Tag color="arcoblue">{projectName}</Tag>}
        </Space>
      }
      visible={visible}
      onCancel={onClose}
      footer={footer() as unknown as React.ReactNode}
      style={{ width: step === 'history' ? 820 : 680 }}
      unmountOnExit
    >
      {step !== 'exporting' && step !== 'result' && (
        <Tabs
          activeTab={step === 'history' ? 'history' : 'preflight'}
          onChange={(key) => setStep(key as Step)}
          style={{ marginBottom: 16 }}
        >
          <TabPane
            key="preflight"
            title={
              <span>
                <Shield size={13} style={{ marginRight: 4 }} />
                导出预检
              </span>
            }
          />
          <TabPane
            key="history"
            title={
              <span>
                <History size={13} style={{ marginRight: 4 }} />
                导出历史
                <Clock size={11} style={{ marginLeft: 4, opacity: 0.5 }} />
              </span>
            }
          />
        </Tabs>
      )}

      {step === 'preflight' && renderPreflight()}
      {step === 'exporting' && renderExporting()}
      {step === 'result' && exportResult && renderResult(exportResult)}
      {step === 'history' && renderHistory()}
    </Modal>
  );
};

export default ExportAuditModal;
