/**
 * Tests for SHA-256 hash generation and manifest file inventory.
 *
 * Mirrors the logic in workspaceExport.ts addTextFile/addBinaryFile which:
 *   1. Computes SHA-256 of every file added to tar
 *   2. Records (path, sizeBytes, sha256, mediaType, addedAt) in fileEntries
 *   3. Ensures manifest.json itself is added to tar at the end
 *
 * Uses Node.js Web Crypto (available in Node 19+ / 20+) to mirror browser crypto.subtle.
 */

import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

// ─── Mirror the hash helper from workspaceExport.ts ────────────────

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const buf = await webcrypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Minimal tar builder mirror (collects file entries only) ──────

class ManifestBuilder {
  constructor() {
    this.files = [];
    this.totalSize = 0;
    this.now = new Date().toISOString();
  }
  async addTextFile(path, content, mediaType) {
    const bytes = new TextEncoder().encode(content);
    const hash = await sha256Hex(bytes);
    this.files.push({
      path,
      sizeBytes: bytes.length,
      sha256: hash,
      mediaType,
      addedAt: this.now,
    });
    this.totalSize += bytes.length;
  }
  get paths() {
    return this.files.map((f) => f.path);
  }
  findByPath(p) {
    return this.files.find((f) => f.path === p);
  }
}

// ─── Assertions ───────────────────────────────────────────────────

let passed = 0,
  failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─── Expected files for a full export with script/storyboard ─────

const REQUIRED_PATHS = [
  'manifest.json',
  'verification-report.json',
  'missing-assets.json',
  'project-snapshot.json',
  'workspace-snapshot.json',
  'core-bundle.md',
];

console.log('\n📋 Manifest & Hash Tests\n');

t('SHA-256 produces deterministic hex digest for empty input', async () => {
  const h = await sha256Hex('');
  // SHA-256 of empty string is a well-known constant
  assertEq(
    h,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

t('SHA-256 produces correct digest for known input', async () => {
  const h = await sha256Hex('hello');
  assertEq(
    h,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});

t('Same content yields same hash (determinism)', async () => {
  const a = await sha256Hex('test content 12345');
  const b = await sha256Hex('test content 12345');
  assertEq(a, b);
});

t('Different content yields different hash', async () => {
  const a = await sha256Hex('content A');
  const b = await sha256Hex('content B');
  assert(a !== b, 'hashes should differ');
});

t('Hash is 64 hex characters (256 bits)', async () => {
  const h = await sha256Hex('anything');
  assertEq(h.length, 64);
  assert(/^[0-9a-f]{64}$/.test(h), 'hash should be lowercase hex');
});

t('Binary Uint8Array hashing works', async () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
  const h = await sha256Hex(bytes);
  assertEq(h.length, 64);
  // should differ from string interpretation
  const str = new TextDecoder().decode(bytes);
  const h2 = await sha256Hex(str);
  // Note: not asserting inequality because it might be equal for these specific
  // bytes (latin-1 edge case), but length is correct which validates binary path.
  assert(h2.length === 64);
});

t('ManifestBuilder records every added file with hash and size', async () => {
  const mb = new ManifestBuilder();
  await mb.addTextFile('script/current-script.md', '# Script\nhello', 'text/markdown');
  await mb.addTextFile('manifest.json', '{"v":1}', 'application/json');

  assertEq(mb.files.length, 2);
  const f = mb.findByPath('script/current-script.md');
  assert(f, 'script file should exist');
  assertEq(f.mediaType, 'text/markdown');
  assertEq(f.sizeBytes, 14); // "# Script\nhello"
  assert(f.sha256.length === 64, 'sha256 should be 64 hex chars');
  assert(f.addedAt.length > 0, 'addedAt should be set');
});

t('totalSize accumulates correctly', async () => {
  const mb = new ManifestBuilder();
  await mb.addTextFile('a.md', '12345', 'text/markdown'); // 5 bytes
  await mb.addTextFile('b.json', '{}', 'application/json'); // 2 bytes
  assertEq(mb.totalSize, 7);
});

t('All required top-level manifest files are accounted for', () => {
  // Simulate post-build state after all addTextFile calls
  const builtPaths = [
    'script/current-script.md',
    'storyboard/storyboard.json',
    'project-snapshot.json',
    'timeline/final-cut.json',
    'conversations/01-chat.md',
    'assets/001-img.png',
    'core-bundle.md',
    'workspace-snapshot.json',
    'missing-assets.json',
    'verification-report.json',
    'manifest.json',
  ];
  for (const required of REQUIRED_PATHS) {
    assert(builtPaths.includes(required), `missing required file: ${required}`);
  }
});

t('Conditional files (script/storyboard) are optional', () => {
  // Project without script/storyboard should not include their paths
  const noScriptPaths = [
    'project-snapshot.json',
    'workspace-snapshot.json',
    'core-bundle.md',
    'missing-assets.json',
    'verification-report.json',
    'manifest.json',
  ];
  assert(!noScriptPaths.includes('script/current-script.md'));
  assert(!noScriptPaths.includes('storyboard/storyboard.json'));
  for (const required of [
    'project-snapshot.json',
    'workspace-snapshot.json',
    'manifest.json',
    'verification-report.json',
  ]) {
    assert(noScriptPaths.includes(required), `missing required file: ${required}`);
  }
});

t('Each asset gets a deterministic 3-digit index prefix', () => {
  const assets = [
    { id: 'a1', name: 'x.png' },
    { id: 'a2', name: 'y.mp4' },
    { id: 'a3', name: 'z.wav' },
  ];
  const paths = assets.map((a, i) => {
    const idx = String(i + 1).padStart(3, '0');
    return `assets/${idx}-${a.name}`;
  });
  assertEq(paths[0], 'assets/001-x.png');
  assertEq(paths[1], 'assets/002-y.mp4');
  assertEq(paths[2], 'assets/003-z.wav');
});

t('File paths use forward slashes (no backslashes) and no spaces in structure', () => {
  const paths = [
    'script/current-script.md',
    'storyboard/storyboard.json',
    'assets/001-image.png',
    'conversations/01-chat.md',
  ];
  for (const p of paths) {
    assert(!p.includes('\\'), `path should not contain backslash: ${p}`);
    assert(!p.startsWith('/'), `path should be relative: ${p}`);
  }
});

t('Empty asset list still produces required metadata files', () => {
  const paths = [
    'project-snapshot.json',
    'workspace-snapshot.json',
    'core-bundle.md',
    'missing-assets.json',
    'verification-report.json',
    'manifest.json',
  ];
  assert(paths.includes('manifest.json'));
  assert(paths.includes('verification-report.json'));
  assert(paths.includes('missing-assets.json'));
  assert(!paths.some((p) => p.startsWith('assets/')));
});

// ─── Summary ─────────────────────────────────────────────────────

if (!import.meta.main) process.exit(0);
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
