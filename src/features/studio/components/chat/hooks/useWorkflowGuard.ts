/**
 * useWorkflowGuard - 工作流守卫（Workflow Guard）逻辑 Hook
 *
 * 管理 Workflow Guard 的确认/待确认状态，处理用户确认守卫的操作。
 */
import { useState, useMemo, useCallback } from 'react';
import type { AgentContact, Asset, Message } from '../../../../../types';
import type { SendAiMessageOptions, SendMessageResult } from '../../../../../store';
import type { ToastType } from '../../../../../components/Toast/Toast';

/** useWorkflowGuard 的参数 */
export type UseWorkflowGuardParams = {
  /** 当前活跃的消息列表 */
  activeMessages: Message[];
  /** 智能体联系人列表 */
  agentContacts: AgentContact[];
  /** 资产列表 */
  assets: Asset[];
  /** 发送 AI 消息的方法 */
  sendAiMessage: (content: string, options?: SendAiMessageOptions) => Promise<SendMessageResult>;
  /** 显示 Toast 提示的方法 */
  showToast: (options: { type: ToastType; title: string; message?: string; duration?: number }) => void;
  /** 是否在底部的 ref，与滚动逻辑共享 */
  isAtBottomRef: React.MutableRefObject<boolean>;
};

/** useWorkflowGuard 的返回值 */
export type UseWorkflowGuardResult = {
  confirmedWorkflowGuardIds: Set<string>;
  pendingWorkflowGuardIds: Set<string>;
  submittingWorkflowGuardId: string | null;
  handleWorkflowGuardConfirm: (
    messageId: string,
    suggestedReply: string,
    isAssistantActionGuard: boolean,
  ) => Promise<void>;
  handleWorkflowGuardConfirmForMessage: (
    messageId: string,
    suggestedReply: string,
    isAssistantActionGuard: boolean,
  ) => void;
  normalizeWorkflowGuardReply: (value: string) => string;
};

/**
 * 工作流守卫逻辑 Hook
 *
 * 负责计算哪些 Workflow Guard 已确认/待确认，以及处理用户确认操作。
 *
 * @param params - 包含消息、智能体、资产、发送方法等参数的对象
 * @returns 守卫状态与确认操作方法
 */
