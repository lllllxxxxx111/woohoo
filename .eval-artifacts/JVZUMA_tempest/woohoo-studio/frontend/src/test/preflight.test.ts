// Tests for preflight validation rules
import { describe, it, expect } from 'vitest';
import { runPreflight, type PreflightInput } from '../utils/preflight';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    userId: 'u1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function baseInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    project: makeProject(),
    scripts: [],
    storyboards: [],
    keyframes: [],
    videoPlans: [],
    assets: [],
    ...overrides,
  };
}

describe('runPreflight', () => {
  it('passes clean project with no issues', () => {
    const result = runPreflight(
      baseInput({
        scripts: [{ id: 's1', projectId: 'p1', title: 'Script 1', content: 'Hello world', createdAt: '', updatedAt: '' } as Script],
        storyboards: [],
        keyframes: [],
        videoPlans: [],
        assets: [],
      }),
    );
    expect(result.canExport).toBe(true);
    expect(result.summary.blockingCount).toBe(0);
  });

  it('returns blocking for empty project name', () => {
    const result = runPreflight(baseInput({ project: makeProject({ name: '' }) }));
    expect(result.canExport).toBe(false);
    expect(result.blocking.some((i) => i.code === 'PROJECT_NAME_EMPTY')).toBe(true);
  });

  it('returns warning for empty script content', () => {
    const result = runPreflight(
      baseInput({
        scripts: [{ id: 's1', projectId: 'p1', title: 'Empty', content: '', createdAt: '', updatedAt: '' } as Script],
      }),
    );
    expect(result.warnings.some((i) => i.code === 'SCRIPT_EMPTY')).toBe(true);
  });

  it('returns warning for storyboard with no scenes', () => {
    const result = runPreflight(
      baseInput({
        storyboards: [
          { id: 'sb1', projectId: 'p1', title: 'Empty SB', scenes: [], createdAt: '', updatedAt: '' } as unknown as Storyboard,
        ],
      }),
    );
    expect(result.warnings.some((i) => i.code === 'STORYBOARD_NO_SCENES')).toBe(true);
  });

  it('returns warning for keyframe without image', () => {
    const result = runPreflight(
      baseInput({
        keyframes: [{ id: 'k1', projectId: 'p1', storyboardId: 'sb1', prompt: 'a scene', timestamp: 0 } as Keyframe],
      }),
    );
    expect(result.warnings.some((i) => i.code === 'KEYFRAME_NO_IMAGE')).toBe(true);
  });

  it('returns blocking for video plan with no config', () => {
    const result = runPreflight(
      baseInput({
        videoPlans: [{ id: 'vp1', projectId: 'p1', config: undefined as unknown as VideoPlan['config'], createdAt: '' } as VideoPlan],
      }),
    );
    expect(result.blocking.some((i) => i.code === 'VIDEO_PLAN_NO_CONFIG')).toBe(true);
    expect(result.canExport).toBe(false);
  });

  it('returns warning for invalid video plan fps', () => {
    const result = runPreflight(
      baseInput({
        videoPlans: [
          {
            id: 'vp1',
            projectId: 'p1',
            config: { resolution: '1920x1080', fps: 0, duration: 30 },
            createdAt: '',
          } as VideoPlan,
        ],
      }),
    );
    expect(result.warnings.some((i) => i.code === 'VIDEO_PLAN_INVALID_FPS')).toBe(true);
  });

  it('returns blocking for asset with no URL', () => {
    const result = runPreflight(
      baseInput({
        assets: [{ id: 'a1', projectId: 'p1', name: 'img.png', type: 'image', url: '', createdAt: '' } as Asset],
      }),
    );
    expect(result.blocking.some((i) => i.code === 'ASSET_NO_URL')).toBe(true);
  });

  it('returns warning for duplicate asset names', () => {
    const result = runPreflight(
      baseInput({
        assets: [
          { id: 'a1', projectId: 'p1', name: 'same.png', type: 'image', url: 'http://example.com/1.png', createdAt: '' } as Asset,
          { id: 'a2', projectId: 'p1', name: 'same.png', type: 'image', url: 'http://example.com/2.png', createdAt: '' } as Asset,
        ],
      }),
    );
    expect(result.warnings.some((i) => i.code === 'DUPLICATE_ASSET_NAME')).toBe(true);
  });

  it('returns warning for blob/data URLs on assets', () => {
    const result = runPreflight(
      baseInput({
        assets: [
          { id: 'a1', projectId: 'p1', name: 'local.png', type: 'image', url: 'blob:http://localhost/abc', createdAt: '' } as Asset,
        ],
      }),
    );
    expect(result.warnings.some((i) => i.code === 'ASSET_LOCAL_ONLY_URL')).toBe(true);
  });

  it('returns info for missing scripts entirely', () => {
    const result = runPreflight(baseInput());
    expect(result.info.some((i) => i.code === 'NO_SCRIPTS')).toBe(true);
  });

  it('categorizes issues correctly into severity arrays', () => {
    const result = runPreflight(
      baseInput({
        project: makeProject({ name: '' }),
        assets: [{ id: 'a1', projectId: 'p1', name: 'x.png', type: 'image', url: '', createdAt: '' } as Asset],
      }),
    );
    expect(result.blocking.length).toBeGreaterThanOrEqual(2);
    expect(result.allIssues.length).toBe(result.blocking.length + result.warnings.length + result.info.length);
  });
});
