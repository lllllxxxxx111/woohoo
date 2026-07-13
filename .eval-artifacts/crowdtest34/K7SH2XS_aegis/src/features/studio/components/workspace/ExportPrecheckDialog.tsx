import React from 'react';
import { Modal, Typography, Space, Tag, Button, Alert, Spin, Descriptions, Collapse } from '@arco-design/web-react';
import {
  ShieldAlert,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  FileArchive,
  Image,
  Video,
  Music,
  FileText,
  HardDrive,
  Clock,
  Info,
} from 'lucide-react';
import type { PrecheckResponse, PrecheckIssue } from './exportAudit';
import { formatBytes } from './exportAudit';

const { Text } = Typography;
const CollapseItem = Collapse.Item;

interface ExportPrecheckDialogProps {
  visible: boolean;
  loading: boolean;
  precheck: PrecheckResponse | null;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  exportLabel: string;
}

const severityIcon = (severity: string) => {
  switch (severity) {
    case 'error':
      return <XCircle size={14} color="var(--color-danger-6)" />;
    case 'warning':
      return <AlertTriangle size={14} color="var(--color-warning-6)" />;
    case 'info':
    default:
      return <CheckCircle size={14} color="var(--color-success-6)" />;
  }
};

const IssueRow: React.FC<{ issue: PrecheckIssue }> = ({ issue }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '6px 0',
      fontSize: 13,
    }}
  >
    <span style={{ marginTop: 2, flexShrink: 0 }}>{severityIcon(issue.severity)}</span>
    <Text
      style={{
        color:
          issue.severity === 'error'
            ? 'var(--color-danger-6)'
            : issue.severity === 'warning'
              ? 'var(--color-text-2)'
              : 'var(--color-text-3)',
      }}
    >
      {issue.message}
    </Text>
  </div>
);

