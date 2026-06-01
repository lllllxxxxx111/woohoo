export type ActionProjectScope = 'current_only' | 'user_projects' | 'all_accessible';

export type AssistantActionPolicy = {
  enabled: boolean;
  allowedActionTypes: string[];
  maxActionsPerResponse: number;
  projectScope: ActionProjectScope;
  expiresAt?: string | null;
  requireConfirmationFor: string[];
};

export type AssistantActionAudit = {
  id: string;
  userId: string;
  projectId: string;
  conversationId: string;
  messageId: string;
  actionType: string;
  actionPayloadJson: string;
  executionStatus: string;
  errorMessage?: string | null;
  envelopeHash: string;
  confirmationToken?: string | null;
  confirmationExpiresAt?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConfirmationToken = {
  token: string;
  userId: string;
  projectId: string;
  conversationId: string;
  messageId: string;
  envelopeHash: string;
  createdAt: string;
  expiresAt: string;
  consumed: boolean;
  consumedAt?: string | null;
  consumedBy?: string | null;
};

export type ConsumeTokenInput = {
  token: string;
  approved: boolean;
  reason?: string | null;
};

export type AuditLogFilter = {
  projectId?: string;
  actionType?: string;
  executionStatus?: string;
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
};

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

/** 创建助理动作策略 API 客户端 */
export function createPolicyApi(requestApi: RequestApi) {
  return {
    /** 获取当前用户的助理动作策略 */
    getPolicy() {
      return requestApi<AssistantActionPolicy>('/api/ai/policy');
    },

    /** 更新助理动作策略 */
    updatePolicy(policy: AssistantActionPolicy) {
      return requestApi<AssistantActionPolicy>('/api/ai/policy', {
        method: 'PUT',
        body: JSON.stringify(policy),
      });
    },

    /** 查询审计日志 */
    listAudits(filter?: AuditLogFilter) {
      const params = new URLSearchParams();
      if (filter?.projectId) params.set('projectId', filter.projectId);
      if (filter?.actionType) params.set('actionType', filter.actionType);
      if (filter?.executionStatus) params.set('executionStatus', filter.executionStatus);
      if (filter?.limit) params.set('limit', String(filter.limit));
      if (filter?.offset) params.set('offset', String(filter.offset));
      if (filter?.since) params.set('since', filter.since);
      if (filter?.until) params.set('until', filter.until);
      const qs = params.toString();
      return requestApi<AssistantActionAudit[]>(
        `/api/ai/action-audits${qs ? `?${qs}` : ''}`,
      );
    },

    /** 为审计记录创建确认令牌 */
    createConfirmationToken(auditId: string) {
      return requestApi<ConfirmationToken>(
        `/api/ai/action-audits/${auditId}/confirm-token`,
        { method: 'POST' },
      );
    },

    /** 消费确认令牌（批准或拒绝动作） */
    consumeConfirmationToken(input: ConsumeTokenInput) {
      return requestApi<{ auditId: string; approved: boolean; processedAt: string }>(
        '/api/ai/action-audits/consume-token',
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      );
    },
  };
}
