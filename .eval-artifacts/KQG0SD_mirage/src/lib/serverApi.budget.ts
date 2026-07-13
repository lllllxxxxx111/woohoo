export type BudgetPeriod = 'daily' | 'monthly';

export type UserBudgetSettings = {
  id: string;
  userId: string;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  warningThreshold: number; // 0.0 ~ 1.0
  blockHighCostOverBudget: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UpdateBudgetSettingsInput = {
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  warningThreshold?: number;
  blockHighCostOverBudget?: boolean;
  enabled?: boolean;
};

export type BudgetPeriodStatus = {
  periodType: BudgetPeriod;
  periodKey: string;
  limit: number | null;
  spent: number;
  usageRatio: number | null;
  isWarning: boolean;
  isOverBudget: boolean;
  remaining: number | null;
};

export type BudgetStatus = {
  settings: UserBudgetSettings;
  daily: BudgetPeriodStatus;
  monthly: BudgetPeriodStatus;
  canProceed: boolean;
  warningMessage: string | null;
  blockReason: string | null;
};

export type BudgetBlockEvent = {
  id: string;
  userId: string;
  periodType: BudgetPeriod;
  periodKey: string;
  limitAmount: number;
  currentSpent: number;
  estimatedCost: number;
  blockedOperation: string;
  blockedResourceKind: string | null;
  reason: string;
  model: string | null;
  endpointId: string | null;
  createdAt: string;
};

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

export function createBudgetApi(requestApi: RequestApi) {
  return {
    getStatus() {
      return requestApi<BudgetStatus>('/api/budget/status');
    },

    getSettings() {
      return requestApi<UserBudgetSettings>('/api/budget/settings');
    },

    updateSettings(input: UpdateBudgetSettingsInput) {
      return requestApi<UserBudgetSettings>('/api/budget/settings', {
        method: 'PUT',
        body: JSON.stringify(input),
      });
    },

    listBlockEvents(limit = 20) {
      return requestApi<BudgetBlockEvent[]>(`/api/budget/blocks?limit=${limit}`);
    },
  };
}
