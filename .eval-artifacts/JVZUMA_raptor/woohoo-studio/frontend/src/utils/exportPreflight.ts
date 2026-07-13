// Pre-export validation (preflight checks)
// Checks project state before export and reports issues at three levels:
//   blocking  - must be resolved or explicitly acknowledged before export
//   warning   - should be reviewed but won't prevent export
//   info      - informational messages about the export
//
// runPreflightChecks()        - synchronous checks (fast, no network)
// runPreflightChecksWithProbe() - async checks including asset URL reachability probes

import type {
  Project, Script, Storyboard, Keyframe, VideoPlan, Asset, ExportOptions,
} from '../types';
import { detectDuplicateFilenames } from '../assets/handlers';
import type { PreflightIssue, PreflightSeverity } from '../stores/exportStore';

export interface PreflightContext {
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
  options: ExportOptions;
}

export interface PreflightResult {
  issues: PreflightIssue[];
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  canProceed: boolean; // true if no blocking issues
}

/** Maximum time to wait for an asset reachability probe (ms) */
const ASSET_PROBE_TIMEOUT_MS = 5000;

/**
 * Run synchronous preflight checks. Always runs first — fast, no network.
 */
export function runPreflightChecks(ctx: PreflightContext): PreflightResult {
  const issues: PreflightIssue[] = [];

  // --- PROJECT LEVEL ---
  if (!ctx.project.name || ctx.project.name.trim() === '') {
    issues.push(issue('blocking', 'project', 'Project has no name', 'Set a project name before exporting.', ctx.project.id));
  }

  // --- SCRIPTS ---
  if (ctx.options.includeScripts) {
    if (ctx.scripts.length === 0) {
      issues.push(issue('info', 'scripts', 'No scripts in project', 'The export will contain no script data.'));
    }
    for (const script of ctx.scripts) {
      if (!script.title || script.title.trim() === '') {
        issues.push(issue('warning', 'scripts', `Script (${script.id.substring(0, 8)}...) has no title`, 'Consider titling your script for clarity.', script.id));
      }
      if (!script.content || script.content.trim() === '') {
        issues.push(issue('warning', 'scripts', `Script "${script.title || '(untitled)'}" is empty`, `Script ID: ${script.id}`, script.id));
      }
      if (!script.scenes || script.scenes.length === 0) {
        issues.push(issue('info', 'scripts', `Script "${script.title || '(untitled)'}" has no scenes`, `Script ID: ${script.id}`, script.id));
      }
      for (const scene of script.scenes) {
        if (!scene.heading || scene.heading.trim() === '') {
          issues.push(issue('warning', 'scripts', `Scene #${scene.number} in "${script.title || '(untitled)'}" has no heading`, undefined, scene.id));
        }
        // Check for empty dialogue lines
        if (scene.dialogue && scene.dialogue.length > 0) {
          for (const dl of scene.dialogue) {
            if (!dl.character || dl.character.trim() === '') {
              issues.push(issue('warning', 'scripts', `Scene #${scene.number} has dialogue without a character name`, undefined, scene.id));
              break;
            }
            if (!dl.line || dl.line.trim() === '') {
              issues.push(issue('info', 'scripts', `Scene #${scene.number} has an empty dialogue line for "${dl.character || '(unknown)'}"`, undefined, scene.id));
            }
          }
        }
      }
    }
  }

  // --- STORYBOARDS ---
  if (ctx.options.includeStoryboards) {
    if (ctx.storyboards.length === 0) {
      issues.push(issue('info', 'storyboards', 'No storyboards in project', 'The export will contain no storyboard data.'));
    }
    for (const sb of ctx.storyboards) {
      if (!sb.name || sb.name.trim() === '') {
        issues.push(issue('warning', 'storyboards', `Storyboard (${sb.id.substring(0, 8)}...) has no name`, 'Consider naming your storyboard.', sb.id));
      }
      if (!sb.shots || sb.shots.length === 0) {
        issues.push(issue('warning', 'storyboards', `Storyboard "${sb.name || '(untitled)'}" has no shots`, `Storyboard ID: ${sb.id}`, sb.id));
      }
      for (const shot of sb.shots) {
        if (!shot.description || shot.description.trim() === '') {
          issues.push(issue('warning', 'storyboards', `Shot #${shot.number} in "${sb.name || '(untitled)'}" has no description`, undefined, shot.id));
        }
        if (shot.duration !== undefined && shot.duration <= 0) {
          issues.push(issue('info', 'storyboards', `Shot #${shot.number} in "${sb.name || '(untitled)'}" has zero or negative duration`, undefined, shot.id));
        }
        // Check for keyframe references that don't exist
        if (shot.keyframeIds && shot.keyframeIds.length > 0 && ctx.options.includeKeyframes) {
          const kfIds = new Set(ctx.keyframes.map((k) => k.id));
          for (const kfId of shot.keyframeIds) {
            if (!kfIds.has(kfId)) {
              issues.push(issue('warning', 'storyboards', `Shot #${shot.number} references missing keyframe ${kfId.substring(0, 8)}...`, undefined, shot.id));
            }
          }
        }
      }
    }
  }

  // --- KEYFRAMES ---
  if (ctx.options.includeKeyframes) {
    if (ctx.keyframes.length === 0) {
      issues.push(issue('info', 'keyframes', 'No keyframes in project', 'The export will contain no keyframe data.'));
    }
    for (const kf of ctx.keyframes) {
      if (!kf.name || kf.name.trim() === '') {
        issues.push(issue('warning', 'keyframes', `Keyframe (${kf.id.substring(0, 8)}...) has no name`, undefined, kf.id));
      }
      if (!kf.assetId) {
        issues.push(issue('warning', 'keyframes', `Keyframe "${kf.name || '(untitled)'}" has no associated asset`, `Keyframe ID: ${kf.id}`, kf.id));
      } else {
        // Check if referenced asset exists
        const assetExists = ctx.assets.some((a) => a.id === kf.assetId);
        if (!assetExists) {
          issues.push(issue('blocking', 'keyframes', `Keyframe "${kf.name || '(untitled)'}" references asset ${kf.assetId.substring(0, 8)}... that does not exist`, 'The asset may have been deleted. Remove the reference or re-upload the asset.', kf.id));
        }
      }
    }
  }

  // --- VIDEO PLANS ---
  if (ctx.options.includeVideoPlans) {
    if (ctx.videoPlans.length === 0) {
      issues.push(issue('info', 'videoPlans', 'No video plans in project', 'The export will contain no video plan data.'));
    }
    for (const vp of ctx.videoPlans) {
      if (!vp.name || vp.name.trim() === '') {
        issues.push(issue('warning', 'videoPlans', `Video plan (${vp.id.substring(0, 8)}...) has no name`, undefined, vp.id));
      }
      if (!vp.model || vp.model.trim() === '') {
        issues.push(issue('warning', 'videoPlans', `Video plan "${vp.name || '(untitled)'}" has no model specified`, `Video plan ID: ${vp.id}`, vp.id));
      }
      if (!vp.resolution || vp.resolution.width <= 0 || vp.resolution.height <= 0) {
        issues.push(issue('warning', 'videoPlans', `Video plan "${vp.name || '(untitled)'}" has invalid resolution`, undefined, vp.id));
      }
      if (vp.fps <= 0) {
        issues.push(issue('warning', 'videoPlans', `Video plan "${vp.name || '(untitled)'}" has invalid FPS (${vp.fps})`, undefined, vp.id));
      }
      if (vp.duration <= 0) {
        issues.push(issue('warning', 'videoPlans', `Video plan "${vp.name || '(untitled)'}" has invalid duration (${vp.duration}s)`, undefined, vp.id));
      }
      // Warn if parameters object is empty or missing
      if (!vp.parameters || Object.keys(vp.parameters).length === 0) {
        issues.push(issue('info', 'videoPlans', `Video plan "${vp.name || '(untitled)'}" has no generation parameters`, undefined, vp.id));
      }
    }
  }

  // --- ASSETS ---
  if (ctx.options.includeAssets) {
    if (ctx.assets.length === 0) {
      issues.push(issue('info', 'assets', 'No assets in project', 'The export will contain no asset files.'));
    }

    // Build a set of asset IDs referenced by keyframes for cross-reference
    const referencedAssetIds = new Set<string>();
    for (const kf of ctx.keyframes) {
      if (kf.assetId) referencedAssetIds.add(kf.assetId);
    }

    for (const asset of ctx.assets) {
      // Empty URL → blocking
      if (!asset.url || asset.url.trim() === '') {
        issues.push(issue('blocking', 'assets', `Asset "${asset.name || '(unnamed)'}" has no URL/source`, 'Download will fail. Re-upload or remove the asset.', asset.id));
        continue; // Skip further URL checks for this asset
      }

      // Empty name → warning
      if (!asset.name || asset.name.trim() === '') {
        issues.push(issue('warning', 'assets', `Asset ${asset.id.substring(0, 8)}... has no name`, undefined, asset.id));
      }

      // Invalid URL format → warning
      if (!isValidAssetUrl(asset.url)) {
        issues.push(issue('warning', 'assets', `Asset "${asset.name}" has a malformed URL: ${truncateUrl(asset.url)}`, 'The URL may not be downloadable.', asset.id));
      }

      // Zero-size or missing size → warning
      if (asset.sizeBytes !== undefined && asset.sizeBytes === 0) {
        issues.push(issue('warning', 'assets', `Asset "${asset.name}" has zero bytes`, 'The file may be corrupted or empty.', asset.id));
      }

      // Missing MIME type → info
      if (!asset.mimeType) {
        issues.push(issue('info', 'assets', `Asset "${asset.name}" has no MIME type recorded`, undefined, asset.id));
      }

      // data: URL that is empty/truncated → warning
      if (asset.url.startsWith('data:') && asset.url.length < 50) {
        issues.push(issue('warning', 'assets', `Asset "${asset.name}" uses a data: URL that appears truncated or empty`, undefined, asset.id));
      }

      // blob: URLs won't survive page reload / session restore → warning
      if (asset.url.startsWith('blob:')) {
        issues.push(issue('warning', 'assets', `Asset "${asset.name}" uses a temporary blob: URL`, 'Blob URLs are session-only and will not work after a page reload. Re-upload the asset for persistent access.', asset.id));
      }

      // Asset not referenced by any keyframe → info
      if (!referencedAssetIds.has(asset.id)) {
        issues.push(issue('info', 'assets', `Asset "${asset.name}" is not referenced by any keyframe`, 'It will still be exported but is not used in the storyboard.', asset.id));
      }
    }

    // Duplicate filenames → warning
    const dupes = detectDuplicateFilenames(ctx.assets);
    for (const [name, dupeAssets] of dupes) {
      issues.push(issue('warning', 'assets', `Duplicate filename "${name}" across ${dupeAssets.length} assets`, 'Files will be renamed with numeric suffixes to prevent overwrites.', dupeAssets[0]?.id));
    }
  }

  return summarize(issues);
}

