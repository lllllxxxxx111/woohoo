// Pre-export validation: scans project state for blocking, warning, and info issues
// before an export is allowed to proceed.

import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  Shot,
} from '../types';

export type PreflightSeverity = 'blocking' | 'warning' | 'info';

export interface PreflightIssue {
  severity: PreflightSeverity;
  code: string;
  message: string;
  entityType?: string;
  entityId?: string;
  detail?: string;
}

export interface PreflightResult {
  issues: PreflightIssue[];
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  canExport: boolean;
  summary: string;
}

interface PreflightInput {
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
}

/**
 * Heuristic "download check": classify an asset URL as broken if it is empty,
 * clearly malformed, or if we can synchronously flag obviously bad status from
 * a previously recorded error marker in metadata. A true network check is not
 * performed here — callers should augment with actual HEAD results if desired.
 */
function assetUrlLooksBroken(asset: Asset): boolean {
  if (!asset.url) return true;
  const trimmed = asset.url.trim();
  if (trimmed.length === 0) return true;
  // Require http(s) protocol or an api-relative path starting with '/'.
  if (/^(https?:)?\/\//.test(trimmed)) return false;
  if (trimmed.startsWith('/')) return false;
  // Any other shape (e.g. 'file:', 'data:' with no length, random garbage) is suspect.
  return true;
}

export function runPreflightChecks(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[],
): PreflightResult {
  const issues: PreflightIssue[] = [];

  // ---- BLOCKING ----

  if (scripts.length === 0) {
    issues.push({
      severity: 'blocking',
      code: 'NO_SCRIPTS',
      message: 'Project has no scripts. At least one script is required to export.',
      entityType: 'project',
      entityId: project.id,
    });
  }

  if (storyboards.length === 0) {
    issues.push({
      severity: 'blocking',
      code: 'NO_STORYBOARDS',
      message: 'Project has no storyboards. At least one storyboard is required to export.',
      entityType: 'project',
      entityId: project.id,
    });
  }

  for (const asset of assets) {
    if (!asset.url || asset.url.trim().length === 0) {
      issues.push({
        severity: 'blocking',
        code: 'ASSET_URL_EMPTY',
        message: `Asset "${asset.name}" has no source URL.`,
        entityType: 'asset',
        entityId: asset.id,
      });
    } else if (assetUrlLooksBroken(asset)) {
      issues.push({
        severity: 'blocking',
        code: 'ASSET_URL_INVALID',
        message: `Asset "${asset.name}" has an invalid URL (${asset.url}).`,
        entityType: 'asset',
        entityId: asset.id,
        detail: 'Expected http(s):// or an absolute server path starting with /.',
      });
    }

    // Simulated 4xx/5xx check: if metadata flags a previous download failure, block.
    const meta = asset.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.lastHttpStatus === 'number') {
      const status = meta.lastHttpStatus as number;
      if (status >= 400 && status < 600) {
        issues.push({
          severity: 'blocking',
          code: 'ASSET_DOWNLOAD_FAILED',
          message: `Asset "${asset.name}" download previously returned HTTP ${status}.`,
          entityType: 'asset',
          entityId: asset.id,
          detail: String(status),
        });
      }
    }
  }

  // ---- WARNING ----

  for (const script of scripts) {
    if (!script.content || script.content.trim().length === 0) {
      issues.push({
        severity: 'warning',
        code: 'SCRIPT_EMPTY',
        message: `Script "${script.title}" has empty content.`,
        entityType: 'script',
        entityId: script.id,
      });
    }
  }

  for (const sb of storyboards) {
    const shots: Shot[] = sb.shots ?? [];
    for (const shot of shots) {
      if (!shot.keyframeIds || shot.keyframeIds.length === 0) {
        issues.push({
          severity: 'warning',
          code: 'SHOT_NO_KEYFRAMES',
          message: `Shot #${shot.number} in storyboard "${sb.name}" has no keyframes.`,
          entityType: 'shot',
          entityId: shot.id,
        });
      }
    }
  }

  // Duplicate asset filenames (case-insensitive).
  const nameCounts = new Map<string, string[]>();
  for (const a of assets) {
    const key = a.name.toLowerCase();
    const list = nameCounts.get(key) ?? [];
    list.push(a.id);
    nameCounts.set(key, list);
  }
  for (const [name, ids] of nameCounts) {
    if (ids.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'DUPLICATE_ASSET_NAME',
        message: `Multiple assets share the filename "${name}" (${ids.length} occurrences).`,
        entityType: 'asset',
        entityId: ids.join(','),
      });
    }
  }

  // Keyframes referencing non-existent asset IDs.
  const assetIds = new Set(assets.map((a) => a.id));
  for (const kf of keyframes) {
    if (kf.assetId && !assetIds.has(kf.assetId)) {
      issues.push({
        severity: 'warning',
        code: 'KEYFRAME_MISSING_ASSET',
        message: `Keyframe "${kf.name}" references asset "${kf.assetId}" which does not exist.`,
        entityType: 'keyframe',
        entityId: kf.id,
        detail: kf.assetId,
      });
    }
  }

  // Video plans with no model specified.
  for (const vp of videoPlans) {
    if (!vp.model || vp.model.trim().length === 0) {
      issues.push({
        severity: 'warning',
        code: 'VIDEO_PLAN_NO_MODEL',
        message: `Video plan "${vp.name}" has no model specified.`,
        entityType: 'videoPlan',
        entityId: vp.id,
      });
    }
  }

  // ---- INFO ----

  if (!project.description || project.description.trim().length === 0) {
    issues.push({
      severity: 'info',
      code: 'PROJECT_NO_DESCRIPTION',
      message: 'Project has no description.',
      entityType: 'project',
      entityId: project.id,
    });
  }

  for (const asset of assets) {
    if (!asset.sha256) {
      issues.push({
        severity: 'info',
        code: 'ASSET_NO_SHA256',
        message: `Asset "${asset.name}" has no recorded SHA-256; integrity will be computed at export.`,
        entityType: 'asset',
        entityId: asset.id,
      });
    }
  }

  if (videoPlans.length === 0) {
    issues.push({
      severity: 'info',
      code: 'NO_VIDEO_PLANS',
      message: 'No video plans configured.',
      entityType: 'project',
      entityId: project.id,
    });
  }

  const blockingCount = issues.filter((i) => i.severity === 'blocking').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;
  const canExport = blockingCount === 0;

  const summary =
    blockingCount > 0
      ? `Export blocked: ${blockingCount} blocking issue(s), ${warningCount} warning(s), ${infoCount} info item(s).`
      : warningCount > 0
        ? `Ready to export with ${warningCount} warning(s) and ${infoCount} info item(s).`
        : `Ready to export. ${infoCount} info item(s).`;

  return {
    issues,
    blockingCount,
    warningCount,
    infoCount,
    canExport,
    summary,
  };
}
