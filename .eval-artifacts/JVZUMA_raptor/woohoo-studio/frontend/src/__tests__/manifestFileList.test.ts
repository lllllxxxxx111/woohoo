// Additional manifest / file-list / hash integrity tests
import { describe, it, expect } from 'vitest';
import {
  buildManifest, manifestToJson, validateManifestJson,
  computeAssetHashes, blobToUint8Array,
} from '../utils/exportManifest';
import { sha256String } from '../utils/crypto';
import type { Project, Asset, AssetType } from '../types';
import type { AssetEntry } from '../assets/AssetRepository';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p', name: 'P', ownerId: 'u',
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAsset(
  id: string, name: string, type: AssetType = 'image',
  overrides: Partial<Asset> = {},
): Asset {
  return {
    id, projectId: 'p', name, type,
    url: `http://cdn/${name}`, sizeBytes: 0, mimeType: 'application/octet-stream',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('manifest file list', () => {
  it('lists every jsonFileEntry with kind=json and a sha256', async () => {
    const files = [
      { path: 'project.json', content: '{"id":"p"}', sizeBytes: 11 },
      { path: 'scripts.json', content: '[]', sizeBytes: 2 },
      { path: 'README.txt', content: 'hello', sizeBytes: 5 },
    ];
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'core', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [], jsonFileEntries: files, packagedAssetFiles: [],
      extraMetaFileCount: 0,
    });
    expect(m.files).toHaveLength(3);
    const byPath = Object.fromEntries(m.files.map((f) => [f.path, f]));
    expect(byPath['project.json'].kind).toBe('json');
    expect(byPath['scripts.json'].kind).toBe('json');
    expect(byPath['README.txt'].kind).toBe('document');
    for (const f of m.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('lists packaged assets under assets/ with kind=asset', async () => {
    const blob = new Blob(['image-bytes'], { type: 'image/png' });
    const asset = makeAsset('a1', 'img.png', 'image', { url: 'http://cdn/img.png', sizeBytes: blob.size, mimeType: 'image/png' });
    const entries: AssetEntry[] = [{ asset, blob, downloaded: true }];
    const packaged = [{ assetId: 'a1', path: 'assets/image/img.png', blob }];
    const hashes = await computeAssetHashes(packaged);
    asset.sha256 = hashes.get('a1');

    const m = await buildManifest({
      project: makeProject(),
      exportType: 'full', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: entries,
      jsonFileEntries: [{ path: 'project.json', content: '{}', sizeBytes: 2 }],
      packagedAssetFiles: packaged,
    });
    const fileEntry = m.files.find((f) => f.path === 'assets/image/img.png');
    expect(fileEntry).toBeDefined();
    expect(fileEntry!.kind).toBe('asset');
    expect(fileEntry!.sizeBytes).toBe(blob.size);
    expect(fileEntry!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // asset manifest entry must show packaged=true and packagedPath
    const am = m.assets.find((a) => a.assetId === 'a1')!;
    expect(am.packaged).toBe(true);
    expect(am.packagedPath).toBe('assets/image/img.png');
    expect(am.sha256).toBe(fileEntry!.sha256);
    expect(m.missingAssets).toEqual([]);
  });

  it('marks failed-download assets as missing and excludes them from files[]', async () => {
    const asset = {
      id: 'a-bad', projectId: 'p', name: 'x.png', type: 'image' as const,
      url: 'http://x', sizeBytes: 0, mimeType: 'image/png',
      createdAt: '2024-01-01T00:00:00Z',
    };
    const entries: AssetEntry[] = [
      { asset, downloaded: false, downloadError: '404 Not Found' },
    ];
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'full', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: entries,
      jsonFileEntries: [{ path: 'project.json', content: '{}', sizeBytes: 2 }],
      packagedAssetFiles: [],
    });
    expect(m.missingAssets).toEqual(['a-bad']);
    expect(m.assets[0].packaged).toBe(false);
    expect(m.assets[0].failureReason).toBe('404 Not Found');
    // no asset file entry for failed asset
    expect(m.files.find((f) => f.kind === 'asset')).toBeUndefined();
    expect(m.counts.missingAssets).toBe(1);
    expect(m.counts.packagedAssets).toBe(0);
  });

  it('accounts for extraMetaFileCount in counts.totalFiles', async () => {
    const jsonFiles = [
      { path: 'project.json', content: '{}', sizeBytes: 2 },
    ];
    const m3 = await buildManifest({
      project: makeProject(),
      exportType: 'core', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [], jsonFileEntries: jsonFiles, packagedAssetFiles: [],
      extraMetaFileCount: 3,
    });
    expect(m3.counts.totalFiles).toBe(1 + 3); // 1 json + 3 meta
    // jsonFiles counts manifest itself as +1 when extraMeta > 0
    expect(m3.counts.jsonFiles).toBe(2); // project.json + manifest.json
  });

  it('file sha256 matches recomputed over the same content', async () => {
    const content = '{"hello":"world"}';
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'core', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [],
      jsonFileEntries: [{ path: 'project.json', content, sizeBytes: content.length }],
      packagedAssetFiles: [],
      extraMetaFileCount: 0,
    });
    const expected = await sha256String(content);
    expect(m.files[0].sha256).toBe(expected);
  });
});