/**
 * Run all sync checks AND probe asset URLs for reachability (HEAD requests).
 * This is async and should be called when the user explicitly requests a deep check,
 * or as a secondary step after the sync checks pass.
 */
export async function runPreflightChecksWithProbe(ctx: PreflightContext): Promise<PreflightResult> {
  const syncResult = runPreflightChecks(ctx);
  const issues = [...syncResult.issues];

  if (ctx.options.includeAssets) {
    const probeResults = await probeAssetReachability(ctx.assets);
    issues.push(...probeResults);
  }

  return summarize(issues);
}

/**
 * Probe asset URLs with a HEAD (or GET-range) request to check if they're downloadable.
 * Runs in parallel with a timeout; failures produce warnings (not blocking — the actual
 * download step will determine success).
 */
async function probeAssetReachability(assets: Asset[]): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];

  const probes = assets
    .filter((a) => a.url && a.url.startsWith('http'))
    .map((asset) => probeSingleAsset(asset));

  const results = await Promise.allSettled(probes);

  for (let i = 0; i < results.length; i++) {
    const asset = assets.filter((a) => a.url && a.url.startsWith('http'))[i];
    if (!asset) continue;
    const result = results[i];
    if (result.status === 'rejected') {
      issues.push(issue('warning', 'assets', `Asset "${asset.name}" probe failed: ${result.reason?.message ?? 'network error'}`, 'The asset may not be downloadable at export time.', asset.id));
    } else if (result.value && !result.value.reachable) {
      issues.push(issue('warning', 'assets', `Asset "${asset.name}" is not reachable (${result.value.status ?? 'no response'})`, 'The download may fail during export.', asset.id));
    }
  }

  return issues;
}

