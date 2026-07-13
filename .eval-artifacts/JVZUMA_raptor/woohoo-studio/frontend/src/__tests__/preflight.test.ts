// Tests for pre-export validation rules
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPreflightChecks, runPreflightChecksWithProbe } from '../utils/exportPreflight';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset, Scene, DialogueLine } from '../types';
import { DEFAULT_EXPORT_OPTIONS, CORE_EXPORT_OPTIONS } from '../workspaceMvp/exportUtils';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    ownerId: 'user-1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('exportPreflight — blocking/warning/info coverage', () => {
  // ============================================================
  // PROJECT
  // ============================================================
  describe('project checks', () => {
    it('flags BLOCKING when project has no name', () => {
      const result = runPreflightChecks({
        project: makeProject({ name: '' }),
        scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.canProceed).toBe(false);
      expect(result.blockingCount).toBeGreaterThanOrEqual(1);
      expect(result.issues.some((i) => i.category === 'project' && i.severity === 'blocking')).toBe(true);
    });

    it('passes with valid project name (no blocking issues)', () => {
      const result = runPreflightChecks({
        project: makeProject(),
        scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.canProceed).toBe(true);
      expect(result.blockingCount).toBe(0);
    });
  });

  // ============================================================
  // SCRIPTS (空内容、无场景、空标题、空对白)
  // ============================================================
  describe('script checks (空内容/无场景/空标题/空对白)', () => {
    it('flags INFO when project has no scripts', () => {
      const result = runPreflightChecks({
        project: makeProject(),
        scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'scripts' && i.severity === 'info')).toBe(true);
    });

    it('flags WARNING for empty script content (空内容)', () => {
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: 'Empty Script',
        content: '', scenes: [], createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'scripts' && i.severity === 'warning' && i.message.includes('empty'))).toBe(true);
    });

    it('flags WARNING for whitespace-only script content', () => {
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: 'WS Script',
        content: '   \n\t  ', scenes: [], createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'scripts' && i.severity === 'warning')).toBe(true);
    });

    it('flags INFO for script with no scenes', () => {
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: 'No Scenes',
        content: 'Some content', scenes: [], createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'scripts' && i.severity === 'info' && i.message.includes('no scenes'))).toBe(true);
    });

    it('flags WARNING for scene with empty heading', () => {
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: 'Test', content: 'c',
        scenes: [{ id: 'sc1', number: 1, heading: '', action: 'x' }],
        createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('no heading'))).toBe(true);
    });

    it('flags WARNING for script with empty title', () => {
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: '', content: 'content', scenes: [],
        createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'scripts' && i.severity === 'warning' && i.message.includes('no title'))).toBe(true);
    });

    it('flags WARNING for dialogue without character name', () => {
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: 'Test', content: 'c',
        scenes: [{
          id: 'sc1', number: 1, heading: 'INT. ROOM',
          dialogue: [{ id: 'd1', character: '', line: 'Hello' }],
        }],
        createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('without a character'))).toBe(true);
    });

    it('flags INFO for empty dialogue line', () => {
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: 'Test', content: 'c',
        scenes: [{
          id: 'sc1', number: 1, heading: 'INT. ROOM',
          dialogue: [{ id: 'd1', character: 'Bob', line: '' }],
        }],
        createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts, storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.severity === 'info' && i.message.includes('empty dialogue'))).toBe(true);
    });
  });

  // ============================================================
  // STORYBOARDS (无shots/空描述/空名/时长为0)
  // ============================================================
  describe('storyboard checks (无shots/空描述/空名/时长为0)', () => {
    it('flags INFO when no storyboards', () => {
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'storyboards' && i.severity === 'info')).toBe(true);
    });

    it('flags WARNING for storyboard with no shots', () => {
      const storyboards: Storyboard[] = [{
        id: 'sb1', projectId: 'proj-1', name: 'Empty SB',
        shots: [], createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards, keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'storyboards' && i.severity === 'warning' && i.message.includes('no shots'))).toBe(true);
    });

    it('flags WARNING for shot with no description (空内容)', () => {
      const storyboards: Storyboard[] = [{
        id: 'sb1', projectId: 'proj-1', name: 'SB',
        shots: [{ id: 'sh1', number: 1, description: '', keyframeIds: [] }],
        createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards, keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('no description'))).toBe(true);
    });

    it('flags WARNING for empty storyboard name', () => {
      const storyboards: Storyboard[] = [{
        id: 'sb1', projectId: 'proj-1', name: '',
        shots: [{ id: 'sh1', number: 1, description: 'desc', keyframeIds: [] }],
        createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards, keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'storyboards' && i.severity === 'warning' && i.message.includes('no name'))).toBe(true);
    });

    it('flags INFO for shot with zero/negative duration', () => {
      const storyboards: Storyboard[] = [{
        id: 'sb1', projectId: 'proj-1', name: 'SB',
        shots: [{ id: 'sh1', number: 1, description: 'd', keyframeIds: [], duration: 0 }],
        createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards, keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.severity === 'info' && i.message.includes('zero or negative duration'))).toBe(true);
    });

    it('flags WARNING for shot referencing missing keyframe', () => {
      const storyboards: Storyboard[] = [{
        id: 'sb1', projectId: 'proj-1', name: 'SB',
        shots: [{ id: 'sh1', number: 1, description: 'd', keyframeIds: ['nonexistent'] }],
        createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards, keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('missing keyframe'))).toBe(true);
    });
  });

  // ============================================================
  // KEYFRAMES
  // ============================================================
  describe('keyframe checks', () => {
    it('flags INFO when no keyframes', () => {
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      // keyframes info only triggered if includeKeyframes is true (it is for full export)
      expect(result.issues.some((i) => i.category === 'keyframes' && i.severity === 'info')).toBe(true);
    });

    it('flags WARNING for keyframe without asset', () => {
      const keyframes: Keyframe[] = [{
        id: 'kf1', projectId: 'proj-1', name: 'No Asset KF',
        timestamp: 0, createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes, videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'keyframes' && i.severity === 'warning')).toBe(true);
    });

    it('flags BLOCKING for keyframe referencing non-existent asset', () => {
      const keyframes: Keyframe[] = [{
        id: 'kf1', projectId: 'proj-1', name: 'Bad KF',
        assetId: 'nonexistent-asset', timestamp: 0, createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes, videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.canProceed).toBe(false);
      expect(result.issues.some((i) => i.category === 'keyframes' && i.severity === 'blocking')).toBe(true);
    });

    it('flags WARNING for keyframe with empty name', () => {
      const keyframes: Keyframe[] = [{
        id: 'kf1', projectId: 'proj-1', name: '', timestamp: 0, createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes, videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'keyframes' && i.severity === 'warning' && i.message.includes('no name'))).toBe(true);
    });
  });

  // ============================================================
  // VIDEO PLANS
  // ============================================================
  describe('video plan checks', () => {
    it('flags INFO when no video plans', () => {
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'videoPlans' && i.severity === 'info')).toBe(true);
    });

    it('flags WARNING for empty model', () => {
      const videoPlans: VideoPlan[] = [{
        id: 'vp1', projectId: 'proj-1', name: 'No Model',
        model: '', resolution: { width: 1920, height: 1080 },
        fps: 24, duration: 30, parameters: {}, createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans, assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'videoPlans' && i.severity === 'warning')).toBe(true);
    });

    it('flags WARNING for invalid resolution', () => {
      const videoPlans: VideoPlan[] = [{
        id: 'vp1', projectId: 'proj-1', name: 'Bad Res',
        model: 'm', resolution: { width: 0, height: 0 },
        fps: 24, duration: 30, parameters: {}, createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans, assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('invalid resolution'))).toBe(true);
    });

    it('flags WARNING for invalid duration', () => {
      const videoPlans: VideoPlan[] = [{
        id: 'vp1', projectId: 'proj-1', name: 'Bad Dur',
        model: 'm', resolution: { width: 1920, height: 1080 },
        fps: 24, duration: 0, parameters: {}, createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans, assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('invalid duration'))).toBe(true);
    });

    it('flags WARNING for invalid FPS', () => {
      const videoPlans: VideoPlan[] = [{
        id: 'vp1', projectId: 'proj-1', name: 'Bad FPS',
        model: 'm', resolution: { width: 1920, height: 1080 },
        fps: 0, duration: 30, parameters: {}, createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans, assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('invalid FPS'))).toBe(true);
    });

    it('flags INFO for empty parameters', () => {
      const videoPlans: VideoPlan[] = [{
        id: 'vp1', projectId: 'proj-1', name: 'No Params',
        model: 'm', resolution: { width: 1920, height: 1080 },
        fps: 24, duration: 30, parameters: {}, createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans, assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.severity === 'info' && i.message.includes('no generation parameters'))).toBe(true);
    });
  });

  // ============================================================
  // ASSETS (URL空/格式无效/重复文件名/零字节/blob:URL/无MIME/未引用)
  // ============================================================
  describe('asset checks (URL/重复文件名/空内容/不可下载特征)', () => {
    it('flags INFO when no assets', () => {
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'assets' && i.severity === 'info' && i.message.includes('No assets'))).toBe(true);
    });

    it('flags BLOCKING for asset with empty URL (资产URL空)', () => {
      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'No URL',
        type: 'image', url: '', createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.canProceed).toBe(false);
      expect(result.issues.some((i) => i.category === 'assets' && i.severity === 'blocking' && i.message.includes('no URL'))).toBe(true);
    });

    it('flags WARNING for malformed/invalid URL (资产URL无效)', () => {
      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'Bad URL',
        type: 'image', url: 'not-a-valid-url-at-all', createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'assets' && i.severity === 'warning' && i.message.includes('malformed URL'))).toBe(true);
    });

    it('flags WARNING for duplicate filenames (重复文件名)', () => {
      const assets: Asset[] = [
        { id: 'a1', projectId: 'proj-1', name: 'image.png', type: 'image', url: 'http://x.com/1.png', createdAt: '' },
        { id: 'a2', projectId: 'proj-1', name: 'image.png', type: 'image', url: 'http://x.com/2.png', createdAt: '' },
      ];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('Duplicate filename'))).toBe(true);
    });

    it('flags WARNING for zero-byte assets (空内容/0字节)', () => {
      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'Zero Byte',
        type: 'image', url: 'http://example.com/zero.png', sizeBytes: 0,
        mimeType: 'image/png', createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('zero bytes'))).toBe(true);
    });

    it('flags WARNING for asset with no name (空名称)', () => {
      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: '', type: 'image', url: 'http://x.com/a.png', createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.category === 'assets' && i.severity === 'warning' && i.message.includes('no name'))).toBe(true);
    });

    it('flags WARNING for blob: URLs (临时URL不可持久)', () => {
      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'Blob',
        type: 'image', url: 'blob:http://localhost/abc-123', createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('blob: URL'))).toBe(true);
    });

    it('flags INFO for asset with no MIME type', () => {
      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'No MIME',
        type: 'image', url: 'http://x.com/a.png', createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.severity === 'info' && i.message.includes('no MIME type'))).toBe(true);
    });

    it('flags INFO for unreferenced assets', () => {
      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'Orphan',
        type: 'image', url: 'http://x.com/a.png', mimeType: 'image/png',
        sizeBytes: 1000, createdAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.severity === 'info' && i.message.includes('not referenced'))).toBe(true);
    });

    it('accepts valid http/https/data/blob URLs', () => {
      const assets: Asset[] = [
        { id: 'a1', projectId: 'proj-1', name: 'HTTP', type: 'image', url: 'http://example.com/img.png', mimeType: 'image/png', sizeBytes: 1000, createdAt: '' },
        { id: 'a2', projectId: 'proj-1', name: 'HTTPS', type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png', sizeBytes: 1000, createdAt: '' },
        { id: 'a3', projectId: 'proj-1', name: 'Data', type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', mimeType: 'image/png', sizeBytes: 100, createdAt: '' },
      ];
      const result = runPreflightChecks({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      // No URL-related warnings for valid URLs
      const urlIssues = result.issues.filter((i) => i.category === 'assets' && (i.message.includes('URL') || i.message.includes('malformed')));
      expect(urlIssues.some((i) => i.severity === 'warning' || i.severity === 'blocking')).toBe(false);
    });
  });

  // ============================================================
  // CORE EXPORT — skips asset/keyframe/video plan checks
  // ============================================================
  describe('core export option', () => {
    it('skips asset/keyframe/videoPlan checks for core export', () => {
      // Keyframe without asset — would normally be warning, but keyframes not included in core
      const result = runPreflightChecks({
        project: makeProject({ name: '' }), // name is empty → still blocking
        scripts: [],
        storyboards: [],
        keyframes: [{ id: 'kf1', projectId: 'p', name: 'KF', timestamp: 0, createdAt: '' }], // no assetId but keyframes excluded
        videoPlans: [{
          id: 'vp1', projectId: 'p', name: 'VP', model: '', resolution: { width: 0, height: 0 },
          fps: 0, duration: 0, parameters: {}, createdAt: '', updatedAt: '',
        }],
        assets: [{ id: 'a1', projectId: 'p', name: '', type: 'image', url: '', createdAt: '' }], // empty URL → blocking but assets excluded
        options: CORE_EXPORT_OPTIONS,
      });
      // Core export: assets/keyframes/videoplans not checked, so only project name blocking
      const assetBlocking = result.issues.filter((i) => i.category === 'assets' && i.severity === 'blocking');
      expect(assetBlocking).toHaveLength(0);
      // But project name is still blocking
      expect(result.canProceed).toBe(false);
      expect(result.issues.some((i) => i.category === 'project')).toBe(true);
    });
  });

  // ============================================================
  // SEVERITY COUNTS
  // ============================================================
  describe('severity counting', () => {
    it('correctly tallies blocking/warning/info', () => {
      // Empty project name (blocking) + empty script (warning) + no assets (info)
      const scripts: Script[] = [{
        id: 's1', projectId: 'proj-1', title: '',
        content: '', scenes: [], createdAt: '', updatedAt: '',
      }];
      const result = runPreflightChecks({
        project: makeProject({ name: '' }),
        scripts, storyboards: [], keyframes: [], videoPlans: [], assets: [],
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.blockingCount).toBeGreaterThanOrEqual(1);
      expect(result.warningCount).toBeGreaterThanOrEqual(1);
      expect(result.infoCount).toBeGreaterThanOrEqual(1);
      expect(result.canProceed).toBe(false);
      expect(result.blockingCount + result.warningCount + result.infoCount).toBe(result.issues.length);
    });
  });

  // ============================================================
  // ASYNC PROBE (网络可达性检测)
  // ============================================================
  describe('asset reachability probe (不可下载资产检测)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('flags WARNING when asset URL returns 404', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'Missing',
        type: 'image', url: 'http://example.com/missing.png',
        mimeType: 'image/png', sizeBytes: 100, createdAt: '',
      }];
      const result = await runPreflightChecksWithProbe({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      expect(result.issues.some((i) => i.message.includes('not reachable') || i.message.includes('probe failed'))).toBe(true);
    });

    it('no probe warnings when assets return 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      }));

      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'OK',
        type: 'image', url: 'http://example.com/ok.png',
        mimeType: 'image/png', sizeBytes: 100, createdAt: '',
      }];
      const result = await runPreflightChecksWithProbe({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      const probeIssues = result.issues.filter((i) => i.message.includes('not reachable') || i.message.includes('probe failed'));
      expect(probeIssues).toHaveLength(0);
    });

    it('probe failures are warnings (not blocking) — network issues should not hard-block export', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const assets: Asset[] = [{
        id: 'a1', projectId: 'proj-1', name: 'Flaky',
        type: 'image', url: 'http://example.com/flaky.png',
        mimeType: 'image/png', sizeBytes: 100, createdAt: '',
      }];
      const result = await runPreflightChecksWithProbe({
        project: makeProject(), scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets,
        options: DEFAULT_EXPORT_OPTIONS,
      });
      // Network failure is warning, not blocking
      expect(result.canProceed).toBe(true);
      expect(result.issues.some((i) => i.severity === 'warning')).toBe(true);
    });
  });
});
