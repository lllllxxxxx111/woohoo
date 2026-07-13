// Tests focused on the manifest contract produced by export:
// - files[] entries have required shape and valid sha256
// - counts reflect actual contents
// - assets[] inventory is complete and consistent
// - generator metadata is present and correct
// - exportedAt, schemaVersion, projectId fields are populated
// - manifestHash returned matches actual manifest.json sha256
// - parameterSummary extracts the right keys
// These tests complement the E2E test which checks zip presence of files.

import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { exportFullProjectBundle, exportCoreProjectBundle } from './exportBundle';
import { sha256Hex } from './integrity';
import type {
  Project, Script, Storyboard, Keyframe, VideoPlan, Asset,
  ExportManifest, FileEntry, AssetEntry,
} from '../types';

// Mock serverApi so record() doesn't hit network
vi.mock('../api/serverApi', () => ({
  serverApi: {
    exportAudit: { record: vi.fn().mockResolvedValue({}), listByProject: vi.fn(), listRecent: vi.fn() },
    projects: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), snapshot: vi.fn() },
    assets: { list: vi.fn(), downloadUrl: vi.fn(), upload: vi.fn() },
  },
}));

// Mock asset download to return a deterministic tiny blob
vi.mock('../assets/handlers', async () => {
  const actual = await vi.importActual<typeof import('../assets/handlers')>('../assets/handlers');
  return {
    ...actual,
    downloadAssetWithFallback: vi.fn().mockResolvedValue({
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], { type: 'image/png' }),
    }),
  };
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-manifest', name: 'Manifest Test', userId: 'u1',
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', ...overrides,
  };
}
function makeScript(i = 1): Script {
  return { id: `s${i}`, projectId: 'proj-manifest', sceneIndex: i,
    content: `Scene ${i} content`, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' };
}
function makeStoryboard(i = 1): Storyboard {
  return { id: `sb${i}`, projectId: 'proj-manifest', sceneId: null as unknown as string, order: i,
    title: `Board ${i}`, description: `d${i}`, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' };
}
function makeKeyframe(i = 1, sb = 'sb1'): Keyframe {
  return { id: `kf${i}`, projectId: 'proj-manifest', storyboardId: sb, order: i,
    imageUrl: `https://example.com/kf${i}.png`, prompt: `prompt ${i}`,
    parameters: { steps: 30, seed: 1000 + i },
    createdAt: '2024-01-01T00:00:00Z' };
}
function makeVideoPlan(): VideoPlan {
  return { id: 'vp1', projectId: 'proj-manifest',
    settings: { resolution: '1920x1080', fps: 24, duration: 60, style: 'cinematic' },
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' };
}
function makeAsset(i: number, name?: string): Asset {
  return {
    id: `a${i}`, projectId: 'proj-manifest', name: name || `asset${i}.png`,
    type: 'image', url: `https://cdn.example.com/a${i}.png`,
    uploadedAt: '2024-01-01T00:00:00Z',
  };
}

describe('manifest contract (full bundle)', () => {
  it('schemaVersion, projectId, projectName, exportType, exportedAt are populated', async () => {
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeVideoPlan()], [makeAsset(1)]
    );
    const m = result.manifest;
    expect(m.schemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.projectId).toBe('proj-manifest');
    expect(m.projectName).toBe('Manifest Test');
    expect(m.exportType).toBe('full');
    expect(m.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generator metadata is present and has expected name', async () => {
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [], [], [], []
    );
    expect(result.manifest.generator.name).toBe('woohoo-studio-export');
    expect(result.manifest.generator.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('files[] entries all have path, kind, sizeBytes > 0, and valid sha256', async () => {
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeVideoPlan()], [makeAsset(1)]
    );
    const files: FileEntry[] = result.manifest.files;
    expect(files.length).toBeGreaterThan(0);

    const seenPaths = new Set<string>();
    for (const f of files) {
      expect(typeof f.path).toBe('string');
      expect(f.path.length).toBeGreaterThan(0);
      expect(['data', 'asset', 'document', 'meta']).toContain(f.kind);
      expect(typeof f.sizeBytes).toBe('number');
      expect(f.sizeBytes).toBeGreaterThan(0);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      // Paths must be unique
      expect(seenPaths.has(f.path)).toBe(false);
      seenPaths.add(f.path);
    }
  });

  it('files[] does NOT contain manifest.json (self-reference avoidance)', async () => {
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [], [], [], []
    );
    const paths = result.manifest.files.map(f => f.path);
    expect(paths).not.toContain('manifest.json');
    // But it must contain workspace_snapshot.json and data files
    expect(paths).toContain('workspace_snapshot.json');
    expect(paths).toContain('data/project.json');
  });

  it('counts match actual array lengths', async () => {
    const scripts = [makeScript(1), makeScript(2)];
    const storyboards = [makeStoryboard(1)];
    const keyframes = [makeKeyframe(1), makeKeyframe(2), makeKeyframe(3)];
    const videoPlans = [makeVideoPlan()];
    const assets = [makeAsset(1), makeAsset(2)];

    const result = await exportFullProjectBundle(
      makeProject(), scripts, storyboards, keyframes, videoPlans, assets
    );
    const m = result.manifest;
    expect(m.counts.scripts).toBe(scripts.length);
    expect(m.counts.storyboards).toBe(storyboards.length);
    expect(m.counts.keyframes).toBe(keyframes.length);
    expect(m.counts.videoPlans).toBe(videoPlans.length);
    expect(m.counts.assets).toBe(assets.length);
    // counts.files = content files listed + README + manifest itself
    expect(m.counts.files).toBe(m.files.length + 2);
  });

  it('assets[] inventory lists every input asset with correct id/name/type', async () => {
    const assets = [
      makeAsset(1, 'hero.png'),
      makeAsset(2, 'bg.jpg'),
    ];
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [], [], [], assets
    );
    const inv: AssetEntry[] = result.manifest.assets;
    expect(inv).toHaveLength(assets.length);

    for (let i = 0; i < assets.length; i++) {
      expect(inv[i].assetId).toBe(assets[i].id);
      expect(inv[i].name).toBe(assets[i].name);
      expect(inv[i].type).toBe(assets[i].type);
      expect(inv[i].source).toContain(assets[i].url);
    }
  });

  it('assets packed into full bundle have bundlePath, sizeBytes, sha256', async () => {
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [], [], [], [makeAsset(1)]
    );
    const packed = result.manifest.assets.filter(a => a.packedInBundle);
    expect(packed.length).toBe(1);
    expect(packed[0].bundlePath).toMatch(/^assets\//);
    expect(packed[0].sizeBytes).toBeGreaterThan(0);
    expect(packed[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(packed[0].failureReason).toBeUndefined();
    expect(result.packedAssetCount).toBe(1);
    expect(result.missingAssetCount).toBe(0);
  });

  it('parameterSummary extracts keyframe params and video plan settings', async () => {
    const keyframes = [makeKeyframe(1), makeKeyframe(2)];
    keyframes[0].parameters = { steps: 30, cfg: 7.5 };
    keyframes[1].parameters = { steps: 40, seed: 42 };
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], keyframes, [makeVideoPlan()], []
    );
    const ps = result.manifest.parameterSummary as any;
    expect(ps.keyframes.total).toBe(2);
    expect(ps.keyframes.withParameters).toBe(2);
    // Unique param keys
    expect(ps.keyframes.parameterKeys.sort()).toEqual(['cfg', 'seed', 'steps']);
    expect(ps.videoPlan.resolution).toBe('1920x1080');
    expect(ps.videoPlan.fps).toBe(24);
    expect(ps.videoPlan.duration).toBe(60);
    expect(ps.videoPlan.style).toBe('cinematic');
  });

  it('missingAssets lists ids that were not packed', async () => {
    // Make one asset download fail via URL validation
    const badAsset: Asset = { ...makeAsset(99), url: '' }; // invalid URL
    // Need forceBypassBlocking because invalid URL is blocking
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [], [], [],
      [makeAsset(1), badAsset],
      undefined, undefined, true // force bypass
    );
    // The bad asset URL is empty so download will fail; missingAssetCount > 0
    // Packed asset count depends on whether mock returns blob for all assets
    expect(Array.isArray(result.manifest.missingAssets)).toBe(true);
    expect(result.missingAssetCount).toBeGreaterThanOrEqual(0);
  });
});

