import React, { useEffect, useState } from 'react';
import { Space, Tag, Typography, Spin, Button } from '@arco-design/web-react';
import { Activity, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { getOpsOverview, listOpsFindings } from '../../lib/serverApi';
import type { OpsOverview, InspectionFinding } from '../../lib/serverApi.ops';

const { Text } = Typography;

/** 运维监控面板组件 */
export const OpsMonitorPanel: React.FC = () => {
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [findings, setFindings] = useState<InspectionFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let isActive = true;
    setLoading(true);
    setLoadError(null);

    Promise.all([getOpsOverview(), listOpsFindings(false, 20)])
      .then(([ov, fd]) => {
        if (isActive) {
          setOverview(ov);
          setFindings(fd);
        }
      })
      .catch((error) => {
        if (isActive) {
          setLoadError(error instanceof Error ? error.message : '运维数据加载失败');
        }
      })
      .finally(() => {
        if (isActive) setLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [reloadTick]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 20 }}>
        <Spin />
      </div>
    );
  }

  if (loadError || !overview) {
    return (
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Text type="secondary">
          {loadError
            ? `无法加载运维数据：${loadError}。请确认后端服务正在运行。`
            : '无法加载运维数据，请确认后端服务正在运行。'}
        </Text>
        <Button size="mini" type="outline" onClick={() => setReloadTick((t) => t + 1)}>
          重试
        </Button>
      </Space>
    );
  }

  const summary = overview.notificationSummary;
  const unresolvedFindings = findings.filter((f) => !f.resolved);

  return (
    <Space direction="vertical" size="medium" style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Activity size={16} style={{ color: 'var(--color-primary-6)' }} />
          <Text>心跳记录</Text>
          <Tag color="arcoblue" size="small">{overview.heartbeats.length}</Tag>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={16} style={{ color: 'var(--color-warning-6)' }} />
          <Text>活跃告警</Text>
          <Tag color={unresolvedFindings.length > 0 ? 'orange' : 'green'} size="small">
            {unresolvedFindings.length}
          </Tag>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <CheckCircle size={16} style={{ color: 'var(--color-success-6)' }} />
          <Text>通知通道</Text>
          <Tag color="arcoblue" size="small">{summary?.enabledChannels ?? 0}/{summary?.configuredChannels ?? 0}</Tag>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <XCircle size={16} style={{ color: 'var(--color-danger-6)' }} />
          <Text>失败事件</Text>
          <Tag color={summary?.failedEvents ? 'red' : 'green'} size="small">
            {summary?.failedEvents ?? 0}
          </Tag>
        </div>
      </div>

      {unresolvedFindings.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Text bold style={{ marginBottom: 4, display: 'block' }}>未解决的检查发现</Text>
          {unresolvedFindings.slice(0, 5).map((f, i) => (
            <div key={f.id || `finding-${i}`} style={{ padding: '4px 0', fontSize: 12 }}>
              <Tag
                color={f.severity === 'critical' ? 'red' : f.severity === 'warning' ? 'orange' : 'blue'}
                size="small"
              >
                {f.severity}
              </Tag>
              <Text type="secondary" style={{ marginLeft: 6 }}>{f.message}</Text>
            </div>
          ))}
        </div>
      )}

      {overview.heartbeats.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Text bold style={{ marginBottom: 4, display: 'block' }}>最近心跳</Text>
          {overview.heartbeats.slice(0, 3).map((h, i) => (
            <div key={h.id || `heartbeat-${i}`} style={{ padding: '2px 0', fontSize: 12 }}>
              <Tag color={h.status === 'healthy' ? 'green' : 'red'} size="small">
                {h.status}
              </Tag>
              <Text type="secondary" style={{ marginLeft: 6 }}>
                {new Date(h.timestamp).toLocaleString()}
              </Text>
              {h.message && (
                <Text type="secondary" style={{ marginLeft: 6 }}>{h.message}</Text>
              )}
            </div>
          ))}
        </div>
      )}
    </Space>
  );
};
