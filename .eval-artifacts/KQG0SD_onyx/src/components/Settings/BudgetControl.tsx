import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  InputNumber,
  Switch,
  Typography,
  Space,
  Tag,
  Table,
  Message,
  Tooltip,
  Progress,
} from '@arco-design/web-react';
import {
  IconInfoCircle,
  IconExclamationCircle,
  IconCheckCircle,
  IconCloseCircle,
  IconRefresh,
} from '@arco-design/web-react/icon';
import type { BudgetStatus, UpdateBudgetConfigInput } from '../../types';
import { getBudgetStatus, listBudgetBlocks, updateBudgetConfig } from '../../lib/serverApi';
import { formatCreditAmount } from '../../lib/credits';

import styles from './BudgetControl.module.css';

const { Title, Text, Paragraph } = Typography;
const FormItem = Form.Item;

interface BudgetControlProps {
  onBudgetChange?: (status: BudgetStatus) => void;
}

export const BudgetControl: React.FC<BudgetControlProps> = ({ onBudgetChange }) => {
  const [budgetStatus, setBudgetStatus] = useState<BudgetStatus | null>(null);
  const [budgetBlocks, setBudgetBlocks] = useState<Array<{
    id: string;
    operation: string;
    reason: string;
    currentUsage: number;
    limitValue: number;
    createdAt: string;
  }>>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  // 加载预算状态
  const loadBudgetStatus = async () => {
    setLoading(true);
    try {
      const status = await getBudgetStatus();
      setBudgetStatus(status);
      onBudgetChange?.(status);
      
      // 填充表单
      form.setFieldsValue({
        dailyCreditLimit: status.config.dailyCreditLimit ?? undefined,
        monthlyCreditLimit: status.config.monthlyCreditLimit ?? undefined,
        warnRatio: status.config.warnRatio,
        isEnabled: status.config.isEnabled,
      });
    } catch (error) {
      Message.error('加载预算状态失败');
      console.error('Failed to load budget status:', error);
    } finally {
      setLoading(false);
    }
  };

  // 加载最近拦截记录
  const loadBudgetBlocks = async () => {
    try {
      const blocks = await listBudgetBlocks();
      setBudgetBlocks(blocks);
    } catch (error) {
      console.error('Failed to load budget blocks:', error);
    }
  };

  // 保存预算配置
  const handleSave = async (values: UpdateBudgetConfigInput) => {
    setSaving(true);
    try {
      // 处理空值
      const input: UpdateBudgetConfigInput = {
        ...values,
        dailyCreditLimit: values.dailyCreditLimit === undefined ? null : values.dailyCreditLimit,
        monthlyCreditLimit: values.monthlyCreditLimit === undefined ? null : values.monthlyCreditLimit,
      };

      const updatedStatus = await updateBudgetConfig(input);
      setBudgetStatus(updatedStatus);
      onBudgetChange?.(updatedStatus);
      Message.success('预算配置已保存');
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '保存预算配置失败');
      console.error('Failed to save budget config:', error);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    loadBudgetStatus();
    loadBudgetBlocks();
  }, []);

  // 预算状态标签
  const renderStatusTag = () => {
    if (!budgetStatus) return null;
    
    if (budgetStatus.hasExceeded) {
      return <Tag color="red" icon={<IconCloseCircle />}>预算超限</Tag>;
    }
    if (budgetStatus.hasWarning) {
      return <Tag color="orange" icon={<IconExclamationCircle />}>即将超限</Tag>;
    }
    return <Tag color="green" icon={<IconCheckCircle />}>状态正常</Tag>;
  };

  // 使用率颜色
  const getUsageColor = (ratio: number, isExceeded: boolean, isWarning: boolean) => {
    if (isExceeded) return '#f53f3f';
    if (isWarning) return '#ff7d00';
    return '#00b42a';
  };

  const columns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '操作类型',
      dataIndex: 'operation',
      width: 120,
      render: (v: string) => {
        const typeMap: Record<string, string> = {
          chat: '同步聊天',
          stream: '流式聊天',
          task: '异步任务',
          test: '连通性测试',
        };
        return typeMap[v] || v;
      },
    },
    {
      title: '拦截原因',
      dataIndex: 'reason',
      width: 120,
      render: (v: string) => {
        const reasonMap: Record<string, string> = {
          daily_exceeded: '日预算超限',
          monthly_exceeded: '月预算超限',
        };
        return reasonMap[v] || v;
      },
    },
    {
      title: '当前消耗',
      dataIndex: 'currentUsage',
      width: 100,
      render: (v: number) => formatCreditAmount(v),
    },
    {
      title: '预算上限',
      dataIndex: 'limitValue',
      width: 100,
      render: (v: number) => formatCreditAmount(v),
    },
  ];

  return (
    <div className={styles.budgetControl}>
      <Card
        title={
          <Space>
            <Title heading={6} style={{ margin: 0 }}>预算控制</Title>
            {renderStatusTag()}
          </Space>
        }
        extra={
          <Button
            type="text"
            icon={<IconRefresh />}
            onClick={loadBudgetStatus}
            loading={loading}
          >
            刷新
          </Button>
        }
        className={styles.card}
      >
        {budgetStatus?.hasExceeded && (
          <Alert
            type="error"
            title="预算已超限"
            content="您的预算已使用完毕，部分 AI 功能将被限制。请调整预算上限或等待周期重置。"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        {budgetStatus?.hasWarning && !budgetStatus.hasExceeded && (
          <Alert
            type="warning"
            title="预算即将超限"
            content="您的预算使用率已超过预警阈值，请注意控制消耗。"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        <div className={styles.usageOverview}>
          <div className={styles.usageItem}>
            <div className={styles.usageLabel}>今日消耗</div>
            <div className={styles.usageValue}>
              {formatCreditAmount(budgetStatus?.dailyUsage || 0)}
              {budgetStatus?.config.dailyCreditLimit && (
                <span className={styles.usageLimit}>
                  / {formatCreditAmount(budgetStatus.config.dailyCreditLimit)}
                </span>
              )}
            </div>
            <Progress
              percent={Math.round((budgetStatus?.dailyUsageRatio || 0) * 100)}
              color={getUsageColor(
                budgetStatus?.dailyUsageRatio || 0,
                budgetStatus?.isDailyExceeded || false,
                budgetStatus?.isDailyWarning || false
              )}
              showText={false}
              style={{ marginTop: 8 }}
            />
            <div className={styles.usageHint}>
              {budgetStatus?.isDailyExceeded ? '日预算已超限' : 
               budgetStatus?.isDailyWarning ? '日预算即将超限' : '日预算使用正常'}
            </div>
          </div>

          <div className={styles.usageItem}>
            <div className={styles.usageLabel}>本月消耗</div>
            <div className={styles.usageValue}>
              {formatCreditAmount(budgetStatus?.monthlyUsage || 0)}
              {budgetStatus?.config.monthlyCreditLimit && (
                <span className={styles.usageLimit}>
                  / {formatCreditAmount(budgetStatus.config.monthlyCreditLimit)}
                </span>
              )}
            </div>
            <Progress
              percent={Math.round((budgetStatus?.monthlyUsageRatio || 0) * 100)}
              color={getUsageColor(
                budgetStatus?.monthlyUsageRatio || 0,
                budgetStatus?.isMonthlyExceeded || false,
                budgetStatus?.isMonthlyWarning || false
              )}
              showText={false}
              style={{ marginTop: 8 }}
            />
            <div className={styles.usageHint}>
              {budgetStatus?.isMonthlyExceeded ? '月预算已超限' : 
               budgetStatus?.isMonthlyWarning ? '月预算即将超限' : '月预算使用正常'}
            </div>
          </div>
        </div>

        <Form
          form={form}
          layout="vertical"
          onSubmit={handleSave}
          className={styles.form}
          initialValues={{
            warnRatio: 0.8,
            isEnabled: true,
          }}
        >
          <FormItem
            label={
              <Space>
                启用预算控制
                <Tooltip content="启用后，当消耗达到预算上限时将拦截 AI 请求">
                  <IconInfoCircle style={{ color: 'var(--color-text-3)' }} />
                </Tooltip>
              </Space>
            }
            field="isEnabled"
            triggerPropName="checked"
          >
            <Switch />
          </FormItem>

          <FormItem
            label={
              <Space>
                日预算上限（积分）
                <Tooltip content="每日累计消耗超过此值后将拦截 AI 请求。留空表示不限制">
                  <IconInfoCircle style={{ color: 'var(--color-text-3)' }} />
                </Tooltip>
              </Space>
            }
            field="dailyCreditLimit"
            rules={[
              {
                validator: (value, callback) => {
                  if (value !== undefined && value < 0) {
                    callback('日预算不能为负数');
                  }
                  callback();
                },
              },
            ]}
          >
            <InputNumber
              placeholder="留空表示不限制"
              min={0}
              step={0.01}
              precision={2}
              style={{ width: '100%' }}
              disabled={!form.getFieldValue('isEnabled')}
            />
          </FormItem>

          <FormItem
            label={
              <Space>
                月预算上限（积分）
                <Tooltip content="每月累计消耗超过此值后将拦截 AI 请求。留空表示不限制">
                  <IconInfoCircle style={{ color: 'var(--color-text-3)' }} />
                </Tooltip>
              </Space>
            }
            field="monthlyCreditLimit"
            rules={[
              {
                validator: (value, callback) => {
                  if (value !== undefined && value < 0) {
                    callback('月预算不能为负数');
                  }
                  callback();
                },
              },
            ]}
          >
            <InputNumber
              placeholder="留空表示不限制"
              min={0}
              step={0.01}
              precision={2}
              style={{ width: '100%' }}
              disabled={!form.getFieldValue('isEnabled')}
            />
          </FormItem>

          <FormItem
            label={
              <Space>
                预警比例
                <Tooltip content="当使用率达到此比例时将显示预警提示。取值范围 0-1，默认 0.8">
                  <IconInfoCircle style={{ color: 'var(--color-text-3)' }} />
                </Tooltip>
              </Space>
            }
            field="warnRatio"
            rules={[
              {
                required: true,
                message: '请输入预警比例',
              },
              {
                validator: (value, callback) => {
                  if (value < 0 || value > 1) {
                    callback('预警比例必须在 0 到 1 之间');
                  }
                  callback();
                },
              },
            ]}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              precision={2}
              style={{ width: '100%' }}
              disabled={!form.getFieldValue('isEnabled')}
            />
          </FormItem>

          <FormItem>
            <Space>
              <Button type="primary" htmlType="submit" loading={saving} disabled={loading}>
                保存配置
              </Button>
              <Button onClick={() => loadBudgetStatus()} disabled={loading}>
                重置
              </Button>
            </Space>
          </FormItem>
        </Form>

        {budgetBlocks.length > 0 && (
          <div className={styles.blocksSection}>
            <Title heading={6} style={{ marginBottom: 12 }}>最近拦截记录</Title>
            <Table
              columns={columns}
              data={budgetBlocks}
              rowKey="id"
              pagination={false}
              size="small"
              className={styles.blocksTable}
            />
          </div>
        )}
      </Card>
    </div>
  );
};
