import React, { useEffect, useState } from 'react';
import { Table, Tag, Typography } from '@arco-design/web-react';
import { listActionAudits, createConfirmationToken, consumeConfirmationToken } from '../../lib/serverApi';
import type { AssistantActionAudit } from '../../lib/serverApi';

const { Text } = Typography;

/** 动作审计日志组件 */
export const ActionAuditLog: React.FC = () => {
  const [audits, setAudits] = useState<AssistantActionAudit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let isActive = true;
    setLoading(true);
    void listActionAudits({ limit: 50 })
      .then((result) => {
        if (isActive) setAudits(result);
      })
      .catch(() => {
        // 审计日志加载失败不阻塞
      })
      .finally(() => {
        if (isActive) setLoading(false);
      });
    return () => {
      isActive = false;
    };
  }, []);

  /** 批准或拒绝待确认动作 */
  const handleConsume = async (audit: AssistantActionAudit, approved: boolean) => {
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
    } catch {
      // 令牌操作失败静默处理
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
          render: (_: unknown, record: AssistantActionAudit) =>
            record.executionStatus === 'pending' ? (
              <div style={{ display: 'flex', gap: 4 }}>
                <Tag
                  color="green"
                  size="small"
                  style={{ cursor: 'pointer' }}
                  onClick={() => void handleConsume(record, true)}
                >
                  批准
                </Tag>
                <Tag
                  color="red"
                  size="small"
                  style={{ cursor: 'pointer' }}
                  onClick={() => void handleConsume(record, false)}
                >
                  拒绝
                </Tag>
              </div>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                -
              </Text>
            ),
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
  );
};
