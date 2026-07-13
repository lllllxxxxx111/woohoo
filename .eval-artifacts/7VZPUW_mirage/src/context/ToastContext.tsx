import React, { useState, type ReactNode, useCallback } from 'react';
import { Toast, ToastType } from '../components/Toast/Toast';
import styles from '../components/Toast/Toast.module.css';
import { ToastContext } from './toast-context';

interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  /**
   * 显示一个新的Toast提示
   * @param options Toast配置选项，包括类型、标题、消息和显示时长
   */
  const showToast = useCallback(
    ({
      type,
      title,
      message,
      duration = 5000,
    }: {
      type: ToastType;
      title: string;
      message?: string;
      duration?: number;
    }) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      const newToast: ToastItem = {
        id,
        type,
        title,
        message,
        duration,
      };
      setToasts((prev) => [...prev, newToast]);
    },
    [],
  );

  /**
   * 隐藏指定的Toast提示
   * @param id 要隐藏的Toast的唯一标识符
   */
  const hideToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, hideToast }}>
      {children}
      <div className={styles.toastContainer}>
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            id={toast.id}
            type={toast.type}
            title={toast.title}
            message={toast.message}
            duration={toast.duration}
            onClose={hideToast}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
};
