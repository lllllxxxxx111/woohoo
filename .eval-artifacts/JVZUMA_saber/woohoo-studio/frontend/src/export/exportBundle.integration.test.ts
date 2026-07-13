// End-to-end integration tests: actually invoke exportFullProjectBundle,
// generate a ZIP in memory, open it with JSZip, and verify files exist and
// checksums match. These tests prove the ZIP actually contains manifest.json,
// workspace_snapshot.json, etc. — not just that code paths exist.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import JSZip from 'jszip';
import { exportFullProjectBundle, exportCoreProjectBundle } from './exportBundle';
import { sha256Hex } from './integrity';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset, ExportManifest } from '../types';

// Mock serverApi so we don't hit network
vi.mock('../api/serverApi', () => ({
  serverApi: {
    exportAudit: {
      record: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      listByProject: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
    },
    projects: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), snapshot: vi.fn() },
    assets: { list: vi.fn(), downloadUrl: vi.fn(), upload: vi.fn() },
  },
}));

// Mock asset download to return a tiny in-memory blob (avoids network/data URL issues)
vi.mock('../assets/handlers', async () => {
  const actual = await vi.importActual<typeof import('../assets/handlers')>('../assets/handlers');
  return {
    ...actual,
    downloadAssetWithFallback: vi.fn().mockResolvedValue({
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])], { type: 'image/png' }),
    }),
  };
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-e2e-1',
    name: 'E2E Test Project',
    userId: 'user-1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeScripts(): Script[] {
  return [{
    id: 's1', projectId: 'proj-e2e-1', sceneIndex: 1,
    title: 'Opening', content: 'INT. ROOM - DAY\nHello world.',
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  }];
}

function makeStoryboards(): Storyboard[] {
  return [{
    id: 'sb1', projectId: 'proj-e2e-1', sceneId: 's1', order: 1,
    title: 'Wide shot', description: 'Camera pans across the room',
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  }];
}

function makeKeyframes(): Keyframe[] {
  return [{
    id: 'kf1', projectId: 'proj-e2e-1', storyboardId: 'sb1', order: 1,
    imageUrl: 'https://example.com/kf.png',
    prompt: 'a cozy room, daylight',
    parameters: { steps: 30, cfg: 7.5, seed: 42 },
    createdAt: '2024-01-01T00:00:00Z',
  }];
}

function makeVideoPlans(): VideoPlan[] {
  return [{
    id: 'vp1', projectId: 'proj-e2e-1',
    name: 'Main plan',
    settings: { resolution: '1920x1080', fps: 24, duration: 60, style: 'cinematic' },
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  }];
}

// Assets use valid URLs (preflight) but download is mocked
function makeAssets(): Asset[] {
  return [{
    id: 'a1', projectId: 'proj-e2e-1',
    name: 'reference.png',
    type: 'image',
    url: 'https://example.com/reference.png',
    uploadedAt: '2024-01-01T00:00:00Z',
  }];
}

// Helper: extract a file from opened zip as text + bytes
async function readZipFile(zip: JSZip, path: string): Promise<{ text: string; bytes: Uint8Array }> {
  const file = zip.file(path);
  expect(file, `Expected file ${path} to exist in ZIP`).toBeTruthy();
  const text = await file!.async('string');
  const arrayBuf = await file!.async('arraybuffer');
  return { text, bytes: new Uint8Array(arrayBuf) };
}

