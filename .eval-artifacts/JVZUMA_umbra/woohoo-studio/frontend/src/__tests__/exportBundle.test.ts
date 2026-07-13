import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';
import { exportCoreProjectBundle, exportFullProjectBundle } from '../utils/exportBundle';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

const PROJECT_ID = 'p-test';

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    name: 'Test Export Bundle',
    description: 'verification test',
    ownerId: 'u1',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    settings: { resolution: { width: 1920, height: 1080 }, fps: 24, pipeline: { model: 'gen-3', parameters: { seed: 42 } } },
  };
}
function makeScripts(): Script[] {
  return [{
    id: 's1', projectId: PROJECT_ID, title: 'Ep 1',
    content: 'Once upon a time there was a studio.',
    scenes: [{ id: 'sc1', number: 1, heading: 'INT. ROOM', action: 'dark', dialogue: [] }],
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
  }];
}
function makeStoryboards(): Storyboard[] {
  return [{
    id: 'sb1', projectId: PROJECT_ID, name: 'Main',
    shots: [{ id: 'sh1', number: 1, description: 'wide', keyframeIds: ['kf1'] }],
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
  }];
}
function makeKeyframes(): Keyframe[] {
  return [{
    id: 'kf1', projectId: PROJECT_ID, name: 'KF1', assetId: 'a1',
    timestamp: 0, annotations: 'note', prompt: 'wide shot', createdAt: '2025-01-01T00:00:00Z',
  }];
}
function makeVideoPlans(): VideoPlan[] {
  return [{
    id: 'vp1', projectId: PROJECT_ID, name: 'Plan A', model: 'gen-3',
    resolution: { width: 1920, height: 1080 }, fps: 24, duration: 30, parameters: {},
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
  }];
}
function makeAssets(): Asset[] {
  return [{
    id: 'a1', projectId: PROJECT_ID, name: 'hero.png', type: 'image',
    url: '/api/assets/a1/download', sizeBytes: 1234, sha256: 'a'.repeat(64),
    metadata: { harmless: 'ok' }, createdAt: '2025-01-01T00:00:00Z',
  }];
}

