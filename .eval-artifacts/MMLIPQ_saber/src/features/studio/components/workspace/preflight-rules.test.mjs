/**
 * Tests for preflight rule coverage.
 *
 * These tests verify the rule patterns used in workspaceExport.ts runPreflightCheck().
 * The actual function depends on browser APIs, so we test the detection logic by
 * replicating the key predicates.
 */

// ─── Mirror preflight predicates from workspaceExport.ts ─────────

function isBadUrl(url) {
  if (!url || !url.trim()) return 'empty';
  if (url.startsWith('/uploads/')) return 'local';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'external';
  if (url.startsWith('data:')) return 'data';
  return 'bad';
}

function isEmptyName(name) {
  return !name || !name.trim();
}

function scriptReady(content) {
  return !!(content && content.trim());
}

function scriptTooShort(content) {
  return content && content.trim().length > 0 && content.trim().length < 50;
}

function storyboardReady(lines) {
  return !!(lines && lines.length > 0);
}

function emptyStoryboardScenes(lines) {
  return lines.filter((l) => !l.description || !l.description.trim()).length;
}

function duplicateNames(assets) {
  const counts = new Map();
  for (const a of assets) {
    const key = (a.name || '').trim().toLowerCase();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

function hasPhoneNumber(text) {
  return /(?<!\d)1[3-9]\d{9}(?!\d)/.test(text);
}

function hasEmail(text) {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text);
}

function hasApiKeyPattern(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes('sk-') ||
    /api[_-]?key/i.test(text) ||
    lower.includes('secret=') ||
    lower.includes('password=')
  );
}

// ─── Severity classification mirrors runPreflightCheck logic ─────

function classify(asset, scriptContent, storyboardLines, allAssets) {
  const blockers = [];
  const warnings = [];
  const infos = [];

  // Asset-level
  const urlStatus = isBadUrl(asset.url);
  if (isEmptyName(asset.name)) {
    blockers.push('ASSET_EMPTY_NAME');
  }
  if (urlStatus === 'empty') blockers.push('ASSET_NO_URL');
  if (urlStatus === 'bad') blockers.push('ASSET_BAD_URL');
  if (urlStatus === 'external') warnings.push('ASSET_EXTERNAL_URL');
  if (asset.sizeBytes === 0) warnings.push('ASSET_ZERO_BYTES');

  // Script
  if (!scriptContent) infos.push('SCRIPT_MISSING');
  else if (!scriptReady(scriptContent)) warnings.push('SCRIPT_EMPTY');
  else if (scriptTooShort(scriptContent)) warnings.push('SCRIPT_TOO_SHORT');
  else infos.push('SCRIPT_OK');

  if (scriptContent && hasApiKeyPattern(scriptContent)) warnings.push('SCRIPT_SENSITIVE_KEY');
  if (scriptContent && (hasEmail(scriptContent) || hasPhoneNumber(scriptContent)))
    warnings.push('SCRIPT_PII');

  // Storyboard
  if (!storyboardLines || storyboardLines.length === 0) {
    infos.push('STORYBOARD_MISSING');
  } else {
    const empty = emptyStoryboardScenes(storyboardLines);
    if (empty > 0) warnings.push(`STORYBOARD_EMPTY_SCENES:${empty}`);
    const zeroDur = storyboardLines.filter((l) => !l.duration || l.duration <= 0).length;
    if (zeroDur > 0) infos.push(`STORYBOARD_ZERO_DURATION:${zeroDur}`);
    infos.push(`STORYBOARD_OK:${storyboardLines.length}`);
  }

  // Duplicate names
  const dups = duplicateNames(allAssets);
  for (const d of dups) warnings.push(`DUPLICATE_ASSET_NAME:${d}`);

  // Project-level
  if (allAssets.length === 0) warnings.push('NO_ASSETS');

  // canExport = has any downloadable asset OR script OR storyboard
  const hasReachable = allAssets.some(
    (a) => isBadUrl(a.url) === 'local' || isBadUrl(a.url) === 'data',
  );
  const hasExternal = allAssets.some((a) => isBadUrl(a.url) === 'external');
  const canExport = hasReachable || hasExternal || scriptReady(scriptContent) || storyboardReady(storyboardLines);

  return { blockers, warnings, infos, canExport };
}

