import React from 'react';
import { Modal, Button, Typography, Tag, Space, Progress, List, Alert } from '@arco-design/web-react';
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  FileCheck,
  Download,
  Loader2,
  Info,
  Ban,
} from 'lucide-react';
import type { PreflightResult, PreflightFinding } from './workspaceExport';

const { Text, Paragraph } = Typography;

interface ExportPreflightModalProps {
  visible: boolean;
  loading: boolean;
  preflight: PreflightResult | null;
  onCancel: () => void;
  onConfirm: () => void;
  exportType?: string;
}

const severityConfig = {
  pass: { icon: <CheckCircle size={16} color="#00b42a" />, color: 'green' as const, label: '通过' },
  warn: { icon: <AlertTriangle size={16} color="#ff7d00" />, color: 'orange' as const, label: '警告' },
  fail: { icon: <XCircle size={16} color="#f53f3f" />, color: 'red' as const, label: '失败' },
  skip: { icon: <FileCheck size={16} color="#86909c" />, color: 'gray' as const, label: '跳过' },
};

const findingSeverityConfig = {
  blocking: { icon: <Ban size={14} color="#f53f3f" />, color: 'red' as const, label: '阻塞' },
  warning: { icon: <AlertTriangle size={14} color="#ff7d00" />, color: 'orange' as const, label: '警告' },
  info: { icon: <Info size={14} color="#165dff" />, color: 'arcoblue' as const, label: '信息' },
};

function FindingList({ findings, title, emptyText }: {
  findings: PreflightFinding[];
  title: string;
  emptyText?: string;
}) {
  if (findings.length === 0) {
    return emptyText ? (
      <Text type="secondary" style={{ fontSize: 12 }}>{emptyText}</Text>
    ) : null;
  }

  return (
    <div>
      <Text bold style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>{title}</Text>
      <List
        size="small"
        style={{ background: 'var(--color-fill-1)', borderRadius: 6, padding: '4px 8px' }}
        dataSource={findings}
        render={(f) => {
          const cfg = findingSeverityConfig[f.severity];
          return (
            <List.Item style={{ padding: '4px 0', border: 'none' }}>
              <Space size={6} style={{ width: '100%' }}>
                {cfg.icon}
                <Tag size="small" color={cfg.color} style={{ margin: 0, minWidth: 36, textAlign: 'center' }}>
                  {cfg.label}
                </Tag>
                <Text style={{ fontSize: 12, flex: 1 }}>{f.message}</Text>
                {f.code && (
                  <Text type="secondary" style={{ fontSize: 10, fontFamily: 'monospace' }}>
                    {f.code}
                  </Text>
                )}
              </Space>
            </List.Item>
          );
        }}
      />
    </div>
  );
}

