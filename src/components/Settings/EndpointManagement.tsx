import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Table,
  Space,
  Typography,
  Tag,
  Modal,
  Form,
  Input,
  Popconfirm,
  Select,
  Switch,
} from '@arco-design/web-react';
import { Plus, Network, Key, Server, Zap, Eye, EyeOff } from 'lucide-react';
import {
  listServerAiEndpoints,
  createServerAiEndpoint,
  updateServerAiEndpoint,
  deleteServerAiEndpoint,
  testServerAiCompletionByEndpoint,
  testServerAiCompletion,
} from '../../lib/serverApi';
import { useToast } from '../../context/useToast';
import { AI_PROVIDER_OPTIONS, AI_PROVIDER_PRESETS, normalizeAiBaseUrl } from '../../lib/ai';
import type { AiProvider, AiSettings } from '../../types';

const { Text, Paragraph } = Typography;

type ServerAiEndpoint = Awaited<ReturnType<typeof listServerAiEndpoints>>[number];

type EndpointManagementProps = {
  currentSettings: AiSettings;
  currentEndpointId?: string | null;
  onApplySettings?: (settings: AiSettings) => void;
};

/** 规范化基础 URL，去除首尾空格和末尾斜杠 */
function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

/** 判断端点配置是否与给定设置完全匹配（服务商、URL、模型） */
function endpointMatchesSettings(endpoint: ServerAiEndpoint, settings: AiSettings) {
  return (
    endpoint.provider.trim().toLowerCase() === settings.provider.trim().toLowerCase() &&
    normalizeBaseUrl(endpoint.baseUrl) === normalizeBaseUrl(settings.baseUrl) &&
    (endpoint.defaultModel?.trim() || '') === settings.model.trim()
  );
}