async function probeSingleAsset(asset: Asset): Promise<{ reachable: boolean; status?: number }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ASSET_PROBE_TIMEOUT_MS);

  try {
    // Use method: 'HEAD' first; fall back to GET with Range if HEAD is rejected
    const res = await fetch(asset.url, {
      method: 'HEAD',
      signal: controller.signal,
      mode: 'cors',
    });
    clearTimeout(timeoutId);
    return { reachable: res.ok, status: res.status };
  } catch (headErr) {
    // Some servers don't support HEAD; try a minimal GET
    try {
      const res = await fetch(asset.url, {
        method: 'GET',
        signal: controller.signal,
        mode: 'cors',
        headers: { Range: 'bytes=0-0' },
      });
      clearTimeout(timeoutId);
      return { reachable: res.ok || res.status === 206, status: res.status };
    } catch (getErr) {
      clearTimeout(timeoutId);
      // CORS or network error — still a warning, not blocking
      return { reachable: false };
    }
  }
}

function summarize(issues: PreflightIssue[]): PreflightResult {
  const blockingCount = issues.filter((i) => i.severity === 'blocking').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;

  return {
    issues,
    blockingCount,
    warningCount,
    infoCount,
    canProceed: blockingCount === 0,
  };
}

function issue(
  severity: PreflightSeverity,
  category: string,
  message: string,
  detail?: string,
  entityId?: string,
): PreflightIssue {
  return { severity, category, message, detail, entityId };
}

function isValidAssetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'blob:', 'data:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function truncateUrl(url: string, maxLen = 60): string {
  if (url.length <= maxLen) return url;
  return url.substring(0, maxLen - 3) + '...';
}
