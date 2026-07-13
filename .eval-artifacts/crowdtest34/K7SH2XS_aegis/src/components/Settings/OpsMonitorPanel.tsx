import React, { useEffect, useState } from 'react';
import { Space, Tag, Typography, Spin } from '@arco-design/web-react';
import { Activity, AlertTriangle, CheckCircle, XCircle, Shuffle } from 'lucide-react';
import { getOpsOverview, listOpsFindings, getRoutingHealth, listRoutingEvents } from '../../lib/serverApi';
import type { OpsOverview, InspectionFinding } from '../../lib/serverApi.ops';
import type { RoutingHealthSummary, RoutingEvent } from '../../lib/serverApi';

const { Text } = Typography;

/** 运维监控面板组件 */
export const OpsMonitorPanel: React.FC = () => {
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [findings, setFindings] = useState<InspectionFinding[]>([]);
  const [routingHealth, setRoutingHealth] = useState<RoutingHealthSummary | null>(null);
  const [recentFallbacks, setRecentFallbacks] = useState<RoutingEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isActive = true;
    setLoading(true);

    Promise.all([
      getOpsOverview(),
      listOpsFindings(false, 20),
      getRoutingHealth(24).catch(() => null),
      listRoutingEvents({ status: 'fallback', limit: 5 }).catch(() => [] as RoutingEvent[]),
    ])
      .then(([ov, fd, rh, rf]) => {
        if (isActive) {
          setOverview(ov);
          setFindings(fd);
          setRoutingHealth(rh);
          setRecentFallbacks(rf);
        }
      })
      .catch(() => {
        // Ops 面板加载失败不阻塞
      })
      .finally(() => {
        if (isActive) setLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, []);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 20 }}>
        <Spin />
      </div>
    );
  }

  if (!overview) {
    return <Text type="secondary">无法加载运维数据，请确认后端服务正在运行。</Text>;
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
        {routingHealth && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Shuffle size={16} style={{ color: routingHealth.fallbackRate > 0.05 ? 'var(--color-warning-6)' : 'var(--color-success-6)' }} />
            <Text>路由降级</Text>
            <Tag
              color={routingHealth.fallbackRate > 0.1 ? 'orange' : routingHealth.fallbackRate > 0 ? 'arcoblue' : 'green'}
              size="small"
            >
              {routingHealth.fallbacks} 次 ({(routingHealth.fallbackRate * 100).toFixed(1)}%)
            </Tag>
          </div>
        )}
      </div>

      {routingHealth && (routingHealth.fallbacks > 0 || routingHealth.failed > 0) && (
        <div style={{ padding: '8px 12px', background: 'var(--color-fill-2)', borderRadius: 6, fontSize: 12 }}>
          <Text type="secondary">
            AI 路由 (24h): {routingHealth.totalRequests} 请求, {routingHealth.successful} 成功,{' '}
            {routingHealth.failed} 失败, {routingHealth.fallbacks} 自动降级
            {routingHealth.avgLatencyMs ? `, 平均延迟 ${routingHealth.avgLatencyMs}ms` : ''}
          </Text>
        </div>
      )}

      {recentFallbacks.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <Text bold style={{ marginBottom: 4, display: 'block', fontSize: 12 }}>最近路由降级</Text>
          {recentFallbacks.slice(0, 5).map((event, i) => (
            <div key={event.id || i} style={{ padding: '3px 0', fontSize: 11 }}>
              <Tag color="orange" size="small">{event.capability}</Tag>
              <Text type="secondary" style={{ marginLeft: 4 }}>
                {event.operation} → {event.finalEndpointId?.slice(0, 8) ?? 'unknown'}
                {event.errorMessage ? ` (${event.errorMessage.slice(0, 80)})` : ''}
              </Text>
            </div>
          ))}
        </div>
      )}

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
