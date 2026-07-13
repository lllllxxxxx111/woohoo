export type BudgetOverlimitAction = 'block' | 'warn_only';

export type UserBudgetSettings = {
  id: string;
  userId: string;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  warningThresholdPct: number;
  overlimitAction: BudgetOverlimitAction | string;
  enabled: boolean;
  lastWarningAt?: string | null;
  lastWarningKind?: string | null;
  updatedAt: string;
  createdAt: string;
};

export type BudgetEvent = {
  id: string;
  userId: string;
  kind: 'warning' | 'blocked' | string;
  window: 'daily' | 'monthly' | string;
  spentAmount: number;
  limitAmount: number | null;
  estimatedCost: number | null;
  resourceKind: string | null;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string;
};

export type BudgetSnapshot = {
  settings: UserBudgetSettings;
  dailySpent: number;
  monthlySpent: number;
  dailyUsedPct: number | null;
  monthlyUsedPct: number | null;
  dailyRemaining: number | null;
  monthlyRemaining: number | null;
  dailyExceeded: boolean;
  monthlyExceeded: boolean;
  dailyWarning: boolean;
  monthlyWarning: boolean;
};

export type UpsertBudgetSettingsInput = {
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  warningThresholdPct?: number;
  overlimitAction?: BudgetOverlimitAction;
  enabled?: boolean;
};

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

export function createBudgetApi(requestApi: RequestApi) {
  return {
    getBudget() {
      return requestApi<BudgetSnapshot>('/api/billing/budget');
    },

    updateBudget(input: UpsertBudgetSettingsInput) {
      return requestApi<UserBudgetSettings>('/api/billing/budget', {
        method: 'PUT',
        body: JSON.stringify(input),
      });
    },

    listBudgetEvents() {
      return requestApi<BudgetEvent[]>('/api/billing/budget/events');
    },
  };
}
