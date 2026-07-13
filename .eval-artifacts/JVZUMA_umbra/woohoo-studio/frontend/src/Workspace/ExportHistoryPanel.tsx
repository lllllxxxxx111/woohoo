import React, { useEffect } from 'react';
import { Table, Typography, Tag, Spin, Empty } from '@arco-design/web-react';
import { useExportStore } from '../stores/exportStore';
import type { TableProps } from '@arco-design/web-react/es/Table';
import type { ExportAuditRecord } from '../serverApi';

const { Text } = Typography;

interface ExportHistoryPanelProps {
  projectId: string;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const ExportHistoryPanel: React.FC<ExportHistoryPanelProps> = ({ projectId }) => {
  const { auditHistory, isLoadingHistory, loadAuditHistory } = useExportStore();

  useEffect(() => {
    if (projectId) {
      loadAuditHistory(projectId);
    }
  }, [projectId, loadAuditHistory]);

  const columns: TableProps['columns'] = [
    {
      title: 'Date',
      dataIndex: 'createdAt',
      render: (val: string) => <Text>{formatDate(val)}</Text>,
      sorter: (a: ExportAuditRecord, b: ExportAuditRecord) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Type',
      dataIndex: 'exportType',
      width: 100,
      render: (val: string) => {
        const color = val === 'full' ? 'arcoblue' : val === 'core' ? 'green' : 'gray';
        return <Tag color={color}>{val}</Tag>;
      },
    },
    {
      title: 'Manifest Hash',
      dataIndex: 'manifestHash',
      render: (val: string) => <Text code>{val ? `${val.slice(0, 12)}…` : '—'}</Text>,
    },
    {
      title: 'Assets',
      dataIndex: 'assetCount',
      align: 'right',
      width: 90,
      render: (val: number) => <Text>{val ?? 0}</Text>,
    },
    {
      title: 'Missing',
      dataIndex: 'missingAssetCount',
      align: 'right',
      width: 90,
      render: (val: number) => {
        const count = val ?? 0;
        return <Text style={{ color: count > 0 ? '#f53f3f' : undefined }}>{count}</Text>;
      },
    },
    {
      title: 'Size',
      dataIndex: 'totalSizeBytes',
      align: 'right',
      width: 100,
      render: (val: number) => <Text>{formatBytes(val ?? 0)}</Text>,
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      <Typography.Title heading={5} style={{ marginTop: 0 }}>
        Export History
      </Typography.Title>
      <Spin loading={isLoadingHistory} style={{ width: '100%' }}>
        {auditHistory.length === 0 && !isLoadingHistory ? (
          <Empty description="No export records yet" />
        ) : (
          <Table
            rowKey="id"
            columns={columns}
            data={auditHistory}
            pagination={{ pageSize: 10 }}
            size="small"
          />
        )}
      </Spin>
    </div>
  );
};

export default ExportHistoryPanel;
