// Tests for manifest file-list invariants and hash determinism.
// Builds real bundles with empty/simple data (no data: URLs, because jsdom's fetch
// cannot resolve those into Blobs) and inspects the manifest against the ZIP.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildExportBundle } from '../utils/exportBundle';
import { sha256Hex, computeManifestHash } from '../utils/crypto';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

function makeProject(name = 'Manifest Audit'): Project {
  return {
    id: 'ma-proj', name, userId: 'u', createdAt: '', updatedAt: '',
  };
}

async function build(opts: {
  exportType?: 'full' | 'core' | 'snapshot';
  scripts?: Script[];
  assets?: Asset[];
} = {}) {
  const project = makeProject();
  const scripts = opts.scripts ?? [
    { id: 's1', projectId: project.id, title: 'Intro', content: 'A scene.', createdAt: '', updatedAt: '' },
  ];
  const storyboards: Storyboard[] = [
    { id: 'sb1', projectId: project.id, title: 'SB1', scenes: [{ id: 'sc1', description: 'd' }], createdAt: '', updatedAt: '' } as unknown as Storyboard,
  ];
  const keyframes: Keyframe[] = [];
  const videoPlans: VideoPlan[] = [
    { id: 'vp1', projectId: project.id, config: { resolution: '1080p', fps: 24, duration: 5 }, createdAt: '' },
  ];
  // Use http URLs that will fail to resolve in jsdom — assets are listed but not packed
  // (we only check manifest invariants here; actual binary pack tests are in bundleIntegration).
  const assets = opts.assets ?? [];
  return buildExportBundle({
    project, scripts, storyboards, keyframes, videoPlans, assets,
    exportType: opts.exportType ?? 'full',
  });
}