describe('manifest hash', () => {
  it('manifestHash is a 64-char hex string', async () => {
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'core', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [], jsonFileEntries: [], packagedAssetFiles: [],
    });
    expect(m.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('manifestHash is reproducible by deleting the manifestHash key and re-serializing', async () => {
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'core', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [],
      jsonFileEntries: [{ path: 'project.json', content: '{}', sizeBytes: 2 }],
      packagedAssetFiles: [], extraMetaFileCount: 0,
    });
    // Rebuild the exact string used: serialize manifest without manifestHash key
    const { manifestHash: _omit, ...rest } = m;
    const expected = await sha256String(JSON.stringify(rest));
    expect(m.manifestHash).toBe(expected);
  });

  it('changes when project name changes', async () => {
    const base = {
      exportType: 'core' as const, scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [], jsonFileEntries: [], packagedAssetFiles: [], extraMetaFileCount: 0,
    };
    const m1 = await buildManifest({ ...base, project: makeProject({ name: 'A' }) });
    const m2 = await buildManifest({ ...base, project: makeProject({ name: 'B' }) });
    expect(m1.manifestHash).not.toBe(m2.manifestHash);
  });

  it('manifestToJson round-trips through JSON.parse', async () => {
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'full', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [],
      jsonFileEntries: [{ path: 'project.json', content: '{}', sizeBytes: 2 }],
      packagedAssetFiles: [],
    });
    const json = manifestToJson(m);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.manifestHash).toBe(m.manifestHash);
    expect(parsed.projectId).toBe(m.projectId);
    expect(Array.isArray(parsed.files)).toBe(true);
  });
});

describe('validateManifestJson', () => {
  it('accepts a freshly-built manifest serialized via manifestToJson', async () => {
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'core', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [],
      jsonFileEntries: [{ path: 'project.json', content: '{}', sizeBytes: 2 }],
      packagedAssetFiles: [],
    });
    const r = validateManifestJson(manifestToJson(m));
    expect(r.valid).toBe(true);
  });

  it('rejects JSON missing counts', () => {
    const r = validateManifestJson(JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'p', projectName: 'P',
      exportedAt: '2024-01-01', exportType: 'core', manifestHash: 'a'.repeat(64),
      files: [], assets: [], missingAssets: [], pipelineSummary: {},
      tool: { name: 'Woohoo Studio', version: '0.3.0' },
    }));
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/counts/);
  });

  it('rejects a manifestHash that is not 64 hex chars', async () => {
    const m = await buildManifest({
      project: makeProject(), exportType: 'core',
      scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: [], jsonFileEntries: [], packagedAssetFiles: [],
    });
    const bad = { ...m, manifestHash: 'tooshort' };
    const r = validateManifestJson(JSON.stringify(bad));
    expect(r.valid).toBe(false);
  });
});

