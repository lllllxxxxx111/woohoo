import React, { useState } from 'react';
import { Form, Input, Button, Tabs, Space, Typography, Message } from '@arco-design/web-react';
import { User, Mail, Lock, ShieldCheck, Rocket } from 'lucide-react';
import { loginUser, registerUser } from '../../lib/serverApi';
import { useAppStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import '../../styles/arco-async';
import styles from './AuthModal.module.css';

const { Title, Text } = Typography;

/** 认证表单提交值类型定义 */
interface AuthFormValues {
  username?: string;
  email: string;
  password: string;
}

export const AuthModal: React.FC = () => {
  const { isAuthenticated, setIsAuthenticated } = useAppStore(
    useShallow((state) => ({
      isAuthenticated: state.isAuthenticated,
      setIsAuthenticated: state.setIsAuthenticated,
    })),
  );
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('login');
  const [form] = Form.useForm();

  if (isAuthenticated) return null;

  /** 处理登录/注册表单提交 */
  const handleSubmit = async (values: AuthFormValues) => {
    setLoading(true);
    try {
      if (activeTab === 'login') {
        await loginUser(values.email, values.password);
        Message.success('登录成功');
      } else {
        await registerUser(values.username ?? '', values.email, values.password);
        Message.success('注册成功');
      }
      setIsAuthenticated(true);
      // AppContext will trigger syncWorkspace which now sees isAuthenticated = true
      window.location.reload(); // Hard reload to re-run bootstrap in clean state
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.authOverlay}>
      <div className={styles.authCard}>
        <div className={styles.authHeader}>
          <div className={styles.logoIcon}>
            <Rocket size={32} color="var(--bg-accent)" />
          </div>
          <Title heading={3} style={{ margin: '16px 0 8px' }}>
            Woohoo Studio
          </Title>
          <Text type="secondary">欢迎回来，开启你的创作之旅</Text>
        </div>

        <Tabs activeTab={activeTab} onChange={setActiveTab} className={styles.tabs} justify>
          <Tabs.TabPane key="login" title="登录" />
          <Tabs.TabPane key="register" title="注册" />
        </Tabs>

        <Form form={form} layout="vertical" onSubmit={handleSubmit} className={styles.form}>
          {activeTab === 'register' && (
            <Form.Item
              label="用户名"
              field="username"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input prefix={<User size={16} />} placeholder="你的昵称" />
            </Form.Item>
          )}
          <Form.Item
            label="邮箱"
            field="email"
            rules={[{ required: true, type: 'email', message: '请输入有效的邮箱' }]}
          >
            <Input prefix={<Mail size={16} />} placeholder="email@example.com" />
          </Form.Item>
          <Form.Item
            label="密码"
            field="password"
            rules={[
              {
                required: true,
                validator: (value, callback) => {
                  if (!value || !String(value).trim()) {
                    callback('请输入密码');
                  } else if (String(value).trim().length < 6) {
                    callback('密码至少6位');
                  } else {
                    callback(null);
                  }
                },
              },
            ]}
          >
            <Input.Password prefix={<Lock size={16} />} placeholder="你的密码" />
          </Form.Item>

          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            long
            className={styles.submitBtn}
          >
            {activeTab === 'login' ? '立即登录' : '创建账号'}
          </Button>
        </Form>

        <div className={styles.authFooter}>
          <Space>
            <ShieldCheck size={14} color="var(--text-muted)" />
            <Text type="secondary" style={{ fontSize: '12px' }}>
              数据传输已通过高级加密保护
            </Text>
          </Space>
        </div>
      </div>
    </div>
  );
};
