// Tests for preflight checks

import { describe, it, expect } from 'vitest';
import { runPreflightChecks } from '../export/preflight';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    userId: 'user-1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeScript(overrides: Partial<Script> = {}): Script {
  return {
    id: 'script-1',
    projectId: 'proj-1',
    sceneIndex: 1,
    content: 'INT. OFFICE - DAY\nA person sits at a desk.',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    projectId: 'proj-1',
    name: 'image.png',
    type: 'image',
    url: 'https://example.com/image.png',
    uploadedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeStoryboard(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    id: 'sb-1',
    projectId: 'proj-1',
    sceneId: null as unknown as string,
    order: 1,
    title: 'Board 1',
    description: 'desc',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeKeyframe(order = 1, storyboardId = 'sb-1'): Keyframe {
  return {
    id: `kf-${order}`,
    projectId: 'proj-1',
    storyboardId,
    order,
    imageUrl: `https://example.com/kf${order}.png`,
    prompt: `prompt ${order}`,
    createdAt: '2024-01-01T00:00:00Z',
  };
}

describe('runPreflightChecks', () => {
  it('passes with a valid minimal project', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [], []
    );
    expect(result.passed).toBe(true);
    expect(result.blockingCount).toBe(0);
  });

  it('warns on empty project name', () => {
    const result = runPreflightChecks(
      makeProject({ name: '' }),
      [makeScript()],
      [], [], [], []
    );
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.issues.some(i => i.message.includes('Project name is empty'))).toBe(true);
  });

  it('warns when there are no scripts', () => {
    const result = runPreflightChecks(
      makeProject(),
      [],
      [], [], [], []
    );
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.issues.some(i => i.category === 'script' && i.message.includes('no scripts'))).toBe(true);
  });

  it('warns on empty script content', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript({ content: '' })],
      [], [], [], []
    );
    expect(result.issues.some(i => i.message.includes('empty content'))).toBe(true);
  });

  it('warns on duplicate scene indices', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript({ id: 's1', sceneIndex: 1 }), makeScript({ id: 's2', sceneIndex: 1 })],
      [], [], [], []
    );
    expect(result.issues.some(i => i.message.includes('Duplicate scene index'))).toBe(true);
  });

  it('blocks on invalid asset URL', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [],
      [makeAsset({ url: 'not-a-valid-url' })]
    );
    expect(result.blockingCount).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.severity === 'blocking' && i.category === 'asset')).toBe(true);
  });

  it('blocks on empty asset URL', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [],
      [makeAsset({ url: '' })]
    );
    expect(result.blockingCount).toBeGreaterThan(0);
  });

  it('blocks on empty asset name', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [],
      [makeAsset({ name: '', url: 'https://example.com/x.png' })]
    );
    expect(result.issues.some(i => i.severity === 'blocking' && i.category === 'filename')).toBe(true);
  });

  it('warns on duplicate asset filenames', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [],
      [
        makeAsset({ id: 'a1', name: 'image.png' }),
        makeAsset({ id: 'a2', name: 'image.png' }),
      ]
    );
    expect(result.issues.some(i => i.category === 'filename' && i.message.includes('share the filename'))).toBe(true);
  });

  it('warns on keyframes without images', () => {
    const keyframes: Keyframe[] = [{
      id: 'kf-1',
      projectId: 'proj-1',
      storyboardId: 'sb-1',
      order: 1,
      createdAt: '2024-01-01T00:00:00Z',
    }];
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [],
      keyframes,
      [],
      []
    );
    expect(result.issues.some(i => i.message.includes('have no image URL'))).toBe(true);
  });

  it('info when no storyboards', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [], []
    );
    expect(result.issues.some(i => i.severity === 'info' && i.category === 'storyboard')).toBe(true);
  });

  it('info when no keyframes', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [], []
    );
    expect(result.issues.some(i => i.severity === 'info' && i.category === 'keyframe')).toBe(true);
  });

  it('warns when keyframe references nonexistent storyboard', () => {
    const keyframes: Keyframe[] = [{
      id: 'kf-1',
      projectId: 'proj-1',
      storyboardId: 'does-not-exist',
      order: 1,
      imageUrl: 'https://example.com/kf.png',
      createdAt: '2024-01-01T00:00:00Z',
    }];
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [],
      keyframes,
      [],
      []
    );
    expect(result.issues.some(i => i.message.includes('does not exist'))).toBe(true);
  });

  it('info on special characters in filename that will be sanitized', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [],
      [makeAsset({ name: 'my file (1).png', url: 'https://example.com/x.png' })]
    );
    expect(result.issues.some(i => i.severity === 'info' && i.message.includes('special characters'))).toBe(true);
  });

  it('warns on video plan without settings', () => {
    const videoPlans: VideoPlan[] = [{
      id: 'vp-1',
      projectId: 'proj-1',
      settings: {},
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }];
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [],
      videoPlans,
      []
    );
    expect(result.issues.some(i => i.category === 'video_plan' && i.message.includes('no settings'))).toBe(true);
  });

  it('sets checkedAt to ISO timestamp', () => {
    const result = runPreflightChecks(makeProject(), [makeScript()], [], [], [], []);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts relative URLs starting with /', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [],
      [makeAsset({ url: '/api/assets/xyz/download' })]
    );
    expect(result.blockingCount).toBe(0);
  });

  it('accepts blob: URLs', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript()],
      [], [], [],
      [makeAsset({ url: 'blob:http://localhost/abc-123' })]
    );
    expect(result.blockingCount).toBe(0);
  });

  it('blocks when project has no ID (audit log impossible)', () => {
    const result = runPreflightChecks(
      makeProject({ id: '' }),
      [makeScript()], [], [], [], []
    );
    expect(result.blockingCount).toBeGreaterThan(0);
    expect(result.issues.some(i => i.category === 'general' && i.message.includes('no ID'))).toBe(true);
  });

  it('warns when project has no userId (anonymous export)', () => {
    const result = runPreflightChecks(
      makeProject({ userId: '' }),
      [makeScript()], [], [], [], []
    );
    expect(result.issues.some(i => i.severity === 'warning' && i.message.includes('no user ID'))).toBe(true);
  });

  it('info on very short script content', () => {
    const result = runPreflightChecks(
      makeProject(),
      [makeScript({ content: 'Hi' })],
      [], [], [], []
    );
    expect(result.issues.some(i => i.severity === 'info' && i.message.includes('very short'))).toBe(true);
  });

  it('warns on keyframe with invalid image URL', () => {
    const keyframes: Keyframe[] = [{
      id: 'kf-1', projectId: 'proj-1', storyboardId: 'sb-1', order: 1,
      imageUrl: 'not a url',
      createdAt: '2024-01-01T00:00:00Z',
    }];
    const storyboards: Storyboard[] = [{
      id: 'sb-1', projectId: 'proj-1', sceneId: null as unknown as string, order: 1,
      createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    }];
    const result = runPreflightChecks(
      makeProject(), [makeScript()], storyboards, keyframes, [], []
    );
    expect(result.issues.some(i => i.category === 'keyframe' && i.message.includes('invalid image URL'))).toBe(true);
  });

  it('info for orphan storyboards with no keyframes', () => {
    const storyboards: Storyboard[] = [
      { id: 'sb-1', projectId: 'proj-1', sceneId: null as unknown as string, order: 1,
        title: 'Empty board', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
    ];
    const result = runPreflightChecks(
      makeProject(), [makeScript()], storyboards, [], [], []
    );
    expect(result.issues.some(i => i.message.includes('no keyframes attached'))).toBe(true);
  });

  it('info for keyframes without prompts', () => {
    const keyframes: Keyframe[] = [{
      id: 'kf-1', projectId: 'proj-1', storyboardId: null as unknown as string, order: 1,
      imageUrl: 'https://example.com/kf.png',
      createdAt: '2024-01-01T00:00:00Z',
    }];
    const result = runPreflightChecks(
      makeProject(), [makeScript()], [], keyframes, [], []
    );
    // No prompt → info; imageUrl present → no warning
    expect(result.issues.some(i => i.severity === 'info' && i.message.includes('no generation prompt'))).toBe(true);
    expect(result.warningCount).toBe(0);
  });

  it('info when video plan lacks core settings', () => {
    const videoPlans: VideoPlan[] = [{
      id: 'vp-1', projectId: 'proj-1',
      settings: { style: 'cinematic' }, // no resolution/fps/duration
      createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    }];
    const result = runPreflightChecks(
      makeProject(), [makeScript()], [], [], videoPlans, []
    );
    expect(result.issues.some(i => i.message.includes('missing resolution/fps/duration'))).toBe(true);
  });

  it('classifies issues into correct severity buckets', () => {
    const result = runPreflightChecks(
      makeProject({ id: '', name: '' }),  // blocking (no id) + warning (no name)
      [],                                  // warning (no scripts)
      [],                                  // info (no storyboards)
      [],                                  // info (no keyframes)
      [],                                  // info (no video plan)
      [
        makeAsset({ url: '' }),            // blocking
        makeAsset({ name: '' , url: 'https://x.com/a.png' }), // blocking (empty name)
        makeAsset({ id: 'a2', name: 'image.png', url: 'https://x.com/b.png' }), // duplicate warning
      ]
    );
    expect(result.passed).toBe(false);
    expect(result.blockingCount).toBeGreaterThanOrEqual(3);
    expect(result.warningCount).toBeGreaterThanOrEqual(2);
    expect(result.infoCount).toBeGreaterThanOrEqual(3);
    expect(result.issues.length).toBe(result.blockingCount + result.warningCount + result.infoCount);
  });

  // --- Additional edge cases ---

  it('counts match filtered arrays exactly (not just lower bounds)', () => {
    const result = runPreflightChecks(
      makeProject({ id: '', name: '' }), // blocking (no id) + warning (empty name)
      [],                                // warning (no scripts)
      [],                                // info (no storyboards)
      [],                                // info (no keyframes)
      [],                                // info (no video plan)
      []                                 // info (no assets)
    );
    const blockings = result.issues.filter(i => i.severity === 'blocking');
    const warnings = result.issues.filter(i => i.severity === 'warning');
    const infos = result.issues.filter(i => i.severity === 'info');
    expect(result.blockingCount).toBe(blockings.length);
    expect(result.warningCount).toBe(warnings.length);
    expect(result.infoCount).toBe(infos.length);
    expect(result.passed).toBe(blockings.length === 0);
  });

  it('checkedAt is ISO-8601 timestamp', () => {
    const result = runPreflightChecks(makeProject(), [makeScript()], [], [], [], []);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('passed=true when there are warnings and infos but no blocking issues', () => {
    const result = runPreflightChecks(
      makeProject(),
      [],            // warning: no scripts
      [],            // info: no storyboards
      [], [], []     // info: no kf, no vp, no assets
    );
    expect(result.passed).toBe(true);
    expect(result.blockingCount).toBe(0);
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.infoCount).toBeGreaterThan(0);
  });

  it('multiple duplicates are all reported', () => {
    const result = runPreflightChecks(
      makeProject(), [makeScript()], [], [], [],
      [
        makeAsset({ id: 'a1', name: 'img.png', url: 'https://a.com/1.png' }),
        makeAsset({ id: 'a2', name: 'img.png', url: 'https://a.com/2.png' }),
        makeAsset({ id: 'a3', name: 'clip.mp4', url: 'https://a.com/3.mp4' }),
        makeAsset({ id: 'a4', name: 'clip.mp4', url: 'https://a.com/4.mp4' }),
      ]
    );
    const dupIssues = result.issues.filter(i => i.category === 'filename' && i.message.includes('share the filename'));
    expect(dupIssues.length).toBe(2); // img.png + clip.mp4
    expect(dupIssues.some(i => i.message.includes('img.png'))).toBe(true);
    expect(dupIssues.some(i => i.message.includes('clip.mp4'))).toBe(true);
  });

  it('empty keyframe imageUrl counts but non-empty does not double-warn', () => {
    // One keyframe with image, one without
    const kfs: Keyframe[] = [
      { id: 'k1', projectId: 'proj-1', storyboardId: null as unknown as string, order: 1,
        imageUrl: 'https://example.com/a.png', createdAt: '2024-01-01T00:00:00Z' },
      { id: 'k2', projectId: 'proj-1', storyboardId: null as unknown as string, order: 2,
        createdAt: '2024-01-01T00:00:00Z' },
    ];
    const result = runPreflightChecks(makeProject(), [makeScript()], [], kfs, [], []);
    // Only 1 keyframe without image
    const noImg = result.issues.find(i => i.message.includes('have no image URL'));
    expect(noImg).toBeTruthy();
    expect(noImg?.details).toEqual({ count: 1 });
  });

  it('cross-reference: keyframe referencing existing storyboard does NOT warn', () => {
    const sbs: Storyboard[] = [makeStoryboard({ id: 'sb1' })];
    const kfs: Keyframe[] = [makeKeyframe(1, 'sb1')];
    const result = runPreflightChecks(makeProject(), [makeScript()], sbs, kfs, [], []);
    expect(result.issues.some(i => i.message.includes('does not exist'))).toBe(false);
  });

  it('info-only issues (storyboard without keyframes) are classified correctly', () => {
    const sbs: Storyboard[] = [
      makeStoryboard({ id: 'sb1', title: 'Empty board', description: 'd' }),
    ];
    const result = runPreflightChecks(makeProject(), [makeScript()], sbs, [], [], []);
    expect(result.issues.some(i =>
      i.severity === 'info' && i.message.includes('no keyframes attached'))).toBe(true);
  });

  it('blob: and relative URLs do not trigger blocking on assets', () => {
    const result = runPreflightChecks(
      makeProject(), [makeScript()], [], [], [],
      [
        makeAsset({ id: 'b1', url: 'blob:http://localhost/uuid-123', name: 'b.png' }),
        makeAsset({ id: 'b2', url: '/api/assets/123/download', name: 'c.png' }),
      ]
    );
    expect(result.blockingCount).toBe(0);
    expect(result.passed).toBe(true);
  });
});
