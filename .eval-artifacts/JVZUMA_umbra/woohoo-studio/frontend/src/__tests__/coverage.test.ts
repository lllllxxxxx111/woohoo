import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';
import {
  buildFileListFromZip,
  buildAssetManifest,
  createManifest,
  generateReadmeExport,
  type ExportManifest,
} from '../utils/exportManifest';
import { sha256String, sha256Bytes } from '../utils/crypto';
import { sanitizeForExport, sanitizeStringForExport } from '../utils/sanitize';
import { runPreflightChecks } from '../utils/preflight';
import { exportFullProjectBundle, exportCoreProjectBundle } from '../utils/exportBundle';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

const PROJECT_ID = 'p-cover';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID, name: 'Coverage', description: 'desc', ownerId: 'u1',
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
    settings: { resolution: { width: 1920, height: 1080 }, fps: 24 },
    ...overrides,
  };
}
const script: Script = {
  id: 's1', projectId: PROJECT_ID, title: 'Ep1', content: 'x',
  scenes: [{ id: 'sc1', number: 1, heading: 'INT', action: '', dialogue: [] }],
  createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
};
const storyboard: Storyboard = {
  id: 'sb1', projectId: PROJECT_ID, name: 'MB',
  shots: [
    { id: 'sh1', number: 1, description: 'wide', keyframeIds: ['kf1'] },
    { id: 'sh2', number: 2, description: 'close', keyframeIds: ['kf2'] },
  ],
  createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
};
const keyframes: Keyframe[] = [
  { id: 'kf1', projectId: PROJECT_ID, name: 'A', assetId: 'a1', timestamp: 0,
    prompt: 'p', annotations: 'n', createdAt: '2025-01-01T00:00:00Z' },
  { id: 'kf2', projectId: PROJECT_ID, name: 'B', assetId: 'a2', timestamp: 1,
    prompt: 'p', annotations: 'n', createdAt: '2025-01-01T00:00:00Z' },
];
const videoPlan: VideoPlan = {
  id: 'vp1', projectId: PROJECT_ID, name: 'Plan', model: 'm',
  resolution: { width: 1920, height: 1080 }, fps: 24, duration: 10, parameters: {},
  createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
};
const assets: Asset[] = [
  { id: 'a1', projectId: PROJECT_ID, name: 'hero.png', type: 'image',
    url: '/api/assets/a1/download', sizeBytes: 8, sha256: 'a'.repeat(64),
    createdAt: '2025-01-01T00:00:00Z' },
  { id: 'a2', projectId: PROJECT_ID, name: 'bg.png', type: 'image',
    url: 'https://cdn.example.com/bg.png?token=SECRET', sizeBytes: 16, sha256: 'b'.repeat(64),
    metadata: { apiKey: 'sk-abc123secret' },
    createdAt: '2025-01-01T00:00:00Z' },
];

