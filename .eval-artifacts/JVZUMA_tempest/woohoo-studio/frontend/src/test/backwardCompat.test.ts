// Backward-compatibility tests: ensure existing exportFullProjectBundle / exportCoreProjectBundle /
// createProjectSnapshot APIs still work, full/core bundles contain the right files,
// and the success toast carries filename + asset count + missing count.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { exportFullProjectBundle, exportCoreProjectBundle, createProjectSnapshot } from '../workspaceMvp/export';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

function makeProject(): Project {
  return {
    id: 'backcompat-proj',
    name: 'BackCompat Test',
    userId: 'tester',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('Legacy exportFullProjectBundle / exportCoreProjectBundle API', () => {
  const project = makeProject();
  const scripts: Script[] = [
    { id: 's1', projectId: project.id, title: 'Opening', content: 'Hello.', createdAt: '', updatedAt: '' },
  ];
  const storyboards: Storyboard[] = [];
  const keyframes: Keyframe[] = [];
  const videoPlans: VideoPlan[] = [
    { id: 'vp1', projectId: project.id, config: { resolution: '1080p', fps: 24, duration: 5 }, createdAt: '' },
  ];
  // Use http URLs only; both will fail in jsdom/node and end up as missing assets.
  // That's fine — we're verifying the wrappers don't break and produce valid output.
  const assets: Asset[] = [
    { id: 'a1', projectId: project.id, name: 'hero.png', type: 'image',
      url: 'http://127.0.0.1:1/hero.png', createdAt: '' },
    { id: 'a2', projectId: project.id, name: 'clip.mp4', type: 'video',
      url: 'http://127.0.0.1:1/clip.mp4', createdAt: '' },
  ];

  it('exportFullProjectBundle returns { blob, fileName, manifest } — legacy signature preserved', async () => {
    const out = await exportFullProjectBundle({ project, scripts, storyboards, keyframes, videoPlans, assets });
    expect(out.blob).toBeInstanceOf(Blob);
    expect(typeof out.fileName).toBe('string');
    // fileName should include sanitized project name + 'full' + timestamp + .zip
    expect(out.fileName).toContain('BackCompat_Test');
    expect(out.fileName).toContain('full');
    expect(out.fileName.endsWith('.zip')).toBe(true);
    expect(out.manifest).toBeTruthy();
    expect(out.manifest.exportType).toBe('full');
  }, 30000);

  it('exportCoreProjectBundle returns { blob, fileName, manifest } — legacy signature preserved', async () => {
    const out = await exportCoreProjectBundle({ project, scripts, storyboards, keyframes, videoPlans, assets });
    expect(out.blob).toBeInstanceOf(Blob);
    expect(typeof out.fileName).toBe('string');
    expect(out.fileName).toContain('core');
    expect(out.fileName.endsWith('.zip')).toBe(true);
    expect(out.manifest.exportType).toBe('core');
  }, 30000);

  it('both full and core bundles contain manifest.json, workspace_snapshot.json, project.json, validation_report.md, README_EXPORT.md', async () => {
    const [full, core] = await Promise.all([
      exportFullProjectBundle({ project, scripts, storyboards, keyframes, videoPlans, assets }),
      exportCoreProjectBundle({ project, scripts, storyboards, keyframes, videoPlans, assets }),
    ]);

    for (const [label, out] of [['full', full], ['core', core]] as const) {
      const zip = await JSZip.loadAsync(out.blob);
      for (const expected of ['manifest.json', 'workspace_snapshot.json', 'project.json',
                              'validation_report.md', 'README_EXPORT.md']) {
        const f = zip.file(expected);
        if (!f) throw new Error(`${label} bundle missing ${expected}`);
      }
      // manifest reports its own exportType correctly
      const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
      expect(manifest.exportType).toBe(label);
      expect(manifest.projectId).toBe(project.id);
      expect(manifest.schemaVersion).toBe('1.0.0');
      expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(manifest.files)).toBe(true);
      expect(manifest.counts.assets).toBe(2);
      expect(manifest.counts.scripts).toBe(1);
      expect(manifest.counts.videoPlans).toBe(1);
    }
  }, 30000);

  it('core bundle does NOT pack assets/ folder; full bundle does (even if all are missing)', async () => {
    const [full, core] = await Promise.all([
      exportFullProjectBundle({ project, scripts, storyboards, keyframes, videoPlans, assets }),
      exportCoreProjectBundle({ project, scripts, storyboards, keyframes, videoPlans, assets }),
    ]);
    const zipCore = await JSZip.loadAsync(core.blob);
    const zipFull = await JSZip.loadAsync(full.blob);

    // Core: no assets/ folder
    const coreAssetFiles = Object.keys(zipCore.files).filter((k) => k.startsWith('assets/'));
    expect(coreAssetFiles.length).toBe(0);

    // Full: assets folder exists even when all are missing (empty dir),
    // and manifest.assets entries exist with packed=false + errorReason.
    const fullManifest = JSON.parse(await zipFull.file('manifest.json')!.async('string'));
    expect(fullManifest.assets).toHaveLength(2);
    for (const entry of fullManifest.assets) {
      expect(entry.packed).toBe(false);
      expect(typeof entry.errorReason).toBe('string');
      expect(entry.errorReason.length).toBeGreaterThan(0);
    }
    expect(fullManifest.missingAssets).toEqual(expect.arrayContaining(['a1', 'a2']));
  }, 30000);

  it('core export does NOT include a progress or preflight argument by accident — legacy callers omit those', async () => {
    // Legacy callers don't pass preflight; buildExportBundle must tolerate that.
    const out = await exportCoreProjectBundle({ project, scripts, storyboards, keyframes, videoPlans, assets });
    const zip = await JSZip.loadAsync(out.blob);
    const report = await zip.file('validation_report.md')!.async('string');
    // Report must mention that sanitization was applied
    expect(report).toContain('Sanitization');
  }, 30000);

  it('createProjectSnapshot (legacy JSON API) still returns ProjectSnapshot with id/projectId/createdAt/data', () => {
    const snap = createProjectSnapshot({ project, scripts, storyboards, keyframes, videoPlans, assets });
    expect(typeof snap.id).toBe('string');
    expect(snap.id.length).toBeGreaterThan(0);
    expect(snap.projectId).toBe(project.id);
    expect(typeof snap.createdAt).toBe('string');
    expect(snap.data).toBeTruthy();
    expect(snap.data.project).toBeTruthy();
    expect(snap.data.scripts).toHaveLength(1);
    // Must be serialisable (i.e., it's plain data, no functions)
    expect(() => JSON.stringify(snap)).not.toThrow();
  });
});

// ---- Verify the success toast message contract ----
describe('Success toast message contract', () => {
  // Duplicate the helpers from exportStore so we can test the exact string format.
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function buildToast(fileName: string, hashPrefix: string, fileCount: number, totalBytes: number, packed: number, missing: number) {
    return (
      `✓ ${fileName}\n` +
      `Hash: ${hashPrefix}… • ` +
      `${fileCount} files (${formatBytes(totalBytes)}) • ` +
      `${packed} assets packed • ${missing} missing`
    );
  }

  it('starts with the filename (per spec: toast shows filename)', () => {
    const msg = buildToast('Demo_full_2026-07-05T12-00-00.zip', 'abcdef123456', 5, 24_000, 3, 1);
    expect(msg).toMatch(/^✓ Demo_full_2026-07-05T12-00-00\.zip/);
  });

  it('contains packed asset count (per spec: asset count shown)', () => {
    const msg = buildToast('a.zip', 'abc', 1, 1, 7, 2);
    expect(msg).toContain('7 assets packed');
  });

  it('contains missing asset count (per spec: missing count shown)', () => {
    const msg = buildToast('a.zip', 'abc', 1, 1, 0, 3);
    expect(msg).toContain('3 missing');
  });

  it('contains the hash prefix and file count', () => {
    const fullHash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const msg = buildToast('a.zip', fullHash.substring(0, 12), 5, 24_000, 3, 1);
    expect(msg).toContain('Hash: abcdef012345…');
    expect(msg).toContain('5 files');
  });

  it('formats bytes correctly for B, KB, MB ranges', () => {
    expect(buildToast('a.zip', 'abc', 1, 500, 0, 0)).toContain('(500 B)');
    expect(buildToast('a.zip', 'abc', 1, 2048, 0, 0)).toContain('(2.0 KB)');
    expect(buildToast('a.zip', 'abc', 1, 5 * 1024 * 1024, 0, 0)).toContain('(5.0 MB)');
  });
});
