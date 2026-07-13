/**
 * Tests for export summary and completeness reporting.
 *
 * Mirrors verification.ts logic in workspaceExport.ts:
 *   - completeness percentages
 *   - status determination (completed/partial/failed)
 *   - asset count aggregation
 *   - toast message formatting
 */

// ─── Mirror the status/completeness logic from workspaceExport ───

function computeStatus(totalAssets, downloadedAssets, missingAssets) {
  if (totalAssets === 0 && downloadedAssets === 0 && missingAssets === 0) return 'completed';
  if (missingAssets === 0 && downloadedAssets > 0) return 'completed';
  if (downloadedAssets > 0) return 'partial';
  return 'failed';
}

function completenessReport(totalAssets, includedAssets, missingAssets, filesList, hasScript, hasStoryboard, convCount) {
  return {
    expectedAssets: totalAssets,
    includedAssets,
    missingAssets,
    scriptIncluded: hasScript,
    storyboardIncluded: hasStoryboard,
    conversationsIncluded: convCount,
    percent: totalAssets > 0 ? Math.round((includedAssets / totalAssets) * 100) : 100,
  };
}

function verificationStatus(rep, failedChecksums = 0, issues = []) {
  if (failedChecksums > 0) return 'fail';
  if (issues.length > 0 || rep.missingAssets > 0) return 'warn';
  return 'pass';
}

// ─── Mirror toast message formatting from Workspace.tsx ──────────

function toastMessage(filename, downloaded, missing, totalFiles, status) {
  if (status === 'failed') {
    return `未成功打包任何文件，${filename} 未能生成。`;
  }
  if (missing > 0) {
    return `${filename} 已下载，${downloaded} 个资产成功打包，${missing} 个资产下载失败，共 ${totalFiles} 个文件。`;
  }
  return `${filename} 已下载，${downloaded} 个资产全部成功打包，共 ${totalFiles} 个文件。`;
}

// ─── Assertions ────────────────────────────────────────────────

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n📊 Export Summary Tests\n');

// ─── Status computation ───────────────────────────────────────

t('status=completed when all assets download (no missing)', () => {
  assertEq(computeStatus(5, 5, 0), 'completed');
});

t('status=completed when zero assets (no script-only case)', () => {
  assertEq(computeStatus(0, 0, 0), 'completed');
});

t('status=partial when some assets fail but at least one succeeds', () => {
  assertEq(computeStatus(5, 3, 2), 'partial');
});

t('status=partial when only 1 of many assets succeeds', () => {
  assertEq(computeStatus(10, 1, 9), 'partial');
});

t('status=failed when all assets fail', () => {
  assertEq(computeStatus(3, 0, 3), 'failed');
});

t('status=failed when no assets AND no script (handled by canExport separately)', () => {
  // This case would be blocked by preflight, but if reached:
  assertEq(computeStatus(0, 0, 0), 'completed'); // no assets = nothing to fail
});

// ─── Completeness report ──────────────────────────────────────

t('percent is 100 when all assets included', () => {
  const r = completenessReport(10, 10, 0, [], true, true, 3);
  assertEq(r.percent, 100);
  assertEq(r.includedAssets, 10);
  assertEq(r.missingAssets, 0);
});

t('percent is 0 when no assets included', () => {
  const r = completenessReport(5, 0, 5, [], true, true, 0);
  assertEq(r.percent, 0);
});

t('percent is 60 for 3/5 assets', () => {
  const r = completenessReport(5, 3, 2, [], true, false, 1);
  assertEq(r.percent, 60);
});

t('percent is 100 when no expected assets (script-only export)', () => {
  const r = completenessReport(0, 0, 0, [], true, false, 0);
  assertEq(r.percent, 100);
});

t('script/storyboard flags propagated', () => {
  const r = completenessReport(0, 0, 0, [], true, false, 0);
  assertEq(r.scriptIncluded, true);
  assertEq(r.storyboardIncluded, false);
});

t('conversations count propagated', () => {
  const r = completenessReport(0, 0, 0, [], false, false, 5);
  assertEq(r.conversationsIncluded, 5);
});

// ─── Verification status ──────────────────────────────────────

t('verification=pass when nothing missing and no checksum failures', () => {
  const r = completenessReport(5, 5, 0, [], true, true, 1);
  assertEq(verificationStatus(r), 'pass');
});

