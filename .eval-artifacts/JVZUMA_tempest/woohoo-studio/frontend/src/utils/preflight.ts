// Pre-export preflight checks — runs client-side integrity validation before export.
// Produces blocking/warning/info issues.
//
// Coverage map (required by spec):
//   - scripts:           SCRIPT_EMPTY (warning), SCRIPT_TITLE_EMPTY (warning),
//                        NO_SCRIPTS (info), SCRIPT_VERY_LARGE (warning)
//   - storyboards:       STORYBOARD_NO_SCENES (warning), STORYBOARD_TITLE_EMPTY (warning),
//                        SCENE_DESCRIPTION_EMPTY (info)
//   - keyframes:         KEYFRAME_NO_IMAGE (warning), KEYFRAME_EMPTY_PROMPT (info)
//   - video plans:       VIDEO_PLAN_NO_CONFIG (blocking), VIDEO_PLAN_NO_RESOLUTION (warning),
//                        VIDEO_PLAN_INVALID_FPS (warning), VIDEO_PLAN_INVALID_DURATION (warning)
//   - asset URLs:        ASSET_NO_URL (blocking), ASSET_INVALID_URL (blocking),
//                        ASSET_UNSUPPORTED_PROTOCOL (warning), ASSET_LOCAL_ONLY_URL (warning),
//                        ASSET_FILE_URL (warning)
//   - duplicate names:   DUPLICATE_ASSET_NAME (warning)
//   - empty content:     PROJECT_NAME_EMPTY (blocking) + above
//   - undownloadable:    ASSET_INVALID_URL, ASSET_LOCAL_ONLY_URL, ASSET_FILE_URL,
//                        ASSET_UNSUPPORTED_PROTOCOL
import type {
  Project,
  Script,
  Storyboard,
  Keyframe,
  VideoPlan,
  Asset,
  PreflightResult,
  PreflightIssue,
  PreflightSeverity,
} from '../types';

export interface PreflightInput {
  project: Project;
  scripts: Script[];
  storyboards: Storyboard[];
  keyframes: Keyframe[];
  videoPlans: VideoPlan[];
  assets: Asset[];
}

const DOWNLOADABLE_PROTOCOLS = ['http:', 'https:', 'blob:', 'data:'];

/**
 * Validate that a URL string is well-formed and safe to attempt a download from.
 * Returns: { valid, reason } where reason is suitable for error message.
 */
export function validateAssetUrl(url: string): { valid: boolean; code?: string; reason?: string } {
  if (!url || url.trim().length === 0) {
    return { valid: false, code: 'ASSET_NO_URL', reason: 'URL is empty' };
  }
  const trimmed = url.trim();
  let parsed: URL;
  try {
    // Allow relative URLs starting with '/' to be treated as API-relative (not invalid, but flag)
    if (trimmed.startsWith('/')) {
      return { valid: true, code: 'ASSET_RELATIVE_URL', reason: 'Relative API URL' };
    }
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, code: 'ASSET_INVALID_URL', reason: 'URL is malformed and cannot be parsed' };
  }
  if (parsed.protocol === 'file:') {
    return { valid: false, code: 'ASSET_FILE_URL', reason: 'file:// URLs point to local filesystem and cannot be downloaded in browser' };
  }
  if (parsed.protocol === 'javascript:' || parsed.protocol === 'about:' || parsed.protocol === 'vbscript:') {
    return { valid: false, code: 'ASSET_INVALID_URL', reason: `Disallowed protocol: ${parsed.protocol}` };
  }
  if (!DOWNLOADABLE_PROTOCOLS.includes(parsed.protocol)) {
    return { valid: false, code: 'ASSET_UNSUPPORTED_PROTOCOL', reason: `Protocol "${parsed.protocol}" is not expected to be downloadable in browser` };
  }
  return { valid: true };
}

/**
 * Run all preflight checks and return a structured result.
 */
