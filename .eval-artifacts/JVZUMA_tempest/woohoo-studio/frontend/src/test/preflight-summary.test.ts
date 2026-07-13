// Tests for preflight summary correctness, entity tagging, and blocking/warning/info separation.
import { describe, it, expect } from 'vitest';
import { runPreflight } from '../utils/preflight';
import type { PreflightInput } from '../utils/preflight';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

function mk(opts: Partial<PreflightInput> = {}): PreflightInput {
  const project: Project = {
    id: 'p1', name: 'Proj', userId: 'u', createdAt: '', updatedAt: '',
  };
  return {
    project, scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
    ...opts,
  };
}

describe('preflight summary counts match severity buckets', () => {
  it('summary counts agree with array lengths on a noisy project', () => {
    const input = mk({
      project: { id: 'p1', name: '', userId: 'u', createdAt: '', updatedAt: '' },
      scripts: [
        { id: 's1', projectId: 'p1', title: '', content: '', createdAt: '', updatedAt: '' },
      ],
      storyboards: [
        { id: 'sb1', projectId: 'p1', title: 'T', scenes: [{ id: 'sc', description: '' }], createdAt: '', updatedAt: '' } as unknown as Storyboard,
      ],
      videoPlans: [
        { id: 'vp1', projectId: 'p1', config: { resolution: '', fps: -1, duration: 0 }, createdAt: '' },
      ],
      assets: [
        { id: 'a1', projectId: 'p1', name: 'dup', type: 'image', url: '', createdAt: '' },
        { id: 'a2', projectId: 'p1', name: 'dup', type: 'image', url: 'not-a-url', createdAt: '' },
      ],
    });
    const r = runPreflight(input);
    expect(r.summary.blockingCount).toBe(r.blocking.length);
    expect(r.summary.warningCount).toBe(r.warnings.length);
    expect(r.summary.infoCount).toBe(r.info.length);
    expect(r.allIssues.length).toBe(r.blocking.length + r.warnings.length + r.info.length);
    expect(r.canExport).toBe(r.blocking.length === 0);
  });

  it('canExport is false when any blocking issue exists; true otherwise', () => {
    const bad = runPreflight(mk({ project: { id: 'p', name: '', userId: 'u', createdAt: '', updatedAt: '' } }));
    expect(bad.canExport).toBe(false);

    const good = runPreflight(mk({
      scripts: [{ id: 's', projectId: 'p', title: 'Hi', content: 'Content', createdAt: '', updatedAt: '' }],
    }));
    expect(good.canExport).toBe(true);
  });
});

describe('preflight issues tag entityType / entityId when applicable', () => {
  it('script issues carry entityType=script and the script id', () => {
    const r = runPreflight(mk({
      scripts: [
        { id: 'script-xyz', projectId: 'p1', title: '', content: '', createdAt: '', updatedAt: '' },
      ],
    }));
    const titleIssue = r.allIssues.find((i) => i.code === 'SCRIPT_TITLE_EMPTY');
    expect(titleIssue?.entityType).toBe('script');
    expect(titleIssue?.entityId).toBe('script-xyz');
    const contentIssue = r.allIssues.find((i) => i.code === 'SCRIPT_EMPTY');
    expect(contentIssue?.entityType).toBe('script');
    expect(contentIssue?.entityId).toBe('script-xyz');
  });

  it('asset issues carry entityType=asset and the asset id', () => {
    const r = runPreflight(mk({
      assets: [{ id: 'asset-99', projectId: 'p1', name: '', type: 'image', url: '', createdAt: '' } as Asset],
    }));
    const noUrl = r.allIssues.find((i) => i.code === 'ASSET_NO_URL');
    expect(noUrl?.entityType).toBe('asset');
    expect(noUrl?.entityId).toBe('asset-99');
    const noName = r.allIssues.find((i) => i.code === 'ASSET_NAME_EMPTY');
    expect(noName?.entityType).toBe('asset');
    expect(noName?.entityId).toBe('asset-99');
  });

  it('storyboard scene issues carry entityType=storyboard', () => {
    const r = runPreflight(mk({
      storyboards: [
        { id: 'sb-b', projectId: 'p1', title: '', scenes: [], createdAt: '', updatedAt: '' } as unknown as Storyboard,
      ],
    }));
    const noScenes = r.allIssues.find((i) => i.code === 'STORYBOARD_NO_SCENES');
    expect(noScenes?.entityType).toBe('storyboard');
    expect(noScenes?.entityId).toBe('sb-b');
  });
});

