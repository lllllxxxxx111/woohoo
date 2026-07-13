import React from 'react';
import { Modal, Typography, Descriptions, Tag, Space, Progress, Alert, Divider, Collapse } from '@arco-design/web-react';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  FileArchive,
  Shield,
  Clock,
  HardDrive,
  Hash,
} from 'lucide-react';
import type { ExportResult } from './exportAudit';
import { formatBytes } from './exportAudit';

const { Text } = Typography;
const CollapseItem = Collapse.Item;

interface ExportResultDialogProps {
  visible: boolean;
  result: ExportResult | null;
  precheckIssues?: Array<{ code: string; severity: string; message: string }>;
  onClose: () => void;
}

const severityIcon = (severity: string, passed: boolean) => {
  if (!passed && severity === 'error') return <XCircle size={14} color="var(--color-danger-6)" />;
  if (severity === 'warning') return <AlertTriangle size={14} color="var(--color-warning-6)" />;
  if (passed) return <CheckCircle size={14} color="var(--color-success-6)" />;
  return <Info size={14} color="var(--color-text-3)" />;
};

const statusTag = (result: ExportResult) => {
  if (!result.success) {
    return <Tag color="red" icon={<XCircle size={12} />}>失败</Tag>;
  }
  if (result.missingAssets > 0) {
    return <Tag color="orange" icon={<AlertTriangle size={12} />}>部分成功</Tag>;
  }
  if (result.verification.warningChecks > 0) {
    return <Tag color="arcoblue" icon={<Info size={12} />}>完成（有警告）</Tag>;
  }
  return <Tag color="green" icon={<CheckCircle size={12} />}>完成</Tag>;
};

export const ExportResultDialog: React.FC<ExportResultDialogProps> = ({
  visible,
  result,
  precheckIssues,
  onClose,
}) => {
  if (!result) return null;

  const successRate = result.totalAssets > 0
    ? Math.round((result.includedAssets / result.totalAssets) * 100)
    : 100;

  return (
    <Modal
      title={
        <Space>
          <FileArchive size={20} />
          <span>导出结果</span>
          {statusTag(result)}
        </Space>
      }
      visible={visible}
      onCancel={onClose}
      footer={null}
      style={{ maxWidth: 680 }}
      unmountOnExit
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        {/* Error state */}
        {!result.success && result.errorMessage && (
          <Alert type="error" title="导出失败" content={result.errorMessage} />
        )}

        {/* File info */}
        <Descriptions
          column={2}
          data={[
            {
              label: '文件名',
              value: <Text code>{result.filename || '(未生成)'}</Text>,
            },
            {
              label: '导出类型',
              value: (
                <Tag>
                  {result.exportType === 'full' ? '完整工程包' :
                   result.exportType === 'core' ? '核心策划包' : '成片计划'}
                </Tag>
              ),
            },
            {
              label: (
                <Space size={4}><HardDrive size={12} /> 文件大小</Space>
              ),
              value: formatBytes(result.bundleSizeBytes),
            },
            {
              label: (
                <Space size={4}><Clock size={12} /> 耗时</Space>
              ),
              value: `${result.durationSeconds} 秒`,
            },
          ]}
        />

        {/* Asset stats */}
        {result.totalAssets > 0 && (
          <div>
            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
              <Text bold>资产打包进度</Text>
              <Text type="secondary">
                {result.includedAssets}/{result.totalAssets} 已包含
              </Text>
            </div>
            <Progress
              percent={successRate}
              status={result.missingAssets > 0 ? 'warning' : 'success'}
              formatText={() => `${successRate}%`}
            />
          </div>
        )}

        {/* Verification */}
        {result.success && (
          <div>
            <Space size={6} style={{ marginBottom: 8 }}>
              <Shield size={14} />
              <Text bold>验证报告</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                ({result.verification.passedChecks}/{result.verification.totalChecks} 通过,{' '}
                {result.verification.warningChecks} 警告, {result.verification.failedChecks} 失败)
              </Text>
            </Space>

            {result.verification.checks.map((check) => (
              <div
                key={check.name}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--color-border-1)',
                }}
              >
                <span style={{ marginTop: 2, flexShrink: 0 }}>
                  {severityIcon(check.severity, check.passed)}
                </span>
                <div style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13 }}>{check.message}</Text>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Missing assets */}
        {result.missingAssets > 0 && (
          <Alert
            type="warning"
            title={`${result.missingAssets} 个资产未能打包`}
            content="这些资产可能因网络问题、文件已删除或 URL 失效而无法下载。请在 VERIFICATION.md 中查看详细清单。"
          />
        )}

        {/* Sensitive data */}
        {result.sensitiveDataFindings.length > 0 && (
          <Alert
            type="info"
            title={`已自动脱敏 ${result.sensitiveDataFindings.length} 处敏感数据`}
            content="导出包中的对话记录已自动检测并遮罩 API 密钥、令牌和密码等敏感信息。"
          />
        )}

        {/* Content fingerprints */}
        {result.success && (
          <Collapse>
            <CollapseItem
              header={
                <Space size={6}>
                  <Hash size={14} />
                  <Text>内容指纹（用于可复现性校验）</Text>
                </Space>
              }
              name="fingerprints"
            >
              <Descriptions
                column={1}
                size="small"
                data={[
                  result.manifestSha256 && {
                    label: 'Manifest SHA-256',
                    value: <Text code style={{ fontSize: 11, wordBreak: 'break-all' }}>{result.manifestSha256}</Text>,
                  },
                  result.scriptSha256 && {
                    label: '剧本 SHA-256',
                    value: <Text code style={{ fontSize: 11, wordBreak: 'break-all' }}>{result.scriptSha256}</Text>,
                  },
                  result.storyboardSha256 && {
                    label: '分镜 SHA-256',
                    value: <Text code style={{ fontSize: 11, wordBreak: 'break-all' }}>{result.storyboardSha256}</Text>,
                  },
                ].filter(Boolean) as Array<{ label: string; value: React.ReactNode }>}
              />
            </CollapseItem>
          </Collapse>
        )}

        {/* Precheck issues */}
        {precheckIssues && precheckIssues.length > 0 && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              预检发现 {precheckIssues.length} 项提示，已在导出时处理。
            </Text>
          </>
        )}
      </Space>
    </Modal>
  );
};
