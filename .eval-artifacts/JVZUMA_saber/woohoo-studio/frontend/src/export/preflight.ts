// Preflight checks: validate project state before export
//
// Two entry points:
//   runPreflightChecks()   — synchronous, cheap, always runs (URL format, empty
//                            fields, duplicates, cross-refs). Never touches network.
//   runPreflightChecksAsync() — adds network-reachability checks (asset/keyframe
//                            image download probes with timeout). Runs after sync
//                            checks pass; downgrades unreachable assets to
//                            'warning' (not blocking, since asset may be behind
//                            auth that works in production but not in preflight).

import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  PreflightResult,
  PreflightIssue,
} from '../types';
import { detectDuplicateFilenames, isAssetUrlValid, sanitizeAssetFilename } from '../assets/handlers';

/**
 * Run synchronous preflight checks. These never touch the network and are
 * instant — safe to call on every export-menu open.
 */
export function runPreflightChecks(
  project: Project,
  scripts: Script[],
  storyboards: Storyboard[],
  keyframes: Keyframe[],
  videoPlans: VideoPlan[],
  assets: Asset[]
): PreflightResult {
  const issues: PreflightIssue[] = [];

  // --- Project-level checks ---
  if (!project.id || project.id.trim().length === 0) {
    issues.push({
      severity: 'blocking',
      category: 'general',
      message: 'Project has no ID; cannot record audit log',
    });
  }
  if (!project.userId || project.userId.trim().length === 0) {
    issues.push({
      severity: 'warning',
      category: 'general',
      message: 'Project has no user ID; audit log will show anonymous exporter',
    });
  }
  if (!project.name || project.name.trim().length === 0) {
    issues.push({
      severity: 'warning',
      category: 'general',
      message: 'Project name is empty; exported bundle will use default filename',
    });
  }

  // --- Script checks ---
  if (scripts.length === 0) {
    issues.push({
      severity: 'warning',
      category: 'script',
      message: 'Project has no scripts; exported bundle will contain no script content',
    });
  }

  for (const script of scripts) {
    if (!script.content || script.content.trim().length === 0) {
      issues.push({
        severity: 'warning',
        category: 'script',
        entityId: script.id,
        entityName: script.title || `Scene ${script.sceneIndex}`,
        message: `Script "${script.title || `Scene ${script.sceneIndex}`}" has empty content`,
      });
    }
    if (script.content && script.content.trim().length < 5) {
      issues.push({
        severity: 'info',
        category: 'script',
        entityId: script.id,
        entityName: script.title || `Scene ${script.sceneIndex}`,
        message: `Script "${script.title || `Scene ${script.sceneIndex}`}" has very short content (${script.content.trim().length} chars)`,
      });
    }
  }

  // Duplicate scene indices
  const sceneIndices = new Map<number, number>();
  for (const s of scripts) {
    sceneIndices.set(s.sceneIndex, (sceneIndices.get(s.sceneIndex) || 0) + 1);
  }
  for (const [idx, count] of sceneIndices) {
    if (count > 1) {
      issues.push({
        severity: 'warning',
        category: 'script',
        message: `Duplicate scene index ${idx} appears ${count} times; may cause ordering confusion`,
      });
    }
  }

  // --- Storyboard checks ---
  if (storyboards.length === 0) {
    issues.push({
      severity: 'info',
      category: 'storyboard',
      message: 'Project has no storyboards',
    });
  }

  for (const sb of storyboards) {
    if (!sb.description && !sb.title) {
      issues.push({
        severity: 'info',
        category: 'storyboard',
        entityId: sb.id,
        entityName: sb.title || `Storyboard ${sb.order}`,
        message: `Storyboard ${sb.order} has no title or description`,
      });
    }
  }

  // Check for orphan storyboards (no keyframes pointing to them)
  const sbIdsWithKeyframes = new Set(
    keyframes.map(k => k.storyboardId).filter(Boolean) as string[]
  );
  for (const sb of storyboards) {
    if (!sbIdsWithKeyframes.has(sb.id)) {
      issues.push({
        severity: 'info',
        category: 'storyboard',
        entityId: sb.id,
        entityName: sb.title || `Storyboard ${sb.order}`,
        message: `Storyboard "${sb.title || `#${sb.order}`}" has no keyframes attached`,
      });
    }
  }

  // --- Keyframe checks ---
  if (keyframes.length === 0) {
    issues.push({
      severity: 'info',
      category: 'keyframe',
      message: 'Project has no keyframes; export will not include keyframe images',
    });
  }

  let keyframesWithoutImage = 0;
  let keyframesWithoutPrompt = 0;
  let keyframesWithInvalidImageUrl = 0;
  for (const kf of keyframes) {
    if (!kf.imageUrl) {
      keyframesWithoutImage++;
    } else if (!isAssetUrlValid(kf.imageUrl)) {
      keyframesWithInvalidImageUrl++;
      issues.push({
        severity: 'warning',
        category: 'keyframe',
        entityId: kf.id,
        message: `Keyframe #${kf.order} has invalid image URL: "${kf.imageUrl}" — preview may be broken`,
        details: { keyframeId: kf.id, url: kf.imageUrl },
      });
    }
    if (!kf.prompt || kf.prompt.trim().length === 0) {
      keyframesWithoutPrompt++;
    }
  }
  if (keyframesWithoutImage > 0) {
    issues.push({
      severity: 'warning',
      category: 'keyframe',
      message: `${keyframesWithoutImage} keyframe(s) have no image URL and cannot be previewed in the bundle`,
      details: { count: keyframesWithoutImage },
    });
  }
  if (keyframesWithoutPrompt > 0) {
    issues.push({
      severity: 'info',
      category: 'keyframe',
      message: `${keyframesWithoutPrompt} keyframe(s) have no generation prompt stored`,
      details: { count: keyframesWithoutPrompt },
    });
  }

  // --- Video plan checks ---
  if (videoPlans.length === 0) {
    issues.push({
      severity: 'info',
      category: 'video_plan',
      message: 'Project has no video plan; production settings not exported',
    });
  } else {
    for (const vp of videoPlans) {
      if (!vp.settings || Object.keys(vp.settings).length === 0) {
        issues.push({
          severity: 'warning',
          category: 'video_plan',
          entityId: vp.id,
          message: 'Video plan has no settings configured (resolution, fps, etc.)',
        });
      } else {
        // Check for essential settings
        const s = vp.settings;
        if (!s.resolution && !s.fps && !s.duration) {
          issues.push({
            severity: 'info',
            category: 'video_plan',
            entityId: vp.id,
            message: 'Video plan is missing resolution/fps/duration settings',
          });
        }
      }
    }
  }

  // --- Asset checks ---
  if (assets.length === 0) {
    issues.push({
      severity: 'info',
      category: 'asset',
      message: 'Project has no assets to pack',
    });
  }

  let totalAssetBytesEstimate = 0;
  for (const asset of assets) {
    if (asset.sizeBytes) totalAssetBytesEstimate += asset.sizeBytes;

    if (!asset.url || !isAssetUrlValid(asset.url)) {
      issues.push({
        severity: 'blocking',
        category: 'asset',
        entityId: asset.id,
        entityName: asset.name,
        message: `Asset "${asset.name}" has invalid or missing URL: "${asset.url || '(empty)'}" and cannot be downloaded`,
        details: { assetId: asset.id, url: asset.url },
      });
    }
  }

  // Duplicate filenames
  const duplicates = detectDuplicateFilenames(assets);
  for (const dupName of duplicates) {
    issues.push({
      severity: 'warning',
      category: 'filename',
      message: `Multiple assets share the filename "${dupName}"; export will add numeric suffixes to avoid conflicts`,
      details: { filename: dupName },
    });
  }

  // Empty asset names
  for (const asset of assets) {
    if (!asset.name || asset.name.trim().length === 0) {
      issues.push({
        severity: 'blocking',
        category: 'filename',
        entityId: asset.id,
        message: 'Asset has empty name; cannot determine file extension for export',
      });
    }
    const sanitized = sanitizeAssetFilename(asset.name);
    if (sanitized !== asset.name && asset.name.length > 0) {
      issues.push({
        severity: 'info',
        category: 'filename',
        entityId: asset.id,
        entityName: asset.name,
        message: `Asset "${asset.name}" contains special characters; will be exported as "${sanitized}"`,
      });
    }
  }

  // Warn about large bundles
  if (totalAssetBytesEstimate > 500 * 1024 * 1024) { // > 500 MB
    issues.push({
      severity: 'warning',
      category: 'asset',
      message: `Total asset size exceeds 500 MB (≈ ${(totalAssetBytesEstimate / 1024 / 1024).toFixed(0)} MB); export may be slow or fail`,
      details: { totalBytes: totalAssetBytesEstimate },
    });
  }

  // --- Cross-reference integrity ---
  const scriptIds = new Set(scripts.map(s => s.id));
  const storyboardIds = new Set(storyboards.map(sb => sb.id));
  const assetIds = new Set(assets.map(a => a.id));

  // Keyframe → storyboard FK
  for (const kf of keyframes) {
    if (kf.storyboardId && !storyboardIds.has(kf.storyboardId)) {
      issues.push({
        severity: 'warning',
        category: 'storyboard',
        entityId: kf.id,
        message: `Keyframe #${kf.order} references storyboard "${kf.storyboardId}" which does not exist in this project`,
      });
    }
  }

  // Tally
  const blocking = issues.filter(i => i.severity === 'blocking');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  return {
    passed: blocking.length === 0,
    blockingCount: blocking.length,
    warningCount: warnings.length,
    infoCount: infos.length,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Options for the async network preflight check.
 */
export interface AsyncPreflightOptions {
  /** Per-request timeout in milliseconds (default 5000) */
  timeoutMs?: number;
  /** Method: 'HEAD' is fast but some servers don't support it; 'GET' with Range: bytes=0-0 fetches 1 byte. Default 'HEAD'. */
  method?: 'HEAD' | 'GET';
  /** Maximum number of concurrent probes (default 4) */
  concurrency?: number;
}

/**
 * Run asynchronous reachability probes against asset and keyframe image URLs.
 * Adds 'warning' (never blocking) issues for unreachable URLs — because even if
 * the HEAD probe fails the browser/asset server may still serve the content
 * (e.g. behind auth, cookie-gated CDN). The user sees warnings and can proceed.
 *
 * Returns a supplementary PreflightResult whose issues should be merged with
 * the sync result by the caller.
 */
export async function runPreflightChecksAsync(
  _project: Project,
  _scripts: Script[],
  _storyboards: Storyboard[],
  keyframes: Keyframe[],
  _videoPlans: VideoPlan[],
  assets: Asset[],
  options: AsyncPreflightOptions = {}
): Promise<PreflightResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const method = options.method ?? 'HEAD';
  const issues: PreflightIssue[] = [];

  // Collect all external URLs to probe (assets + keyframe images that are http/https)
  const targets: Array<{ url: string; kind: 'asset' | 'keyframe'; entityId: string; name: string }> = [];

  for (const a of assets) {
    if (a.url && /^https?:\/\//.test(a.url)) {
      targets.push({ url: a.url, kind: 'asset', entityId: a.id, name: a.name });
    }
  }
  for (const kf of keyframes) {
    if (kf.imageUrl && /^https?:\/\//.test(kf.imageUrl)) {
      targets.push({ url: kf.imageUrl, kind: 'keyframe', entityId: kf.id, name: `Keyframe #${kf.order}` });
    }
  }

  // Run probes with bounded concurrency
  const concurrency = options.concurrency ?? 4;
  let idx = 0;

  async function worker() {
    while (idx < targets.length) {
      const i = idx++;
      const t = targets[i];
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(t.url, {
          method,
          signal: controller.signal,
          // For GET, request only first byte to save bandwidth
          headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
        });
        clearTimeout(timer);
        if (!resp.ok && resp.status !== 206 /* Partial Content */) {
          issues.push({
            severity: 'warning',
            category: t.kind,
            entityId: t.entityId,
            entityName: t.name,
            message: `${t.kind === 'asset' ? 'Asset' : 'Keyframe image'} "${t.name}" returned HTTP ${resp.status} when probed — may fail to download`,
            details: { url: t.url, status: resp.status },
          });
        }
      } catch (err) {
        const reason = err instanceof Error
          ? (err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message)
          : String(err);
        issues.push({
          severity: 'warning',
          category: t.kind,
          entityId: t.entityId,
          entityName: t.name,
          message: `${t.kind === 'asset' ? 'Asset' : 'Keyframe image'} "${t.name}" probe failed (${reason}) — will attempt download anyway`,
          details: { url: t.url, error: reason },
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());
  await Promise.all(workers);

  const blocking = issues.filter(i => i.severity === 'blocking');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  return {
    passed: blocking.length === 0,
    blockingCount: blocking.length,
    warningCount: warnings.length,
    infoCount: infos.length,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Merge two preflight results into one (sync + async).
 */
export function mergePreflightResults(a: PreflightResult, b: PreflightResult): PreflightResult {
  const issues = [...a.issues, ...b.issues];
  return {
    passed: a.passed && b.passed,
    blockingCount: a.blockingCount + b.blockingCount,
    warningCount: a.warningCount + b.warningCount,
    infoCount: a.infoCount + b.infoCount,
    issues,
    checkedAt: b.checkedAt,
  };
}