// ─── Assertions ─────────────────────────────────────────────────

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }
function assertIncludes(arr, item, msg) {
  if (!arr.includes(item)) throw new Error(msg ?? `expected array to include ${item}`);
}

console.log('\n🔍 Preflight Rule Tests\n');

// ─── Asset URL classification ──────────────────────────────────

t('Empty URL is blocking', () => {
  const r = classify({ name: 'x.png', url: '' }, 'script', [], [{ name: 'x.png', url: '' }]);
  assertIncludes(r.blockers, 'ASSET_NO_URL');
});

t('Whitespace-only URL is blocking', () => {
  const r = classify({ name: 'x.png', url: '   ' }, 'script', [], [{ name: 'x.png', url: '   ' }]);
  assertIncludes(r.blockers, 'ASSET_NO_URL');
});

t('Missing name is blocking', () => {
  const r = classify({ name: '', url: '/uploads/x.png' }, 's', [], [{ name: '', url: '/uploads/x.png' }]);
  assertIncludes(r.blockers, 'ASSET_EMPTY_NAME');
});

t('Unrecognised URL scheme is blocking', () => {
  const r = classify({ name: 'x', url: 'ftp://bad.com/file' }, 's', [], [{ name: 'x', url: 'ftp://bad.com/file' }]);
  assertIncludes(r.blockers, 'ASSET_BAD_URL');
});

t('/uploads/ URL is local-reachable (pass)', () => {
  const r = classify({ name: 'x.png', url: '/uploads/uuid.png', sizeBytes: 1024 }, 's', [], [
    { name: 'x.png', url: '/uploads/uuid.png' },
  ]);
  assert(!r.blockers.includes('ASSET_NO_URL') && !r.blockers.includes('ASSET_BAD_URL'));
  assert(r.canExport);
});

t('http(s) URL is warning (external, to-be-downloaded)', () => {
  const r = classify({ name: 'x.png', url: 'https://cdn.example.com/x.png' }, 's', [], [
    { name: 'x.png', url: 'https://cdn.example.com/x.png' },
  ]);
  assertIncludes(r.warnings, 'ASSET_EXTERNAL_URL');
  assert(r.canExport, 'external URLs are downloadable so export should proceed');
});

t('data: URL is pass', () => {
  const r = classify({ name: 'x', url: 'data:image/png;base64,AAAA' }, 's', [], [
    { name: 'x', url: 'data:image/png;base64,AAAA' },
  ]);
  assert(r.blockers.length === 0);
});

t('Zero-byte asset is warning', () => {
  const r = classify({ name: 'x.png', url: '/uploads/x.png', sizeBytes: 0 }, 's', [], [
    { name: 'x.png', url: '/uploads/x.png' },
  ]);
  assertIncludes(r.warnings, 'ASSET_ZERO_BYTES');
});

// ─── Script checks ─────────────────────────────────────────────

t('Null/undefined script is info (not blocking by itself)', () => {
  const r = classify({ name: 'x.png', url: '/uploads/x.png' }, null, [], [
    { name: 'x.png', url: '/uploads/x.png' },
  ]);
  assertIncludes(r.infos, 'SCRIPT_MISSING');
  assert(!r.warnings.includes('SCRIPT_EMPTY'));
});

t('Empty script content is warning', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, '   \n  ', [], [
    { name: 'x', url: '/uploads/x' },
  ]);
  assertIncludes(r.warnings, 'SCRIPT_EMPTY');
});

t('Very short script is warning (draft)', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, 'hi', [], [
    { name: 'x', url: '/uploads/x' },
  ]);
  assertIncludes(r.warnings, 'SCRIPT_TOO_SHORT');
});

t('Script containing sk- triggers sensitive key warning', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, 'key is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ01 done', [], [
    { name: 'x', url: '/uploads/x' },
  ]);
  assertIncludes(r.warnings, 'SCRIPT_SENSITIVE_KEY');
});

t('Script containing email triggers PII warning', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, 'contact admin@example.com pls', [], [
    { name: 'x', url: '/uploads/x' },
  ]);
  assertIncludes(r.warnings, 'SCRIPT_PII');
});

t('Script containing phone triggers PII warning', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, 'call 13812345678 now', [], [
    { name: 'x', url: '/uploads/x' },
  ]);
  assertIncludes(r.warnings, 'SCRIPT_PII');
});

