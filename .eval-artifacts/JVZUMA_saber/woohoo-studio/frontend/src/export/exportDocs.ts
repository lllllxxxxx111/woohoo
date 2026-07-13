// Generate README_EXPORT.md and validation_report.md content for export bundles

import type { ExportManifest, PreflightResult } from '../types';

export function buildExportReadme(
  manifest: ExportManifest,
  manifestHash: string,
  preflight: PreflightResult
): string {
  const lines: string[] = [];

  lines.push(`# ${manifest.projectName} - Export Package`);
  lines.push('');
  lines.push(`**Project:** ${manifest.projectName} (${manifest.projectId})`);
  lines.push(`**Export Type:** ${manifest.exportType === 'full' ? 'Full Project Bundle' : 'Core Planning Bundle'}`);
  lines.push(`**Exported At:** ${manifest.exportedAt}`);
  lines.push(`**Manifest SHA-256:** \`${manifestHash}\``);
  lines.push(`**Schema Version:** ${manifest.schemaVersion}`);
  lines.push(`**Generator:** ${manifest.generator.name} v${manifest.generator.version}`);
  lines.push('');

  lines.push('## Package Contents');
  lines.push('');
  lines.push('| Item | Count |');
  lines.push('|------|-------|');
  lines.push(`| Scripts | ${manifest.counts.scripts} |`);
  lines.push(`| Storyboards | ${manifest.counts.storyboards} |`);
  lines.push(`| Keyframes | ${manifest.counts.keyframes} |`);
  lines.push(`| Video Plans | ${manifest.counts.videoPlans} |`);
  lines.push(`| Assets (total) | ${manifest.counts.assets} |`);
  lines.push(`| Files in bundle | ${manifest.counts.files} |`);
  lines.push(`| Assets successfully packed | ${manifest.assets.filter(a => a.packedInBundle).length} |`);
  lines.push(`| Assets missing/failed | ${manifest.missingAssets.length} |`);
  lines.push('');

  lines.push('## Bundle Structure');
  lines.push('');
  lines.push('```');
  lines.push('├── manifest.json           # Package manifest with checksums and asset inventory');
  lines.push('├── workspace_snapshot.json # Complete reproducible workspace snapshot');
  lines.push('├── README_EXPORT.md        # This file');
  lines.push('├── data/');
  lines.push('│   ├── project.json        # Project metadata');
  lines.push('│   ├── scripts.json        # All scripts');
  lines.push('│   ├── storyboards.json    # Storyboard definitions');
  lines.push('│   ├── keyframes.json      # Keyframe data (if included)');
  lines.push('│   ├── video_plans.json    # Video production plans (full bundle only)');
  lines.push('│   └── assets.json         # Asset metadata');
  if (manifest.exportType === 'full') {
    lines.push('└── assets/                 # Downloaded asset files (full bundle only)');
  }
  lines.push('```');
  lines.push('');

  lines.push('## How to Verify This Package');
  lines.push('');
  lines.push('1. **Verify manifest.json integrity**:');
  lines.push('   - Compute SHA-256 of `manifest.json`');
  lines.push(`   - Expected: \`${manifestHash}\``);
  lines.push('');
  lines.push('2. **Verify individual file checksums**:');
  lines.push('   - Each entry in `manifest.json > files` has a `sha256` field');
  lines.push('   - Compute SHA-256 of the file and compare');
  lines.push('   - Note: `manifest.json` itself is NOT listed in `files[]` (self-referential);');
  lines.push('     recompute its hash independently and compare with the value shown above.');
  lines.push('   - `README_EXPORT.md` is documentation and not integrity-verified via manifest.');
  lines.push('');
  lines.push('3. **Verify asset checksums**:');
  lines.push('   - Each packed asset in `manifest.json > assets` has a `sha256` field');
  lines.push('   - Compute SHA-256 of the asset file under `assets/` and compare');
  lines.push('');
  lines.push('4. **Check for missing assets**:');
  lines.push(`   - ${manifest.missingAssets.length === 0 ? 'All assets were successfully packed.' : `${manifest.missingAssets.length} asset(s) failed to download; see manifest.json > assets for failure reasons.`}`);
  lines.push('');

  // Preflight results
  lines.push('## Pre-Export Validation Results');
  lines.push('');
  lines.push(`- **Blocking issues:** ${preflight.blockingCount}`);
  lines.push(`- **Warnings:** ${preflight.warningCount}`);
  lines.push(`- **Info:** ${preflight.infoCount}`);
  if (preflight.blockingCount > 0) {
    lines.push('');
    lines.push('### Blocking Issues (Overridden)');
    lines.push('');
    for (const issue of preflight.issues.filter(i => i.severity === 'blocking')) {
      lines.push(`- **${issue.message}**`);
      if (issue.entityName) lines.push(`  - Entity: ${issue.entityName}`);
    }
  }
  if (preflight.warningCount > 0) {
    lines.push('');
    lines.push('### Warnings');
    lines.push('');
    for (const issue of preflight.issues.filter(i => i.severity === 'warning')) {
      lines.push(`- ${issue.message}`);
    }
  }
  lines.push('');

  // Parameter summary
  if (manifest.parameterSummary && Object.keys(manifest.parameterSummary).length > 0) {
    lines.push('## Generation Parameters Summary');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(manifest.parameterSummary, null, 2));
    lines.push('```');
    lines.push('');
  }

  // Missing assets detail
  if (manifest.missingAssets.length > 0) {
    lines.push('## Missing / Failed Assets');
    lines.push('');
    lines.push('The following assets could not be included:');
    lines.push('');
    lines.push('| Asset ID | Name | Reason |');
    lines.push('|----------|------|--------|');
    for (const entry of manifest.assets.filter(a => !a.packedInBundle)) {
      lines.push(`| ${entry.assetId} | ${entry.name} | ${entry.failureReason || 'Unknown'} |`);
    }
    lines.push('');
  }

  // Security note
  lines.push('## Security & Privacy Notes');
  lines.push('');
  lines.push('- API keys, tokens, passwords, and credentials have been stripped from this bundle');
  lines.push('- Local filesystem absolute paths have been normalized to remove user home directory information');
  lines.push('- JWT tokens and Bearer authorization headers are not included');
  lines.push('');

  lines.push('---');
  lines.push(`*Generated by Woohoo Studio v${manifest.generator.version}*`);

  return lines.join('\n');
}

export function buildValidationReport(manifest: ExportManifest, manifestHash: string): string {
  const lines: string[] = [];
  lines.push('# Validation Report');
  lines.push('');
  lines.push(`Manifest Hash: ${manifestHash}`);
  lines.push(`Project: ${manifest.projectName}`);
  lines.push(`Date: ${manifest.exportedAt}`);
  lines.push('');
  lines.push('## File Checksums');
  lines.push('');
  lines.push('| Path | Kind | Size (bytes) | SHA-256 |');
  lines.push('|------|------|--------------|---------|');
  for (const f of manifest.files) {
    lines.push(`| ${f.path} | ${f.kind} | ${f.sizeBytes} | ${f.sha256} |`);
  }
  lines.push('');
  return lines.join('\n');
}