describe('manifest file-list invariants', () => {
  it('every file entry has non-empty path, known kind, non-negative sizeBytes, 64-hex sha256', async () => {
    const { manifest } = await build();
    const KNOWN_KINDS = ['data', 'metadata', 'asset', 'document', 'script', 'storyboard', 'config', 'keyframe'];
    for (const f of manifest.files) {
      expect(f.path.length).toBeGreaterThan(0);
      expect(KNOWN_KINDS).toContain(f.kind);
      expect(f.sizeBytes).toBeGreaterThanOrEqual(0);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('file paths are unique (no duplicate entries)', async () => {
    const { manifest } = await build();
    const paths = manifest.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('file paths never start with "/" or contain ".." or backslashes (no path traversal)', async () => {
    const { manifest } = await build();
    for (const f of manifest.files) {
      expect(f.path).not.toMatch(/^\//);
      expect(f.path).not.toContain('..');
      expect(f.path).not.toContain('\\');
    }
  });

  it('manifest lists itself (manifest.json) exactly once, with kind=metadata', async () => {
    const { manifest } = await build();
    const selfEntries = manifest.files.filter((f) => f.path === 'manifest.json');
    expect(selfEntries).toHaveLength(1);
    expect(selfEntries[0].kind).toBe('metadata');
    expect(selfEntries[0].sizeBytes).toBeGreaterThan(0);
  });

  it('lists workspace_snapshot.json and project.json with correct kinds', async () => {
    const { manifest } = await build();
    const snap = manifest.files.find((f) => f.path === 'workspace_snapshot.json');
    const proj = manifest.files.find((f) => f.path === 'project.json');
    expect(snap?.kind).toBe('metadata');
    expect(proj?.kind).toBe('data');
  });

  it('asset metadata entries exist in manifest.assets even if no files were packed', async () => {
    const assets: Asset[] = [
      { id: 'a1', projectId: 'ma-proj', name: 'x.png', type: 'image', url: 'http://127.0.0.1:1/x', createdAt: '' },
      { id: 'a2', projectId: 'ma-proj', name: 'y.mp4', type: 'video', url: 'http://127.0.0.1:1/y', createdAt: '' },
    ];
    const { manifest } = await build({ assets });
    expect(manifest.assets).toHaveLength(2);
    for (const a of manifest.assets) {
      expect(a.assetId).toMatch(/^a[12]$/);
      expect(a.packed).toBe(false); // http fetch fails in jsdom
      expect(typeof a.errorReason).toBe('string');
    }
    expect(manifest.counts.assets).toBe(2);
    expect(manifest.counts.missingAssets).toBe(2);
    expect(manifest.missingAssets).toEqual(expect.arrayContaining(['a1', 'a2']));
  });

  it('reported counts.files equals actual files array length', async () => {
    const { manifest } = await build();
    expect(manifest.counts.files).toBe(manifest.files.length);
  });

  it('reported counts.assets equals assets array length and matches packed + missing', async () => {
    const { manifest } = await build({ assets: [] });
    expect(manifest.counts.assets).toBe(0);
    expect(manifest.assets).toHaveLength(0);
    expect(manifest.missingAssets).toHaveLength(0);
  });

  it('each non-asset file entry sha256 matches the actual bytes inside the ZIP', async () => {
    const { blob, manifest } = await build();
    const zip = await JSZip.loadAsync(blob);
    for (const f of manifest.files) {
      // Skip asset files (none packed in this test due to http-only asset URLs)
      if (f.path.startsWith('assets/')) continue;
      const zf = zip.file(f.path);
      if (!zf) throw new Error(`ZIP missing file declared in manifest: ${f.path}`);
      const bytes = await zf.async('uint8array');
      expect(bytes.length).toBe(f.sizeBytes);
      const actualHash = await sha256Hex(bytes);
      expect(actualHash).toBe(f.sha256);
    }
  });
});

describe('manifest hash', () => {
  it('is a 64-char lowercase hex string', async () => {
    const { manifest } = await build();
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('manifest.manifestHash equals content hash over core payload files (project/snapshot/assets, not reports which embed the hash itself)', async () => {
    const { manifest } = await build();
    // Core payload files are everything except manifest.json itself and the report/README docs
    // (reports embed the hash so they can't be part of the hash input)
    const corePayload = manifest.files.filter(
      (f) => f.path !== 'manifest.json' && f.path !== 'validation_report.md' && f.path !== 'README_EXPORT.md',
    );
    const computed = await computeManifestHash(
      corePayload.map((f) => ({ path: f.path, sha256: f.sha256 })),
    );
    expect(manifest.manifestHash).toBe(computed);
  });

  it('computeManifestHash is order-independent (sorts internally)', async () => {
    const ordered = [{ path: 'a.txt', sha256: 'aaa' }, { path: 'b.txt', sha256: 'bbb' }];
    const reversed = [{ path: 'b.txt', sha256: 'bbb' }, { path: 'a.txt', sha256: 'aaa' }];
    expect(await computeManifestHash(ordered)).toBe(await computeManifestHash(reversed));
  });

  it('only looks at path+sha256 fields (extra fields ignored)', async () => {
    const base = [{ path: 'a.txt', sha256: 'aaa' }];
    const extra = [{ path: 'a.txt', sha256: 'aaa', sizeBytes: 999, kind: 'data' as const, foo: 'bar' }];
    expect(await computeManifestHash(base)).toBe(await computeManifestHash(extra as unknown as typeof base));
  });

  it('changes when a file path changes even if sha256 stays the same', async () => {
    const a = [{ path: 'a.txt', sha256: 'aaa' }];
    const b = [{ path: 'b.txt', sha256: 'aaa' }];
    expect(await computeManifestHash(a)).not.toBe(await computeManifestHash(b));
  });

  it('changes when a file content (sha256) changes even if path stays same', async () => {
    const a = [{ path: 'a.txt', sha256: 'aaa' }];
    const b = [{ path: 'a.txt', sha256: 'bbb' }];
    expect(await computeManifestHash(a)).not.toBe(await computeManifestHash(b));
  });
});