export function runPreflight(input: PreflightInput): PreflightResult {
  const { project, scripts, storyboards, keyframes, videoPlans, assets } = input;
  const issues: PreflightIssue[] = [];

  // --- Project-level checks ---
  if (!project.name || project.name.trim().length === 0) {
    issues.push(issue('blocking', 'PROJECT_NAME_EMPTY', 'Project name is empty', undefined, 'project', project.id));
  }

  // --- Script checks ---
  if (scripts.length === 0) {
    issues.push(issue('info', 'NO_SCRIPTS', 'Project has no scripts yet', 'Core bundle will include empty script section.', 'project', project.id));
  }
  for (const s of scripts) {
    if (!s.title || s.title.trim().length === 0) {
      issues.push(issue('warning', 'SCRIPT_TITLE_EMPTY', `Script ${s.id} has empty title`, 'Titles help identify scripts in the export manifest.', 'script', s.id));
    }
    if (!s.content || s.content.trim().length === 0) {
      issues.push(issue('warning', 'SCRIPT_EMPTY', `Script "${s.title || s.id}" has empty content`, undefined, 'script', s.id));
    }
    if (s.content && s.content.length > 500_000) {
      issues.push(
        issue(
          'warning',
          'SCRIPT_VERY_LARGE',
          `Script "${s.title || s.id}" is very large (${(s.content.length / 1024).toFixed(1)} KB)`,
          'Consider splitting or summarising.',
          'script',
          s.id,
        ),
      );
    }
  }

  // --- Storyboard checks ---
  for (const sb of storyboards) {
    if (!sb.title || sb.title.trim().length === 0) {
      issues.push(issue('warning', 'STORYBOARD_TITLE_EMPTY', `Storyboard ${sb.id} has empty title`, undefined, 'storyboard', sb.id));
    }
    if (!sb.scenes || sb.scenes.length === 0) {
      issues.push(issue('warning', 'STORYBOARD_NO_SCENES', `Storyboard "${sb.title || sb.id}" has no scenes`, undefined, 'storyboard', sb.id));
    }
    for (const scene of sb.scenes ?? []) {
      if (!scene.description || scene.description.trim().length === 0) {
        issues.push(issue('info', 'SCENE_DESCRIPTION_EMPTY', `Scene ${scene.index} in "${sb.title || sb.id}" has no description`, undefined, 'storyboard', sb.id));
      }
    }
  }

  // --- Keyframe checks ---
  for (const kf of keyframes) {
    if (!kf.assetId && !kf.imageUrl) {
      issues.push(
        issue(
          'warning',
          'KEYFRAME_NO_IMAGE',
          `Keyframe ${kf.id} has no associated image or asset`,
          'The keyframe prompt will be exported but no image file will be packed.',
          'keyframe',
          kf.id,
        ),
      );
    }
    if (!kf.prompt || kf.prompt.trim().length === 0) {
      issues.push(issue('info', 'KEYFRAME_EMPTY_PROMPT', `Keyframe ${kf.id} has an empty prompt`, undefined, 'keyframe', kf.id));
    }
  }

  // --- Video plan checks ---
  if (videoPlans.length === 0) {
    issues.push(issue('info', 'NO_VIDEO_PLANS', 'Project has no video plans', undefined, 'project', project.id));
  }
  for (const vp of videoPlans) {
    if (!vp.config) {
      issues.push(issue('blocking', 'VIDEO_PLAN_NO_CONFIG', `Video plan ${vp.id} has no configuration`, undefined, 'videoPlan', vp.id));
      continue;
    }
    if (!vp.config.resolution || String(vp.config.resolution).trim().length === 0) {
      issues.push(issue('warning', 'VIDEO_PLAN_NO_RESOLUTION', `Video plan ${vp.id} has no resolution set`, 'Default will be assumed.', 'videoPlan', vp.id));
    }
    if (!vp.config.fps || vp.config.fps <= 0) {
      issues.push(issue('warning', 'VIDEO_PLAN_INVALID_FPS', `Video plan ${vp.id} has invalid FPS`, undefined, 'videoPlan', vp.id));
    }
    if (!vp.config.duration || vp.config.duration <= 0) {
      issues.push(issue('warning', 'VIDEO_PLAN_INVALID_DURATION', `Video plan ${vp.id} has invalid duration`, undefined, 'videoPlan', vp.id));
    }
  }

  // --- Asset checks ---
  const seenNames = new Map<string, string>(); // name -> assetId
  for (const a of assets) {
    // Duplicate filename check
    if (a.name && seenNames.has(a.name)) {
      issues.push(
        issue(
          'warning',
          'DUPLICATE_ASSET_NAME',
          `Duplicate asset name: "${a.name}"`,
          `First seen in asset ${seenNames.get(a.name)}, also in ${a.id}. Files may overwrite each other in export.`,
          'asset',
          a.id,
        ),
      );
    } else if (a.name) {
      seenNames.set(a.name, a.id);
    }

    // Empty asset name
    if (!a.name || a.name.trim().length === 0) {
      issues.push(issue('warning', 'ASSET_NAME_EMPTY', `Asset ${a.id} has empty name`, 'Will default to asset ID in bundle.', 'asset', a.id));
    }

    // URL validity + downloadability
    const urlCheck = validateAssetUrl(a.url);
    if (!urlCheck.valid) {
      if (urlCheck.code === 'ASSET_NO_URL') {
        issues.push(issue('blocking', 'ASSET_NO_URL', `Asset "${a.name || a.id}" has no URL`, 'Cannot download asset for packaging.', 'asset', a.id));
        continue;
      }
      if (urlCheck.code === 'ASSET_FILE_URL') {
        issues.push(
          issue(
            'warning',
            'ASSET_FILE_URL',
            `Asset "${a.name || a.id}" uses file:// URL`,
            'file:// URLs reference the local filesystem and cannot be packed from the browser. Re-upload the asset.',
            'asset',
            a.id,
          ),
        );
        continue;
      }
      if (urlCheck.code === 'ASSET_UNSUPPORTED_PROTOCOL') {
        issues.push(
          issue(
            'warning',
            'ASSET_UNSUPPORTED_PROTOCOL',
            `Asset "${a.name || a.id}" has non-downloadable URL (${urlCheck.reason})`,
            undefined,
            'asset',
            a.id,
          ),
        );
        continue;
      }
      // Malformed
      issues.push(
        issue(
          'blocking',
          'ASSET_INVALID_URL',
          `Asset "${a.name || a.id}" has invalid URL: ${urlCheck.reason}`,
          undefined,
          'asset',
          a.id,
        ),
      );
      continue;
    }

    // Local/blob/data URLs (still "valid" but not shareable)
    if (urlCheck.code === 'ASSET_RELATIVE_URL') {
      issues.push(
        issue(
          'warning',
          'ASSET_RELATIVE_URL',
          `Asset "${a.name || a.id}" uses a relative URL (${a.url})`,
          'Asset will only be downloadable from this server; export bundles will not contain the binary.',
          'asset',
          a.id,
        ),
      );
    }
    if (a.url.startsWith('blob:') || a.url.startsWith('data:')) {
      issues.push(
        issue(
          'warning',
          'ASSET_LOCAL_ONLY_URL',
          `Asset "${a.name || a.id}" uses a local/blob/data URL`,
          'Asset will need to be re-uploaded before sharing the export.',
          'asset',
          a.id,
        ),
      );
    }

    // Empty / unknown size
    if (a.fileSize === undefined || a.fileSize <= 0) {
      issues.push(issue('info', 'ASSET_UNKNOWN_SIZE', `Asset "${a.name || a.id}" has unknown file size`, undefined, 'asset', a.id));
    }
  }

  // Categorise
  const blocking = issues.filter((i) => i.severity === 'blocking');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');

  return {
    projectId: project.id,
    checkedAt: new Date().toISOString(),
    blocking,
    warnings,
    info: infos,
    allIssues: issues,
    canExport: blocking.length === 0,
    summary: {
      blockingCount: blocking.length,
      warningCount: warnings.length,
      infoCount: infos.length,
    },
  };
}

function issue(
  severity: PreflightSeverity,
  code: string,
  message: string,
  detail?: string,
  entityType?: PreflightIssue['entityType'],
  entityId?: string,
): PreflightIssue {
  return { severity, code, message, detail, entityType, entityId };
}
