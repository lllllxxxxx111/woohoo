import React from 'react';
import { Alert, Tag, Typography, List, Space, Button } from '@arco-design/web-react';
import type { PreflightResult, PreflightIssue, PreflightSeverity } from '../types';

const { Title, Text } = Typography;

interface PreflightResultDisplayProps {
  result: PreflightResult;
  onClose?: () => void;
}

const severityConfig: Record<PreflightSeverity, { color: string; label: string; type: 'error' | 'warning' | 'info' }> = {
  blocking: { color: 'red', label: 'Blocking', type: 'error' },
  warning: { color: 'orange', label: 'Warning', type: 'warning' },
  info: { color: 'arcoblue', label: 'Info', type: 'info' },
};

function IssueGroup({
  severity,
  issues,
}: {
  severity: PreflightSeverity;
  issues: PreflightIssue[];
}) {
  if (issues.length === 0) return null;
  const cfg = severityConfig[severity];
  return (
    <Alert
      type={cfg.type}
      style={{ marginBottom: 12 }}
      title={
        <Space>
          <Tag color={cfg.color}>{cfg.label}</Tag>
          <Text bold>{issues.length} issue{issues.length !== 1 ? 's' : ''}</Text>
        </Space>
      }
      content={
        <List
          size="small"
          dataSource={issues}
          render={(issue) => {
            // Support both canonical fields (entityId/detail) and legacy aliases (assetId/details).
            const entityId = issue.entityId ?? issue.assetId;
            const entityType = issue.entityType ?? issue.field;
            const detail = issue.detail ?? issue.details;
            return (
              <List.Item>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space wrap>
                    <Tag color={cfg.color} size="small">{issue.code}</Tag>
                    <Text>{issue.message}</Text>
                  </Space>
                  {entityType && entityId && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {entityType}: {entityId}
                    </Text>
                  )}
                  {!entityType && entityId && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      ID: {entityId}
                    </Text>
                  )}
                  {detail && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {detail}
                    </Text>
                  )}
                </Space>
              </List.Item>
            );
          }}
        />
      }
    />
  );
}

const PreflightResultDisplay: React.FC<PreflightResultDisplayProps> = ({ result, onClose }) => {
  const blocking = result.issues.filter((i) => i.severity === 'blocking');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  const infos = result.issues.filter((i) => i.severity === 'info');

  const assetCount = result.assetCount ?? 0;
  const missingCount = result.missingAssetCount ?? 0;
  const sizeKb = result.totalSizeBytes ? (result.totalSizeBytes / 1024).toFixed(1) : null;

  return (
    <div style={{ marginTop: 12 }}>
      <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
        <Title heading={6} style={{ margin: 0 }}>
          Preflight Results
        </Title>
        <Space wrap>
          <Tag color="red">{result.blockingCount} blocking</Tag>
          <Tag color="orange">{result.warningCount} warning</Tag>
          <Tag color="arcoblue">{result.infoCount} info</Tag>
          {onClose && <Button size="mini" onClick={onClose}>Clear</Button>}
        </Space>
      </Space>

      {(assetCount > 0 || sizeKb || result.manifestHash) && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
          {assetCount > 0 && <>{assetCount} assets</>}
          {assetCount > 0 && missingCount > 0 && <> · {missingCount} missing</>}
          {sizeKb && <> · {sizeKb} KB</>}
          {result.manifestHash && <> · manifest: {result.manifestHash.slice(0, 12)}…</>}
        </Text>
      )}

      {result.summary && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
          {result.summary}
        </Text>
      )}

      <IssueGroup severity="blocking" issues={blocking} />
      <IssueGroup severity="warning" issues={warnings} />
      <IssueGroup severity="info" issues={infos} />

      {result.issues.length === 0 && (
        <Alert type="success" content="All checks passed — no issues found." />
      )}
    </div>
  );
};

export default PreflightResultDisplay;
