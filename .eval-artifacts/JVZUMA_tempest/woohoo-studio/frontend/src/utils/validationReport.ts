// Validation report / README_EXPORT.md generator.
// Produces a human-readable markdown document describing the export bundle contents,
// missing items, checksums, and how to verify integrity.
import type { ExportManifest, PreflightResult } from '../types';

export interface ReportOptions {
  manifest: ExportManifest;
  preflight?: PreflightResult;
  reproducible?: boolean;
}

/**
 * Generate a validation_report.md (also used as README_EXPORT.md) string.
 */
export function generateValidationReport(opts: ReportOptions): string {
  const { manifest, preflight, reproducible = true } = opts;
  const lines: string[] = [];

  lines.push(`# ${manifest.projectName} — Export Validation Report`);
  lines.push('');
  lines.push(`- **Project ID**: \`${manifest.projectId}\``);
  lines.push(`- **Export Type**: \`${manifest.exportType}\``);
  lines.push(`- **Exported At**: ${manifest.exportedAt}`);
  lines.push(`- **Schema Version**: ${manifest.schemaVersion}`);
  if (manifest.manifestHash) {
    lines.push(`- **Manifest Hash (SHA-256)**: \`${manifest.manifestHash}\``);
  }
  lines.push('');

  lines.push('## Counts');
  lines.push('');
  lines.push(`| Item | Count |`);
  lines.push(`|------|-------|`);
  lines.push(`| Files in bundle | ${manifest.counts.files} |`);
  lines.push(`| Assets (total referenced) | ${manifest.counts.assets} |`);
  lines.push(`| Missing assets | ${manifest.counts.missingAssets} |`);
  lines.push(`| Scripts | ${manifest.counts.scripts} |`);
  lines.push(`| Storyboards | ${manifest.counts.storyboards} |`);
  lines.push(`| Keyframes | ${manifest.counts.keyframes} |`);
  lines.push(`| Video plans | ${manifest.counts.videoPlans} |`);
  lines.push('');

  // File listing with checksums
  lines.push('## File Inventory');
  lines.push('');
  lines.push('| Path | Kind | Size (bytes) | SHA-256 |');
  lines.push('|------|------|-------------|---------|');
  for (const f of manifest.files) {
    lines.push(`| \`${f.path}\` | ${f.kind} | ${f.sizeBytes} | \`${f.sha256.substring(0, 16)}…\` |`);
  }
  lines.push('');

  // Asset status
  lines.push('## Asset Status');
  lines.push('');
  lines.push('| Asset ID | Name | Type | Packed | Error |');
  lines.push('|----------|------|------|--------|-------|');
  for (const a of manifest.assets) {
    lines.push(`| \`${a.assetId}\` | ${a.name} | ${a.type} | ${a.packed ? 'yes' : 'no'} | ${a.errorReason ?? ''} |`);
  }
  lines.push('');

  if (manifest.missingAssets.length > 0) {
    lines.push('### Missing Assets');
    lines.push('');
    for (const id of manifest.missingAssets) {
      lines.push(`- \`${id}\``);
    }
    lines.push('');
  }

  // Generation params
  if (Object.keys(manifest.generationParams).length > 0) {
    lines.push('## Generation Parameters');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(manifest.generationParams, null, 2));
    lines.push('```');
    lines.push('');
  }

  // Preflight results
  if (preflight) {
    lines.push('## Preflight Results');
    lines.push('');
    lines.push(`- Blocking: ${preflight.summary.blockingCount}`);
    lines.push(`- Warnings: ${preflight.summary.warningCount}`);
    lines.push(`- Info: ${preflight.summary.infoCount}`);
    lines.push('');
    if (preflight.allIssues.length > 0) {
      lines.push('| Severity | Code | Message |');
      lines.push('|----------|------|---------|');
      for (const i of preflight.allIssues) {
        lines.push(`| ${i.severity} | \`${i.code}\` | ${i.message} |`);
      }
      lines.push('');
    }
  }

  // Verification instructions
  lines.push('## How to Verify this Package');
  lines.push('');
  lines.push('1. Extract the ZIP archive.');
  lines.push('2. Open `manifest.json` and compare `manifestHash` against a fresh computation over the sorted file list (`path:sha256` per file joined by newlines).');
  lines.push('3. For each file listed under `files`, compute its SHA-256 and verify it matches the entry.');
  lines.push('4. Check `workspace_snapshot.json` for project metadata summary.');
  if (reproducible) {
    lines.push('5. To reproduce generation, use parameters from `generationParams` and pipeline info in the snapshot.');
  }
  lines.push('');
  lines.push('## Sanitization Notice');
  lines.push('');
  lines.push('This bundle has been automatically sanitized to remove API keys, JWT tokens, passwords, and absolute local filesystem paths. See source code for the exact redaction rules.');
  lines.push('');

  return lines.join('\n');
}
