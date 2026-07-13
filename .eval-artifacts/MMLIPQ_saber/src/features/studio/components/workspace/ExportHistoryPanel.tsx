import React, { useEffect, useState } from 'react';
import { Modal, Table, Button, Tag, Space, Typography, Empty, Spin, Drawer } from '@arco-design/web-react';
import { History, Eye } from 'lucide-react';
import { listProjectExports, listMyExports } from '../../../../lib/serverApi';
import type { ExportAuditRecord } from '../../../../lib/serverApi';

const { Text } = Typography;

interface ExportHistoryPanelProps {
  visible: boolean;
  projectId?: string;
  /** Show all user exports (across projects) when true; otherwise just this project */
  showAll?: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso;
  }
}

const statusTagColor: Record<string, string> = {
  completed: 'green',
  partial: 'orange',
  failed: 'red',
  pending: 'gray',
};

const exportTypeLabel: Record<string, string> = {
  full: '完整工程包',
  core: '核心策划包',
  final_cut: '成片计划',
  snapshot: '项目快照',
};

export const ExportHistoryPanel: React.FC<ExportHistoryPanelProps> = ({
  visible,
  projectId,
  showAll,
  onClose,
}) => {
  const [records, setRecords] = useState<ExportAuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<ExportAuditRecord | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);

  useEffect(() => {
    if (visible && (projectId || showAll)) {
      void loadHistory();
    }
  }, [visible, projectId, showAll]);

  async function loadHistory() {
    if (!projectId && !showAll) return;
    setLoading(true);
    try {
      let data: ExportAuditRecord[];
      if (showAll) {
        data = await listMyExports(50);
      } else if (projectId) {
        data = await listProjectExports(projectId, 50);
      } else {
        data = [];
      }
      setRecords(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn('Failed to load export history:', err);
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }

  const columns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (v: string) => <Text style={{ fontSize: 12 }}>{formatDate(v)}</Text>,
    },
    {
      title: '类型',
      dataIndex: 'exportType',
      width: 120,
      render: (v: string) => (
        <Tag size="small">{exportTypeLabel[v] || v}</Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (
        <Tag size="small" color={statusTagColor[v] || 'gray'}>{v}</Tag>
      ),
    },
    {
      title: '资产',
      dataIndex: 'includedAssets',
      width: 90,
      render: (v: number, r: ExportAuditRecord) => (
        <Text style={{ fontSize: 12 }}>
          {v}/{r.totalAssets}
          {r.missingAssets > 0 && <span style={{ color: '#f53f3f' }}> (-{r.missingAssets})</span>}
        </Text>
      ),
    },
    {
      title: '大小',
      dataIndex: 'totalSizeBytes',
      width: 90,
      render: (v: number) => <Text type="secondary" style={{ fontSize: 12 }}>{formatBytes(v)}</Text>,
    },
    {
      title: '文件名',
      dataIndex: 'filename',
      render: (v?: string) => v ? (
        <Text style={{ fontSize: 12, fontFamily: 'monospace' }} ellipsis>{v}</Text>
      ) : '-',
    },
    {
      title: '操作',
      width: 80,
      render: (_: unknown, record: ExportAuditRecord) => (
        <Button
          type="text"
          size="mini"
          icon={<Eye size={14} />}
          onClick={() => {
            setSelectedRecord(record);
            setDetailVisible(true);
          }}
        />
      ),
    },
  ];

  return (
    <>
      <Drawer
        title={
          <Space size={8}>
            <History size={18} />
            <span>导出历史记录</span>
          </Space>
        }
        visible={visible}
        onCancel={onClose}
        width={720}
        footer={null}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin />
          </div>
        ) : records.length === 0 ? (
          <Empty description="暂无导出记录" />
        ) : (
          <Table
            size="small"
            columns={columns}
            data={records}
            pagination={{ pageSize: 10 }}
            rowKey="id"
          />
        )}
      </Drawer>

      <Drawer
        title="导出详情"
        visible={detailVisible}
        onCancel={() => setDetailVisible(false)}
        width={560}
        footer={null}
      >
        {selectedRecord && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>导出 ID</Text>
              <div><Text style={{ fontSize: 12, fontFamily: 'monospace' }}>{selectedRecord.id}</Text></div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>时间</Text>
              <div><Text style={{ fontSize: 13 }}>{formatDate(selectedRecord.createdAt)}</Text></div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>状态</Text>
              <div><Tag color={statusTagColor[selectedRecord.status]}>{selectedRecord.status}</Tag></div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>文件</Text>
              <div><Text style={{ fontSize: 12, fontFamily: 'monospace' }}>{selectedRecord.filename || '-'}</Text></div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>资产统计</Text>
              <div>
                <Text style={{ fontSize: 12 }}>
                  包含 {selectedRecord.includedAssets} / {selectedRecord.totalAssets} 个资产
                  {selectedRecord.missingAssets > 0 && (
                    <span style={{ color: '#f53f3f' }}> ({selectedRecord.missingAssets} 个缺失)</span>
                  )}
                  {' · '}包大小 {formatBytes(selectedRecord.totalSizeBytes)}
                </Text>
              </div>
            </div>
            {selectedRecord.manifestSha256 && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Manifest SHA-256</Text>
                <div>
                  <Text style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {selectedRecord.manifestSha256}
                  </Text>
                </div>
              </div>
            )}
            {selectedRecord.errorMessage && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>错误信息</Text>
                <div style={{ padding: 8, background: 'var(--color-danger-light-1)', borderRadius: 4 }}>
                  <Text style={{ fontSize: 12, color: 'var(--color-danger-6)' }}>{selectedRecord.errorMessage}</Text>
                </div>
              </div>
            )}
          </Space>
        )}
      </Drawer>
    </>
  );
};