describe('computeAssetHashes / blob helpers', () => {
  it('computes a 64-char hex hash for a Blob input', async () => {
    const blob = new Blob(['hello world'], { type: 'text/plain' });
    const hashes = await computeAssetHashes([{ assetId: 'x', path: 'a.txt', blob }]);
    const hash = hashes.get('x');
    expect(hash).toBeDefined();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces identical hashes for identical Blob content', async () => {
    const blob1 = new Blob(['deterministic-content']);
    const blob2 = new Blob(['deterministic-content']);
    const h1 = await computeAssetHashes([{ assetId: 'a', path: 'a', blob: blob1 }]);
    const h2 = await computeAssetHashes([{ assetId: 'b', path: 'b', blob: blob2 }]);
    expect(h1.get('a')).toBe(h2.get('b'));
  });

  it('produces different hashes for different Blob content', async () => {
    const h1 = await computeAssetHashes([{ assetId: 'a', path: 'a', blob: new Blob(['one']) }]);
    const h2 = await computeAssetHashes([{ assetId: 'b', path: 'b', blob: new Blob(['two']) }]);
    expect(h1.get('a')).not.toBe(h2.get('b'));
  });

  it('blobToUint8Array returns bytes with correct length and content', async () => {
    const blob = new Blob(['abc']);
    const u8 = await blobToUint8Array(blob);
    expect(u8.length).toBe(3);
    expect(u8[0]).toBe(97); // 'a'
    expect(u8[1]).toBe(98);
    expect(u8[2]).toBe(99);
  });

  it('blobToUint8Array works with larger blobs', async () => {
    const data = new Uint8Array(1024);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    const blob = new Blob([data]);
    const out = await blobToUint8Array(blob);
    expect(out.length).toBe(1024);
    expect(out[0]).toBe(0);
    expect(out[255]).toBe(255);
    expect(out[256]).toBe(0);
  });
});

describe('manifest counts reflect added items', () => {
  it('counts scripts/storyboards/keyframes/videoPlans from context', async () => {
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'full',
      scripts: [{ id: 's1' }, { id: 's2' }] as any,
      storyboards: [{ id: 'sb1' }] as any,
      keyframes: [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }] as any,
      videoPlans: [{ id: 'v1' }, { id: 'v2' }] as any,
      assetEntries: [],
      jsonFileEntries: [{ path: 'project.json', content: '{}', sizeBytes: 2 }],
      packagedAssetFiles: [],
      extraMetaFileCount: 0,
    });
    expect(m.counts.scripts).toBe(2);
    expect(m.counts.storyboards).toBe(1);
    expect(m.counts.keyframes).toBe(3);
    expect(m.counts.videoPlans).toBe(2);
    expect(m.counts.totalAssets).toBe(0);
  });

  it('counts.assetFiles equals number of packaged files', async () => {
    const b1 = new Blob(['a']);
    const b2 = new Blob(['bb']);
    const a1 = makeAsset('a1', 'a1.png');
    const a2 = makeAsset('a2', 'a2.png');
    const miss = makeAsset('a3', 'a3.png');
    const entries: AssetEntry[] = [
      { asset: a1, blob: b1, downloaded: true },
      { asset: a2, blob: b2, downloaded: true },
      { asset: miss, downloaded: false, downloadError: 'nope' },
    ];
    const packaged = [
      { assetId: 'a1', path: 'assets/image/a1.png', blob: b1 },
      { assetId: 'a2', path: 'assets/image/a2.png', blob: b2 },
    ];
    const hashes = await computeAssetHashes(packaged);
    a1.sha256 = hashes.get('a1');
    a2.sha256 = hashes.get('a2');
    const m = await buildManifest({
      project: makeProject(),
      exportType: 'full', scripts: [], storyboards: [], keyframes: [], videoPlans: [],
      assetEntries: entries,
      jsonFileEntries: [{ path: 'project.json', content: '{}', sizeBytes: 2 }],
      packagedAssetFiles: packaged, extraMetaFileCount: 0,
    });
    expect(m.counts.assetFiles).toBe(2);
    expect(m.counts.packagedAssets).toBe(2);
    expect(m.counts.missingAssets).toBe(1);
    expect(m.counts.totalAssets).toBe(3);
  });
});