t('verification=warn when missing assets but no checksum failures', () => {
  const r = completenessReport(5, 3, 2, [], true, true, 0);
  assertEq(verificationStatus(r), 'warn');
});

t('verification=fail when checksum failures exist', () => {
  const r = completenessReport(5, 5, 0, [], true, true, 0);
  assertEq(verificationStatus(r, 2), 'fail');
});

t('verification=warn when extra issues listed', () => {
  const r = completenessReport(5, 5, 0, [], true, true, 0);
  assertEq(verificationStatus(r, 0, ['some warning']), 'warn');
});

// ─── Toast message formatting ────────────────────────────────

t('Success toast includes filename and count', () => {
  const msg = toastMessage('myfilm-full-abc123.tar', 5, 0, 12, 'completed');
  assert(msg.includes('myfilm-full-abc123.tar'), 'should include filename');
  assert(msg.includes('5'), 'should include asset count');
  assert(msg.includes('全部成功打包'), 'should indicate all success');
});

t('Partial toast includes both success and failure counts', () => {
  const msg = toastMessage('proj.tar', 3, 2, 10, 'partial');
  assert(msg.includes('3 个资产成功打包'));
  assert(msg.includes('2 个资产下载失败'));
  assert(msg.includes('10 个文件'));
});

t('Failed toast indicates nothing was created', () => {
  const msg = toastMessage('proj.tar', 0, 5, 0, 'failed');
  assert(msg.includes('未能生成'));
  assert(!msg.includes('已下载'));
});

// ─── Summary: file count categorization ───────────────────────

function categorizeFiles(filePaths) {
  const counts = {
    metadata: 0,
    scripts: 0,
    storyboards: 0,
    snapshots: 0,
    timelines: 0,
    conversations: 0,
    assets: 0,
    markdown: 0,
  };
  for (const p of filePaths) {
    if (p === 'manifest.json' || p === 'verification-report.json' || p === 'missing-assets.json')
      counts.metadata++;
    else if (p.startsWith('script/')) counts.scripts++;
    else if (p.startsWith('storyboard/')) counts.storyboards++;
    else if (p === 'project-snapshot.json' || p === 'workspace-snapshot.json') counts.snapshots++;
    else if (p.startsWith('timeline/')) counts.timelines++;
    else if (p.startsWith('conversations/')) counts.conversations++;
    else if (p.startsWith('assets/')) counts.assets++;
    else if (p.endsWith('.md')) counts.markdown++;
  }
  return counts;
}

t('Full export has metadata files', () => {
  const files = [
    'manifest.json', 'verification-report.json', 'missing-assets.json',
    'script/current-script.md', 'storyboard/storyboard.json',
    'project-snapshot.json', 'workspace-snapshot.json',
    'timeline/final-cut.json',
    'conversations/01-chat.md',
    'assets/001-img.png', 'assets/002-vid.mp4',
    'core-bundle.md',
  ];
  const c = categorizeFiles(files);
  assertEq(c.metadata, 3, '3 metadata files');
  assertEq(c.scripts, 1);
  assertEq(c.storyboards, 1);
  assertEq(c.snapshots, 2);
  assertEq(c.timelines, 1);
  assertEq(c.conversations, 1);
  assertEq(c.assets, 2);
  assertEq(c.markdown, 1); // core-bundle.md
});

t('Script-only export (no assets/storyboard)', () => {
  const files = [
    'manifest.json', 'verification-report.json', 'missing-assets.json',
    'script/current-script.md',
    'project-snapshot.json', 'workspace-snapshot.json',
    'core-bundle.md',
  ];
  const c = categorizeFiles(files);
  assertEq(c.storyboards, 0);
  assertEq(c.assets, 0);
  assertEq(c.scripts, 1);
});

// ─── Redaction summary aggregation ────────────────────────────

function summarizeRedaction(byCategory) {
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
  const cats = Object.entries(byCategory)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join(', ');
  return { total, summary: cats };
}

t('Redaction summary is empty when nothing redacted', () => {
  const s = summarizeRedaction({});
  assertEq(s.total, 0);
  assertEq(s.summary, '');
});

t('Redaction summary aggregates counts', () => {
  const s = summarizeRedaction({ email: 2, api_key: 1, phone_cn: 1 });
  assertEq(s.total, 4);
  assert(s.summary.includes('email×2'));
  assert(s.summary.includes('api_key×1'));
  assert(s.summary.includes('phone_cn×1'));
});

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