export function useWorkflowGuard(params: UseWorkflowGuardParams): UseWorkflowGuardResult {
  const { activeMessages, agentContacts, assets, sendAiMessage, showToast, isAtBottomRef } = params;

  const [submittingWorkflowGuardId, setSubmittingWorkflowGuardId] = useState<string | null>(null);

  /** 标准化 Workflow Guard 回复文本，移除资源引用和智能体提及 */
  const normalizeWorkflowGuardReply = useCallback(
    (value: string) => {
      let normalized = value
        .replace(/#([^#\n<]+?)<asset:[^>\s]+>/g, (_match, rawName: string) => `#${rawName.trim()}`)
        .trim();

      agentContacts.forEach((agent) => {
        normalized = normalized.split(`@${agent.name}`).join(' ');
      });
      assets.forEach((asset) => {
        normalized = normalized.split(`#${asset.name}`).join(' ');
      });

      return normalized.replace(/\s+/g, ' ').trim();
    },
    [agentContacts, assets],
  );

  /** 计算已确认和待确认的 Workflow Guard ID 集合 */
  const { confirmedWorkflowGuardIds, pendingWorkflowGuardIds } = useMemo(() => {
    const confirmedIds = new Set<string>();
    const pendingIds = new Set<string>();
    const messages = activeMessages;
    const pendingGuardIdsByReply = new Map<string, string[]>();
    const guardStatesById = new Map<
      string,
      {
        reopenedAtMs?: number;
        requiresServerConfirmation: boolean;
        isServerConfirmed: boolean;
      }
    >();

    /** 收集每条 AI 消息的守卫状态 */
    messages.forEach((message) => {
      if (message.role !== 'ai') {
        return;
      }
      const reopenedAt = message.meta?.workflowGuard?.reopenedAt;
      const reopenedAtMs = typeof reopenedAt === 'string' ? Date.parse(reopenedAt) : NaN;
      const assistantActions = Array.isArray(message.meta?.assistantActions)
        ? message.meta.assistantActions
        : [];
      guardStatesById.set(message.id, {
        reopenedAtMs: Number.isFinite(reopenedAtMs) ? reopenedAtMs : undefined,
        requiresServerConfirmation: assistantActions.some(
          (item) => item.status === 'needs_confirmation',
        ),
        isServerConfirmed: Boolean(message.meta?.workflowGuard?.confirmedAt),
      });
    });

    /** 判断用户消息是否在守卫重开时间之后，具备确认资格 */
    const isEligibleForCurrentGuard = (guardId: string, messageTimestamp: number) => {
      const reopenedAtMs = guardStatesById.get(guardId)?.reopenedAtMs;
      return !reopenedAtMs || messageTimestamp >= reopenedAtMs;
    };

    /** 判断用户消息是否可以确认指定守卫（考虑服务端确认要求） */
    const canUserMessageConfirmGuard = (guardId: string, messageTimestamp: number) => {
      if (!isEligibleForCurrentGuard(guardId, messageTimestamp)) {
        return false;
      }

      const guardState = guardStatesById.get(guardId);
      if (!guardState) {
        return true;
      }

      if (guardState.requiresServerConfirmation && !guardState.isServerConfirmed) {
        return false;
      }

      return true;
    };

    /** 遍历消息，匹配守卫确认关系 */
    messages.forEach((message) => {
      if (message.role === 'user') {
        const confirmedGuardId =
          typeof message.meta?.confirmedWorkflowGuardMessageId === 'string'
            ? message.meta.confirmedWorkflowGuardMessageId
            : null;
        if (message.meta?.workflowGuardConfirmPending) {
          if (confirmedGuardId && isEligibleForCurrentGuard(confirmedGuardId, message.timestamp)) {
            pendingIds.add(confirmedGuardId);
          }
          return;
        }
        if (confirmedGuardId) {
          if (!canUserMessageConfirmGuard(confirmedGuardId, message.timestamp)) {
            return;
          }
          confirmedIds.add(confirmedGuardId);
          pendingGuardIdsByReply.forEach((guardIds, reply) => {
            const filteredIds = guardIds.filter((guardId) => guardId !== confirmedGuardId);
            if (filteredIds.length > 0) {
              pendingGuardIdsByReply.set(reply, filteredIds);
            } else {
              pendingGuardIdsByReply.delete(reply);
            }
          });
          return;
        }

        const normalizedReply = normalizeWorkflowGuardReply(message.content);
        const guardIds = pendingGuardIdsByReply.get(normalizedReply);
        if (guardIds && guardIds.length > 0) {
          const matchedGuardIndex = [...guardIds]
            .map((guardId, index) => ({ guardId, index }))
            .reverse()
            .find(({ guardId }) => canUserMessageConfirmGuard(guardId, message.timestamp))?.index;
          const matchedGuardId =
            typeof matchedGuardIndex === 'number'
              ? guardIds.splice(matchedGuardIndex, 1)[0]
              : undefined;
          if (matchedGuardId) {
            confirmedIds.add(matchedGuardId);
          }
          if (guardIds.length === 0) {
            pendingGuardIdsByReply.delete(normalizedReply);
          }
        }
        return;
      }

      const workflowGuard = message.meta?.workflowGuard;
      if (workflowGuard?.confirmedAt) {
        confirmedIds.add(message.id);
        return;
      }

      const suggestedReply = workflowGuard?.suggestedReply?.trim();
      if (!suggestedReply) {
        return;
      }

      const normalizedSuggestedReply = normalizeWorkflowGuardReply(suggestedReply);
      if (!normalizedSuggestedReply) {
        return;
      }
      const guardIds = pendingGuardIdsByReply.get(normalizedSuggestedReply) ?? [];
      guardIds.push(message.id);
      pendingGuardIdsByReply.set(normalizedSuggestedReply, guardIds);
    });

    /** 从待确认集合中移除已确认的 ID */
    pendingIds.forEach((guardId) => {
      if (confirmedIds.has(guardId)) {
        pendingIds.delete(guardId);
      }
    });

    return {
      confirmedWorkflowGuardIds: confirmedIds,
      pendingWorkflowGuardIds: pendingIds,
    };
  }, [activeMessages, normalizeWorkflowGuardReply]);

  /** 处理确认 Workflow Guard */
  const handleWorkflowGuardConfirm = useCallback(
    async (messageId: string, suggestedReply: string, isAssistantActionGuard: boolean) => {
      if (!suggestedReply.trim()) {
        return;
      }

      setSubmittingWorkflowGuardId(messageId);
      try {
        await sendAiMessage(suggestedReply, {
          allowAssistantActions: isAssistantActionGuard || undefined,
          confirmedAssistantMessageId: isAssistantActionGuard ? messageId : undefined,
          confirmedWorkflowGuardMessageId: messageId,
        });
        isAtBottomRef.current = true;
      } catch (error) {
        showToast({
          type: 'error',
          title: '确认失败',
          message: error instanceof Error ? error.message : '无法继续当前流程',
        });
      } finally {
        setSubmittingWorkflowGuardId(null);
      }
    },
    [sendAiMessage, showToast, isAtBottomRef],
  );

  /** 确认 Workflow Guard 的包装回调，供列表项组件调用 */
  const handleWorkflowGuardConfirmForMessage = useCallback(
    (messageId: string, suggestedReply: string, isAssistantActionGuard: boolean) => {
      void handleWorkflowGuardConfirm(messageId, suggestedReply, isAssistantActionGuard);
    },
    [handleWorkflowGuardConfirm],
  );

  return {
    confirmedWorkflowGuardIds,
    pendingWorkflowGuardIds,
    submittingWorkflowGuardId,
    handleWorkflowGuardConfirm,
    handleWorkflowGuardConfirmForMessage,
    normalizeWorkflowGuardReply,
  };
}
