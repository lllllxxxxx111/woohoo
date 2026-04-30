import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  Input,
  InputNumber,
  Select,
  Tag,
  Button,
  Typography,
  Form,
  Space,
  Divider,
  Message,
} from '@arco-design/web-react';
import { Save, Plus, Tag as TagIcon, Bot } from 'lucide-react';
import type { AgentContact } from '../../../../types';
import '../../../../styles/arco-async';
import styles from './AgentEditModal.module.css';

const { TextArea } = Input;
const { Text } = Typography;

/** AgentEditModal组件属性接口定义 */
interface AgentEditModalProps {
  /** 控制模态框显示/隐藏 */
  visible: boolean;
  /** 当前编辑的智能体数据，为null时为新建模式 */
  agent: AgentContact | null;
  /** 关闭模态框的回调函数 */
  onClose: () => void;
  /** 保存数据的回调函数 */
  onSave: (data: Partial<AgentContact>) => Promise<void> | void;
}

/** 表单数据接口定义 */
interface FormData {
  name: string;
  role: string;
  description: string;
  badge: string;
  systemPrompt: string;
  mainCapabilities: string[];
  model: string;
  temperature: number | undefined;
  maxTokens: number | undefined;
  avatar: string;
}

/** 初始表单数据 */
const initialFormData: FormData = {
  name: '',
  role: '',
  description: '',
  badge: '',
  systemPrompt: '',
  mainCapabilities: [],
  model: '',
  temperature: undefined,
  maxTokens: undefined,
  avatar: '',
};

/** 预设的能力选项列表 */
const CAPABILITY_OPTIONS = [
  '文本生成',
  '图像生成',
  '视频制作',
  '音频处理',
  '文档编写',
  '代码开发',
  '数据分析',
  '翻译',
  '创意设计',
  '项目管理',
  '质量审核',
  '内容优化',
];

/** 常用的模型选项列表 */
const MODEL_OPTIONS = [
  { label: 'GPT-4', value: 'gpt-4' },
  { label: 'GPT-3.5-Turbo', value: 'gpt-3.5-turbo' },
  { label: 'Claude-3', value: 'claude-3' },
  { label: 'DeepSeek', value: 'deepseek-chat' },
  { label: 'Moonshot', value: 'moonshot-v1-128k' },
  { label: '自定义模型', value: 'custom' },
];

/** 智能体编辑模态框组件
 * 提供智能体信息的完整编辑功能，支持表单验证和数据保存
 */
