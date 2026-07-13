// Core domain types for Woohoo Studio

export interface Project {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  settings?: ProjectSettings;
}

export interface ProjectSettings {
  resolution?: { width: number; height: number };
  fps?: number;
  defaultDuration?: number;
  pipeline?: PipelineConfig;
}

export interface PipelineConfig {
  model?: string;
  style?: string;
  parameters?: Record<string, unknown>;
}

export interface Script {
  id: string;
  projectId: string;
  title: string;
  content: string;
  scenes: Scene[];
  createdAt: string;
  updatedAt: string;
}

export interface Scene {
  id: string;
  number: number;
  heading: string;
  action?: string;
  dialogue?: DialogueLine[];
  duration?: number;
}

export interface DialogueLine {
  id: string;
  character: string;
  line: string;
  parenthetical?: string;
}

export interface Storyboard {
  id: string;
  projectId: string;
  name: string;
  shots: Shot[];
  createdAt: string;
  updatedAt: string;
}

export interface Shot {
  id: string;
  number: number;
  description: string;
  keyframeIds: string[];
  cameraAngle?: string;
  duration?: number;
  notes?: string;
}

export interface Keyframe {
  id: string;
  projectId: string;
  name: string;
  assetId?: string;
  timestamp: number;
  annotations?: string;
  prompt?: string;
  createdAt: string;
}

export interface VideoPlan {
  id: string;
  projectId: string;
  name: string;
  model: string;
  resolution: { width: number; height: number };
  fps: number;
  duration: number;
  parameters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type AssetType = 'image' | 'audio' | 'video' | 'document' | 'reference';

export interface Asset {
  id: string;
  projectId: string;
  name: string;
  type: AssetType;
  url: string;
  sizeBytes?: number;
  mimeType?: string;
  sha256?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  userId: string;
  startedAt: string;
  endedAt?: string;
  changeSummary?: string;
}

// Export-related types (existing)
export type ExportType = 'full' | 'core' | 'snapshot';

export interface ExportOptions {
  includeAssets: boolean;
  includeScripts: boolean;
  includeStoryboards: boolean;
  includeKeyframes: boolean;
  includeVideoPlans: boolean;
  includeSessions: boolean;
  assetQuality?: 'original' | 'preview';
}

export interface ProjectSnapshot {
  snapshotId: string;
  projectId: string;
  capturedAt: string;
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  assetMetadata: Asset[];
}

export interface ExportResult {
  success: boolean;
  blob?: Blob;
  filename: string;
  error?: string;
  manifestHash?: string;
  stats?: {
    totalFiles: number;
    totalAssets: number;
    missingAssets: number;
    totalSizeBytes: number;
  };
}

// Preflight / validation types
export type PreflightSeverity = 'blocking' | 'warning' | 'info';

export interface PreflightIssue {
  code: string;
  severity: PreflightSeverity;
  message: string;
  entityType?: string;
  entityId?: string;
  detail?: string;
  // Legacy/aliased fields
  assetId?: string;
  field?: string;
  details?: string;
}

export interface PreflightResult {
  projectId?: string;
  checkedAt?: string;
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  canExport?: boolean;
  summary?: string;
  issues: PreflightIssue[];
  assetCount?: number;
  missingAssetCount?: number;
  totalSizeBytes?: number;
  manifestHash?: string;
}
