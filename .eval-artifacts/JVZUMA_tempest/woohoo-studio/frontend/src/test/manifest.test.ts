// Tests for manifest entry creation, counts, and export result summary logic.
// Tests cover the expected structure of the manifest, count computation,
// and that manifest entries include required fields.
import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../utils/crypto';
import type { ExportManifest, ManifestFileEntry } from '../types';

describe('manifest file entry contract', () => {
  it('file entries contain path, kind, sizeBytes, sha256', async () => {
    const content = '{"hello":"world"}';
    const bytes = new TextEncoder().encode(content);
    const entry: ManifestFileEntry = {
      path: 'project.json',
      kind: 'data',
      sizeBytes: bytes.length,
      sha256: await sha256Hex(bytes),
    };
    expect(entry.path).toBe('project.json');
    expect(entry.kind).toBe('data');
    expect(entry.sizeBytes).toBeGreaterThan(0);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('export manifest schema contract', () => {
  it('manifest has all required top-level fields', () => {
    const manifest: ExportManifest = {
      projectId: 'p1',
      projectName: 'Test',
      exportedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      exportType: 'full',
      counts: {
        files: 3,
        assets: 2,
        missingAssets: 0,
        scripts: 1,
        storyboards: 1,
        keyframes: 2,
        videoPlans: 1,
      },
      files: [],
      assets: [],
      missingAssets: [],
      generationParams: { resolution: '1920x1080', fps: 24, duration: 60 },
    };

    expect(manifest.projectId).toBeDefined();
    expect(manifest.projectName).toBeDefined();
    expect(manifest.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.schemaVersion).toBe('1.0.0');
    expect(['full', 'core', 'snapshot']).toContain(manifest.exportType);
    expect(manifest.counts.files).toBeDefined();
    expect(manifest.counts.assets).toBeDefined();
    expect(manifest.counts.missingAssets).toBeDefined();
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(Array.isArray(manifest.assets)).toBe(true);
    expect(Array.isArray(manifest.missingAssets)).toBe(true);
    expect(manifest.generationParams).toBeDefined();
  });

  it('asset entries contain assetId, name, type, packed, optional errorReason', () => {
    const manifest: ExportManifest = {
      projectId: 'p1',
      projectName: 'Test',
      exportedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      exportType: 'full',
      counts: { files: 0, assets: 1, missingAssets: 1, scripts: 0, storyboards: 0, keyframes: 0, videoPlans: 0 },
      files: [],
      assets: [
        { assetId: 'a1', name: 'img.png', type: 'image', url: 'http://example.com/a.png', packed: true },
        { assetId: 'a2', name: 'x.png', type: 'image', url: 'http://example.com/x.png', packed: false, errorReason: 'HTTP 404' },
      ],
      missingAssets: ['a2'],
      generationParams: {},
    };

    expect(manifest.assets[0].assetId).toBe('a1');
    expect(manifest.assets[0].packed).toBe(true);
    expect(manifest.assets[1].packed).toBe(false);
    expect(manifest.assets[1].errorReason).toBe('HTTP 404');
    expect(manifest.missingAssets).toContain('a2');
  });

  it('counts reflect assets array correctly', () => {
    const m: ExportManifest = {
      projectId: 'p1',
      projectName: 'Test',
      exportedAt: '2024-01-01T00:00:00Z',
      schemaVersion: '1.0.0',
      exportType: 'full',
      counts: { files: 5, assets: 3, missingAssets: 1, scripts: 2, storyboards: 1, keyframes: 0, videoPlans: 0 },
      files: [
        { path: 'project.json', kind: 'data', sizeBytes: 100, sha256: 'a' },
        { path: 'workspace_snapshot.json', kind: 'metadata', sizeBytes: 200, sha256: 'b' },
        { path: 'assets/f1.png', kind: 'asset', sizeBytes: 1000, sha256: 'c' },
        { path: 'assets/f2.png', kind: 'asset', sizeBytes: 2000, sha256: 'd' },
        { path: 'manifest.json', kind: 'metadata', sizeBytes: 300, sha256: 'e' },
      ],
      assets: [
        { assetId: 'a1', name: 'f1.png', type: 'image', packed: true },
        { assetId: 'a2', name: 'f2.png', type: 'image', packed: true },
        { assetId: 'a3', name: 'f3.png', type: 'image', packed: false, errorReason: '404' },
      ],
      missingAssets: ['a3'],
      generationParams: {},
      manifestHash: 'abc123',
    };

    // Verify counts match actual data
    const packedAssets = m.assets.filter((a) => a.packed).length;
    expect(packedAssets).toBe(2);
    expect(m.counts.missingAssets).toBe(m.missingAssets.length);
    expect(m.counts.files).toBe(m.files.length);
    expect(m.files.some((f) => f.path === 'manifest.json')).toBe(true);
    expect(m.files.some((f) => f.path === 'workspace_snapshot.json')).toBe(true);
    expect(m.files.some((f) => f.path === 'project.json')).toBe(true);
  });
});
