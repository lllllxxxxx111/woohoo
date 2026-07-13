export type OpsOverview = {
  generatedAt: string;
  heartbeats: RuntimeHeartbeat[];
  activeFindings: InspectionFinding[];
  taskSnapshot: unknown;
  recentFailures: unknown[];
  notificationSummary: {
    configuredChannels: number;
    enabledChannels: number;
    queuedEvents: number;
    failedEvents: number;
  };
};

export type RuntimeHeartbeat = {
  id: string;
  timestamp: string;
  status: string;
  message?: string | null;
  metadataJson?: string | null;
};

export type InspectionFinding = {
  id: string;
  userId: string;
  findingType: string;
  severity: string;
  message: string;
  resolved: boolean;
  createdAt: string;
  resolvedAt?: string | null;
};

type RequestApi = <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>;

/** 创建运维监控 API 客户端 */
export function createOpsApi(requestApi: RequestApi) {
  return {
    /** 获取系统概览 */
    getOverview() {
      return requestApi<OpsOverview>('/api/ops/overview');
    },

    /** 获取心跳记录 */
    listHeartbeats(limit?: number) {
      const params = limit ? `?limit=${limit}` : '';
      return requestApi<RuntimeHeartbeat[]>(`/api/ops/heartbeats${params}`);
    },

    /** 获取检查发现 */
    listFindings(includeResolved?: boolean, limit?: number) {
      const params = new URLSearchParams();
      if (includeResolved) params.set('includeResolved', 'true');
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      return requestApi<InspectionFinding[]>(
        `/api/ops/findings${qs ? `?${qs}` : ''}`,
      );
    },
  };
}
