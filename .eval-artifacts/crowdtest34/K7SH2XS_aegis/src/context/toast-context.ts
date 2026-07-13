import { createContext } from 'react';
import type { ToastType } from '../components/Toast/Toast';

export interface ToastContextType {
  showToast: (options: {
    type: ToastType;
    title: string;
    message?: string;
    duration?: number;
  }) => void;
  hideToast: (id: string) => void;
}

const defaultContext: ToastContextType = {
  showToast: () => {},
  hideToast: () => {},
};

export const ToastContext = createContext<ToastContextType>(defaultContext);
