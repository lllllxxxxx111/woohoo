import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Mail, RefreshCw, Send, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  Divider,
  Input,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from '@arco-design/web-react';

import { useToast } from '../../context/useToast';
import {
  createNotificationChannel,
  deleteNotificationChannel,
  listNotificationChannels,
  listNotificationEvents,
  testNotificationChannel,
  type NotificationChannelType,
  type OpsNotificationChannel,
  type OpsNotificationEvent,
  updateNotificationChannel,
} from '../../lib/serverApi';

const { Paragraph, Text } = Typography;

type Props = {
  language: string;
  onLanguageChange: (value: string) => void;
};

type NotificationFormState = {
  name: string;
  channelType: NotificationChannelType;
  target: string;
  isEnabled: boolean;
  configText: string;
};

const CHANNEL_OPTIONS: Array<{
  value: NotificationChannelType;
  label: string;
  subtitle: string;
  live: boolean;
}> = [
  { value: 'feishu', label: '飞书', subtitle: '机器人 Webhook', live: true },
  { value: 'webhook', label: '通用 Webhook', subtitle: '原样 POST JSON', live: true },
  { value: 'dingtalk', label: '钉钉', subtitle: '机器人 Webhook', live: true },
  { value: 'wecom', label: '企业微信', subtitle: '机器人 Webhook', live: true },
  { value: 'slack', label: 'Slack', subtitle: 'Incoming Webhook', live: true },
  {
    value: 'email',
    label: '邮箱 (开发中)',
    subtitle: 'SMTP 发送器待接入，可提前配置',
    live: false,
  },
  {
    value: 'telegram',
    label: 'Telegram (开发中)',
    subtitle: 'Bot API 待接入，可提前配置',
    live: false,
  },
  { value: 'other', label: '其他', subtitle: '自定义保留类型', live: true },
];

const DEFAULT_FORM: NotificationFormState = {
  name: '',
  channelType: 'feishu',
  target: '',
  isEnabled: true,
  configText: '',
};

function prettifyConfig(value: OpsNotificationChannel['config']) {
  if (!value || Object.keys(value).length === 0) {
    return '';
  }

  return JSON.stringify(value, null, 2);
}

function formatTimestamp(value?: string | null) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function parseConfigText(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('附加配置必须是 JSON 对象');
  }

  return parsed as Record<string, unknown>;
}

function getStatusTagColor(status: OpsNotificationEvent['status']) {
  switch (status) {
    case 'sent':
      return 'green';
    case 'failed':
      return 'red';
    case 'queued':
      return 'arcoblue';
    case 'skipped':
      return 'orange';
    default:
      return 'gray';
  }
}

function channelDescription(type: NotificationChannelType) {
  return CHANNEL_OPTIONS.find((item) => item.value === type) ?? CHANNEL_OPTIONS[0];
}

