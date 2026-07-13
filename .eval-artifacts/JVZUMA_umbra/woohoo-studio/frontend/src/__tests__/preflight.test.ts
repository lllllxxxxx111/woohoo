import { describe, it, expect } from 'vitest';
import { runPreflightChecks } from '../utils/preflight';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    description: 'A test project',
    ownerId: 'u1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeScript(overrides: Partial<Script> = {}): Script {
  return {
    id: 's1',
    projectId: 'p1',
    title: 'Scene 1',
    content: 'Once upon a time...',
    scenes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStoryboard(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    id: 'sb1',
    projectId: 'p1',
    name: 'Main Storyboard',
    shots: [
      { id: 'sh1', number: 1, description: 'Wide shot', keyframeIds: ['kf1'] },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeKeyframe(overrides: Partial<Keyframe> = {}): Keyframe {
  return {
    id: 'kf1',
    projectId: 'p1',
    name: 'KF 1',
    assetId: 'a1',
    timestamp: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeVideoPlan(overrides: Partial<VideoPlan> = {}): VideoPlan {
  return {
    id: 'vp1',
    projectId: 'p1',
    name: 'Default Plan',
    model: 'gen-3',
    resolution: { width: 1920, height: 1080 },
    fps: 24,
    duration: 30,
    parameters: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a1',
    projectId: 'p1',
    name: 'hero.png',
    type: 'image',
    url: 'https://cdn.example.com/hero.png',
    sizeBytes: 12345,
    sha256: 'abc123',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('runPreflightChecks', () => {
  it('returns canExport=true for a fully-populated valid project', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.canExport).toBe(true);
    expect(result.blockingCount).toBe(0);
    // There may be zero warnings with valid data
  });

  it('BLOCKING: no scripts prevents export', () => {
    const result = runPreflightChecks(
      makeProject(),
      [],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.canExport).toBe(false);
    expect(result.blockingCount).toBeGreaterThanOrEqual(1);
    expect(result.issues.some(i => i.code === 'NO_SCRIPTS')).toBe(true);
  });

  it('BLOCKING: no storyboards prevents export', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.canExport).toBe(false);
    expect(result.issues.some(i => i.code === 'NO_STORYBOARDS')).toBe(true);
  });

  it('BLOCKING: empty asset URL is flagged', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset({ url: '' })],
    );
    expect(result.canExport).toBe(false);
    expect(result.issues.some(i => i.code === 'ASSET_URL_EMPTY')).toBe(true);
  });

  it('BLOCKING: invalid URL protocol is flagged', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset({ url: 'not-a-real-url' })],
    );
    expect(result.canExport).toBe(false);
    expect(result.issues.some(i => i.code === 'ASSET_URL_INVALID')).toBe(true);
  });

  it('BLOCKING: asset with HTTP 4xx/5xx recorded in metadata', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset({ metadata: { lastHttpStatus: 404 } })],
    );
    expect(result.canExport).toBe(false);
    expect(result.issues.some(i => i.code === 'ASSET_DOWNLOAD_FAILED')).toBe(true);
  });

  it('WARNING: empty script content', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript({ content: '' })],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'SCRIPT_EMPTY')).toBe(true);
  });

  it('WARNING: shot with no keyframes', () => {
    const sb = makeStoryboard({
      shots: [{ id: 'sh1', number: 1, description: 'Empty shot', keyframeIds: [] }],
    });
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [sb],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'SHOT_NO_KEYFRAMES')).toBe(true);
  });

  it('WARNING: duplicate asset filenames', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset({ id: 'a1', name: 'hero.png' }), makeAsset({ id: 'a2', name: 'hero.png', url: 'https://cdn.example.com/hero2.png' })],
    );
    expect(result.issues.some(i => i.code === 'DUPLICATE_ASSET_NAME')).toBe(true);
  });

  it('WARNING: keyframe referencing nonexistent asset', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe({ assetId: 'does-not-exist' })],
      [makeVideoPlan()],
      [makeAsset({ id: 'a1' })],
    );
    expect(result.issues.some(i => i.code === 'KEYFRAME_MISSING_ASSET')).toBe(true);
  });

  it('WARNING: video plan with no model', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan({ model: '' })],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'VIDEO_PLAN_NO_MODEL')).toBe(true);
  });

  it('INFO: project with no description', () => {
    const result = runPreflightChecks(
      makeProject({ description: '' }),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'PROJECT_NO_DESCRIPTION')).toBe(true);
    expect(result.canExport).toBe(true);
  });

  it('INFO: asset without sha256', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset({ sha256: undefined })],
    );
    expect(result.issues.some(i => i.code === 'ASSET_NO_SHA256')).toBe(true);
  });

  it('INFO: no video plans', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'NO_VIDEO_PLANS')).toBe(true);
    expect(result.canExport).toBe(true);
  });

  it('accepts absolute server paths (starting with /) as valid URLs', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset({ url: '/api/assets/a1/download' })],
    );
    expect(result.blockingCount).toBe(0);
  });

  it('accepts blob:/data:/local: URLs (valid in-browser asset sources)', () => {
    const assets = [
      makeAsset({ id: 'b1', url: 'blob:http://localhost/abc', name: 'blob.png' }),
      makeAsset({ id: 'b2', url: 'data:image/png;base64,AAAA', name: 'data.png' }),
      makeAsset({ id: 'b3', url: 'local://uploads/tmp.png', name: 'local.png' }),
    ];
    const result = runPreflightChecks(
      makeProject(), [makeScript()], [makeStoryboard()], [makeKeyframe()], [makeVideoPlan()], assets,
    );
    expect(result.blockingCount).toBe(0);
    expect(result.issues.filter(i => i.code === 'ASSET_URL_INVALID')).toHaveLength(0);
  });

  // ---- New-rule coverage (added in the expanded preflight) ----

  it('BLOCKING: asset with sizeBytes <= 0 is flagged ASSET_EMPTY', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset({ sizeBytes: 0 })],
    );
    expect(result.issues.some(i => i.code === 'ASSET_EMPTY')).toBe(true);
    expect(result.canExport).toBe(false);
  });

  it('WARNING: storyboard with no shots is flagged STORYBOARD_EMPTY', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard({ shots: [] })],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'STORYBOARD_EMPTY')).toBe(true);
  });

  it('WARNING: shot with empty description is flagged SHOT_EMPTY_DESCRIPTION', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard({
        shots: [{ id: 'sh1', number: 1, description: '', keyframeIds: ['kf1'] }],
      })],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'SHOT_EMPTY_DESCRIPTION')).toBe(true);
  });

  it('WARNING: keyframe with no assetId is flagged KEYFRAME_NO_ASSET', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe({ assetId: undefined })],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'KEYFRAME_NO_ASSET')).toBe(true);
  });

  it('WARNING: video plan with duration <= 0 is flagged VIDEO_PLAN_ZERO_DURATION', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan({ duration: 0 })],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'VIDEO_PLAN_ZERO_DURATION')).toBe(true);
  });

  it('INFO: script with content but no scenes is flagged SCRIPT_NO_SCENES', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript({ scenes: [] })],
      [makeStoryboard()],
      [makeKeyframe()],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'SCRIPT_NO_SCENES')).toBe(true);
    // has content so should NOT get SCRIPT_EMPTY
    expect(result.issues.some(i => i.code === 'SCRIPT_EMPTY')).toBe(false);
  });

  it('INFO: keyframe with neither prompt nor annotations is flagged KEYFRAME_NO_NOTES', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [makeStoryboard()],
      [makeKeyframe({ prompt: undefined, annotations: undefined })],
      [makeVideoPlan()],
      [makeAsset()],
    );
    expect(result.issues.some(i => i.code === 'KEYFRAME_NO_NOTES')).toBe(true);
  });

  it('severity distribution: all three levels present in an unhealthy project', () => {
    const result = runPreflightChecks(
      makeProject({ description: '' }),                 // info
      [],                                              // blocking (no scripts)
      [makeStoryboard({ shots: [] })],                 // warning (empty storyboard) + info for anything?
      [makeKeyframe({ prompt: undefined, annotations: undefined })],
      [makeVideoPlan({ duration: 0 })],
      [makeAsset({ sizeBytes: 0 })],                   // blocking
    );
    expect(result.blockingCount).toBeGreaterThanOrEqual(2);
    expect(result.warningCount).toBeGreaterThanOrEqual(2);
    expect(result.infoCount).toBeGreaterThanOrEqual(2);
    expect(result.canExport).toBe(false);
  });
});