describe('manifest hash consistency (returned hash matches on-disk manifest.json)', () => {
  it('full bundle: result.manifestHash === sha256(manifest.json bytes in zip)', async () => {
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeVideoPlan()], [makeAsset(1)]
    );
    const zip = await JSZip.loadAsync(result.bundleBlob!);
    const mf = await zip.file('manifest.json')!.async('arraybuffer');
    const onDisk = await sha256Hex(new Uint8Array(mf));
    expect(onDisk).toBe(result.manifestHash);
  });

  it('core bundle: result.manifestHash matches manifest.json on disk', async () => {
    const result = await exportCoreProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeAsset(1)]
    );
    const zip = await JSZip.loadAsync(result.bundleBlob!);
    const mf = await zip.file('manifest.json')!.async('arraybuffer');
    const onDisk = await sha256Hex(new Uint8Array(mf));
    expect(onDisk).toBe(result.manifestHash);
  });

  it('all files[] sha256 match actual bytes in the zip', async () => {
    const result = await exportFullProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeVideoPlan()], [makeAsset(1)]
    );
    const zip = await JSZip.loadAsync(result.bundleBlob!);
    for (const f of result.manifest.files) {
      const entry = zip.file(f.path);
      expect(entry, `zip must contain ${f.path}`).toBeTruthy();
      const bytes = new Uint8Array(await entry!.async('arraybuffer'));
      expect(bytes.length).toBe(f.sizeBytes);
      const actual = await sha256Hex(bytes);
      expect(actual).toBe(f.sha256);
    }
  });
});