export const EndpointManagement: React.FC<EndpointManagementProps> = ({
  currentSettings,
  currentEndpointId,
  onApplySettings,
}) => {
  const [endpoints, setEndpoints] = useState<ServerAiEndpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [verifiedConfigSignature, setVerifiedConfigSignature] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [, setStoredApiKey] = useState('');
  const { showToast } = useToast();
  const [form] = Form.useForm();

  /** 根据设置和端点 ID 构建连通性签名，用于判断是否需要重新测试 */
  const buildConnectivitySignature = (
    settings: AiSettings,
    endpointIdForStoredKey?: string | null,
  ) => {
    const keyFingerprint = settings.apiKey
      ? `${settings.apiKey.length}:${settings.apiKey.slice(-4)}`
      : endpointIdForStoredKey
        ? `stored:${endpointIdForStoredKey}`
        : 'none';
    return [
      settings.provider.trim().toLowerCase(),
      normalizeBaseUrl(settings.baseUrl),
      settings.model.trim().toLowerCase(),
      settings.forceStreamFallback ? 'stream' : 'auto',
      keyFingerprint,
    ].join('|');
  };

  /** 判断是否可以复用当前设置中的 API Key */
  const canReuseCurrentSettingsKey = (endpoint?: ServerAiEndpoint) => {
    if (!endpoint) {
      return false;
    }

    const hasCurrentKey = Boolean(currentSettings.apiKey.trim());
    if (!hasCurrentKey) {
      return false;
    }

    if (currentEndpointId) {
      return endpoint.id === currentEndpointId;
    }

    return endpointMatchesSettings(endpoint, currentSettings);
  };

  /** 从服务端加载端点列表 */
  const fetchEndpoints = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listServerAiEndpoints(true);
      setEndpoints(data);
    } catch (error) {
      showToast({ type: 'error', title: '加载端点失败', message: String(error) });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void fetchEndpoints();
  }, [fetchEndpoints]);

  /** 打开创建新端点的弹窗 */
  const handleCreate = () => {
    setEditingId(null);
    setVerifiedConfigSignature(null);
    setApiKeyVisible(false);
    setStoredApiKey('');
    form.resetFields();
    form.setFieldsValue({
      ...AI_PROVIDER_PRESETS['openai'],
      forceStreamFallback: true,
    });
    setVisible(true);
  };

  /** 打开编辑指定端点的弹窗，填充表单初始值 */
  const handleEdit = (record: ServerAiEndpoint) => {
    setEditingId(record.id);
    setVerifiedConfigSignature(null);
    setApiKeyVisible(false);
    setStoredApiKey('');
    form.setFieldsValue({
      name: record.name,
      provider: record.provider,
      baseUrl: record.baseUrl,
      model: record.defaultModel || '',
      apiKey: '',
      forceStreamFallback: true,
    });
    setVisible(true);
  };

  /** 删除指定端点并刷新列表 */
  const handleDelete = async (id: string) => {
    try {
      await deleteServerAiEndpoint(id);
      showToast({ type: 'success', title: 'API通道已删除' });
      await fetchEndpoints();
    } catch (error) {
      showToast({ type: 'error', title: '删除失败', message: String(error) });
    }
  };

  /** 切换服务商时自动填充预设值 */
  const handleProviderChange = (provider: AiProvider) => {
    const preset = AI_PROVIDER_PRESETS[provider];
    setVerifiedConfigSignature(null);
    if (preset) {
      form.setFieldsValue({
        provider: provider,
        baseUrl: preset.baseUrl,
        model: preset.model,
      });
    }
  };

  /** 测试当前表单配置的 API 连通性 */
  const handleTestConnectivity = async () => {
    try {
      await form.validate();
      setTesting(true);
      const values = form.getFieldsValue();
      const provider = values.provider as AiProvider;
      const providerPreset = AI_PROVIDER_PRESETS[provider];
      if (!providerPreset) {
        showToast({
          type: 'error',
          title: '无效服务商',
          message: '请重新选择模型提供商后再测试。',
        });
        return;
      }
      const editingRecord = editingId
        ? endpoints.find((endpoint) => endpoint.id === editingId)
        : undefined;
      const rawApiKey = (values.apiKey || '').trim();
      const isEditingWithEmptyKey = Boolean(editingRecord) && !rawApiKey;
      const shouldReuseCurrentKey =
        isEditingWithEmptyKey && canReuseCurrentSettingsKey(editingRecord);
      const canUseStoredEndpointKeyForTest =
        Boolean(editingRecord?.id) &&
        providerPreset.requiresApiKey &&
        isEditingWithEmptyKey &&
        !shouldReuseCurrentKey &&
        Boolean(editingRecord?.hasApiKey);

      // 构建测试用的设置对象
      const testSettings: AiSettings = {
        provider,
        baseUrl: normalizeAiBaseUrl(provider, values.baseUrl || ''),
        model: (values.model || '').trim(),
        apiKey: shouldReuseCurrentKey ? currentSettings.apiKey.trim() : rawApiKey,
        systemPrompt: currentSettings.systemPrompt,
        temperature: currentSettings.temperature,
        maxTokens: currentSettings.maxTokens,
        topP: currentSettings.topP,
        frequencyPenalty: currentSettings.frequencyPenalty,
        forceStreamFallback: values.forceStreamFallback !== false,
        multiAgentBetaEnabled: currentSettings.multiAgentBetaEnabled === true,
        promptOptimizerBetaEnabled: currentSettings.promptOptimizerBetaEnabled === true,
        pipelineRetryBackoffSec: currentSettings.pipelineRetryBackoffSec,
        pipelineRetryMaxBackoffSec: currentSettings.pipelineRetryMaxBackoffSec,
      };

      if (
        isEditingWithEmptyKey &&
        !shouldReuseCurrentKey &&
        providerPreset.requiresApiKey &&
        !canUseStoredEndpointKeyForTest
      ) {
        showToast({
          type: 'warning',
          title: '无法复用原密钥',
          message: '该端点当前没有可复用的服务端密钥，请输入该端点的 API Key 后再测试。',
        });
        return;
      }

      if (
        !testSettings.apiKey &&
        providerPreset.requiresApiKey &&
        !canUseStoredEndpointKeyForTest
      ) {
        showToast({ type: 'warning', title: '缺少 API Key', message: '请先输入有效的授权密钥' });
        return;
      }

      if (canUseStoredEndpointKeyForTest && editingRecord?.id) {
        await testServerAiCompletionByEndpoint(
          editingRecord.id,
          testSettings,
          '请只回复"连接成功"。',
          { forceStreamFallback: testSettings.forceStreamFallback },
        );
        setVerifiedConfigSignature(buildConnectivitySignature(testSettings, editingRecord.id));
      } else {
        await testServerAiCompletion(testSettings, '请只回复"连接成功"。', {
          forceStreamFallback: testSettings.forceStreamFallback,
        });
        setVerifiedConfigSignature(buildConnectivitySignature(testSettings));
      }
      showToast({
        type: 'success',
        title: '✅ 连通性测试通过',
        message: `已成功连接到 ${testSettings.model} (${provider})`,
      });
    } catch (error) {
      setVerifiedConfigSignature(null);
      showToast({
        type: 'error',
        title: '❌ 连通性测试失败',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  /** 提交创建或编辑端点表单，包含连通性自动验证逻辑 */
  const handleSubmit = async () => {
    try {
      await form.validate();
      setSaving(true);
      const values = form.getFieldsValue();
      const provider = values.provider as AiProvider;
      const providerPreset = AI_PROVIDER_PRESETS[provider];
      if (!providerPreset) {
        showToast({
          type: 'error',
          title: '无效服务商',
          message: '请重新选择模型提供商后再保存。',
        });
        return;
      }
      const editingRecord = editingId
        ? endpoints.find((endpoint) => endpoint.id === editingId)
        : undefined;
      const rawApiKey = (values.apiKey || '').trim();

      const isEditingWithEmptyKey = Boolean(editingRecord) && !rawApiKey;

      const nextSettings: AiSettings = {
        provider,
        baseUrl: normalizeAiBaseUrl(provider, values.baseUrl || ''),
        model: (values.model || '').trim(),
        apiKey: isEditingWithEmptyKey ? undefined : rawApiKey,
        systemPrompt: currentSettings.systemPrompt,
        temperature: currentSettings.temperature,
        maxTokens: currentSettings.maxTokens,
        topP: currentSettings.topP,
        frequencyPenalty: currentSettings.frequencyPenalty,
        forceStreamFallback: values.forceStreamFallback !== false,
        multiAgentBetaEnabled: currentSettings.multiAgentBetaEnabled === true,
        promptOptimizerBetaEnabled: currentSettings.promptOptimizerBetaEnabled === true,
        pipelineRetryBackoffSec: currentSettings.pipelineRetryBackoffSec,
        pipelineRetryMaxBackoffSec: currentSettings.pipelineRetryMaxBackoffSec,
      };

      const shouldReuseCurrentKey =
        Boolean(editingRecord) &&
        isEditingWithEmptyKey &&
        canReuseCurrentSettingsKey(editingRecord);
      const appliedSettings: AiSettings = shouldReuseCurrentKey
        ? { ...nextSettings, apiKey: currentSettings.apiKey.trim() }
        : { ...nextSettings, apiKey: nextSettings.apiKey || '' };

      const actionLabel = editingId ? '更新' : '创建';
      let connectivityVerified: boolean | null = null;
      let savedEndpointId: string | null = null;
      let savedEndpointHasApiKey = false;

      if (editingId) {
        const updatedEndpoint = await updateServerAiEndpoint(editingId, appliedSettings);
        savedEndpointId = updatedEndpoint.id;
        savedEndpointHasApiKey = Boolean(updatedEndpoint.hasApiKey);
      } else {
        const createdEndpoint = await createServerAiEndpoint(appliedSettings);
        savedEndpointId = createdEndpoint.id;
        savedEndpointHasApiKey = Boolean(createdEndpoint.hasApiKey);
      }

      const canUseStoredEndpointKeyForTest =
        providerPreset.requiresApiKey &&
        !appliedSettings.apiKey &&
        Boolean(savedEndpointId) &&
        savedEndpointHasApiKey;
      const currentSignature = buildConnectivitySignature(
        appliedSettings,
        canUseStoredEndpointKeyForTest ? savedEndpointId : null,
      );
      const canRunConnectivityTest =
        !providerPreset.requiresApiKey ||
        Boolean(appliedSettings.apiKey) ||
        canUseStoredEndpointKeyForTest;
      const canSkipRetest = canRunConnectivityTest && verifiedConfigSignature === currentSignature;

      if (canRunConnectivityTest) {
        if (canSkipRetest) {
          connectivityVerified = true;
        } else {
          setTesting(true);
          showToast({
            type: 'info',
            title: '正在测试 API 连通性',
            message: '首次保存该配置，系统将自动完成连通性验证',
          });
          try {
            if (canUseStoredEndpointKeyForTest && savedEndpointId) {
              await testServerAiCompletionByEndpoint(
                savedEndpointId,
                appliedSettings,
                '请只回复“连接成功”。',
                { forceStreamFallback: appliedSettings.forceStreamFallback },
              );
            } else {
              await testServerAiCompletion(appliedSettings, '请只回复“连接成功”。', {
                forceStreamFallback: appliedSettings.forceStreamFallback,
              });
            }
            connectivityVerified = true;
            setVerifiedConfigSignature(currentSignature);
          } catch (error) {
            connectivityVerified = false;
            setVerifiedConfigSignature(null);
            showToast({
              type: 'warning',
              title: `API通道已${actionLabel}，但连通性测试失败`,
              message:
                error instanceof Error ? error.message : '请检查 Base URL / API Key / 模型名称',
            });
          } finally {
            setTesting(false);
          }
        }
      }

      if (canRunConnectivityTest && connectivityVerified !== false) {
        onApplySettings?.(appliedSettings);
      }

      if (!canRunConnectivityTest) {
        const keepOriginalKeyWithoutReuse =
          Boolean(editingRecord) &&
          isEditingWithEmptyKey &&
          !canReuseCurrentSettingsKey(editingRecord) &&
          providerPreset.requiresApiKey;
        showToast({
          type: 'warning',
          title: `API通道已${actionLabel}`,
          message: keepOriginalKeyWithoutReuse
            ? '该端点未保存可用密钥，暂无法自动连通性测试；请输入 API Key 后重试。'
            : '未提供可测试密钥，暂未自动切为当前默认聊天配置',
        });
      } else if (connectivityVerified) {
        showToast({
          type: 'success',
          title: `API通道${actionLabel}成功`,
          message: canSkipRetest
            ? '检测到此前已通过连通性测试，已跳过重复测试并同步为当前默认聊天配置'
            : '连通性测试通过，已同步为当前默认聊天配置',
        });
      }

      setVisible(false);
      await fetchEndpoints();
    } catch (error) {
      showToast({
        type: 'error',
        title: '操作失败',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
      setTesting(false);
    }
  };

  const columns = [
    {
      title: '服务商及通道名称',
      dataIndex: 'provider',
      render: (col: string, record: ServerAiEndpoint) => (
        <Space size="medium">
          <div style={{ padding: 8, background: 'var(--color-fill-2)', borderRadius: 4 }}>
            <Server size={18} />
          </div>
          <Space direction="vertical" size="mini">
            <Text bold>{record.name || col.toUpperCase()}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              <Network size={12} style={{ marginRight: 4 }} />
              {record.baseUrl}
            </Text>
          </Space>
        </Space>
      ),
    },
    {
      title: '默认调用模型',
      dataIndex: 'defaultModel',
      render: (col: string) => (
        <Tag color="cyan" bordered>
          {col || '未设置'}
        </Tag>
      ),
    },
    {
      title: '认证状态',
      dataIndex: 'hasApiKey',
      render: (hasApiKey: boolean) =>
        hasApiKey ? (
          <Tag color="green">
            <Key size={12} style={{ marginRight: 4 }} /> 已配置密钥
          </Tag>
        ) : (
          <Tag color="red">缺少密钥</Tag>
        ),
    },
    {
      title: '全局启用',
      dataIndex: 'isActive',
      render: (isActive: boolean) => <Switch checked={isActive} disabled />,
    },
    {
      title: '操作',
      dataIndex: 'action',
      render: (_col: string, record: ServerAiEndpoint) => (
        <Space>
          <Button type="text" size="small" onClick={() => handleEdit(record)}>
            编辑与模型管理
          </Button>
          <Popconfirm
            focusLock
            title="确认删除提供商端点？历史用量不受影响。"
            onOk={() => handleDelete(record.id)}
          >
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
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text bold style={{ display: 'block' }}>
              多模型引擎通道管理
            </Text>
            <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
              添加不同的 API Keys 以便在系统中无缝切换调用不同渠道的 AI 原生大模型能力。
            </Paragraph>
          </div>
          <Button type="primary" icon={<Plus size={16} />} onClick={handleCreate}>
            新增 API 通道
          </Button>
        </div>
        <Table
          rowKey="id"
          columns={columns}
          data={endpoints}
          loading={loading}
          pagination={false}
          border={false}
          hover={true}
          style={{ background: 'var(--color-bg-2)' }}
        />
      </Space>

      <Modal
        title={editingId ? '配置通道与模型参数' : '新增 API 通道'}
        visible={visible}
        onOk={handleSubmit}
        confirmLoading={saving}
        onCancel={() => setVisible(false)}
        style={{ width: 600 }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Button
              icon={<Zap size={14} />}
              loading={testing}
              onClick={handleTestConnectivity}
              style={{ borderRadius: 8 }}
            >
              {testing ? '测试中...' : '🔗 测试连通性'}
            </Button>
            <Space>
              <Button onClick={() => setVisible(false)}>取消</Button>
              <Button type="primary" loading={saving} onClick={handleSubmit}>
                {editingId ? '保存配置' : '创建通道'}
              </Button>
            </Space>
          </div>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item label="服务商类型 (Provider)" field="provider" rules={[{ required: true }]}>
            <Select onChange={(val) => handleProviderChange(val as AiProvider)}>
              {AI_PROVIDER_OPTIONS.map((opt) => (
                <Select.Option key={opt.value} value={opt.value}>
                  {opt.label}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="通道接口地址 (Base URL)"
            field="baseUrl"
            rules={[{ required: true }]}
            help="必须输入完整的服务请求前缀。例如: https://api.openai.com/v1"
          >
            <Input placeholder="https://..." />
          </Form.Item>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <Form.Item label="缺省首选模型 (Default Model)" field="model">
              <Input placeholder="例如: gpt-4o" />
            </Form.Item>
            <Form.Item
              label="授权密钥 (API Key)"
              field="apiKey"
              extra={editingId ? '留空将保留原密钥不变' : ''}
            >
              <Input
                placeholder="sk-..."
                type={apiKeyVisible ? 'text' : 'password'}
                addAfter={
                  <button
                    type="button"
                    onClick={() => setApiKeyVisible(!apiKeyVisible)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      border: 'none',
                      background: 'transparent',
                      padding: '4px',
                      color: 'var(--color-text-3)',
                    }}
                    tabIndex={-1}
                  >
                    {apiKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                }
              />
            </Form.Item>
          </div>
          <Form.Item
            label="流式输出 (Stream)"
            field="forceStreamFallback"
            triggerPropName="checked"
            extra="开启后优先使用流式请求，兼容只支持流式的 API 中转服务"
          >
            <Switch checkedText="流式" uncheckedText="非流式" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};
