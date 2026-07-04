export type BudgetLevel = 'ok' | 'warning' | 'blocked';
export type BudgetWindowType = 'daily' | 'monthly';

export type BudgetSettings = {
  id: string;
  userId: string;
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  warningThreshold: number;
  blockHighCostOnly: boolean;
  highCostThreshold: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BudgetWindowStatus = {
  windowType: BudgetWindowType;
  limit?: number | null;
  spent: number;
  remaining?: number | null;
  percentUsed?: number | null;
  warning: boolean;
  blocked: boolean;
  windowStart: string;
  windowEnd: string;
};

export type BudgetBlockEvent = {
  id: string;
  userId: string;
  windowType: BudgetWindowType | string;
  limitAmount: number;
  spentAmount: number;
  estimatedCost: number;
  taskType: string;
  reason: string;
  model?: string | null;
  projectId?: string | null;
  createdAt: string;
};

export type BudgetStatus = {
  settings: BudgetSettings;
  daily: BudgetWindowStatus;
  monthly: BudgetWindowStatus;
  overallLevel: BudgetLevel;
  warnings: string[];
  recentBlocks: BudgetBlockEvent[];
};

export type UpdateBudgetSettingsInput = {
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  warningThreshold: number;
  blockHighCostOnly: boolean;
  highCostThreshold: number;
  enabled: boolean;
};

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

export const BUDGET_REFRESH_EVENT = 'woohoo:budget-refresh';

export function notifyBudgetChanged() {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new Event(BUDGET_REFRESH_EVENT));
}

export function createBudgetApi(requestApi: RequestApi) {
  const getBudgetStatus = () => requestApi<BudgetStatus>('/api/billing/budget');

  const updateBudgetSettings = async (input: UpdateBudgetSettingsInput) => {
    const settings = await requestApi<BudgetSettings>('/api/billing/budget', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    notifyBudgetChanged();
    return settings;
  };

  const listBudgetBlocks = (limit = 50) => {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    return requestApi<BudgetBlockEvent[]>(`/api/billing/budget/blocks?limit=${safeLimit}`);
  };

  return {
    getBudgetStatus,
    updateBudgetSettings,
    listBudgetBlocks,
  };
}