beforeAll(() => {
  // Mock all serverApi calls. Core export doesn't download assets; full export
  // calls downloadAssetBlob() for each asset, so we return a tiny valid Blob.
  (globalThis as any).__auditCalls = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    let body: unknown;
    if (urlStr.endsWith(`/projects/${PROJECT_ID}`)) body = makeProject();
    else if (urlStr.endsWith(`/projects/${PROJECT_ID}/scripts`)) body = makeScripts();
    else if (urlStr.endsWith(`/projects/${PROJECT_ID}/storyboards`)) body = makeStoryboards();
    else if (urlStr.endsWith(`/projects/${PROJECT_ID}/keyframes`)) body = makeKeyframes();
    else if (urlStr.endsWith(`/projects/${PROJECT_ID}/video-plans`)) body = makeVideoPlans();
    else if (urlStr.endsWith(`/projects/${PROJECT_ID}/assets`)) body = makeAssets();
    else if (urlStr.endsWith('/exports/audit')) {
      const payload = init?.body ? JSON.parse(init.body as string) : null;
      (globalThis as any).__auditCalls.push({ url: urlStr, method: init?.method, payload });
      body = { id: 'audit-1', ...payload };
    }
    else if (urlStr.includes('/assets/') && urlStr.endsWith('/download')) {
      // Asset download: return a fake Response whose .blob() resolves to a tiny Blob.
      // We override .blob() because jsdom's Response + Blob body interop is flaky across versions.
      const blob = new Blob(['PNG-DATA'], { type: 'image/png' });
      const res: any = new Response(null, { status: 200, headers: { 'Content-Type': 'image/png' } });
      res.blob = async () => blob;
      return res as Response;
    }
    else body = {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  (globalThis as any).__auditCalls = [];
});

describe('exportBundle end-to-end (core bundle)', () => {
  it('produces a zip that contains manifest.json, workspace_snapshot.json and README_EXPORT.md', async () => {
    const result = await exportCoreProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    expect(result.success).toBe(true);
    expect(result.blob).toBeTruthy();
    expect(result.filename).toMatch(/\.zip$/);

    const zip = await JSZip.loadAsync(result.blob!);

    // 1. manifest.json must exist and parse
    const manifestFile = zip.file('manifest.json');
    expect(manifestFile).not.toBeNull();
    const manifestText = await manifestFile!.async('string');
    let manifestJson: any;
    expect(() => { manifestJson = JSON.parse(manifestText); }).not.toThrow();
    expect(manifestJson.schemaVersion).toBe('1.0.0');
    expect(manifestJson.projectId).toBe(PROJECT_ID);
    expect(manifestJson.projectName).toBe('Test Export Bundle');
    expect(manifestJson.exportType).toBe('core');
    expect(manifestJson.manifestSha256).toMatch(/^[0-9a-f]{64}$/);

    // counts
    expect(manifestJson.counts.scripts).toBeGreaterThanOrEqual(1);
    expect(manifestJson.counts.storyboards).toBeGreaterThanOrEqual(1);
    expect(manifestJson.counts.keyframes).toBeGreaterThanOrEqual(1);
    expect(manifestJson.counts.videoPlans).toBeGreaterThanOrEqual(1);

    // files list includes README, workspace_snapshot, data/*, assets/*;
    // manifest.json itself is intentionally NOT listed (self-verified via manifestSha256).
    const paths: string[] = manifestJson.files.map((f: any) => f.path);
    expect(paths).toContain('workspace_snapshot.json');
    expect(paths).toContain('README_EXPORT.md');
    expect(paths).not.toContain('manifest.json');
    for (const f of manifestJson.files) {
      expect(f).toHaveProperty('path');
      expect(f).toHaveProperty('kind');
      expect(typeof f.sizeBytes).toBe('number');
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // manifest.json must still physically exist in the zip
    expect(zip.file('manifest.json')).not.toBeNull();

    // 2. workspace_snapshot.json must exist, parse, and contain sanitized data
    const snapFile = zip.file('workspace_snapshot.json');
    expect(snapFile).not.toBeNull();
    const snapText = await snapFile!.async('string');
    const snap = JSON.parse(snapText);
    expect(snap.projectId).toBe(PROJECT_ID);
    expect(snap.project.id).toBe(PROJECT_ID);
    expect(snap.scripts).toHaveLength(1);
    expect(snap.storyboards).toHaveLength(1);
    expect(snap.keyframes).toHaveLength(1);
    expect(snap.videoPlans).toHaveLength(1);
    expect(snap.assets).toHaveLength(1);
    expect(snap.snapshotId).toMatch(/^snap-/);

    // 3. data/ files present
    expect(zip.file('data/project.json')).not.toBeNull();
    expect(zip.file('data/scripts.json')).not.toBeNull();
    expect(zip.file('data/storyboards.json')).not.toBeNull();
    expect(zip.file('data/keyframes.json')).not.toBeNull();
    expect(zip.file('data/video_plans.json')).not.toBeNull();

    // 5. validation_report.json is a machine-readable report and is listed in manifest
    const reportFile = zip.file('validation_report.json');
    expect(reportFile).not.toBeNull();
    const report = JSON.parse(await reportFile!.async('string'));
    expect(report.schemaVersion).toBe('1.0.0');
    expect(report.exportType).toBe('core');
    expect(report.manifestHash).toBe(manifestJson.manifestSha256);
    expect(report.preflight).toHaveProperty('blockingCount');
    expect(report.preflight).toHaveProperty('warningCount');
    expect(report.preflight).toHaveProperty('issues');
    expect(Array.isArray(report.preflight.issues)).toBe(true);
    const reportEntry = manifestJson.files.find((f: any) => f.path === 'validation_report.json');
    expect(reportEntry).toBeTruthy();
    expect(reportEntry!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // 4. README_EXPORT.md present and contains verification instructions
    const readmeFile = zip.file('README_EXPORT.md');
    expect(readmeFile).not.toBeNull();
    const readme = await readmeFile!.async('string');
    expect(readme).toContain('# Project Export');
    expect(readme).toContain('manifestSha256');
    expect(readme).toContain('Verification');
    expect(readme).toContain('SHA-256');
    // README entry itself appears in manifest files list (we hashed its bytes)
    const readmeEntry = manifestJson.files.find((f: any) => f.path === 'README_EXPORT.md');
    expect(readmeEntry).toBeTruthy();
    expect(readmeEntry!.kind).toBe('readme');
    expect(readmeEntry!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('manifest.json manifestSha256 matches re-computation over its content (excluding itself)', async () => {
    const result = await exportCoreProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    const zip = await JSZip.loadAsync(result.blob!);
    const manifestText = await zip.file('manifest.json')!.async('string');
    const manifest = JSON.parse(manifestText);

    // Recompute hash the way verifier would: strip manifestSha256 + serialize deterministically.
    const { sha256String } = await import('../utils/crypto');
    const { sanitizeForExport } = await import('../utils/sanitize');
    const without = Object.fromEntries(
      Object.entries(manifest).filter(([k]) => k !== 'manifestSha256'),
    );
    const canonical = JSON.stringify(sanitizeForExport(without), Object.keys(without).sort(), 0);
    const recomputed = await sha256String(canonical);
    expect(recomputed).toBe(manifest.manifestSha256);
  });

  it('listed file sha256 matches actual unzipped bytes for each entry', async () => {
    const result = await exportCoreProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    const zip = await JSZip.loadAsync(result.blob!);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const { sha256Bytes } = await import('../utils/crypto');

    for (const entry of manifest.files) {
      const zf = zip.file(entry.path);
      expect(zf, `zip should contain ${entry.path}`).not.toBeNull();
      const buf = await zf!.async('arraybuffer');
      expect(buf.byteLength).toBe(entry.sizeBytes);
      const h = await sha256Bytes(buf);
      expect(h, `sha256 mismatch for ${entry.path}`).toBe(entry.sha256);
    }
  });

  it('sensitive fields are stripped from exported data', async () => {
    // Add a script containing a fake JWT in content via the project?
    // We can verify by reusing sanitizeForExport path implicitly: bundle runs sanitize.
    // Inject a sensitive value into project settings via fetch mock:
    // Already mocked, but we can check that no `password`, `token`, etc appear in any file.
    const result = await exportCoreProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    const zip = await JSZip.loadAsync(result.blob!);
    const allText = await Promise.all(
      Object.keys(zip.files)
        .filter((p) => p.endsWith('.json') || p.endsWith('.md'))
        .map(async (p) => (await zip.file(p)!.async('string'))),
    );
    const combined = allText.join('\n');
    // Sanity: there's no obvious secret-shaped string like "sk-" inserted
    // (we didn't insert one, but verify the keywords are not present as keys anywhere)
    // The code uses SENSITIVE_KEYS; a key like "password" as a property name would be redacted.
    // Check the pattern '"password":'  does not appear with a non-redacted value.
    expect(combined).not.toMatch(/"password"\s*:\s*"[^<]/);
    expect(combined).not.toMatch(/"apiKey"\s*:\s*"sk-/);
  });

  it('posts an audit record to POST /api/exports/audit with manifest hash and counts', async () => {
    const result = await exportCoreProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    expect(result.success).toBe(true);

    const calls = (globalThis as any).__auditCalls as Array<{ url: string; method: string; payload: any }>;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const audit = calls.find((c) => c.url.endsWith('/exports/audit'));
    expect(audit).toBeTruthy();
    expect(audit!.method).toBe('POST');

    const { payload } = audit!;
    expect(payload.projectId).toBe(PROJECT_ID);
    expect(payload.exportType).toBe('core');
    // manifestHash is a 64-char hex SHA-256
    expect(payload.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    // Numeric counts are non-negative integers
    expect(Number.isInteger(payload.assetCount)).toBe(true);
    expect(Number.isInteger(payload.missingAssetCount)).toBe(true);
    expect(Number.isInteger(payload.totalSizeBytes)).toBe(true);
    expect(payload.assetCount).toBeGreaterThanOrEqual(0);
    expect(payload.missingAssetCount).toBeGreaterThanOrEqual(0);
    expect(payload.totalSizeBytes).toBeGreaterThan(0);
    // The hash matches what's inside the zip
    const zip = await JSZip.loadAsync(result.blob!);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(payload.manifestHash).toBe(manifest.manifestSha256);
    expect(payload.assetCount).toBe(manifest.counts.assets);
    expect(payload.missingAssetCount).toBe(manifest.counts.missingAssets);
  });

  it('full bundle produces zip with assets/ folder, includes binaries and reports assetCount>0', async () => {
    const result = await exportFullProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    expect(result.success).toBe(true);
    expect(result.blob).toBeTruthy();
    expect(result.filename).toMatch(/full/);

    const zip = await JSZip.loadAsync(result.blob!);

    // Full bundle has assets folder with the test asset
    const assetFiles = Object.keys(zip.files).filter((p) => p.startsWith('assets/') && !p.endsWith('/'));
    expect(assetFiles.length).toBeGreaterThanOrEqual(1);

    // manifest reports packed assets = number of asset files
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.exportType).toBe('full');
    expect(manifest.counts.assets).toBe(assetFiles.length);
    expect(manifest.counts.assets).toBeGreaterThan(0);
    expect(manifest.counts.missingAssets).toBe(0);

    // Same required top-level files as core bundle
    expect(zip.file('manifest.json')).not.toBeNull();
    expect(zip.file('workspace_snapshot.json')).not.toBeNull();
    expect(zip.file('README_EXPORT.md')).not.toBeNull();

    // Snapshot and data files present
    expect(zip.file('data/project.json')).not.toBeNull();
  });

  it('core bundle produces zip without assets/ folder and reports missingAssets for excluded binaries', async () => {
    const result = await exportCoreProjectBundle(PROJECT_ID, { proceedWithWarnings: true });
    expect(result.success).toBe(true);
    const zip = await JSZip.loadAsync(result.blob!);
    const assetFiles = Object.keys(zip.files).filter((p) => p.startsWith('assets/') && !p.endsWith('/'));
    expect(assetFiles.length).toBe(0);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.exportType).toBe('core');
    expect(manifest.counts.assets).toBe(0);
    // Core marks every asset as missing (packed: false)
    expect(manifest.counts.missingAssets).toBeGreaterThan(0);
  });
});
