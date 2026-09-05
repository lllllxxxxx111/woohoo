import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Popconfirm, Table, Tag, Typography } from '@arco-design/web-react';
import { listActionAudits, createConfirmationToken, consumeConfirmationToken } from '../../lib/serverApi';
import type { AssistantActionAudit } from '../../lib/serverApi';
import { useToast } from '../../context/useToast';

const { Text } = Typography;

/** 动作审计日志组件 */
export const ActionAuditLog: React.FC = () => {
  const { showToast } = useToast();
  const [audits, setAudits] = useState<AssistantActionAudit[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submittingIds, setSubmittingIds] = useState<ReadonlySet<string>>(new Set());

  const loadAudits = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await listActionAudits({ limit: 50 });
      setAudits(result);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '审计日志加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAudits();
  }, [loadAudits]);

  /** 批准或拒绝待确认动作 */
  const handleConsume = async (audit: AssistantActionAudit, approved: boolean) => {
    if (submittingIds.has(audit.id)) {
      return;
    }
    setSubmittingIds((prev) => new Set(prev).add(audit.id));
    try {
      const tokenResult = await createConfirmationToken(audit.id);
      await consumeConfirmationToken({
        token: tokenResult.token,
        approved,
        reason: approved ? '用户批准' : '用户拒绝',
      });
      setAudits((prev) =>
        prev.map((a) =>
          a.id === audit.id
            ? { ...a, executionStatus: approved ? 'confirmed' : 'rejected' }
            : a,
        ),
      );
      showToast({
        type: 'success',
        title: approved ? '已批准' : '已拒绝',
        message: `动作 ${audit.actionType} 已${approved ? '批准执行' : '拒绝'}`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: approved ? '批准失败' : '拒绝失败',
        message: error instanceof Error ? error.message : '令牌操作失败，请重试',
      });
    } finally {
      setSubmittingIds((prev) => {
        const next = new Set(prev);
        next.delete(audit.id);
        return next;
      });
    }
  };

  const statusColorMap: Record<string, string> = {
    pending: 'orange',
    confirmed: 'green',
    rejected: 'red',
    executed: 'blue',
    failed: 'red',
    expired: 'gray',
  };

  const statusLabelMap: Record<string, string> = {
    pending: '待确认',
    confirmed: '已批准',
    rejected: '已拒绝',
    executed: '已执行',
    failed: '失败',
    expired: '已过期',
  };

  return (
    <div style={{ width: '100%' }}>
      {loadError && (
        <Alert
          type="error"
          content={`审计日志加载失败：${loadError}`}
          action={
            <Button size="mini" type="outline" onClick={() => void loadAudits()}>
              重试
            </Button>
          }
          style={{ marginBottom: 8 }}
        />
      )}
      <Table
        columns={[
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 140,
            render: (v: string) => (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {new Date(v).toLocaleString()}
              </Text>
            ),
          },
          {
            title: '动作类型',
            dataIndex: 'actionType',
            width: 140,
            render: (v: string) => <Tag size="small">{v}</Tag>,
          },
          {
            title: '状态',
            dataIndex: 'executionStatus',
            width: 100,
            render: (v: string) => (
              <Tag color={statusColorMap[v] || 'gray'} size="small">
                {statusLabelMap[v] || v}
              </Tag>
            ),
          },
          {
            title: '项目',
            dataIndex: 'projectId',
            width: 100,
            render: (v: string) => (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {v.slice(0, 8)}
              </Text>
            ),
          },
          {
            title: '操作',
            width: 140,
            render: (_: unknown, record: AssistantActionAudit) => {
              const isSubmitting = submittingIds.has(record.id);
              const disabledStyle = {
                cursor: (isSubmitting ? 'not-allowed' : 'pointer') as React.CSSProperties['cursor'],
                opacity: isSubmitting ? 0.6 : 1,
              };
              return record.executionStatus === 'pending' ? (
                <div style={{ display: 'flex', gap: 4 }}>
                  <Popconfirm
                    title="批准后该动作将被执行，确认继续？"
                    onOk={() => void handleConsume(record, true)}
                    disabled={isSubmitting}
                  >
                    <Tag color="green" size="small" style={disabledStyle}>
                      批准
                    </Tag>
                  </Popconfirm>
                  <Tag
                    color="red"
                    size="small"
                    style={disabledStyle}
                    onClick={() => {
                      if (!isSubmitting) void handleConsume(record, false);
                    }}
                  >
                    拒绝
                  </Tag>
                </div>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  -
                </Text>
              );
            },
          },
        ]}
        data={audits}
        rowKey="id"
        pagination={{ pageSize: 10 }}
        border={false}
        loading={loading}
        scroll={{ x: 620, y: 300 }}
        style={{ width: '100%' }}
        size="small"
      />
    </div>
  );
};
