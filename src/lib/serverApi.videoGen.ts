export type VideoGenerationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type VideoGeneration = {
  id: string;
  prompt: string;
  model: string;
  durationSeconds?: number | null;
  aspectRatio: string;
  status: VideoGenerationStatus;
  errorMessage?: string | null;
  url?: string | null;
  b64Data?: string | null;
  costCredits: number;
  createdAt: string;
  completedAt?: string | null;
};

export type CreateVideoGenerationInput = {
  projectId?: string | null;
  endpointId?: string | null;
  prompt: string;
  model: string;
  durationSeconds?: number | null;
  aspectRatio: string;
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

type VideoGenApiDeps = {
  invalidateWorkspaceCache?: () => void;
};

/** 创建视频生成 API 客户端 */
export function createVideoGenApi(requestApi: RequestApi, deps: VideoGenApiDeps = {}) {
  return {
    /** 获取当前用户的视频生成列表 */
    listGenerations() {
      return requestApi<VideoGeneration[]>('/api/video-gen/generations');
    },

    /** 获取单个视频生成详情 */
    getGeneration(id: string) {
      return requestApi<VideoGeneration>(`/api/video-gen/generations/${id}`);
    },

    /** 创建视频生成任务（含 300s 超时） */
    async createGeneration(input: CreateVideoGenerationInput) {
      const timeout = withTimeout(300_000);
      try {
        const generation = await requestApi<VideoGeneration>('/api/video-gen/generations', {
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
  };
}