export const NotificationSettings: React.FC<Props> = ({ language, onLanguageChange }) => {
  const { showToast } = useToast();
  const [channels, setChannels] = useState<OpsNotificationChannel[]>([]);
  const [events, setEvents] = useState<OpsNotificationEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<NotificationFormState>(DEFAULT_FORM);
  const [loadError, setLoadError] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const formRef = useRef(form);

  selectedIdRef.current = selectedId;
  formRef.current = form;

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedId) ?? null,
    [channels, selectedId],
  );
  const selectedChannelOption = channelDescription(form.channelType);

  const syncForm = useCallback((channel?: OpsNotificationChannel | null) => {
    if (!channel) {
      setSelectedId(null);
      setForm(DEFAULT_FORM);
      return;
    }

    setSelectedId(channel.id);
    setForm({
      name: channel.name,
      channelType: channel.channelType,
      target: channel.target,
      isEnabled: channel.isEnabled,
      configText: prettifyConfig(channel.config),
    });
  }, []);

  const refresh = useCallback(
    async (forceRefresh = false) => {
      setLoading(true);
      try {
        const [nextChannels, nextEvents] = await Promise.all([
          listNotificationChannels(forceRefresh),
          listNotificationEvents(12),
        ]);
        setChannels(nextChannels);
        setEvents(nextEvents);
        setLoadError(null);

        if (selectedIdRef.current) {
          const updatedSelected = nextChannels.find((item) => item.id === selectedIdRef.current);
          if (updatedSelected) {
            syncForm(updatedSelected);
          } else {
            syncForm(null);
          }
        } else if (nextChannels.length === 1 && !formRef.current.name && !formRef.current.target) {
          syncForm(nextChannels[0]);
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : '通知设置加载失败');
      } finally {
        setLoading(false);
      }
    },
    [syncForm],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateForm = <K extends keyof NotificationFormState>(
    key: K,
    value: NotificationFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const buildPayload = () => {
    if (!form.name.trim()) {
      throw new Error('通道名称不能为空');
    }
    if (!form.target.trim()) {
      throw new Error('通知目标不能为空');
    }

    /**
     * 根据渠道类型校验目标格式
     */
    if (form.channelType === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(form.target.trim())) {
        throw new Error('邮箱地址格式不正确');
      }
    }

    if (form.channelType === 'telegram') {
      const telegramRegex = /^\d+:[A-Za-z0-9_-]+$/;
      if (!telegramRegex.test(form.target.trim())) {
        throw new Error('Telegram Bot Token 格式不正确（应为数字:字母数字组合）');
      }
    }

    return {
      name: form.name.trim(),
      channelType: form.channelType,
      target: form.target.trim(),
      isEnabled: form.isEnabled,
      config: parseConfigText(form.configText),
    };
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const payload = buildPayload();
      const nextChannel = selectedChannel
        ? await updateNotificationChannel(selectedChannel.id, payload)
        : await createNotificationChannel(payload);

      showToast({
        type: 'success',
        title: selectedChannel ? '通知通道已更新' : '通知通道已创建',
        message: `${nextChannel.name} 已保存到后端`,
      });
      await refresh(true);
      syncForm(nextChannel);
    } catch (error) {
      showToast({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '通知通道保存失败',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (channel: OpsNotificationChannel) => {
    const confirmed = window.confirm(`确认删除通知通道「${channel.name}」？`);
    if (!confirmed) {
      return;
    }

    setDeleting(channel.id);
    try {
      await deleteNotificationChannel(channel.id);
      showToast({
        type: 'success',
        title: '通知通道已删除',
        message: channel.name,
      });
      if (selectedId === channel.id) {
        syncForm(null);
      }
      await refresh(true);
    } catch (error) {
      showToast({
        type: 'error',
        title: '删除失败',
        message: error instanceof Error ? error.message : '通知通道删除失败',
      });
    } finally {
      setDeleting(null);
    }
  };

  const handleTest = async (channel?: OpsNotificationChannel | null) => {
    const targetChannelType = channel?.channelType ?? form.channelType;
    const targetOption = channelDescription(targetChannelType);

    /**
     * 未就绪渠道禁止测试
     */
    if (!targetOption.live) {
      showToast({
        type: 'warning',
        title: '该渠道发送器尚未就绪',
        message: `${targetOption.label} 的后端发送器还在开发中，配置已保存，待接入后可立即生效。`,
      });
      return;
    }

    setTesting(true);
    try {
      const payload = channel
        ? {
            channelType: channel.channelType,
            target: channel.target,
            config: channel.config ?? null,
          }
        : {
            channelType: form.channelType,
            target: form.target.trim(),
            config: parseConfigText(form.configText),
          };
      if (!payload.target.trim()) {
        throw new Error('请先填写通知目标');
      }

      const result = await testNotificationChannel({
        ...payload,
        title: 'Woohoo 通知链路测试',
        message: '这是一条从设置页发起的测试通知，用于校验 webhook 是否可达。',
      });
      await refresh(true);
      showToast({
        type: result.status === 'sent' ? 'success' : 'warning',
        title: result.status === 'sent' ? '测试通知已发送' : '测试请求已返回',
        message: result.responseBody || result.event.lastError || `状态: ${result.status}`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '测试发送失败',
        message: error instanceof Error ? error.message : '通知测试失败',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ paddingRight: 16 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card
          bordered={false}
          title="通知语言与派发说明"
          style={{ background: 'var(--color-bg-2)' }}
        >
          <Space direction="vertical" size="medium" style={{ width: '100%' }}>
            <div>
              <Text bold>通知外发语言</Text>
              <Select
                style={{ marginTop: 8, width: 280 }}
                value={language}
                onChange={onLanguageChange}
              >
                <Select.Option value="zh-CN">简体中文</Select.Option>
                <Select.Option value="en-US">English (US)</Select.Option>
                <Select.Option value="ja-JP">日本語</Select.Option>
                <Select.Option value="ko-KR">한국어</Select.Option>
              </Select>
            </div>
            <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
              当前后端已经支持真实通知派发。`feishu / webhook / dingtalk / wecom / slack`
              可直接测试发送；`email / telegram` 已有数据结构，但发送器还没接。
            </Paragraph>
          </Space>
        </Card>

        <Card
          bordered={false}
          title="通知通道管理"
          extra={
            <Button
              type="outline"
              icon={<RefreshCw size={14} />}
              loading={loading}
              onClick={() => void refresh(true)}
            >
              刷新
            </Button>
          }
          style={{ background: 'var(--color-bg-2)' }}
        >
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {loadError ? <Tag color="red">{loadError}</Tag> : null}

            <div
              style={{
                display: 'grid',
                gap: 16,
                gridTemplateColumns: 'minmax(0, 1.1fr) minmax(340px, 0.9fr)',
                alignItems: 'start',
              }}
            >
              <div>
                <div style={{ display: 'grid', gap: 12 }}>
                  {channels.length === 0 ? (
                    <Card bordered={false} style={{ background: 'var(--color-fill-2)' }}>
                      <Space direction="vertical" size="small">
                        <Text bold>还没有已保存的通知通道</Text>
                        <Text type="secondary">
                          右侧填写飞书、钉钉或通用 webhook 后直接保存即可。
                        </Text>
                      </Space>
                    </Card>
                  ) : (
                    channels.map((channel) => {
                      const option = channelDescription(channel.channelType);
                      const isSelected = selectedId === channel.id;
                      return (
                        <Card
                          key={channel.id}
                          bordered={false}
                          hoverable
                          style={{
                            background: isSelected ? 'var(--color-fill-2)' : 'var(--color-bg-1)',
                            border: isSelected
                              ? '1px solid var(--color-primary-light-3)'
                              : '1px solid transparent',
                          }}
                          onClick={() => syncForm(channel)}
                        >
                          <div
                            style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <Space size="small" wrap>
                                <Text bold>{channel.name}</Text>
                                <Tag color={channel.isEnabled ? 'green' : 'gray'}>
                                  {channel.isEnabled ? '已启用' : '已停用'}
                                </Tag>
                                <Tag color={option.live ? 'arcoblue' : 'orange'}>
                                  {option.label}
                                </Tag>
                              </Space>
                              <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                                {option.subtitle}
                              </Text>
                              <Text
                                type="secondary"
                                style={{
                                  display: 'block',
                                  marginTop: 8,
                                  maxWidth: '100%',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {channel.target}
                              </Text>
                            </div>

                            <Space direction="vertical" size="small">
                              <Button
                                size="small"
                                icon={<Send size={14} />}
                                loading={testing}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleTest(channel);
                                }}
                              >
                                测试
                              </Button>
                              <Button
                                size="small"
                                status="danger"
                                icon={<Trash2 size={14} />}
                                loading={deleting === channel.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleDelete(channel);
                                }}
                              >
                                删除
                              </Button>
                            </Space>
                          </div>
                        </Card>
                      );
                    })
                  )}
                </div>
              </div>

              <Card bordered={false} style={{ background: 'var(--color-bg-1)' }}>
                <Space direction="vertical" size="medium" style={{ width: '100%' }}>
                  <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Space align="center">
                      <BellRing size={16} />
                      <Text bold>{selectedChannel ? '编辑通知通道' : '新增通知通道'}</Text>
                    </Space>
                    <Button type="text" onClick={() => syncForm(null)}>
                      新建
                    </Button>
                  </Space>

                  <div>
                    <Text bold>通道名称</Text>
                    <Input
                      style={{ marginTop: 8 }}
                      value={form.name}
                      onChange={(value) => updateForm('name', value)}
                      placeholder="例如：生产环境飞书告警"
                    />
                  </div>

                  <div>
                    <Text bold>通道类型</Text>
                    <Select
                      style={{ marginTop: 8 }}
                      value={form.channelType}
                      onChange={(value) =>
                        updateForm('channelType', value as NotificationChannelType)
                      }
                    >
                      {CHANNEL_OPTIONS.map((option) => (
                        <Select.Option key={option.value} value={option.value}>
                          {option.label}
                        </Select.Option>
                      ))}
                    </Select>
                    <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                      {selectedChannelOption.subtitle}
                    </Text>
                  </div>

                  <div>
                    <Text bold>通知目标</Text>
                    <Input
                      style={{ marginTop: 8 }}
                      value={form.target}
                      onChange={(value) => updateForm('target', value)}
                      placeholder="Webhook URL / 邮箱地址 / 目标地址"
                    />
                  </div>

                  <div>
                    <Text bold>附加配置 JSON</Text>
                    <Input.TextArea
                      style={{ marginTop: 8 }}
                      autoSize={{ minRows: 4, maxRows: 8 }}
                      value={form.configText}
                      onChange={(value) => updateForm('configText', value)}
                      placeholder={`{\n  "language": "${language}"\n}`}
                    />
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Text bold>启用通道</Text>
                    <Switch
                      checked={form.isEnabled}
                      onChange={(value) => updateForm('isEnabled', value)}
                    />
                  </div>

                  <Space>
                    <Button type="primary" loading={saving} onClick={() => void handleSubmit()}>
                      {selectedChannel ? '更新通道' : '创建通道'}
                    </Button>
                    <Button
                      icon={<Send size={14} />}
                      loading={testing}
                      onClick={() => void handleTest()}
                    >
                      测试当前配置
                    </Button>
                  </Space>
                </Space>
              </Card>
            </div>
          </Space>
        </Card>

        <Card bordered={false} title="通知事件审计" style={{ background: 'var(--color-bg-2)' }}>
          <Space direction="vertical" size="medium" style={{ width: '100%' }}>
            {events.length === 0 ? (
              <Text type="secondary">当前账号下还没有通知审计记录。你可以先发送一条测试通知。</Text>
            ) : (
              events.map((event) => (
                <Card key={event.id} bordered={false} style={{ background: 'var(--color-bg-1)' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      alignItems: 'flex-start',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <Space size="small" wrap>
                        <Tag color={getStatusTagColor(event.status)}>{event.status}</Tag>
                        <Tag>{event.eventType}</Tag>
                        <Text type="secondary">尝试 {event.attemptCount} 次</Text>
                      </Space>
                      <Text style={{ display: 'block', marginTop: 8 }}>
                        {String(
                          event.payload?.title ||
                            event.payload?.summary ||
                            event.dedupeKey ||
                            event.id,
                        )}
                      </Text>
                      <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                        创建于 {formatTimestamp(event.createdAt)}
                        {event.sentAt ? `，发送于 ${formatTimestamp(event.sentAt)}` : ''}
                      </Text>
                      {event.lastError ? (
                        <Text
                          type="secondary"
                          style={{ display: 'block', marginTop: 8, color: 'rgb(var(--danger-6))' }}
                        >
                          {event.lastError}
                        </Text>
                      ) : null}
                    </div>

                    {event.responseBody ? (
                      <Tag color="green" style={{ maxWidth: 240, whiteSpace: 'normal' }}>
                        {event.responseBody.slice(0, 120)}
                      </Tag>
                    ) : null}
                  </div>
                </Card>
              ))
            )}
          </Space>
        </Card>

        <Card bordered={false} style={{ background: 'var(--color-bg-2)' }}>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Space align="center">
              <Mail size={16} />
              <Text bold>渠道接通状态</Text>
            </Space>
            <Divider style={{ margin: '8px 0' }} />
            <Tag color="green">已接通：飞书 / 钉钉 / 企业微信 / Slack / Webhook</Tag>
            <Tag color="orange" style={{ marginTop: 4 }}>
              开发中：邮箱 (SMTP) / Telegram (Bot API)
            </Tag>
            <Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
              开发中渠道的配置会被正常保存，待发送器接入后可立即生效，无需重新配置。
            </Paragraph>
          </Space>
        </Card>
      </Space>
    </div>
  );
};
