import React, { useCallback, useEffect, useState } from 'react';
import {
  Avatar,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { Bot, Plus, RefreshCw } from 'lucide-react';

import { useToast } from '../../context/useToast';
import { useAppStore } from '../../store';
import {
  createServerAgent,
  deleteServerAgent,
  listServerAgents,
  listServerAiEndpoints,
  updateServerAgent,
  type CreateAgentInput,
} from '../../lib/serverApi';
import type { ServerAiEndpoint } from '../../lib/serverApi.endpoints';
import type { AgentContact } from '../../types';
import styles from './SettingsSection.module.css';

const { Paragraph, Text } = Typography;

export const AgentManagement: React.FC = () => {
  const [agents, setAgents] = useState<AgentContact[]>([]);
  const [endpoints, setEndpoints] = useState<ServerAiEndpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { showToast } = useToast();
  const [form] = Form.useForm();

  /** 将最新的智能体列表同步到全局状态仓库，同时更新各项目下的 agentRoster */
  const syncAgentsToStore = useCallback((nextAgents: AgentContact[]) => {
    const latestAgentsById = new Map(nextAgents.map((agent) => [agent.id, agent]));
    useAppStore.setState((state) => ({
      allAgentContacts: nextAgents,
      projects: state.projects.map((project) => {
        if (!Array.isArray(project.agentRoster) || project.agentRoster.length === 0) {
          return project;
        }

        let hasChanged = false;
        const nextRoster = project.agentRoster.map((agent) => {
          const latest = latestAgentsById.get(agent.id);
          if (!latest) {
            return agent;
          }
          if (latest !== agent) {
            hasChanged = true;
          }
          return latest;
        });

        return hasChanged ? { ...project, agentRoster: nextRoster } : project;
      }),
    }));
  }, []);

  /** 从服务端加载智能体列表和端点列表 */
  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const [data, eps] = await Promise.all([listServerAgents(), listServerAiEndpoints(true)]);
      setAgents(data);
      syncAgentsToStore(data);
      setEndpoints(eps);
    } catch (error) {
      showToast({
        type: 'error',
        title: '加载失败',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [showToast, syncAgentsToStore]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  /** 打开创建新智能体的弹窗 */
  const handleCreate = () => {
    setEditingId(null);
    form.resetFields();
    setVisible(true);
  };

  /** 打开编辑指定智能体的弹窗，并填充表单初始值 */
  const handleEdit = (record: AgentContact) => {
    setEditingId(record.id);
    form.setFieldsValue({
      name: record.name,
      role: record.role,
      systemPrompt: record.systemPrompt,
      description: record.description,
      endpointId: record.endpointId,
      badge: record.badge,
      model: record.model,
      temperature: record.temperature,
      maxTokens: record.maxTokens,
    });
    setVisible(true);
  };

  /** 删除指定智能体并刷新列表 */
  const handleDelete = async (id: string) => {
    try {
      await deleteServerAgent(id);
      showToast({ type: 'success', title: '删除成功' });
      await fetchAgents();
    } catch (error) {
      showToast({
        type: 'error',
        title: '删除失败',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** 提交创建或编辑表单 */
  const handleSubmit = async () => {
    try {
      await form.validate();
      setSaving(true);
      const values = form.getFieldsValue();
      const payload: CreateAgentInput = {
        name: String(values.name ?? '').trim(),
        role: String(values.role ?? '').trim(),
        systemPrompt: String(values.systemPrompt ?? '').trim(),
        description: values.description ? String(values.description).trim() : undefined,
        endpointId: values.endpointId ? String(values.endpointId) : undefined,
        badge: values.badge ? String(values.badge).trim() : undefined,
        model: values.model ? String(values.model).trim() : undefined,
        temperature: typeof values.temperature === 'number' ? values.temperature : undefined,
        maxTokens: typeof values.maxTokens === 'number' ? values.maxTokens : undefined,
      };

      if (editingId) {
        await updateServerAgent(editingId, payload);
        showToast({ type: 'success', title: '更新成功' });
      } else {
        await createServerAgent(payload);
        showToast({ type: 'success', title: '创建成功' });
      }

      setVisible(false);
      await fetchAgents();
    } catch (error) {
      showToast({
        type: 'error',
        title: editingId ? '更新失败' : '创建失败',
        message: error instanceof Error ? error.message : '请求未完成，请检查填写内容或后端日志',
      });
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      title: '智能体',
      dataIndex: 'name',
      render: (col: string, record: AgentContact) => (
        <Space size="medium">
          <Avatar size={40} shape="square" style={{ backgroundColor: 'var(--color-fill-3)' }}>
            <Bot size={18} />
          </Avatar>
          <Space direction="vertical" size="mini">
            <Text bold>{col}</Text>
            {record.badge && (
              <Tag color="arcoblue" size="small">
                {record.badge}
              </Tag>
            )}
          </Space>
        </Space>
      ),
    },
    {
      title: '角色 / 说明',
      dataIndex: 'role',
      render: (role: string, record: AgentContact) => (
        <Space direction="vertical" size="mini">
          <Text>{role}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {record.description}
          </Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (status: string) => {
        const color = status === 'idle' ? 'green' : status === 'busy' ? 'red' : 'orange';
        return <Tag color={color}>{status}</Tag>;
      },
    },
    {
      title: '通道',
      dataIndex: 'endpointId',
      render: (endpointId: string, record: AgentContact) => {
        const ep = endpoints.find((e) => e.id === endpointId);
        return (
          <Space direction="vertical" size="mini">
            {ep ? (
              <Tag size="small" color="purple">
                {ep.name || ep.provider}
              </Tag>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                全局通道
              </Text>
            )}
            {record.model ? (
              <Text style={{ fontSize: 12, color: 'var(--color-primary-light-4)' }}>
                {record.model}
              </Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '操作',
      dataIndex: 'action',
      render: (_col: string, record: AgentContact) => (
        <Space>
          <Button type="text" size="small" onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Popconfirm focusLock title="确定要删除这个智能体吗？" onOk={() => handleDelete(record.id)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Space direction="vertical" size="large" className={styles.page}>
        <Card bordered={false} className={styles.heroCard}>
          <div className={styles.heroRow}>
            <div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
                智能体管理
              </Text>
              <h3 className={styles.heroTitle}>统一管理角色、模型限制和专属通道</h3>
              <Paragraph type="secondary" className={styles.heroDescription}>
                在这里维护会自动参与对话和制作流程的智能体。每个智能体都可以绑定独立通道、模型和输出上限。
              </Paragraph>
            </div>
            <div className={styles.heroActions}>
              <Button
                type="outline"
                icon={<RefreshCw size={16} />}
                loading={loading}
                onClick={() => void fetchAgents()}
              >
                刷新列表
              </Button>
              <Button type="primary" icon={<Plus size={16} />} onClick={handleCreate}>
                创建智能体
              </Button>
            </div>
          </div>
        </Card>

        <Card bordered={false} className={styles.sectionCard}>
          <div className={styles.tableShell}>
            <Table
              rowKey="id"
              columns={columns}
              data={agents}
              loading={loading}
              pagination={false}
              border={false}
              hover={true}
              style={{ background: 'transparent' }}
            />
          </div>
        </Card>
      </Space>

      <Modal
        title={editingId ? '编辑智能体 (Edit Agent)' : '创建新智能体 (New Agent)'}
        visible={visible}
        onOk={handleSubmit}
        confirmLoading={saving}
        onCancel={() => setVisible(false)}
        style={{ width: 720 }}
      >
        <Form form={form} layout="vertical">
          <div className={styles.formGridFull}>
            <Form.Item
              label="名称 (Name)"
              field="name"
              rules={[{ required: true, message: '必须输入名称' }]}
            >
              <Input placeholder="例如：剧本大师" />
            </Form.Item>
            <Form.Item
              label="角色标识 (Role)"
              field="role"
              rules={[{ required: true, message: '必须输入角色' }]}
            >
              <Input placeholder="例如：编写对白、大纲构建" />
            </Form.Item>
            <Form.Item
              label="系统设定提示词 (System Prompt)"
              field="systemPrompt"
              rules={[{ required: true, message: '必须输入系统设定' }]}
            >
              <Input.TextArea autoSize={{ minRows: 4 }} placeholder="You are a helpful assistant..." />
            </Form.Item>
          </div>

          <div className={styles.formGrid}>
            <Form.Item label="简介 (Description)" field="description">
              <Input placeholder="一句话简介" />
            </Form.Item>
            <Form.Item
              label="API 模型通道 (Endpoint)"
              field="endpointId"
              tooltip="绑定专属模型通道 API"
            >
              <Select placeholder="选择系统通道..." allowClear>
                {endpoints.map((e) => (
                  <Select.Option key={e.id} value={e.id}>
                    {e.name || e.provider}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
            <Form.Item label="徽章 (Badge)" field="badge">
              <Input placeholder="例如：Expert" />
            </Form.Item>
            <Form.Item label="模型绑定 (Model)" field="model" tooltip="覆盖端点默认模型">
              <Input placeholder="例如：claude-3-5-sonnet-20240620" />
            </Form.Item>
            <Form.Item label="发散度 (Temperature)" field="temperature">
              <InputNumber placeholder="0.7" step={0.1} />
            </Form.Item>
            <Form.Item label="最大输出上限" field="maxTokens">
              <InputNumber placeholder="1024" step={100} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  );
};
