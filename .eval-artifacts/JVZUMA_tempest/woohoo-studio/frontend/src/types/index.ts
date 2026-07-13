// Domain types for Woohoo Studio

export interface Project {
  id: string;
  name: string;
  description?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  sessions?: Session[];
  scripts?: Script[];
  storyboards?: Storyboard[];
  assets?: Asset[];
  videoPlans?: VideoPlan[];
}

export interface Session {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
}

export interface Script {
  id: string;
  projectId: string;
  sessionId?: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardScene {
  id: string;
  index: number;
  description: string;
  duration?: number;
  keyframeIds?: string[];
}

export interface Storyboard {
  id: string;
  projectId: string;
  sessionId?: string;
  title: string;
  scenes: StoryboardScene[];
  createdAt: string;
  updatedAt: string;
}

export interface Keyframe {
  id: string;
  projectId: string;
  storyboardId: string;
  assetId?: string;
  prompt: string;
  timestamp: number;
  imageUrl?: string;
}

export interface VideoPlan {
  id: string;
  projectId: string;
  sessionId?: string;
  config: VideoPlanConfig;
  createdAt: string;
}

export interface VideoPlanConfig {
  resolution: string;
  fps: number;
  duration: number;
  style?: string;
  pipeline?: string[];
  model?: string;
  seed?: number;
}

export type AssetType = 'image' | 'video' | 'audio' | 'font' | 'model' | 'other';

export interface Asset {
  id: string;
  projectId: string;
  name: string;
  type: AssetType;
  url: string;
  fileSize?: number;
  mimeType?: string;
  sourceUrl?: string;
  createdAt: string;
}

export interface ProjectSnapshot {
  id: string;
  projectId: string;
  createdAt: string;
  data: {
    project: Project;
    scripts: Script[];
    storyboards: Storyboard[];
    keyframes: Keyframe[];
    assets: Asset[];
    videoPlans: VideoPlan[];
  };
}

// === Export types (existing) ===

export type ExportType = 'full' | 'core' | 'snapshot';

export interface ExportOptions {
  includeAssets: boolean;
  includeSnapshots: boolean;
  compressAssets: boolean;
}

// === New: Export Manifest types ===

export type ManifestSchemaVersion = '1.0.0';

export interface ManifestFileEntry {
  path: string;
  kind: 'data' | 'asset' | 'document' | 'metadata';
  sizeBytes: number;
  sha256: string;
}

export interface ManifestAssetEntry {
  assetId: string;
  name: string;
  type: AssetType;
  url?: string;
  source?: string;
  packed: boolean;
  errorReason?: string;
}

export interface ExportCounts {
  files: number;
  assets: number;
  missingAssets: number;
  scripts: number;
  storyboards: number;
  keyframes: number;
  videoPlans: number;
}

export interface GenerationParams {
  resolution?: string;
  fps?: number;
  duration?: number;
  style?: string;
  model?: string;
  pipeline?: string[];
}

export interface ExportManifest {
  projectId: string;
  projectName: string;
  exportedAt: string;
  schemaVersion: ManifestSchemaVersion;
  exportType: ExportType;
  counts: ExportCounts;
  files: ManifestFileEntry[];
  assets: ManifestAssetEntry[];
  missingAssets: string[];
  generationParams: GenerationParams;
  manifestHash?: string;
}

// === New: Preflight types ===

export type PreflightSeverity = 'blocking' | 'warning' | 'info';

export interface PreflightIssue {
  severity: PreflightSeverity;
  code: string;
  message: string;
  detail?: string;
  entityType?: 'script' | 'storyboard' | 'keyframe' | 'videoPlan' | 'asset' | 'project';
  entityId?: string;
}

export interface PreflightResult {
  projectId: string;
  checkedAt: string;
  blocking: PreflightIssue[];
  warnings: PreflightIssue[];
  info: PreflightIssue[];
  allIssues: PreflightIssue[];
  canExport: boolean;
  summary: {
    blockingCount: number;
    warningCount: number;
    infoCount: number;
  };
}

// === New: Audit types ===

export interface ExportAuditLog {
  id: string;
  userId: string;
  projectId: string;
  projectName?: string;
  exportType: ExportType;
  manifestHash: string;
  assetCount: number;
  missingAssetCount: number;
  fileCount: number;
  totalSizeBytes: number;
  blockingCount: number;
  warningCount: number;
  createdAt: string;
}

export interface RecordExportAuditRequest {
  projectId: string;
  exportType: ExportType;
  manifestHash: string;
  assetCount: number;
  missingAssetCount: number;
  fileCount?: number;
  totalSizeBytes?: number;
  blockingCount?: number;
  warningCount?: number;
}

export interface ExportAuditListResponse {
  exports: ExportAuditLog[];
  total: number;
}

// === New: Workspace snapshot ===

export interface WorkspaceSnapshot {
  version: string;
  capturedAt: string;
  project: {
    id: string;
    name: string;
    description?: string;
  };
  scripts: Array<{ id: string; title: string; lineCount: number; charCount: number }>;
  storyboards: Array<{ id: string; title: string; sceneCount: number; totalKeyframes: number }>;
  assets: Array<{ id: string; name: string; type: AssetType; sizeBytes?: number }>;
  keyframes: Array<{ id: string; storyboardId: string; hasImage: boolean }>;
  videoPlans: Array<{ id: string; config: VideoPlanConfig }>;
  pipeline: {
    outputs: Array<{ stage: string; status: string; summary?: string }>;
  };
}
