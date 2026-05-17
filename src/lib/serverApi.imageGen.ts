export type ImageGenerationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type ImageGeneration = {
  id: string;
  projectId?: string | null;
  prompt: string;
  model: string;
  size: string;
  n: number;
  status: ImageGenerationStatus;
  errorMessage?: string | null;
  urls: string[];
  b64Data: string[];
  assetIds: string[];
  revisedPrompt?: string | null;
  costCredits: number;
  createdAt: string;
  completedAt?: string | null;
};

export type CreateImageGenerationInput = {
  projectId: string;
  endpointId?: string | null;
  prompt: string;
  model: string;
  size: string;
  n: number;
};

export type UserCredits = {
  id: string;
  userId: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  updatedAt: string;
  createdAt: string;
};

export type CreditTransaction = {
  id: string;
  userId: string;
  amount: number;
  balanceAfter: number;
  kind: 'earned' | 'spent' | 'refund' | string;
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
  createdAt: string;
};

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => window.clearTimeout(timeoutId),
  };
}

type ImageGenApiDeps = {
  invalidateWorkspaceCache?: () => void;
};

export function createImageGenApi(requestApi: RequestApi, deps: ImageGenApiDeps = {}) {
  return {
    listGenerations() {
      return requestApi<ImageGeneration[]>('/api/image-gen/generations');
    },

    getGeneration(id: string) {
      return requestApi<ImageGeneration>(`/api/image-gen/generations/${id}`);
    },

    async createGeneration(input: CreateImageGenerationInput) {
      const timeout = withTimeout(120_000);
      try {
        const generation = await requestApi<ImageGeneration>('/api/image-gen/generations', {
          method: 'POST',
          body: JSON.stringify(input),
          signal: timeout.signal,
        });
        deps.invalidateWorkspaceCache?.();
        return generation;
      } finally {
        timeout.clear();
      }
    },

    getCredits() {
      return requestApi<UserCredits>('/api/billing/credits');
    },

    listCreditTransactions() {
      return requestApi<CreditTransaction[]>('/api/billing/transactions');
    },
  };
}
