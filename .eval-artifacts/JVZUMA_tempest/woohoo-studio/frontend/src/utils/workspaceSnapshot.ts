// Workspace snapshot builder — creates workspace_snapshot.json for reproducible experiment packages.
import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  WorkspaceSnapshot,
} from '../types';
import { sanitizeSnapshot } from './sanitize';

export interface SnapshotInput {
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  pipelineOutputs?: Array<{ stage: string; status: string; summary?: string }>;
}

/**
 * Build a workspace snapshot suitable for embedding in an export bundle.
 * This is a compact, sanitized representation — not the full database dump.
 */
export function buildWorkspaceSnapshot(input: SnapshotInput): WorkspaceSnapshot {
  const { project, scripts, storyboards, keyframes, videoPlans, assets, pipelineOutputs } = input;

  const snapshot: WorkspaceSnapshot = {
    version: '1.0.0',
    capturedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
    },
    scripts: scripts.map((s) => ({
      id: s.id,
      title: s.title,
      lineCount: s.content ? s.content.split('\n').length : 0,
      charCount: s.content ? s.content.length : 0,
    })),
    storyboards: storyboards.map((sb) => ({
      id: sb.id,
      title: sb.title,
      sceneCount: sb.scenes?.length ?? 0,
      totalKeyframes: sb.scenes?.reduce((n, sc) => n + (sc.keyframeIds?.length ?? 0), 0) ?? 0,
    })),
    assets: assets.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      sizeBytes: a.fileSize,
    })),
    keyframes: keyframes.map((kf) => ({
      id: kf.id,
      storyboardId: kf.storyboardId,
      hasImage: !!(kf.assetId || kf.imageUrl),
    })),
    videoPlans: videoPlans.map((vp) => ({
      id: vp.id,
      config: vp.config,
    })),
    pipeline: {
      outputs: pipelineOutputs ?? [],
    },
  };

  // Sanitize to remove any accidental sensitive fields before returning
  return sanitizeSnapshot(snapshot as unknown as Record<string, unknown>) as unknown as WorkspaceSnapshot;
}