const AgentEditModal: React.FC<AgentEditModalProps> = ({ visible, agent, onClose, onSave }) => {
  /** 表单数据镜像（仅用于渲染预览与标签区） */
  const [formData, setFormData] = useState<FormData>(initialFormData);
  /** 新能力输入框的状态 */
  const [newCapability, setNewCapability] = useState('');
  /** 表单实例引用 */
  const [form] = Form.useForm();

  /**
   * 当agent数据变化时，初始化表单数据
   * 将传入的智能体数据填充到表单中
   */
  useEffect(() => {
    if (visible && agent) {
      const nextFormData: FormData = {
        name: agent.name || '',
        role: agent.role || '',
        description: agent.description || '',
        badge: agent.badge || '',
        systemPrompt: agent.systemPrompt || '',
        mainCapabilities: agent.mainCapabilities || [],
        model: agent.model || '',
        temperature: agent.temperature ?? 0.7,
        maxTokens: agent.maxTokens ?? 2048,
        avatar: agent.avatar || '',
      };
      setFormData(nextFormData);
      form.setFieldsValue(nextFormData);
    } else if (visible && !agent) {
      // 新建模式：重置表单
      setFormData(initialFormData);
      form.resetFields();
      form.setFieldsValue(initialFormData);
    }
  }, [visible, agent, form]);

  /**
   * 表单值变化时同步到镜像状态，确保预览区域和标签区即时更新
   */
  const handleValuesChange = useCallback((_: unknown, allValues: Partial<FormData>) => {
    setFormData((prev) => ({ ...prev, ...allValues }));
  }, []);

  const setCapabilities = useCallback(
    (capabilities: string[]) => {
      form.setFieldValue('mainCapabilities', capabilities);
      setFormData((prev) => ({ ...prev, mainCapabilities: capabilities }));
    },
    [form],
  );

  /**
   * 添加新的能力标签
   * 验证非空且不重复后添加到能力列表
   */
  const handleAddCapability = useCallback(() => {
    const trimmed = newCapability.trim();
    if (!trimmed) {
      Message.warning('请输入能力标签');
      return;
    }
    const currentCapabilities =
      (form.getFieldValue('mainCapabilities') as string[] | undefined) ?? [];
    if (currentCapabilities.includes(trimmed)) {
      Message.warning('该能力已存在');
      return;
    }
    setCapabilities([...currentCapabilities, trimmed]);
    setNewCapability('');
  }, [form, newCapability, setCapabilities]);

  /**
   * 移除指定索引的能力标签
   * @param index - 要移除的能力标签索引
   */
  const handleRemoveCapability = useCallback(
    (index: number) => {
      const currentCapabilities =
        (form.getFieldValue('mainCapabilities') as string[] | undefined) ?? [];
      setCapabilities(currentCapabilities.filter((_, i) => i !== index));
    },
    [form, setCapabilities],
  );

  /**
   * 从预设选项中选择能力标签
   * @param capability - 选中的能力文本
   */
  const handleSelectCapability = useCallback(
    (capability: string) => {
      const currentCapabilities =
        (form.getFieldValue('mainCapabilities') as string[] | undefined) ?? [];
      if (!currentCapabilities.includes(capability)) {
        setCapabilities([...currentCapabilities, capability]);
      }
    },
    [form, setCapabilities],
  );

  /**
   * 表单提交处理
   * 执行表单验证，通过后调用onSave回调
   */
  const handleSubmit = useCallback(async () => {
    try {
      const values = (await form.validate()) as Partial<FormData>;

      // 构建保存数据对象
      const saveData: Partial<AgentContact> = {
        name: values.name?.trim() || '',
        role: values.role?.trim() || '',
        description: values.description?.trim() || undefined,
        badge: values.badge?.trim() || undefined,
        systemPrompt: values.systemPrompt?.trim() || undefined,
        mainCapabilities: values.mainCapabilities?.length ? values.mainCapabilities : undefined,
        model: values.model?.trim() || undefined,
        temperature: values.temperature !== undefined ? values.temperature : undefined,
        maxTokens: values.maxTokens !== undefined ? values.maxTokens : undefined,
        avatar: values.avatar?.trim() || undefined,
      };

      // 调用保存回调
      await onSave(saveData);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '请检查表单填写是否完整');
    }
  }, [form, onSave]);

  /**
   * 渲染基本信息区域（名称、角色、描述等）
   */
  const renderBasicFields = () => (
    <div className={styles.formSection}>
      <h3 className={styles.sectionTitle}>基本信息</h3>

      <Form.Item
        field="name"
        label="名称"
        rules={[
          { required: true, message: '请输入智能体名称' },
          { minLength: 2, message: '名称至少2个字符' },
          { maxLength: 50, message: '名称不能超过50个字符' },
        ]}
      >
        <Input
          placeholder="请输入智能体名称"
          prefix={<Bot size={16} />}
          maxLength={50}
          showWordLimit
        />
      </Form.Item>

      <Form.Item
        field="role"
        label="角色标识"
        rules={[{ required: true, message: '请输入角色标识' }]}
      >
        <Input placeholder="例如：designer、reviewer、editor" maxLength={30} showWordLimit />
      </Form.Item>

      <Form.Item field="description" label="描述">
        <TextArea
          placeholder="请输入智能体的描述信息（可选）"
          autoSize={{ minRows: 2, maxRows: 4 }}
          maxLength={200}
          showWordLimit
        />
      </Form.Item>

      <Form.Item field="badge" label="徽章">
        <Input placeholder="例如：专家、新手、VIP（可选）" maxLength={20} />
      </Form.Item>
    </div>
  );

  /**
   * 渲染系统提示词区域
   */
  const renderSystemPromptField = () => (
    <div className={styles.formSection}>
      <h3 className={styles.sectionTitle}>系统提示词</h3>

      <Form.Item field="systemPrompt" label="提示词内容">
        <TextArea
          placeholder="请输入系统提示词，用于指导AI的行为和输出风格..."
          autoSize={{ minRows: 4, maxRows: 8 }}
          maxLength={2000}
          showWordLimit
          style={{ fontSize: '13px', lineHeight: '1.6' }}
        />
      </Form.Item>
    </div>
  );

  /**
   * 渲染能力标签选择区域
   */
  const renderCapabilitiesField = () => (
    <div className={styles.formSection}>
      <h3 className={styles.sectionTitle}>核心能力</h3>

      {/* 已选能力标签展示 */}
      <div className={styles.capabilitiesContainer}>
        <Text type="secondary" style={{ fontSize: '12px', marginBottom: 8 }}>
          已选能力：
        </Text>
        <div className={styles.selectedTags}>
          {formData.mainCapabilities.map((capability, index) => (
            <Tag
              key={index}
              color="arcoblue"
              closable
              onClose={() => handleRemoveCapability(index)}
              className={styles.capabilityTag}
            >
              {capability}
            </Tag>
          ))}
          {formData.mainCapabilities.length === 0 && (
            <Text type="secondary" style={{ fontSize: '13px' }}>
              暂未选择任何能力
            </Text>
          )}
        </div>
      </div>

      {/* 手动添加能力 */}
      <div className={styles.addCapabilityRow}>
        <Input
          placeholder="输入新能力并回车添加"
          value={newCapability}
          onChange={(value) => setNewCapability(value)}
          onPressEnter={handleAddCapability}
          prefix={<TagIcon size={14} />}
          style={{ flex: 1 }}
        />
        <Button icon={<Plus size={14} />} onClick={handleAddCapability} type="primary" size="small">
          添加
        </Button>
      </div>

      {/* 预设能力快捷选择 */}
      <div className={styles.presetCapabilities}>
        <Text type="secondary" style={{ fontSize: '12px', marginBottom: 8 }}>
          快捷选择：
        </Text>
        <Space size="small" wrap>
          {CAPABILITY_OPTIONS.map((option) => (
            <Tag
              key={option}
              bordered
              className={`${styles.presetTag} ${
                formData.mainCapabilities.includes(option) ? styles.presetTagSelected : ''
              }`}
              onClick={() => handleSelectCapability(option)}
            >
              {option}
            </Tag>
          ))}
        </Space>
      </div>
    </div>
  );

  /**
   * 渲染模型配置区域
   */
  const renderModelConfigField = () => (
    <div className={styles.formSection}>
      <h3 className={styles.sectionTitle}>模型配置</h3>

      <Form.Item field="model" label="模型">
        <Select
          placeholder="选择或输入模型"
          allowCreate
          options={MODEL_OPTIONS}
          style={{ width: '100%' }}
        />
      </Form.Item>

      <div className={styles.modelParams}>
        <Form.Item field="temperature" label="温度" style={{ flex: 1 }}>
          <InputNumber placeholder="0-2之间" min={0} max={2} step={0.1} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item field="maxTokens" label="最大Token" style={{ flex: 1 }}>
          <InputNumber
            placeholder="最大输出长度"
            min={100}
            max={100000}
            step={100}
            style={{ width: '100%' }}
          />
        </Form.Item>
      </div>
    </div>
  );

  /**
   * 渲染头像设置区域
   */
  const renderAvatarField = () => (
    <div className={styles.formSection}>
      <h3 className={styles.sectionTitle}>头像设置</h3>

      <Form.Item field="avatar" label="头像URL">
        <Input
          placeholder="请输入头像图片URL地址（可选）"
          addBefore={
            formData.avatar ? (
              <img
                src={formData.avatar}
                alt="预览"
                style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Bot size={16} />
            )
          }
        />
      </Form.Item>

      <Text type="secondary" style={{ fontSize: '12px' }}>
        支持输入外部图片URL地址，留空则使用默认头像
      </Text>
    </div>
  );

  return (
    <Modal
      title={
        <div className={styles.modalTitle}>
          <span>{agent ? '编辑智能体' : '创建智能体'}</span>
        </div>
      }
      visible={visible}
      onCancel={onClose}
      footer={null}
      className={styles.modal}
      style={{ width: 640 }}
      maskClosable={false}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initialFormData}
        onValuesChange={handleValuesChange}
        onSubmit={handleSubmit}
        className={styles.form}
      >
        <div className={styles.formContent}>
          {renderBasicFields()}
          <Divider className={styles.divider} />
          {renderSystemPromptField()}
          {renderCapabilitiesField()}
          <Divider className={styles.divider} />
          {renderModelConfigField()}
          {renderAvatarField()}
        </div>

        {/* 底部操作按钮 */}
        <div className={styles.footer}>
          <Button onClick={onClose} size="large">
            取消
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            icon={<Save size={16} />}
            size="large"
            className={styles.saveButton}
          >
            {agent ? '保存修改' : '创建智能体'}
          </Button>
        </div>
      </Form>
    </Modal>
  );
};

export default AgentEditModal;
