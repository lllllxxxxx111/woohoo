// serverApi - Axios-based API client for Woohoo Studio backend

import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  ProjectSnapshot,
  ExportAuditLog,
} from '../types';

interface ExportListResponse {
  exports: ExportAuditLog[];
  total: number;
}

const API_BASE = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!resp.ok) {
    throw new Error(`API ${options.method || 'GET'} ${path} failed: ${resp.status}`);
  }
  return resp.json();
}

// Projects
export const projectsApi = {
  list: () => request<Project[]>('/projects'),
  get: (id: string) => request<Project & {
    scripts: Script[];
    storyboards: Storyboard[];
    keyframes: Keyframe[];
    videoPlans: VideoPlan[];
    assets: Asset[];
  }>(`/projects/${id}`),
  create: (data: Partial<Project>) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Project>) =>
    request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  snapshot: (id: string) => request<ProjectSnapshot>(`/projects/${id}/snapshot`, { method: 'POST' }),
};

// Assets
export const assetsApi = {
  list: (projectId: string) => request<Asset[]>(`/projects/${projectId}/assets`),
  downloadUrl: (assetId: string) => `${API_BASE}/assets/${assetId}/download`,
  upload: (formData: FormData) =>
    request<Asset>('/assets/upload', { method: 'POST', body: formData as unknown as BodyInit, headers: {} }),
};

// Export Audit (NEW)
export const exportAuditApi = {
  record: (entry: Omit<ExportAuditLog, 'id' | 'createdAt'>) =>
    request<ExportAuditLog>('/exports/audit', { method: 'POST', body: JSON.stringify(entry) }),
  listByProject: (projectId: string) =>
    request<ExportListResponse>(`/projects/${projectId}/exports`).then(r => r.exports),
  listRecent: (limit = 20) =>
    request<ExportListResponse>(`/exports/audit?limit=${limit}`).then(r => r.exports),
};

export const serverApi = {
  projects: projectsApi,
  assets: assetsApi,
  exportAudit: exportAuditApi,
};