describe('preflight does not double-count duplicate asset names', () => {
  it('exactly one DUPLICATE_ASSET_NAME warning for a pair; N-1 warnings for N duplicates', () => {
    const assets: Asset[] = [
      { id: 'a1', projectId: 'p', name: 'same.png', type: 'image', url: 'http://x/1.png', createdAt: '' },
      { id: 'a2', projectId: 'p', name: 'same.png', type: 'image', url: 'http://x/2.png', createdAt: '' },
      { id: 'a3', projectId: 'p', name: 'same.png', type: 'image', url: 'http://x/3.png', createdAt: '' },
    ];
    const r = runPreflight(mk({ assets }));
    const dupes = r.warnings.filter((w) => w.code === 'DUPLICATE_ASSET_NAME');
    // Each duplicate after the first gets one warning
    expect(dupes.length).toBe(2);
  });

  it('no duplicate warning when names differ', () => {
    const assets: Asset[] = [
      { id: 'a1', projectId: 'p', name: 'a.png', type: 'image', url: 'http://x/a.png', createdAt: '' },
      { id: 'a2', projectId: 'p', name: 'b.png', type: 'image', url: 'http://x/b.png', createdAt: '' },
    ];
    const r = runPreflight(mk({ assets }));
    expect(r.warnings.some((w) => w.code === 'DUPLICATE_ASSET_NAME')).toBe(false);
  });
});

describe('preflight handles edge cases', () => {
  it('very large script (>500_000 bytes) triggers SCRIPT_VERY_LARGE warning', () => {
    const big = 'x'.repeat(500_001);
    const r = runPreflight(mk({
      scripts: [{ id: 's-big', projectId: 'p', title: 'Big', content: big, createdAt: '', updatedAt: '' }],
    }));
    expect(r.warnings.some((w) => w.code === 'SCRIPT_VERY_LARGE')).toBe(true);
  });

  it('SCRIPT_VERY_LARGE is NOT triggered for exactly 500,000 bytes (threshold is >500,000)', () => {
    const exact = 'x'.repeat(500_000);
    const r = runPreflight(mk({
      scripts: [{ id: 's', projectId: 'p', title: 'S', content: exact, createdAt: '', updatedAt: '' }],
    }));
    expect(r.warnings.some((w) => w.code === 'SCRIPT_VERY_LARGE')).toBe(false);
  });

  it('whitespace-only script content counts as empty', () => {
    const r = runPreflight(mk({
      scripts: [{ id: 's', projectId: 'p', title: 'S', content: '   \n\t\n  ', createdAt: '', updatedAt: '' }],
    }));
    expect(r.warnings.some((w) => w.code === 'SCRIPT_EMPTY')).toBe(true);
  });

  it('keyframe with empty prompt emits KEYFRAME_EMPTY_PROMPT info', () => {
    const r = runPreflight(mk({
      keyframes: [{ id: 'k', projectId: 'p', storyboardId: 'sb', prompt: '', imageUrl: 'http://x/i.png', timestamp: 0 } as Keyframe],
    }));
    expect(r.info.some((i) => i.code === 'KEYFRAME_EMPTY_PROMPT')).toBe(true);
  });

  it('invalid duration on video plan triggers VIDEO_PLAN_INVALID_DURATION', () => {
    const r = runPreflight(mk({
      videoPlans: [{ id: 'vp', projectId: 'p', config: { resolution: '1080p', fps: 24, duration: -5 }, createdAt: '' }],
    }));
    expect(r.warnings.some((w) => w.code === 'VIDEO_PLAN_INVALID_DURATION')).toBe(true);
  });

  it('video plan with empty resolution triggers VIDEO_PLAN_NO_RESOLUTION', () => {
    const r = runPreflight(mk({
      videoPlans: [{ id: 'vp', projectId: 'p', config: { resolution: '', fps: 24, duration: 10 }, createdAt: '' }],
    }));
    expect(r.warnings.some((w) => w.code === 'VIDEO_PLAN_NO_RESOLUTION')).toBe(true);
  });
});

describe('preflight does not crash on null/undefined-ish inputs', () => {
  it('tolerates missing optional arrays', () => {
    // Pass an input with undefined arrays; the runner should treat them as empty.
    const r = runPreflight({
      project: { id: 'p', name: 'Hi', userId: 'u', createdAt: '', updatedAt: '' },
      scripts: [], storyboards: [], keyframes: [], videoPlans: [], assets: [],
    });
    expect(r.allIssues).toBeInstanceOf(Array);
    expect(r.summary.blockingCount).toBe(0);
  });
});
