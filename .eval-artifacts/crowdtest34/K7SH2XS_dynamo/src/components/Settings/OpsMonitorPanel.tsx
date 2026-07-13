import React, { useEffect, useState } from 'react';
import { Space, Tag, Typography, Spin, Table } from '@arco-design/web-react';
import { Activity, AlertTriangle, CheckCircle, XCircle, Shuffle, Cpu } from 'lucide-react';
import { getOpsOverview, listOpsFindings, getEndpointHealth, listRoutingEvents } from '../../lib/serverApi';
import type { OpsOverview, InspectionFinding } from '../../lib/serverApi.ops';
import type { EndpointHealthSummary, ServerRoutingEvent } from '../../lib/serverApi.endpoints';

const { Text } = Typography;

/** 运维监控面板组件 */
export const OpsMonitorPanel: React.FC = () => {
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [findings, setFindings] = useState<InspectionFinding[]>([]);
  const [healthSummaries, setHealthSummaries] = useState<EndpointHealthSummary[]>([]);
  const [recentEvents, setRecentEvents] = useState<ServerRoutingEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isActive = true;
    setLoading(true);

    Promise.all([
      getOpsOverview(),
      listOpsFindings(false, 20),
      getEndpointHealth().catch(() => [] as EndpointHealthSummary[]),
      listRoutingEvents({ limit: 10 }).catch(() => ({ events: [] as ServerRoutingEvent[], total: 0 })),
    ])
      .then(([ov, fd, health, events]) => {
        if (isActive) {
          setOverview(ov);
          setFindings(fd);
          setHealthSummaries(health);
          setRecentEvents(events.events);
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
  const totalFallbacks = healthSummaries.reduce((s, h) => s + h.fallbackCount, 0);
  const totalFailures = healthSummaries.reduce((s, h) => s + h.failedCount, 0);
  const totalRequests = healthSummaries.reduce((s, h) => s + h.totalRequests, 0);

  const statusColor = (s: EndpointHealthSummary) => {
    if (s.failedCount > s.successCount && s.totalRequests > 0) return 'red';
    if (s.fallbackCount > 0 && s.recentErrors24h > 0) return 'orange';
    if (s.totalRequests > 0 && s.successCount > 0) return 'green';
    return 'gray';
  };

  const eventStatusColor = (status: string) => {
    if (status === 'success') return 'green';
    if (status === 'fallback') return 'orange';
    if (status === 'failed') return 'red';
    return 'gray';
  };

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

      {/* AI Endpoint Routing Health */}
      <div style={{ border: '1px solid var(--color-border-2)', borderRadius: 4, padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Cpu size={16} style={{ color: 'var(--color-primary-6)' }} />
          <Text bold>AI Endpoint 路由健康</Text>
          {totalRequests > 0 && (
            <>
              <Tag color="arcoblue" size="small">{totalRequests} 请求</Tag>
              <Tag color={totalFallbacks > 0 ? 'orange' : 'green'} size="small">
                <Shuffle size={10} style={{ marginRight: 2 }} />
                {totalFallbacks} 降级
              </Tag>
              <Tag color={totalFailures > 0 ? 'red' : 'green'} size="small">
                {totalFailures} 失败
              </Tag>
            </>
          )}
        </div>
        {healthSummaries.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>暂无路由数据（发起 AI 请求后将显示）</Text>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {healthSummaries.map((h) => (
              <div key={h.endpointId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <Tag color={statusColor(h)} size="small">
                  {h.successCount}/{h.totalRequests} 成功
                </Tag>
                {h.fallbackCount > 0 && (
                  <Tag color="orange" size="small">{h.fallbackCount} 降级</Tag>
                )}
                {h.failedCount > 0 && (
                  <Tag color="red" size="small">{h.failedCount} 失败</Tag>
                )}
                <Text type="secondary">{h.avgLatencyMs}ms 平均延迟</Text>
                {h.recentErrors24h > 0 && (
                  <Text type="warning" style={{ fontSize: 11 }}>
                    ({h.recentErrors24h} 近24h错误)
                  </Text>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent routing events */}
      {recentEvents.length > 0 && (
        <div style={{ border: '1px solid var(--color-border-2)', borderRadius: 4, padding: 12 }}>
          <Text bold style={{ marginBottom: 8, display: 'block', fontSize: 13 }}>最近路由事件</Text>
          <Table
            size="mini"
            pagination={false}
            data={recentEvents}
            rowKey="id"
            columns={[
              {
                title: '时间',
                dataIndex: 'createdAt',
                width: 140,
                render: (v: string) => (
                  <Text style={{ fontSize: 11 }}>{new Date(v).toLocaleTimeString()}</Text>
                ),
              },
              {
                title: '操作',
                dataIndex: 'operation',
                width: 80,
                render: (v: string) => <Tag size="small">{v}</Tag>,
              },
              {
                title: '模型',
                dataIndex: 'finalModel',
                width: 120,
                render: (v: string | null) => (
                  <Text style={{ fontSize: 11 }}>{v || '-'}</Text>
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 80,
                render: (v: string) => (
                  <Tag color={eventStatusColor(v)} size="small">{v}</Tag>
                ),
              },
              {
                title: '延迟',
                dataIndex: 'latencyMs',
                width: 70,
                render: (v: number) => <Text style={{ fontSize: 11 }}>{v}ms</Text>,
              },
              {
                title: '错误',
                dataIndex: 'errorClassification',
                render: (v: string | null) => (
                  <Text type="secondary" style={{ fontSize: 11 }}>{v || '-'}</Text>
                ),
              },
            ]}
          />
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
