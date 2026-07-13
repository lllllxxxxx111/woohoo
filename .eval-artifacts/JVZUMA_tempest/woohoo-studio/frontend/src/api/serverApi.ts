// Server API client - wraps fetch calls to the Rust Axum backend
import type {
  Project,
  ProjectSnapshot,
  ExportAuditLog,
  ExportAuditListResponse,
  RecordExportAuditRequest,
  PreflightResult,
} from '../types';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- Projects ---

export async function getProjects(): Promise<Project[]> {
  return request<Project[]>('/projects');
}

export async function getProject(id: string): Promise<Project> {
  return request<Project>(`/projects/${id}`);
}

export async function createProject(data: Partial<Project>): Promise<Project> {
  return request<Project>('/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// --- Assets ---

export async function getAssetDownloadUrl(assetId: string): Promise<string> {
  return `${API_BASE}/assets/${assetId}/download`;
}

// --- Snapshots ---

export async function createProjectSnapshotServer(projectId: string): Promise<ProjectSnapshot> {
  return request<ProjectSnapshot>('/snapshots', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

// --- Export Audit (new) ---

export async function listExportAudits(projectId: string): Promise<ExportAuditListResponse> {
  return request<ExportAuditListResponse>(`/projects/${projectId}/exports`);
}

/** List recent exports for the current user across all projects. */
export async function listUserExportAudits(limit = 50): Promise<ExportAuditListResponse> {
  return request<ExportAuditListResponse>(`/exports/audit?limit=${limit}`);
}

export async function recordExportAudit(data: RecordExportAuditRequest): Promise<ExportAuditLog> {
  return request<ExportAuditLog>('/exports/audit', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// --- Preflight API (new, server-side validation) ---

export async function runPreflightServer(projectId: string): Promise<PreflightResult> {
  return request<PreflightResult>(`/projects/${projectId}/preflight`);
}
