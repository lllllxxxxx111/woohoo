import type {
  Project, Script, Storyboard, Keyframe, VideoPlan, Asset, Session,
} from '../types';

const API_BASE = '/api';

// Read a pseudo-user-id for audit attribution (in a real app this would be a
// JWT claim extracted by an auth middleware). Falls back to "anonymous".
function getUserId(): string {
  try {
    return (
      localStorage.getItem('woohoo.userId') ||
      localStorage.getItem('userId') ||
      'anonymous'
    );
  } catch {
    return 'anonymous';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': getUserId(),
    ...(options?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

// Projects
export const getProjects = () => request<Project[]>('/projects');
export const getProject = (id: string) => request<Project>(`/projects/${id}`);
export const createProject = (data: Partial<Project>) =>
  request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) });
export const updateProject = (id: string, data: Partial<Project>) =>
  request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteProject = (id: string) =>
  request<void>(`/projects/${id}`, { method: 'DELETE' });

// Scripts
export const getScripts = (projectId: string) =>
  request<Script[]>(`/projects/${projectId}/scripts`);
export const createScript = (projectId: string, data: Partial<Script>) =>
  request<Script>(`/projects/${projectId}/scripts`, { method: 'POST', body: JSON.stringify(data) });

// Storyboards
export const getStoryboards = (projectId: string) =>
  request<Storyboard[]>(`/projects/${projectId}/storyboards`);

// Keyframes
export const getKeyframes = (projectId: string) =>
  request<Keyframe[]>(`/projects/${projectId}/keyframes`);

// Video plans
export const getVideoPlans = (projectId: string) =>
  request<VideoPlan[]>(`/projects/${projectId}/video-plans`);

// Assets
export const getAssets = (projectId: string) =>
  request<Asset[]>(`/projects/${projectId}/assets`);
export const uploadAsset = (projectId: string, formData: FormData) =>
  request<Asset>(`/projects/${projectId}/assets`, { method: 'POST', body: formData });
export const getAssetDownloadUrl = (assetId: string) =>
  `${API_BASE}/assets/${assetId}/download`;

export async function downloadAssetBlob(assetId: string): Promise<Blob> {
  const res = await fetch(getAssetDownloadUrl(assetId));
  if (!res.ok) throw new Error(`Failed to download asset ${assetId}: ${res.status}`);
  return res.blob();
}

// Sessions
export const getSessions = (projectId: string) =>
  request<Session[]>(`/projects/${projectId}/sessions`);

// Export audit (new)
export interface ExportAuditRecord {
  id: string;
  userId: string;
  projectId: string;
  exportType: string;
  manifestHash: string;
  assetCount: number;
  missingAssetCount: number;
  totalSizeBytes: number;
  createdAt: string;
}

export const getExportAuditLogs = (projectId: string) =>
  request<ExportAuditRecord[]>(`/projects/${projectId}/exports`);

export const recordExportAudit = (data: {
  projectId: string;
  exportType: string;
  manifestHash: string;
  assetCount: number;
  missingAssetCount: number;
  totalSizeBytes: number;
}) =>
  request<ExportAuditRecord>('/exports/audit', { method: 'POST', body: JSON.stringify(data) });
