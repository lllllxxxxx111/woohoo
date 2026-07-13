import React, { useCallback, useEffect, useState } from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import styles from './Toast.module.css';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastProps {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  onClose: (id: string) => void;
}

export const Toast: React.FC<ToastProps> = ({
  id,
  type,
  title,
  message,
  duration = 5000,
  onClose,
}) => {
  const [isRemoving, setIsRemoving] = useState(false);

  /**
   * 根据Toast类型获取对应的图标组件
   * @returns 对应的Lucide图标组件
   */
  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle size={24} />;
      case 'error':
        return <AlertCircle size={24} />;
      case 'warning':
        return <AlertTriangle size={24} />;
      case 'info':
        return <Info size={24} />;
      default:
        return <Info size={24} />;
    }
  };

  /**
   * 处理Toast关闭动画，先设置移除状态，动画完成后调用onClose
   */
  const handleClose = useCallback(() => {
    setIsRemoving(true);
    setTimeout(() => {
      onClose(id);
    }, 300);
  }, [id, onClose]);

  /**
   * 自动关闭计时器，根据duration设置自动关闭
   */
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        handleClose();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, handleClose]);

  return (
    <div className={`${styles.toast} ${styles[type]} ${isRemoving ? styles.removing : ''}`}>
      <div className={styles.icon}>{getIcon()}</div>
      <div className={styles.content}>
        <h4 className={styles.title}>{title}</h4>
        {message && <p className={styles.message}>{message}</p>}
      </div>
      <button className={styles.closeButton} onClick={handleClose} aria-label="关闭提示">
        <X size={18} />
      </button>
      {duration > 0 && (
        <div className={styles.progressBar} style={{ animationDuration: `${duration}ms` }} />
      )}
    </div>
  );
};
