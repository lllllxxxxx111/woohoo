// Core domain types for Woohoo Studio

export interface Project {
  id: string;
  name: string;
  description?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  settings?: Record<string, unknown>;
}

export interface Script {
  id: string;
  projectId: string;
  sceneIndex: number;
  title?: string;
  content: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Storyboard {
  id: string;
  projectId: string;
  sceneId: string;
  order: number;
  title?: string;
  description?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Keyframe {
  id: string;
  projectId: string;
  storyboardId: string;
  order: number;
  imageUrl?: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
  notes?: string;
  createdAt: string;
}

export interface VideoPlan {
  id: string;
  projectId: string;
  name?: string;
  settings: {
    resolution?: string;
    fps?: number;
    duration?: number;
    style?: string;
    [key: string]: unknown;
  };
  timelineJson?: string;
  createdAt: string;
  updatedAt: string;
}

export type AssetType = 'image' | 'video' | 'audio' | 'document' | 'other';

export interface Asset {
  id: string;
  projectId: string;
  name: string;
  type: AssetType;
  url: string;
  sizeBytes?: number;
  hash?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  uploadedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
}

export interface ProjectSnapshot {
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  snapshotAt: string;
  version: string;
}

// Export-related types (existing)
export type ExportType = 'full' | 'core';

export interface ExportOptions {
  includeAssets: boolean;
  includeKeyframes: boolean;
  includeVideoPlans: boolean;
  compressImages?: boolean;
}

// New types for integrity/audit feature

export type PreflightSeverity = 'blocking' | 'warning' | 'info';

export interface PreflightIssue {
  severity: PreflightSeverity;
  category: 'script' | 'storyboard' | 'keyframe' | 'video_plan' | 'asset' | 'filename' | 'general';
  message: string;
  entityId?: string;
  entityName?: string;
  details?: Record<string, unknown>;
}

export interface PreflightResult {
  passed: boolean;
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  issues: PreflightIssue[];
  checkedAt: string;
}

export interface FileEntry {
  path: string;
  kind: 'data' | 'asset' | 'document' | 'meta';
  sizeBytes: number;
  sha256: string;
}

export interface AssetEntry {
  assetId: string;
  name: string;
  type: AssetType;
  source: string;
  packedInBundle: boolean;
  bundlePath?: string;
  sizeBytes?: number;
  sha256?: string;
  failureReason?: string;
}

export interface ExportManifest {
  schemaVersion: string;
  projectId: string;
  projectName: string;
  exportedAt: string;
  exportType: ExportType;
  exportOptions: ExportOptions;
  counts: {
    scripts: number;
    storyboards: number;
    keyframes: number;
    videoPlans: number;
    assets: number;
    files: number;
  };
  files: FileEntry[];
  assets: AssetEntry[];
  missingAssets: string[];
  parameterSummary?: Record<string, unknown>;
  generator: {
    name: string;
    version: string;
  };
}

export interface ExportAuditLog {
  id: string;
  userId: string;
  projectId: string;
  exportType: ExportType;
  manifestHash: string;
  assetCount: number;
  missingAssetCount: number;
  fileCount: number;
  totalSizeBytes: number;
  blockingIssuesOverride?: boolean;
  createdAt: string;
}

export interface ExportResult {
  success: boolean;
  manifest: ExportManifest;
  manifestHash: string;
  bundleBlob?: Blob;
  bundleFilename: string;
  packedAssetCount: number;
  missingAssetCount: number;
  preflight: PreflightResult;
}