export const ExportPrecheckDialog: React.FC<ExportPrecheckDialogProps> = ({
  visible,
  loading,
  precheck,
  error,
  onCancel,
  onConfirm,
  exportLabel,
}) => {
  const canProceed = precheck?.canExport ?? false;
  const errorCount = precheck?.blockingIssues.length ?? 0;
  const warningCount = precheck?.warnings.length ?? 0;
  const infoCount = precheck?.info.length ?? 0;

  return (
    <Modal
      title={
        <Space>
          <ShieldAlert size={18} />
          <span>导出预检</span>
        </Space>
      }
      visible={visible}
      onCancel={onCancel}
      footer={
        <Space>
          <Button onClick={onCancel}>取消</Button>
          <Button
            type="primary"
            disabled={loading || !canProceed}
            onClick={onConfirm}
            icon={loading ? <Loader2 size={14} className="animate-spin" /> : <FileArchive size={14} />}
          >
            {loading ? '检查中...' : `确认导出 ${exportLabel}`}
          </Button>
        </Space>
      }
      style={{ maxWidth: 620 }}
      unmountOnExit
    >
      {loading && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin size={40} tip="正在检查项目状态..." />
        </div>
      )}

      {error && !loading && <Alert type="error" title="预检失败" content={error} />}

      {precheck && !loading && (
        <Space direction="vertical" style={{ width: '100%' }} size="medium">
          {/* Status banner */}
          {!canProceed ? (
            <Alert
              type="error"
              icon={<XCircle size={16} />}
              title="无法导出"
              content={`存在 ${errorCount} 个阻断性问题，请修复后重试。`}
            />
          ) : warningCount > 0 ? (
            <Alert
              type="warning"
              icon={<AlertTriangle size={16} />}
              title="可以导出，但有以下提示"
              content={`${errorCount} 个错误，${warningCount} 条警告，${infoCount} 项通过。导出仍可继续。`}
            />
          ) : (
            <Alert
              type="success"
              icon={<CheckCircle size={16} />}
              title="检查通过"
              content={`所有 ${infoCount} 项检查通过，项目状态良好，可以安全导出。`}
            />
          )}

          {/* Content readiness */}
          <div>
            <Text bold style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>
              内容就绪状态
            </Text>
            <Descriptions
              column={2}
              size="small"
              colon=":"
              data={[
                {
                  label: '项目',
                  value: precheck.projectName,
                },
                {
                  label: '剧本',
                  value: precheck.contentReadiness.hasScript
                    ? <Tag color="green" size="small">{precheck.contentReadiness.scriptWordCount} 字</Tag>
                    : <Tag color="gray" size="small">无</Tag>,
                },
                {
                  label: '分镜',
                  value: precheck.contentReadiness.hasStoryboard
                    ? <Tag color="green" size="small">{precheck.contentReadiness.storyboardLineCount} 条</Tag>
                    : <Tag color="gray" size="small">无</Tag>,
                },
                {
                  label: (
                    <Space size={3}><Clock size={11} /> 总时长</Space>
                  ),
                  value: `${precheck.contentReadiness.totalDurationSeconds}s`,
                },
                {
                  label: '对话',
                  value: `${precheck.contentReadiness.conversationCount} 个会话 / ${precheck.contentReadiness.messageCount} 条消息`,
                },
              ]}
            />
          </div>

          {/* Asset summary */}
          <div>
            <Text bold style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>
              <Space size={6}><HardDrive size={13} /> 资产统计</Space>
            </Text>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <Tag icon={<Image size={12} />} color="cyan">
                图片 {precheck.assetSummary.imageCount}
              </Tag>
              <Tag icon={<Video size={12} />} color="magenta">
                视频 {precheck.assetSummary.videoCount}
              </Tag>
              <Tag icon={<Music size={12} />} color="purple">
                音频 {precheck.assetSummary.audioCount}
              </Tag>
              <Tag icon={<FileText size={12} />} color="orange">
                文档 {precheck.assetSummary.documentCount}
              </Tag>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-3)' }}>
              本地: {precheck.assetSummary.localAssets} | 外部: {precheck.assetSummary.remoteAssets}
              {precheck.assetSummary.missingOrBroken > 0 && (
                <Text color="red" style={{ marginLeft: 8 }}>
                  | 异常: {precheck.assetSummary.missingOrBroken}
                </Text>
              )}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-3)' }}>
              预计包大小: {formatBytes(precheck.estimatedBundleSizeBytes)}
            </div>
          </div>

          {/* Issues list - grouped by severity */}
          {(errorCount > 0 || warningCount > 0 || infoCount > 0) && (
            <Collapse defaultActiveKey={errorCount > 0 ? ['errors', 'warnings'] : ['warnings']}>
              {errorCount > 0 && (
                <CollapseItem
                  key="errors"
                  header={
                    <Space size={6}>
                      <XCircle size={14} color="var(--color-danger-6)" />
                      <Text bold style={{ color: 'var(--color-danger-6)' }}>
                        阻断性问题 ({errorCount})
                      </Text>
                    </Space>
                  }
                  name="errors"
                >
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {precheck.blockingIssues.map((issue, i) => (
                      <IssueRow key={`err-${i}`} issue={issue} />
                    ))}
                  </div>
                </CollapseItem>
              )}

              {warningCount > 0 && (
                <CollapseItem
                  key="warnings"
                  header={
                    <Space size={6}>
                      <AlertTriangle size={14} color="var(--color-warning-6)" />
                      <Text bold style={{ color: 'var(--color-warning-6)' }}>
                        警告 ({warningCount})
                      </Text>
                    </Space>
                  }
                  name="warnings"
                >
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {precheck.warnings.map((issue, i) => (
                      <IssueRow key={`warn-${i}`} issue={issue} />
                    ))}
                  </div>
                </CollapseItem>
              )}

              {infoCount > 0 && (
                <CollapseItem
                  key="info"
                  header={
                    <Space size={6}>
                      <Info size={14} color="var(--color-success-6)" />
                      <Text bold style={{ color: 'var(--color-success-6)' }}>
                        通过项 ({infoCount})
                      </Text>
                    </Space>
                  }
                  name="info"
                >
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {precheck.info.map((issue, i) => (
                      <IssueRow key={`info-${i}`} issue={issue} />
                    ))}
                  </div>
                </CollapseItem>
              )}
            </Collapse>
          )}
        </Space>
      )}
    </Modal>
  );
};
