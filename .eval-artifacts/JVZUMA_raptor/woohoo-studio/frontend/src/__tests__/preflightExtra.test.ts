// Additional preflight rule tests covering edge cases not in the main suite
import { describe, it, expect, afterEach, vi } from 'vitest';
import { runPreflightChecks, runPreflightChecksWithProbe } from '../utils/exportPreflight';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';
import { DEFAULT_EXPORT_OPTIONS } from '../workspaceMvp/exportUtils';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1', name: 'P', ownerId: 'u',
    createdAt: '2024-01-01', updatedAt: '2024-01-01',
    ...overrides,
  };
}

describe('preflight edge cases', () => {
  // ---------- Video plan edge cases ----------
  describe('video plan edge cases', () => {
    it('flags WARNING for video plan with no name', () => {
      const vp: VideoPlan = {
        id: 'vp1', projectId: 'proj-1', name: '',
        model: 'm', resolution: { width: 1920, height: 1080 },
        fps: 24, duration: 30, parameters: { seed: 1 }, createdAt: '', updatedAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [vp],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.category === 'videoPlans' && i.severity === 'warning' && i.message.includes('no name'))).toBe(true);
    });

    it('flags WARNING for negative FPS', () => {
      const vp: VideoPlan = {
        id: 'vp1', projectId: 'proj-1', name: 'VP',
        model: 'm', resolution: { width: 1920, height: 1080 },
        fps: -1, duration: 30, parameters: { s: 1 }, createdAt: '', updatedAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [vp],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.message.includes('invalid FPS'))).toBe(true);
    });

    it('flags WARNING for negative duration', () => {
      const vp: VideoPlan = {
        id: 'vp1', projectId: 'proj-1', name: 'VP',
        model: 'm', resolution: { width: 1920, height: 1080 },
        fps: 24, duration: -10, parameters: { s: 1 }, createdAt: '', updatedAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [vp],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.message.includes('invalid duration'))).toBe(true);
    });

    it('flags WARNING for resolution with zero width but non-zero height', () => {
      const vp: VideoPlan = {
        id: 'vp1', projectId: 'proj-1', name: 'VP',
        model: 'm', resolution: { width: 0, height: 1080 },
        fps: 24, duration: 30, parameters: { s: 1 }, createdAt: '', updatedAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [vp],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.message.includes('invalid resolution'))).toBe(true);
    });
  });

  // ---------- Storyboard edge cases ----------
  describe('storyboard edge cases', () => {
    it('flags INFO for shot with negative duration', () => {
      const sb: Storyboard = {
        id: 'sb1', projectId: 'proj-1', name: 'SB',
        shots: [{ id: 'sh1', number: 1, description: 'd', keyframeIds: [], duration: -5 }],
        createdAt: '', updatedAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [sb], keyframes: [], videoPlans: [],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.severity === 'info' && i.message.includes('zero or negative duration'))).toBe(true);
    });
  });

  // ---------- Keyframe edge cases ----------
  describe('keyframe edge cases', () => {
    it('no keyframe warnings when keyframe references an existing asset', () => {
      const asset: Asset = {
        id: 'a-good', projectId: 'proj-1', name: 'g.png', type: 'image',
        url: 'http://x.com/g.png', mimeType: 'image/png', sizeBytes: 100, createdAt: '',
      };
      const kf: Keyframe = {
        id: 'kf1', projectId: 'proj-1', name: 'Good KF',
        assetId: 'a-good', timestamp: 0, createdAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [kf], videoPlans: [],
        assets: [asset], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.category === 'keyframes' && i.severity === 'blocking')).toBe(false);
      expect(r.issues.some((i) => i.category === 'keyframes' && i.severity === 'warning' && i.message.includes('no asset'))).toBe(false);
      expect(r.issues.some((i) => i.category === 'keyframes' && i.message.includes('does not exist'))).toBe(false);
    });

    it('blocks export when keyframe references deleted asset (canProceed=false)', () => {
      const kf: Keyframe = {
        id: 'kf1', projectId: 'proj-1', name: 'Dangling',
        assetId: 'deleted-123', timestamp: 0, createdAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [kf], videoPlans: [],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.canProceed).toBe(false);
      expect(r.blockingCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------- Asset edge cases ----------
  describe('asset edge cases', () => {
    it('flags WARNING for truncated/empty data: URL', () => {
      const asset: Asset = {
        id: 'a1', projectId: 'proj-1', name: 'Trunc',
        type: 'image', url: 'data:image/png;base64,', mimeType: 'image/png',
        sizeBytes: 0, createdAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [],
        assets: [asset], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.severity === 'warning' && i.message.includes('data: URL'))).toBe(true);
    });

    it('three assets with the same name still produces one duplicate-filename warning', () => {
      const mk = (id: string): Asset => ({
        id, projectId: 'proj-1', name: 'dup.png', type: 'image',
        url: `http://x.com/${id}.png`, mimeType: 'image/png', sizeBytes: 100, createdAt: '',
      });
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [],
        assets: [mk('a1'), mk('a2'), mk('a3')], options: DEFAULT_EXPORT_OPTIONS,
      });
      const dupeIssues = r.issues.filter((i) => i.message.includes('Duplicate filename'));
      expect(dupeIssues.length).toBeGreaterThanOrEqual(1);
      // The message should mention "3 assets" to reflect the duplicate count
      expect(dupeIssues[0].message).toMatch(/3 assets/);
    });

    it('does NOT flag unreferenced-info when an asset is referenced by a keyframe', () => {
      const asset: Asset = {
        id: 'a-used', projectId: 'proj-1', name: 'used.png', type: 'image',
        url: 'http://x.com/u.png', mimeType: 'image/png', sizeBytes: 100, createdAt: '',
      };
      const kf: Keyframe = {
        id: 'kf1', projectId: 'proj-1', name: 'Using KF',
        assetId: 'a-used', timestamp: 0, createdAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [kf], videoPlans: [],
        assets: [asset], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.message.includes('not referenced by any keyframe'))).toBe(false);
    });

    it('flags warning for ftp:// and other non-standard URL schemes', () => {
      const asset: Asset = {
        id: 'a1', projectId: 'proj-1', name: 'FTP',
        type: 'image', url: 'ftp://example.com/a.png', mimeType: 'image/png',
        sizeBytes: 100, createdAt: '',
      };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [],
        assets: [asset], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.severity === 'warning' && i.message.includes('malformed URL'))).toBe(true);
    });
  });

  // ---------- Script dialogue edge cases ----------
  describe('script dialogue edge cases', () => {
    it('flags INFO for whitespace-only dialogue line', () => {
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: 'T', content: 'c',
        scenes: [{
          id: 'sc1', number: 1, heading: 'INT. ROOM',
          dialogue: [{ id: 'd1', character: 'Bob', line: '   ' }],
        }],
        createdAt: '', updatedAt: '',
      }];
      const r = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.issues.some((i) => i.severity === 'info' && i.message.includes('empty dialogue'))).toBe(true);
    });
  });

  // ---------- Probe edge cases ----------
  describe('async probe edge cases', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('500 status from server is a warning (still downloadable in some cases)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      const asset: Asset = {
        id: 'a1', projectId: 'proj-1', name: 'Err', type: 'image',
        url: 'http://example.com/err.png', mimeType: 'image/png', sizeBytes: 100, createdAt: '',
      };
      const r = await runPreflightChecksWithProbe({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [],
        assets: [asset], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.canProceed).toBe(true);
      expect(r.issues.some((i) => i.severity === 'warning')).toBe(true);
    });

    it('no probe runs for core export (assets not included)', async () => {
      const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetch);
      const r = await runPreflightChecksWithProbe({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [],
        assets: [{ id: 'a1', projectId: 'proj-1', name: 'A', type: 'image', url: 'http://x/a.png', mimeType: 'image/png', sizeBytes: 10, createdAt: '' }],
        options: { ...DEFAULT_EXPORT_OPTIONS, includeAssets: false },
      });
      // fetch should not have been called for asset probe
      expect(fetch).not.toHaveBeenCalled();
      expect(r.canProceed).toBe(true);
    });

    it('blob: URLs are not probed (they are session-only and would always fail the probe)', async () => {
      const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetch);
      const asset: Asset = {
        id: 'a1', projectId: 'proj-1', name: 'Blob', type: 'image',
        url: 'blob:http://localhost/uuid', createdAt: '',
      };
      const r = await runPreflightChecksWithProbe({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [],
        assets: [asset], options: DEFAULT_EXPORT_OPTIONS,
      });
      // Should flag the blob: warning but not attempt to fetch
      expect(r.issues.some((i) => i.message.includes('blob: URL'))).toBe(true);
      // fetch may still be called for other URLs; but the blob URL specifically shouldn't be probed
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect(call[0]).not.toMatch(/^blob:/);
      }
    });
  });

  // ---------- Aggregate / counts ----------
  describe('aggregate counts', () => {
    it('canProceed is false if any blocking issue exists across categories', () => {
      // Keyframe with missing asset → blocking on keyframes
      const kf: Keyframe = { id: 'kf1', projectId: 'proj-1', name: 'K', assetId: 'missing', timestamp: 0, createdAt: '' };
      const r = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [kf], videoPlans: [],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.canProceed).toBe(false);
      expect(r.blockingCount).toBeGreaterThanOrEqual(1);
    });

    it('canProceed is true when only warnings and info exist', () => {
      // Script with empty title + no assets → warning + info, no blocking
      const scripts: Script[] = [{ id: 's1', projectId: 'proj-1', title: '', content: 'c', scenes: [], createdAt: '', updatedAt: '' }];
      const r = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [],
        assets: [], options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(r.canProceed).toBe(true);
      expect(r.warningCount).toBeGreaterThanOrEqual(1);
      expect(r.infoCount).toBeGreaterThanOrEqual(1);
    });

    it('every issue has severity/category/message fields', () => {
      const r = runPreflightChecks({
        project: makeProject({ name: '' }),
        scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      for (const i of r.issues) {
        expect(['blocking', 'warning', 'info']).toContain(i.severity);
        expect(i.category).toBeTruthy();
        expect(i.message).toBeTruthy();
        expect(typeof i.message).toBe('string');
      }
    });
  });
});