t('Clean Chinese script has no false positives', () => {
  // Long enough script to avoid SCRIPT_TOO_SHORT threshold (50 chars)
  const clean = '这是一个关于二十五个镜头的短剧项目，描述主角李明在城市中的冒险故事，包含开场、发展、高潮和结局四个主要段落。';
  const r = classify({ name: 'x', url: '/uploads/x' }, clean, [{ description: '开场', duration: 5 }], [
    { name: 'x', url: '/uploads/x' },
  ]);
  assert(!r.warnings.includes('SCRIPT_SENSITIVE_KEY'), 'should not flag API key in clean Chinese text');
  assert(!r.warnings.includes('SCRIPT_PII'), 'should not flag PII in clean Chinese text');
  assert(!r.warnings.includes('SCRIPT_TOO_SHORT'), 'long Chinese script should not be flagged as too short');
});

// ─── Storyboard checks ─────────────────────────────────────────

t('Missing storyboard is info', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, 'script', null, [
    { name: 'x', url: '/uploads/x' },
  ]);
  assertIncludes(r.infos, 'STORYBOARD_MISSING');
});

t('Empty scene descriptions are flagged', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, 'script', [
    { description: 'scene one', duration: 5 },
    { description: '   ', duration: 3 },
    { description: '', duration: 4 },
  ], [{ name: 'x', url: '/uploads/x' }]);
  const empty = r.warnings.find((w) => w.startsWith('STORYBOARD_EMPTY_SCENES'));
  assert(empty, 'should flag empty scenes');
  assert(empty.endsWith(':2'), `expected 2 empty, got ${empty}`);
});

t('Zero-duration scenes are flagged as info', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, 'script', [
    { description: 'a', duration: 0 },
    { description: 'b', duration: 5 },
  ], [{ name: 'x', url: '/uploads/x' }]);
  const zd = r.infos.find((w) => w.startsWith('STORYBOARD_ZERO_DURATION'));
  assert(zd);
});

// ─── Duplicate detection ───────────────────────────────────────

t('Duplicate asset names are flagged', () => {
  const assets = [
    { name: 'hero.png', url: '/uploads/a.png' },
    { name: 'hero.png', url: '/uploads/b.png' },
    { name: 'villain.mp4', url: '/uploads/c.mp4' },
  ];
  const r = classify({ name: 'hero.png', url: '/uploads/a.png' }, 's', [], assets);
  const dup = r.warnings.find((w) => w.startsWith('DUPLICATE_ASSET_NAME'));
  assert(dup, 'should detect duplicate');
  assert(dup.includes('hero.png'));
});

t('Duplicate check is case-insensitive', () => {
  const assets = [
    { name: 'Hero.PNG', url: '/a' },
    { name: 'hero.png', url: '/b' },
  ];
  const r = classify(assets[0], 's', [], assets);
  assert(r.warnings.some((w) => w.startsWith('DUPLICATE_ASSET_NAME')));
});

// ─── Project-level canExport logic ─────────────────────────────

t('canExport=true when has local assets even without script/storyboard', () => {
  const r = classify({ name: 'x', url: '/uploads/x' }, null, null, [
    { name: 'x', url: '/uploads/x' },
  ]);
  assert(r.canExport);
});

t('canExport=true when has external URLs even without local assets', () => {
  const r = classify({ name: 'x', url: 'https://ex.com/x' }, null, null, [
    { name: 'x', url: 'https://ex.com/x' },
  ]);
  assert(r.canExport);
});

t('canExport=true when only script exists (no assets)', () => {
  const r = classify({ name: 'x', url: '' }, 'script content here', [], []);
  assert(r.canExport);
});

t('canExport=false when no reachable/external assets AND no script AND no storyboard', () => {
  const r = classify({ name: 'x', url: '' }, null, null, [
    { name: 'x', url: '' },
  ]);
  assert(!r.canExport);
});

t('No assets triggers NO_ASSETS warning', () => {
  const r = classify({ name: 'nonexistent', url: '' }, 'script', [], []);
  assertIncludes(r.warnings, 'NO_ASSETS');
});

// ─── Phone number boundary checks ──────────────────────────────

t('11-digit phone not matched when surrounded by digits (long number)', () => {
  assert(!hasPhoneNumber('order 1234567890123456'));
});

t('Phone matched in isolation', () => {
  assert(hasPhoneNumber('tel 13812345678 end'));
});

t('4-digit year not a phone', () => {
  assert(!hasPhoneNumber('year 2024'));
});

// ─── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
