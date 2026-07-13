import React, { useState } from 'react';
import { Modal, Button, Typography, Tag, Space, Table, Alert, Tabs } from '@arco-design/web-react';
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  FileArchive,
  FileText,
  Download,
  Copy,
  Eye,
} from 'lucide-react';
import type { ExportResult, FileEntry, AssetEntry, MissingAssetEntry } from './workspaceExport';

const { Text, Paragraph } = Typography;
const TabPane = Tabs.TabPane;

interface ExportResultModalProps {
  visible: boolean;
  result: ExportResult | null;
  onClose: () => void;
  onViewHistory?: () => void;
}

const statusMap = {
  completed: { icon: <CheckCircle size={20} color="#00b42a" />, color: 'green' as const, label: '导出成功' },
  partial: { icon: <AlertTriangle size={20} color="#ff7d00" />, color: 'orange' as const, label: '部分成功' },
  failed: { icon: <XCircle size={20} color="#f53f3f" />, color: 'red' as const, label: '导出失败' },
};

const verifyStatusColor: Record<string, string> = {
  pass: 'green',
  warn: 'orange',
  fail: 'red',
  skip: 'gray',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function shortenHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}...${hash.slice(-8)}` : hash;
}

export const ExportResultModal: React.FC<ExportResultModalProps> = ({
  visible,
  result,
  onClose,
  onViewHistory,
}) => {
  const [manifestOpen, setManifestOpen] = useState(false);

  if (!result) return null;

  const st = statusMap[result.status];
  const { manifest, verification } = result;

  const fileColumns = [
    {
      title: '文件路径',
      dataIndex: 'path',
      render: (path: string) => <Text style={{ fontSize: 12, fontFamily: 'monospace' }}>{path}</Text>,
    },
    {
      title: '大小',
      dataIndex: 'sizeBytes',
      width: 100,
      render: (size: number) => <Text type="secondary" style={{ fontSize: 12 }}>{formatBytes(size)}</Text>,
    },
    {
      title: 'SHA-256',
      dataIndex: 'sha256',
      width: 200,
      render: (hash: string) => (
        <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>
          {shortenHash(hash)}
        </Text>
      ),
    },
  ];

  const missingColumns = [
    {
      title: '资产名称',
      dataIndex: 'name',
      render: (name: string, record: MissingAssetEntry) => (
        <Space size={4}>
          <Tag size="small">{record.type}</Tag>
          <Text style={{ fontSize: 12 }}>{name}</Text>
        </Space>
      ),
    },
    {
      title: '错误',
      dataIndex: 'error',
      render: (error: string) => <Text type="secondary" style={{ fontSize: 12 }}>{error}</Text>,
    },
  ];

  return (
    <>
      <Modal
        title="导出结果"
        visible={visible && !manifestOpen}
        onCancel={onClose}
        style={{ maxWidth: 720 }}
        footer={
          <Space>
            {onViewHistory && (
              <Button icon={<Eye size={14} />} onClick={onViewHistory}>
                查看历史
              </Button>
            )}
            <Button
              icon={<FileText size={14} />}
              onClick={() => setManifestOpen(true)}
            >
              查看清单
            </Button>
            <Button type="primary" onClick={onClose}>
              完成
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size={20}>
          {/* Status header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {st.icon}
            <div>
              <Text bold style={{ fontSize: 16 }}>{st.label}</Text>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {result.filename}
                </Text>
              </div>
            </div>
          </div>

          {/* Description */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
            {[
              { label: '导出 ID', value: <Text style={{ fontSize: 12, fontFamily: 'monospace' }}>{result.exportId}</Text> },
              { label: '导出时间', value: <Text style={{ fontSize: 12 }}>{new Date(manifest.exportedAt).toLocaleString('zh-CN')}</Text> },
              { label: '包大小', value: <Text bold>{formatBytes(result.totalSizeBytes)}</Text> },
              { label: '文件总数', value: <Text>{manifest.files.length} 个</Text> },
              { label: '资产打包', value: <Text>{result.downloadedAssets} / {manifest.assets.length + result.missingAssets}</Text> },
              { label: '校验状态', value: <Tag color={verifyStatusColor[verification.status]}>{verification.status.toUpperCase()}</Tag> },
            ].map((item, i) => (
              <div key={i}>
                <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{item.label}</Text>
                {item.value}
              </div>
            ))}
          </div>

          {/* Verification issues */}
          {verification.issues.length > 0 && (
            <Alert
              type={verification.status === 'fail' ? 'error' : 'warning'}
              title="校验报告"
              content={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {verification.issues.map((issue, i) => (
                    <li key={i} style={{ fontSize: 12 }}>{issue}</li>
                  ))}
                </ul>
              }
            />
          )}

          {/* Content flags */}
          {manifest.contentFlags.warnings.length > 0 && (
            <Alert
              type="info"
              title="内容提示"
              content={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {manifest.contentFlags.warnings.map((w, i) => (
                    <li key={i} style={{ fontSize: 12 }}>{w}</li>
                  ))}
                </ul>
              }
            />
          )}

          {/* Generation params summary */}
          {manifest.generationParams.modelsUsed.length > 0 && (
            <div>
              <Text bold style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
                AI 生成摘要
              </Text>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {manifest.generationParams.modelsUsed.map((m) => (
                  <Tag key={m.model} color="arcoblue">
                    {m.model}: {m.requestCount} 次
                    {m.totalTokens ? ` · ${(m.totalTokens / 1000).toFixed(1)}k tokens` : ''}
                  </Tag>
                ))}
                {manifest.generationParams.imageGenerations > 0 && (
                  <Tag color="cyan">图片: {manifest.generationParams.imageGenerations}</Tag>
                )}
                {manifest.generationParams.videoGenerations > 0 && (
                  <Tag color="purple">视频: {manifest.generationParams.videoGenerations}</Tag>
                )}
              </div>
            </div>
          )}

          {/* Versions */}
          <div>
            <Text bold style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
              版本快照
            </Text>
            <Space size={16} wrap>
              {manifest.versions.script && (
                <Tag color="green">
                  剧本 hash:{manifest.versions.script.contentHash} · {formatBytes(manifest.versions.script.contentLength)}
                </Tag>
              )}
              {manifest.versions.storyboard && (
                <Tag color="blue">
                  分镜 hash:{manifest.versions.storyboard.contentHash} · {manifest.versions.storyboard.contentLength} 字节
                </Tag>
              )}
              <Tag color="gray">消息: {manifest.versions.chatMessagesCount} 条</Tag>
            </Space>
          </div>

          {/* Redaction summary */}
          {manifest.contentFlags.redaction?.applied && (
            <div style={{ padding: 12, background: 'var(--color-orange-light-1)', borderRadius: 8 }}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space size={6}>
                  <AlertTriangle size={16} color="#ff7d00" />
                  <Text bold style={{ fontSize: 13 }}>
                    自动脱敏：已移除 {manifest.contentFlags.redaction.totalRedactions} 处敏感信息
                  </Text>
                </Space>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 22 }}>
                  {Object.entries(manifest.contentFlags.redaction.byCategory)
                    .filter(([, n]) => (n ?? 0) > 0)
                    .map(([cat, n]) => {
                      const labels: Record<string, string> = {
                        api_key: 'API Key',
                        jwt: 'JWT',
                        password: '密码',
                        private_key: '私钥',
                        auth_header: '认证头',
                        email: '邮箱',
                        phone_cn: '手机号',
                        id_card_cn: '身份证号',
                        credit_card: '银行卡',
                        local_path: '本机路径',
                        aws_key: 'AWS密钥',
                        openai_key: 'OpenAI密钥',
                        generic_secret: '密钥字段',
                      };
                      return (
                        <Tag key={cat} size="small" color="orange">
                          {labels[cat] ?? cat} ×{n}
                        </Tag>
                      );
                    })}
                </div>
              </Space>
            </div>
          )}
        </Space>
      </Modal>

      {/* Manifest detail modal */}
      <Modal
        title="导出清单详情"
        visible={manifestOpen}
        onCancel={() => setManifestOpen(false)}
        style={{ maxWidth: 800 }}
        footer={<Button onClick={() => setManifestOpen(false)}>关闭</Button>}
      >
        <Tabs defaultActiveTab="files">
          <TabPane key="files" title={`文件 (${manifest.files.length})`}>
            <Table
              size="small"
              columns={fileColumns}
              data={manifest.files}
              pagination={false}
              scroll={{ y: 300 }}
              rowKey="path"
            />
          </TabPane>
          <TabPane key="assets" title={`资产 (${manifest.assets.length})`}>
            <Table
              size="small"
              columns={[
                { title: '名称', dataIndex: 'name', render: (n: string, r: AssetEntry) => (
                  <Space size={4}><Tag size="small">{r.type}</Tag><Text style={{ fontSize: 12 }}>{n}</Text></Space>
                )},
                { title: '路径', dataIndex: 'filePath', render: (p?: string) => p ? <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{p}</Text> : <Text type="secondary" style={{ fontSize: 11 }}>-</Text> },
                { title: '大小', dataIndex: 'sizeBytes', width: 90, render: (s?: number) => s ? <Text style={{ fontSize: 12 }}>{formatBytes(s)}</Text> : '-' },
                { title: 'Hash', dataIndex: 'sha256', width: 140, render: (h?: string) => h ? <Text style={{ fontSize: 10, fontFamily: 'monospace' }}>{shortenHash(h)}</Text> : '-' },
              ]}
              data={manifest.assets}
              pagination={false}
              scroll={{ y: 300 }}
              rowKey="id"
            />
          </TabPane>
          {manifest.missingAssets.length > 0 && (
            <TabPane key="missing" title={`缺失 (${manifest.missingAssets.length})`}>
              <Alert
                type="warning"
                style={{ marginBottom: 12 }}
                content="以下资产未能下载打包，解压后将无法访问"
              />
              <Table
                size="small"
                columns={missingColumns}
                data={manifest.missingAssets}
                pagination={false}
                scroll={{ y: 250 }}
                rowKey="id"
              />
            </TabPane>
          )}
        </Tabs>
      </Modal>
    </>
  );
};
