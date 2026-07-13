// Export result summary formatting (used in success toast, audit log entries)

export interface ExportSummaryInput {
  filename: string;
  manifestHash: string;
  assetCount: number;
  missingCount: number;
  /** Number of hex characters to show at start of hash (default 12) */
  hashPrefixLength?: number;
}

/** How many leading hex characters of the manifest hash to display */
const DEFAULT_HASH_PREFIX = 12;

/**
 * Produce a human-readable, single-multiline summary string used in the
 * export success toast. Format:
 *   Exported <filename>\nManifest: <hashPrefix>... | Assets: <N> | Missing: <M>
 */
export function formatExportSummary(input: ExportSummaryInput): string {
  const { filename, manifestHash, assetCount, missingCount } = input;
  const prefixLen = input.hashPrefixLength ?? DEFAULT_HASH_PREFIX;
  const shortHash =
    typeof manifestHash === 'string' && manifestHash.length > 0
      ? manifestHash.substring(0, Math.min(prefixLen, manifestHash.length))
      : '';
  const hashPart = shortHash ? shortHash + '...' : '(no hash)';
  return (
    'Exported ' + filename +
    '\nManifest: ' + hashPart +
    ' | Assets: ' + String(assetCount) +
    ' | Missing: ' + String(missingCount)
  );
}

/** Short (single-line) variant for audit history list items */
export function formatExportSummaryShort(input: ExportSummaryInput): string {
  const { filename, assetCount, missingCount } = input;
  return filename + ' (' + String(assetCount) + ' assets, ' + String(missingCount) + ' missing)';
}

/**
 * Validate that a filename for export looks reasonable.
 * Returns null if valid, or an error string if not.
 */
export function validateExportFilename(filename: string): string | null {
  if (!filename || filename.trim().length === 0) return 'Filename is empty';
  if (filename.length > 255) return 'Filename is too long (max 255 chars)';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(filename)) {
    return 'Filename contains invalid characters';
  }
  if (!/\.zip$/i.test(filename)) return 'Filename must end with .zip';
  return null;
}

/**
 * Validate a manifest hash. Must be a 64-char lowercase hex string (SHA-256)
 * or an empty string (allowed during construction).
 */
export function validateManifestHash(hash: string): boolean {
  if (hash === '') return true;
  return /^[0-9a-f]{64}$/.test(hash);
}

/**
 * Return counts summary as a plain object (useful for logging/audit).
 */
export function buildCountsSummary(input: {
  scripts?: number;
  storyboards?: number;
  keyframes?: number;
  videoPlans?: number;
  assets?: number;
  packagedAssets?: number;
  missingAssets?: number;
  files?: number;
}) {
  return {
    scripts: input.scripts ?? 0,
    storyboards: input.storyboards ?? 0,
    keyframes: input.keyframes ?? 0,
    videoPlans: input.videoPlans ?? 0,
    assets: input.assets ?? 0,
    packagedAssets: input.packagedAssets ?? 0,
    missingAssets: input.missingAssets ?? 0,
    files: input.files ?? 0,
  };
}
