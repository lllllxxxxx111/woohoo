import React, { useState, useEffect, useCallback } from 'react';
import { Modal, Table, Tag, Empty, Spin, Button, Space, Typography, Tooltip } from '@arco-design/web-react';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Download,
  FileArchive,
  FileText,
  Film,
  RefreshCw,
  Hash,
  HardDrive,
  ShieldAlert,
} from 'lucide-react';
import { getExportAudits, formatBytes, type ExportAuditRecord } from './exportAudit';

const { Text } = Typography;

interface ExportHistoryDialogProps {
  visible: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
}

function statusTag(status: string) {
  switch (status) {
    case 'completed':
      return <Tag color="green" icon={<CheckCircle size={12} />}>成功</Tag>;
    case 'partial':
      return <Tag color="orange" icon={<AlertTriangle size={12} />}>部分成功</Tag>;
    case 'failed':
      return <Tag color="red" icon={<XCircle size={12} />}>失败</Tag>;
    default:
      return <Tag>{status}</Tag>;
  }
}

function typeTag(type: string) {
  switch (type) {
    case 'full':
      return (
        <Tag color="arcoblue" icon={<FileArchive size={12} />}>
          完整工程包
        </Tag>
      );
    case 'core':
      return (
        <Tag color="purple" icon={<FileText size={12} />}>
          核心策划包
        </Tag>
      );
    case 'final_cut':
      return (
        <Tag color="cyan" icon={<Film size={12} />}>
          成片计划
        </Tag>
      );
    default:
      return <Tag>{type}</Tag>;
  }
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function shortHash(h?: string) {
  if (!h) return '—';
  return h.slice(0, 8);
}

export const ExportHistoryDialog: React.FC<ExportHistoryDialogProps> = ({
  visible,
  projectId,
  projectName,
  onClose,
}) => {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ExportAuditRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getExportAudits(projectId);
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (visible) {
      void load();
    }
  }, [visible, load]);

  const columns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 145,
      render: (v: string) => (
        <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatDate(v)}</Text>
      ),
    },
    {
      title: '类型',
      dataIndex: 'exportType',
      width: 120,
      render: (v: string) => typeTag(v),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => statusTag(v),
    },
    {
      title: '文件',
      dataIndex: 'filename',
      render: (v: string) =>
        v ? (
          <Tooltip content={v}>
            <Text ellipsis style={{ maxWidth: 200, display: 'inline-block', fontSize: 12 }}>
              {v}
            </Text>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
        ),
    },
    {
      title: '资产',
      dataIndex: 'includedAssets',
      width: 80,
      render: (v: number, record: ExportAuditRecord) => (
        <span style={{ fontSize: 12 }}>
          {v}
          {record.missingAssets > 0 && (
            <Text type="warning" style={{ fontSize: 11, marginLeft: 4 }}>
              (-{record.missingAssets})
            </Text>
          )}
        </span>
      ),
    },
    {
      title: '大小',
      dataIndex: 'bundleSizeBytes',
      width: 90,
      render: (v: number) => (
        <span style={{ fontSize: 12 }}>
          <HardDrive size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
          {v > 0 ? formatBytes(v) : '—'}
        </span>
      ),
    },
    {
      title: '校验',
      width: 150,
      render: (_: unknown, record: ExportAuditRecord) => (
        <Space size={4}>
          {record.precheckPassed ? (
            <Tag size="small" color="green" icon={<CheckCircle size={10} />}>预检通过</Tag>
          ) : (
            <Tag size="small" color="orange" icon={<AlertTriangle size={10} />}>预检警告</Tag>
          )}
          {Boolean(record.hasSensitiveData) && (
            <Tooltip content="导出中检测到敏感信息并已脱敏">
              <Tag size="small" color="orange" icon={<ShieldAlert size={10} />}>已脱敏</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Manifest Hash',
      dataIndex: 'manifestSha256',
      width: 100,
      render: (v?: string) => (
        <Text code style={{ fontSize: 11 }}>
          <Hash size={10} style={{ marginRight: 2, verticalAlign: -1 }} />
          {shortHash(v)}
        </Text>
      ),
    },
  ];

  return (
    <Modal
      title={
        <Space>
          <Clock size={18} />
          <span>导出历史</span>
          {projectName && (
            <Text type="secondary" style={{ fontWeight: 400, fontSize: 13 }}>
              — {projectName}
            </Text>
          )}
        </Space>
      }
      visible={visible}
      onCancel={onClose}
      footer={
        <Space>
          <Button icon={<RefreshCw size={14} />} onClick={load} loading={loading}>
            刷新
          </Button>
          <Button type="primary" onClick={onClose}>
            关闭
          </Button>
        </Space>
      }
      style={{ width: 920 }}
      unmountOnExit
    >
      {loading && items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spin tip="加载导出记录..." />
        </div>
      ) : error ? (
        <Empty
          description={
            <Space direction="vertical" size={4}>
              <Text type="error">加载失败</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{error}</Text>
            </Space>
          }
        />
      ) : items.length === 0 ? (
        <Empty
          icon={<Download size={48} style={{ opacity: 0.3 }} />}
          description={
            <Space direction="vertical" size={4}>
              <Text>暂无导出记录</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                第一次导出后将在此显示历史记录
              </Text>
            </Space>
          }
        />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              共 {total} 条记录，按时间倒序显示
            </Text>
          </div>
          <Table
            rowKey="id"
            columns={columns as unknown as React.ComponentProps<typeof Table>['columns']}
            data={items}
            pagination={false}
            size="small"
            border={false}
            stripe
            scroll={{ y: 420 }}
            style={{ fontSize: 12 }}
          />
        </>
      )}
    </Modal>
  );
};