export const ExportPreflightModal: React.FC<ExportPreflightModalProps> = ({
  visible,
  loading,
  preflight,
  onCancel,
  onConfirm,
  exportType = '完整工程包',
}) => {
  if (loading) {
    return (
      <Modal
        title="导出预检"
        visible={visible}
        onCancel={onCancel}
        footer={null}
        style={{ maxWidth: 560 }}
      >
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <Loader2
            size={32}
            style={{
              margin: '0 auto 16px',
              color: 'var(--color-primary)',
              animation: 'spin 1s linear infinite',
            }}
          />
          <Text type="secondary">正在检查项目资产、剧本、分镜、文件名冲突...</Text>
        </div>
      </Modal>
    );
  }

  if (!preflight) return null;

  const pf = preflight;
  const config = severityConfig[pf.overallStatus];
  const totalSizeMB = (pf.estimatedSizeBytes / (1024 * 1024)).toFixed(1);
  const includedPercent = pf.assetSummary.total > 0
    ? Math.round((pf.assetSummary.reachable / pf.assetSummary.total) * 100)
    : 100;

  const blockingCount = pf.blocking?.length ?? 0;
  const warningCount = pf.warnings?.length ?? 0;
  const infoCount = pf.infos?.length ?? 0;

  return (
    <Modal
      title={`导出预检 · ${exportType}`}
      visible={visible}
      onCancel={onCancel}
      style={{ maxWidth: 680 }}
      footer={
        <Space>
          <Button onClick={onCancel}>取消</Button>
          <Button
            type="primary"
            icon={<Download size={14} />}
            disabled={!pf.canExport}
            onClick={onConfirm}
            status={pf.overallStatus === 'fail' ? 'danger' : blockingCount > 0 ? 'warning' : undefined}
          >
            {pf.canExport ? `开始导出` : '无法导出'}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={14}>
        {/* Overall status header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {config.icon}
          <div style={{ flex: 1 }}>
            <Text bold style={{ fontSize: 15 }}>
              {pf.projectName}
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <Tag color={config.color} size="small" style={{ margin: 0 }}>
                {config.label}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                预计大小: {totalSizeMB} MB
              </Text>
              {blockingCount > 0 && (
                <Tag color="red" size="small">{blockingCount} 阻塞</Tag>
              )}
              {warningCount > 0 && (
                <Tag color="orange" size="small">{warningCount} 警告</Tag>
              )}
              {infoCount > 0 && (
                <Tag color="arcoblue" size="small">{infoCount} 信息</Tag>
              )}
            </div>
          </div>
        </div>

        {/* Blocking findings */}
        {blockingCount > 0 && (
          <Alert
            type="error"
            icon={<Ban size={16} />}
            content={
              <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                <List
                  size="small"
                  dataSource={pf.blocking}
                  render={(f) => (
                    <List.Item style={{ padding: '3px 0', border: 'none' }}>
                      <Space size={6}>
                        <Text style={{ fontSize: 12 }}>
                          <b>[{f.code}]</b> {f.message}
                        </Text>
                      </Space>
                    </List.Item>
                  )}
                />
              </div>
            }
          />
        )}

        {/* Warnings */}
        {warningCount > 0 && (
          <Alert
            type="warning"
            icon={<AlertTriangle size={16} />}
            content={
              <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                <List
                  size="small"
                  dataSource={pf.warnings}
                  render={(f) => (
                    <List.Item style={{ padding: '3px 0', border: 'none' }}>
                      <Text style={{ fontSize: 12 }}>
                        <b>[{f.code}]</b> {f.message}
                      </Text>
                    </List.Item>
                  )}
                />
              </div>
            }
          />
        )}

        {/* Asset coverage */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text bold style={{ fontSize: 13 }}>资产覆盖</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {pf.assetSummary.reachable} 可达
              {pf.assetSummary.missing > 0 && <span style={{ color: '#f53f3f' }}> · {pf.assetSummary.missing} 失败</span>}
              {pf.assetSummary.uncertain > 0 && <span style={{ color: '#ff7d00' }}> · {pf.assetSummary.uncertain} 待下载</span>}
              {pf.assetSummary.duplicateNames > 0 && <span style={{ color: '#ff7d00' }}> · {pf.assetSummary.duplicateNames} 同名</span>}
              {pf.assetSummary.zeroByte > 0 && <span style={{ color: '#ff7d00' }}> · {pf.assetSummary.zeroByte} 零字节</span>}
              {' '}/ {pf.assetSummary.total} 总计
            </Text>
          </div>
          <Progress
            percent={includedPercent}
            color={includedPercent === 100 ? '#00b42a' : '#ff7d00'}
            showText={false}
            size="small"
          />
        </div>

        {/* Document readiness */}
        <div style={{ display: 'flex', gap: 12 }}>
          <div
            style={{
              flex: 1,
              padding: '10px 12px',
              background: pf.scriptReady ? 'var(--color-green-light-1)' : 'var(--color-fill-2)',
              borderRadius: 8,
            }}
          >
            <Space size={6}>
              {pf.scriptReady
                ? <CheckCircle size={14} color="#00b42a" />
                : <XCircle size={14} color="#f53f3f" />}
              <Text style={{ fontSize: 13 }}>
                剧本 {pf.scriptReady ? '就绪' : '缺失'}
              </Text>
            </Space>
          </div>
          <div
            style={{
              flex: 1,
              padding: '10px 12px',
              background: pf.storyboardReady ? 'var(--color-green-light-1)' : 'var(--color-fill-2)',
              borderRadius: 8,
            }}
          >
            <Space size={6}>
              {pf.storyboardReady
                ? <CheckCircle size={14} color="#00b42a" />
                : <XCircle size={14} color="#f53f3f" />}
              <Text style={{ fontSize: 13 }}>
                分镜 {pf.storyboardReady ? '就绪' : '缺失'}
              </Text>
            </Space>
          </div>
        </div>

        {/* Info findings */}
        {infoCount > 0 && (
          <FindingList
            findings={pf.infos}
            title="信息"
          />
        )}

        {/* Asset detail list (collapsible) */}
        {pf.assets.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--color-text-2)' }}>
              查看 {pf.assets.length} 个资产逐项检查
            </summary>
            <List
              size="small"
              style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--color-border-2)', borderRadius: 6 }}
              dataSource={pf.assets}
              render={(asset) => {
                const ac = severityConfig[asset.status];
                const hasFindings = asset.findings && asset.findings.length > 0;
                return (
                  <List.Item style={{ padding: '6px 10px', borderBottom: '1px solid var(--color-border-1)' }}>
                    <div style={{ width: '100%' }}>
                      <Space size={8} style={{ width: '100%' }}>
                        {ac.icon}
                        <Text style={{ fontSize: 12, flex: 1 }} ellipsis>
                          <Tag size="mini">{asset.type}</Tag> {asset.name}
                        </Text>
                        {asset.sizeBytes != null && (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {asset.sizeBytes > 1024 ? `${(asset.sizeBytes / 1024).toFixed(0)} KB` : `${asset.sizeBytes} B`}
                          </Text>
                        )}
                      </Space>
                      {asset.reason && (
                        <Text type="secondary" style={{ fontSize: 11, marginLeft: 24, display: 'block' }}>
                          {asset.reason}
                        </Text>
                      )}
                      {hasFindings && asset.findings!.map((f, i) => (
                        <Text
                          key={i}
                          style={{
                            fontSize: 11,
                            marginLeft: 24,
                            display: 'block',
                            color: f.severity === 'blocking' ? '#f53f3f' : '#ff7d00',
                          }}
                        >
                          · {f.message}
                        </Text>
                      ))}
                    </div>
                  </List.Item>
                );
              }}
            />
          </details>
        )}
      </Space>
    </Modal>
  );
};