describe('exportFullProjectBundle E2E', () => {
  it('produces a ZIP containing manifest.json, workspace_snapshot.json, README_EXPORT.md, data/*, and assets/*', async () => {
    const result = await exportFullProjectBundle(
      makeProject(), makeScripts(), makeStoryboards(), makeKeyframes(), makeVideoPlans(), makeAssets()
    );

    expect(result.success).toBe(true);
    expect(result.bundleBlob).toBeTruthy();
    // Filename: <sanitized-project-name>_<type>_<timestamp>.zip
    expect(result.bundleFilename).toMatch(/\.zip$/);
    expect(result.bundleFilename).toMatch(/_full_/);
    expect(result.bundleFilename.startsWith('E2E_Test_Project')).toBe(true);
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.packedAssetCount).toBe(1);
    expect(result.missingAssetCount).toBe(0);
    // Blob is non-empty
    expect(result.bundleBlob!.size).toBeGreaterThan(1000);
    expect(result.preflight.passed).toBe(true);

    // Open the ZIP and verify contents
    const zip = await JSZip.loadAsync(result.bundleBlob!);

    // 1. manifest.json exists, parses, has required fields
    const mf = await readZipFile(zip, 'manifest.json');
    expect(mf.text.length).toBeGreaterThan(100);
    const manifest: ExportManifest = JSON.parse(mf.text);
    expect(manifest.schemaVersion).toBe('1.0.0');
    expect(manifest.projectId).toBe('proj-e2e-1');
    expect(manifest.projectName).toBe('E2E Test Project');
    expect(manifest.exportType).toBe('full');
    expect(manifest.generator.name).toBe('woohoo-studio-export');
    expect(manifest.counts.scripts).toBe(1);
    expect(manifest.counts.storyboards).toBe(1);
    expect(manifest.counts.keyframes).toBe(1);
    expect(manifest.counts.videoPlans).toBe(1);
    expect(manifest.counts.assets).toBe(1);
    // Manifest is consistent: packed = total assets in full bundle
    expect(manifest.assets.filter(a => a.packedInBundle)).toHaveLength(result.packedAssetCount);

    // 2. manifest.json's own on-disk sha256 matches returned manifestHash
    const onDiskManifestHash = await sha256Hex(mf.bytes);
    expect(onDiskManifestHash).toBe(result.manifestHash);

    // 3. workspace_snapshot.json exists and is valid JSON
    const snap = await readZipFile(zip, 'workspace_snapshot.json');
    const snapshot = JSON.parse(snap.text);
    expect(snapshot.project.id).toBe('proj-e2e-1');
    expect(snapshot.scripts).toHaveLength(1);
    expect(snapshot.storyboards).toHaveLength(1);
    expect(snapshot.keyframes).toHaveLength(1);
    expect(snapshot.videoPlans).toHaveLength(1);
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.version).toBe('1.0.0');

    // 4. README_EXPORT.md exists and references the manifest hash
    const readme = await readZipFile(zip, 'README_EXPORT.md');
    expect(readme.text).toContain('# E2E Test Project - Export Package');
    expect(readme.text).toContain(result.manifestHash.slice(0, 16));
    expect(readme.text).toContain('How to Verify This Package');
    expect(readme.text).toContain('Security & Privacy');

    // 5. data/ files exist
    for (const name of ['project.json', 'scripts.json', 'storyboards.json', 'keyframes.json', 'video_plans.json', 'assets.json']) {
      const f = await readZipFile(zip, `data/${name}`);
      expect(f.text.length).toBeGreaterThan(0);
      // Should be valid JSON
      JSON.parse(f.text);
    }

    // 6. Asset file exists in assets/
    const assetFile = zip.file(/^assets\//);
    expect(assetFile.length).toBeGreaterThanOrEqual(1);

    // 7. Every file in manifest.files[] has correct sha256 (this is the key
    //    integrity check: manifest claims match actual ZIP contents)
    for (const entry of manifest.files) {
      const { bytes } = await readZipFile(zip, entry.path);
      expect(bytes.length).toBe(entry.sizeBytes);
      const actualHash = await sha256Hex(bytes);
      expect(actualHash).toBe(entry.sha256);
    }

    // 8. manifest.files lists content files (workspace_snapshot, data/*, assets/*)
    //    README_EXPORT.md is human documentation and not in files[] (avoids hash
    //    circularity; manifest.counts.files includes it in total count).
    const manifestPaths = new Set(manifest.files.map((f: { path: string }) => f.path));
    expect(manifestPaths.has('workspace_snapshot.json')).toBe(true);
    expect(manifestPaths.has('data/project.json')).toBe(true);
    expect(manifestPaths.has('data/scripts.json')).toBe(true);
    expect(manifestPaths.has('data/storyboards.json')).toBe(true);
    expect(manifestPaths.has('data/keyframes.json')).toBe(true);
    expect(manifestPaths.has('data/video_plans.json')).toBe(true);
    expect(manifestPaths.has('data/assets.json')).toBe(true);
    // README not in files[] (documented design)
    expect(manifestPaths.has('README_EXPORT.md')).toBe(false);
    // manifest.json not self-listed
    expect(manifestPaths.has('manifest.json')).toBe(false);

    // 8b. But README and manifest files DO exist in the ZIP
    expect(zip.file('README_EXPORT.md')).toBeTruthy();
    expect(zip.file('manifest.json')).toBeTruthy();

    // 8c. counts.files = content files + README + manifest.json itself
    expect(manifest.counts.files).toBe(manifest.files.length + 2);

    // 9. Asset entry is listed in manifest.assets with packedInBundle = true
    const assetEntry = manifest.assets.find(a => a.assetId === 'a1');
    expect(assetEntry).toBeTruthy();
    expect(assetEntry!.packedInBundle).toBe(true);
    expect(assetEntry!.bundlePath).toMatch(/^assets\//);
    expect(assetEntry!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // 10. manifest.counts.files = content files + README_EXPORT.md + manifest.json itself
    expect(manifest.counts.files).toBe(manifest.files.length + 2);

    // 11. No sensitive data leaked in snapshot
    const snapshotStr = JSON.stringify(snapshot);
    expect(snapshotStr).not.toContain('api_key');
    expect(snapshotStr).not.toContain('password');
    expect(snapshotStr).not.toContain('/home/');
    expect(snapshotStr).not.toContain('Bearer ');
  });

  it('core bundle excludes video plans and assets (non-regression)', async () => {
    const result = await exportCoreProjectBundle(
      makeProject(), makeScripts(), makeStoryboards(), makeKeyframes(), makeAssets()
    );
    expect(result.success).toBe(true);
    // Core bundle filename contains _core_
    expect(result.bundleFilename).toMatch(/_core_/);
    expect(result.bundleFilename).toMatch(/\.zip$/);
    // Core bundle packs 0 assets (includeAssets=false)
    expect(result.packedAssetCount).toBe(0);
    // No missing count from download failures (assets not attempted)
    expect(result.missingAssetCount).toBe(0);
    expect(result.bundleBlob).toBeTruthy();

    const zip = await JSZip.loadAsync(result.bundleBlob!);

    // manifest.json exists and marks core
    const mf = await readZipFile(zip, 'manifest.json');
    const manifest: ExportManifest = JSON.parse(mf.text);
    expect(manifest.exportType).toBe('core');
    expect(manifest.counts.videoPlans).toBe(0);
    expect(manifest.counts.assets).toBe(0);

    // workspace_snapshot still exists (backward compat)
    expect(zip.file('workspace_snapshot.json')).toBeTruthy();

    // No video_plans.json in core bundle
    expect(zip.file('data/video_plans.json')).toBeFalsy();

    // No assets/ folder with files
    const assetFiles = zip.file(/^assets\//);
    expect(assetFiles.filter(f => !f.dir)).toHaveLength(0);

    // Assets listed in manifest but marked as not packed
    for (const a of manifest.assets) {
      expect(a.packedInBundle).toBe(false);
      expect(a.failureReason).toBeTruthy(); // explanation for why not packed
    }
  });

  it('returns success=false when preflight blocking issues exist and bypass is false', async () => {
    // Asset with invalid URL triggers blocking
    const badAssets: Asset[] = [{
      id: 'bad', projectId: 'proj-e2e-1',
      name: '',  // empty name is blocking
      type: 'image',
      url: '',
      uploadedAt: '2024-01-01T00:00:00Z',
    }];
    const result = await exportFullProjectBundle(
      makeProject(), makeScripts(), makeStoryboards(), makeKeyframes(), makeVideoPlans(), badAssets
    );
    expect(result.success).toBe(false);
    expect(result.preflight.passed).toBe(false);
    expect(result.preflight.blockingCount).toBeGreaterThan(0);
    expect(result.bundleBlob).toBeUndefined();
  });

  it('force-bypasses blocking issues when requested', async () => {
    const badAssets: Asset[] = [{
      id: 'bad', projectId: 'proj-e2e-1',
      name: '',  // empty name triggers blocking
      type: 'image',
      url: 'https://example.com/x.png', // valid URL, download is mocked to succeed
      uploadedAt: '2024-01-01T00:00:00Z',
    }];
    const result = await exportFullProjectBundle(
      makeProject(), makeScripts(), makeStoryboards(), makeKeyframes(), makeVideoPlans(), badAssets,
      undefined, undefined, true // forceBypassBlocking = true
    );
    expect(result.success).toBe(true);
    expect(result.preflight.blockingCount).toBeGreaterThan(0);
    expect(result.preflight.passed).toBe(false);
    expect(result.bundleBlob).toBeTruthy();
    // With mocked download the asset is packed despite the name warning;
    // the key assertion is that export proceeds despite blocking preflight.
  });

});