beforeAll(() => {
  (globalThis as any).__auditCalls = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.endsWith(`/projects/${PROJECT_ID}`)) return json(makeProject());
    if (s.endsWith(`/projects/${PROJECT_ID}/scripts`)) return json([script]);
    if (s.endsWith(`/projects/${PROJECT_ID}/storyboards`)) return json([storyboard]);
    if (s.endsWith(`/projects/${PROJECT_ID}/keyframes`)) return json(keyframes);
    if (s.endsWith(`/projects/${PROJECT_ID}/video-plans`)) return json([videoPlan]);
    if (s.endsWith(`/projects/${PROJECT_ID}/assets`)) return json(assets);
    if (s.endsWith('/exports/audit')) {
      const payload = init?.body ? JSON.parse(init.body as string) : null;
      (globalThis as any).__auditCalls.push({ payload });
      return json({ id: 'x', ...payload });
    }
    if (s.includes('/assets/') && s.endsWith('/download')) {
      const blob = new Blob(['BINARY'], { type: 'image/png' });
      const res: any = new Response(null, { status: 200 });
      res.blob = async () => blob;
      return res;
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
beforeEach(() => { (globalThis as any).__auditCalls = []; });

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('manifest file list invariants', () => {
  it('files are sorted lexicographically and have no duplicates', async () => {
    const zip = new JSZip();
    zip.file('b.txt', 'B');
    zip.file('a.txt', 'A');
    zip.file('sub/c.txt', 'C');
    zip.folder('empty');
    const files = await buildFileListFromZip(zip);
    const paths = files.map(f => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every file entry has a 64-hex sha256 and positive sizeBytes', async () => {
    const zip = new JSZip();
    zip.file('data/x.json', JSON.stringify({ a: 1 }));
    zip.file('README.md', '# hi');
    const files = await buildFileListFromZip(zip);
    for (const f of files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.sizeBytes).toBeGreaterThan(0);
      expect(['json', 'asset', 'snapshot', 'readme', 'document']).toContain(f.kind);
    }
  });

  it('counts.files equals files.length in a fully-built manifest', async () => {
    const zip = new JSZip();
    zip.file('data/p.json', '{}');
    const m = await createManifest({
      projectId: 'p', projectName: 'P', exportType: 'core', zip,
      scripts: [], storyboards: [], keyframes: [], videoPlans: [], rawAssets: [],
    });
    expect(m.counts.files).toBe(m.files.length);
  });
});

describe('hashing', () => {
  it('sha256String differs for different inputs', async () => {
    const [h1, h2] = await Promise.all([sha256String('foo'), sha256String('bar')]);
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256Bytes of known bytes matches independent computation', async () => {
    // echo -n "abc" | sha256sum => ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Bytes(bytes)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('manifest hash changes when project name changes', async () => {
    function build(name: string) {
      const z = new JSZip();
      z.file('d.json', '{}');
      return createManifest({
        projectId: 'p', projectName: name, exportType: 'core', zip: z,
        scripts: [], storyboards: [], keyframes: [], videoPlans: [], rawAssets: [],
      });
    }
    const [a, b] = await Promise.all([build('A'), build('B')]);
    expect(a.manifestSha256).not.toBe(b.manifestSha256);
  });

  it('files with identical content produce identical sha256', async () => {
    const z1 = new JSZip(); z1.file('same.txt', 'IDENTICAL');
    z1.file('other.txt', 'zzz');
    const z2 = new JSZip(); z2.file('same.txt', 'IDENTICAL');
    z2.file('another.txt', 'yyy');
    const [f1, f2] = await Promise.all([buildFileListFromZip(z1), buildFileListFromZip(z2)]);
    const h1 = f1.find(f => f.path === 'same.txt')!.sha256;
    const h2 = f2.find(f => f.path === 'same.txt')!.sha256;
    expect(h1).toBe(h2);
  });
});

describe('preflight: precise severity counts', () => {
  it('totals blocking/warning/info exactly across mixed issues', () => {
    const res = runPreflightChecks(
      makeProject({ description: '' }),           // info
      [],                                         // blocking (no scripts)
      [storyboard],                               // + 0 blocking, 2 shots ok
      [
        { id: 'kf-miss', projectId: PROJECT_ID, name: 'miss', assetId: 'does-not-exist',
          timestamp: 0, createdAt: 't' },         // warning (missing asset)
      ],
      [videoPlan],                                // ok
      [
        { id: 'a-bad-url', projectId: PROJECT_ID, name: 'bad', type: 'image',
          url: '', createdAt: 't' },              // blocking (empty url)
        { id: 'a-dup', projectId: PROJECT_ID, name: 'bad', type: 'image',
          url: '/x', sizeBytes: 10, sha256: 'y', createdAt: 't' }, // warning (dup name)
      ],
    );
    expect(res.canExport).toBe(false);
    expect(res.blockingCount).toBe(2); // no scripts + empty url
    expect(res.warningCount).toBeGreaterThanOrEqual(2); // keyframe_missing_asset + dup
    expect(res.infoCount).toBeGreaterThanOrEqual(1); // no description
    // All issues carry code, message, severity
    for (const i of res.issues) {
      expect(i.code).toBeTruthy();
      expect(i.message).toBeTruthy();
      expect(['blocking', 'warning', 'info']).toContain(i.severity);
    }
  });

  it('healthy project returns zero blocking and canExport=true', () => {
    const res = runPreflightChecks(
      makeProject(), [script], [storyboard], keyframes, [videoPlan], assets,
    );
    expect(res.canExport).toBe(true);
    expect(res.blockingCount).toBe(0);
  });
});

describe('sensitive field scrubbing (deep and diverse)', () => {
  const dirty = {
    note: 'Bearer abc.def.ghi token here',
    pem: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----',
    apiKey: 'sk-abc123XYZ',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    url: 'https://example.com/cb?project=p1&token=supersecret&limit=10',
    linuxPath: '/home/alice/.ssh/id_rsa',
    macPath: '/Users/bob/Documents/secret.docx',
    rootPath: '/root/.aws/credentials',
    winPath: 'C:\\Users\\Carol\\Desktop\\bank.pdf',
    gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    nested: {
      authorization: 'Bearer toktok',
      items: [{ password: 'hunter2' }, { publicData: 'visible' }],
    },
  };

  it('scrubs all expected secret patterns and preserves non-secret structure', () => {
    const cleaned: any = sanitizeForExport(dirty);
    const json = JSON.stringify(cleaned);

    // Bearer token credential replaced
    expect(cleaned.note).toContain('Bearer');
    expect(cleaned.note).toContain('<redacted>');
    expect(cleaned.note).not.toContain('abc.def.ghi');

    // PEM block gone
    expect(cleaned.pem).not.toContain('MIIE');
    expect(cleaned.pem).toContain('[REDACTED PRIVATE KEY]');

    // Inline secret-shaped values replaced (ghp_ prefix kept for auditability, body redacted)
    expect(cleaned.apiKey).toBe('<redacted>');          // key name itself is sensitive
    expect(cleaned.jwt).toBe('<redacted>');
    expect(cleaned.gh).toMatch(/^ghp_<redacted>$/);
    expect(cleaned.gh).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(cleaned.url).toContain('token=<redacted>');
    expect(cleaned.url).toContain('project=p1');       // non-secret param preserved
    expect(cleaned.url).not.toContain('supersecret');

    // Paths replaced
    expect(cleaned.linuxPath).not.toContain('alice');
    expect(cleaned.macPath).not.toContain('/Users/bob');
    expect(cleaned.rootPath).toContain('<redacted>');
    expect(cleaned.winPath).not.toContain('Carol');

    // Nested sensitive key
    expect(cleaned.nested.authorization).toBe('<redacted>');
    expect(cleaned.nested.items[0].password).toBe('<redacted>');
    expect(cleaned.nested.items[1].publicData).toBe('visible');  // untouched
  });

  it('sanitizeStringForExport cleans a free-form log line', () => {
    const log = 'GET /api?token=abcd from /root/secrets at 2025-01-01 using Bearer xyz';
    const out = sanitizeStringForExport(log);
    expect(out).toContain('<redacted>');
    expect(out).not.toContain('abcd');
    expect(out).not.toContain('/root/secrets');
    expect(out).not.toContain('xyz');
  });
});

describe('export summary (stats on ExportResult)', () => {
  it('core ExportResult.stats is well-formed and matches zip contents', async () => {
    const r = await exportCoreProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    expect(r.success).toBe(true);
    expect(r.stats).toBeTruthy();
    expect(Number.isInteger(r.stats!.totalFiles)).toBe(true);
    expect(Number.isInteger(r.stats!.totalAssets)).toBe(true);
    expect(Number.isInteger(r.stats!.missingAssets)).toBe(true);
    expect(Number.isInteger(r.stats!.totalSizeBytes)).toBe(true);
    expect(r.stats!.totalSizeBytes).toBe(r.blob!.size);
    expect(r.stats!.totalAssets).toBe(0);         // core packs no binaries
    expect(r.stats!.missingAssets).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(r.blob!);
    const realFiles = Object.keys(zip.files).filter(p => !p.endsWith('/')).length;
    // stats.totalFiles counts payload files (excludes manifest.json itself, by design)
    expect(r.stats!.totalFiles).toBeLessThanOrEqual(realFiles);
    expect(r.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.filename).toMatch(/^[a-z0-9_-]+-core-\d{8}-\d{6}\.zip$/);
  });

  it('full ExportResult.stats reports packed assets and zero missing', async () => {
    const r = await exportFullProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    expect(r.success).toBe(true);
    expect(r.stats!.totalAssets).toBeGreaterThan(0);
    expect(r.stats!.missingAssets).toBe(0);
    expect(r.filename).toContain('-full-');
    const zip = await JSZip.loadAsync(r.blob!);
    const assetFiles = Object.keys(zip.files).filter(p => p.startsWith('assets/') && !p.endsWith('/'));
    expect(assetFiles.length).toBe(r.stats!.totalAssets);
  });

  it('audit payload after core export agrees with ExportResult stats', async () => {
    const r = await exportCoreProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    const calls = (globalThis as any).__auditCalls as any[];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const audit = calls.find(c => c.payload.exportType === 'core').payload;
    expect(audit.projectId).toBe(PROJECT_ID);
    expect(audit.manifestHash).toBe(r.manifestHash);
    expect(audit.assetCount).toBe(r.stats!.totalAssets);
    expect(audit.missingAssetCount).toBe(r.stats!.missingAssets);
    expect(audit.totalSizeBytes).toBe(r.stats!.totalSizeBytes);
  });
});

describe('README generated from manifest references counts and verification steps', () => {
  it('README contains file listing, missing assets section, and verification header', () => {
    const m: ExportManifest = {
      schemaVersion: '1.0.0',
      projectId: 'p', projectName: 'Proj', exportedAt: '2025-01-01T00:00:00Z', exportType: 'full',
      counts: { files: 2, assets: 1, scripts: 1, storyboards: 0, keyframes: 0, videoPlans: 0, missingAssets: 1 },
      files: [
        { path: 'data/scripts.json', kind: 'json', sizeBytes: 10, sha256: 'c'.repeat(64) },
        { path: 'README_EXPORT.md', kind: 'readme', sizeBytes: 100, sha256: 'd'.repeat(64) },
      ],
      assets: [{ assetId: 'a1', name: 'ok.png', type: 'image', source: '/x', packed: true, sizeBytes: 10, sha256: 'c'.repeat(64) }],
      missingAssets: [{ assetId: 'a2', name: 'bad.png', reason: '404' }],
      generationParams: { model: 'g' },
      manifestSha256: 'e'.repeat(64),
    };
    const md = generateReadmeExport(m);
    expect(md).toContain('# Project Export');
    expect(md).toContain('Scripts: 1');
    expect(md).toContain('Missing assets');
    expect(md).toContain('bad.png');
    expect(md).toContain('Verification');
    expect(md).toContain('SHA-256');
    // Each listed file's hash appears
    for (const f of m.files) expect(md).toContain(f.sha256.slice(0, 12));
  });
});
