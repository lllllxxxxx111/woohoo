import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useAppActions } from '../../../../../context/useAppActions';
import { useToast } from '../../../../../context/useToast';
import { useAppStore } from '../../../../../store';
import type { ExecutionMode } from '../../../../../types';

type LaunchOptions = {
  successTitle: string;
  successMessage: string;
  pendingTitle?: string;
  requireServerTask?: boolean;
};

type LaunchResult = {
  success: boolean;
  mode: ExecutionMode;
  taskId?: string;
};

export function usePipelineTaskLauncher() {
  const { isAiConfigured, setSettingsOpen, isServerWorkspaceReady } = useAppStore(
    useShallow((state) => ({
      isAiConfigured: state.isAiConfigured,
      setSettingsOpen: state.setSettingsOpen,
      isServerWorkspaceReady: state.isServerWorkspaceReady,
    })),
  );
  const { sendAiMessage } = useAppActions();
  const { showToast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * 发起流程任务
   * @param prompt 提示词内容
   * @param options 启动选项
   * @returns 包含执行模式和任务ID的结果对象
   */
  const launchTask = async (prompt: string, options: LaunchOptions): Promise<LaunchResult> => {
    if (!prompt.trim()) {
      showToast({
        type: 'warning',
        title: '任务内容为空',
        message: '请先补充要提交给后端执行的内容。',
      });
      return { success: false, mode: 'direct' };
    }

    if (!isAiConfigured) {
      showToast({
        type: 'warning',
        title: '请先配置 AI',
        message: '当前动作会创建真实任务，请先完成模型接入。',
      });
      setSettingsOpen(true);
      return { success: false, mode: 'direct' };
    }

    if (options.requireServerTask && !isServerWorkspaceReady) {
      showToast({
        type: 'error',
        title: '服务端未就绪',
        message: '当前操作要求必须通过服务端任务执行，请检查网络连接或刷新页面重试。',
      });
      return { success: false, mode: 'direct' };
    }

    setIsSubmitting(true);
    try {
      const result = await sendAiMessage(prompt, {
        requireServerTask: options.requireServerTask ?? true,
      });

      const mode = result.mode || 'task';

      let message = options.successMessage;

      if (mode === 'task') {
        message = `${options.successMessage}（任务ID: ${result.taskId?.slice(0, 8)}...）`;
      } else if (mode === 'sync') {
        message = `已提交同步请求：${options.successMessage}`;
      }

      showToast({
        type: 'success',
        title: options.successTitle,
        message,
      });

      return {
        success: true,
        mode,
        taskId: result.taskId,
      };
    } catch (error) {
      showToast({
        type: 'error',
        title: options.pendingTitle || '任务提交失败',
        message: error instanceof Error ? error.message : '后端任务创建失败',
      });
      return { success: false, mode: 'direct' };
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    launchTask,
    isSubmitting,
  };
}
