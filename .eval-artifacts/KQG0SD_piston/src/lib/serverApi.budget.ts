export type BudgetCheckLevel = 'ok' | 'warning' | 'blocked';

export type BudgetSettings = {
  id: string;
  userId: string;
  dailyLimit: number;
  monthlyLimit: number;
  warnThreshold: number;
  blockHighCostOnly: boolean;
  highCostThreshold: number;
  enabled: boolean;
  updatedAt: string;
  createdAt: string;
};

export type UpdateBudgetSettingsInput = {
  dailyLimit?: number;
  monthlyLimit?: number;
  warnThreshold?: number;
  blockHighCostOnly?: boolean;
  highCostThreshold?: number;
  enabled?: boolean;
};

export type BudgetWindowStatus = {
  window: 'daily' | 'monthly';
  limit: number;
  spent: number;
  remaining: number;
  usageRatio: number;
  hasLimit: boolean;
};

export type BudgetBlockEvent = {
  id: string;
  userId: string;
  windowType: 'daily' | 'monthly' | string;
  limitAmount: number;
  currentSpent: number;
  estimatedCost: number;
  taskType: 'chat' | 'stream' | 'task' | 'image_generation' | 'video_generation' | string;
  reason: string;
  model?: string | null;
  projectId?: string | null;
  createdAt: string;
};

export type BudgetStatus = {
  settings: BudgetSettings;
  daily: BudgetWindowStatus;
  monthly: BudgetWindowStatus;
  level: BudgetCheckLevel;
  warnings: string[];
  recentBlocks: BudgetBlockEvent[];
};

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

export function createBudgetApi(requestApi: RequestApi) {
  return {
    getStatus() {
      return requestApi<BudgetStatus>('/api/billing/budget');
    },

    updateSettings(input: UpdateBudgetSettingsInput) {
      return requestApi<BudgetSettings>('/api/billing/budget', {
        method: 'PUT',
        body: JSON.stringify(input),
      });
    },

    listBlocks() {
      return requestApi<BudgetBlockEvent[]>('/api/billing/budget/blocks');
    },
  };
}