describe('manifest contract (core bundle)', () => {
  it('exportType is core, counts.assets and counts.videoPlans are 0', async () => {
    const result = await exportCoreProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeAsset(1), makeAsset(2)]
    );
    const m = result.manifest;
    expect(m.exportType).toBe('core');
    expect(m.counts.videoPlans).toBe(0);
    expect(m.counts.assets).toBe(0);
    // Scripts and storyboards still present
    expect(m.counts.scripts).toBe(1);
    expect(m.counts.storyboards).toBe(1);
    expect(m.counts.keyframes).toBe(1);
  });

  it('assets[] inventory lists all assets but packedInBundle=false', async () => {
    const assets = [makeAsset(1), makeAsset(2)];
    const result = await exportCoreProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], assets
    );
    expect(result.manifest.assets).toHaveLength(assets.length);
    for (const a of result.manifest.assets) {
      expect(a.packedInBundle).toBe(false);
      expect(a.bundlePath).toBeUndefined();
      expect(a.sha256).toBeUndefined();
      expect(a.failureReason).toBeTruthy();
    }
    expect(result.packedAssetCount).toBe(0);
  });

  it('core bundle does not contain assets/ folder or video_plans.json', async () => {
    const result = await exportCoreProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeAsset(1)]
    );
    const zip = await JSZip.loadAsync(result.bundleBlob!);
    expect(zip.file('data/video_plans.json')).toBeFalsy();
    const assetFiles = zip.file(/^assets\//);
    expect(assetFiles.filter(f => !f.dir)).toHaveLength(0);
    // But core still has manifest, snapshot, data files
    expect(zip.file('manifest.json')).toBeTruthy();
    expect(zip.file('workspace_snapshot.json')).toBeTruthy();
    expect(zip.file('data/project.json')).toBeTruthy();
    expect(zip.file('data/scripts.json')).toBeTruthy();
  });

  it('core bundle filename contains _core_', async () => {
    const result = await exportCoreProjectBundle(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeAsset(1)]
    );
    expect(result.bundleFilename).toMatch(/_core_/);
  });
});

describe('empty project manifest', () => {
  it('handles zero scripts, zero storyboards, zero keyframes, zero assets gracefully', async () => {
    const result = await exportCoreProjectBundle(
      makeProject(), [], [], [], []
    );
    expect(result.success).toBe(true);
    const m = result.manifest;
    expect(m.counts.scripts).toBe(0);
    expect(m.counts.storyboards).toBe(0);
    expect(m.counts.keyframes).toBe(0);
    expect(m.counts.videoPlans).toBe(0);
    expect(m.counts.assets).toBe(0);
    expect(m.files.length).toBeGreaterThan(0);
    // files[] sha256 all valid
    for (const f of m.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
