// Unit tests for URL validation and edge-case preflight rules added during audit
import { describe, it, expect } from 'vitest';
import { runPreflight, validateAssetUrl } from '../utils/preflight';
import type { Project, Asset } from '../types';

function makeProject(): Project {
  return {
    id: 'p1',
    name: 'Test',
    userId: 'u1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('validateAssetUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(validateAssetUrl('http://example.com/a.png').valid).toBe(true);
    expect(validateAssetUrl('https://cdn.example.com/a.png').valid).toBe(true);
  });
  it('accepts blob: and data: URLs (with info/warning from caller)', () => {
    expect(validateAssetUrl('blob:http://localhost/abc').valid).toBe(true);
    expect(validateAssetUrl('data:image/png;base64,AAAA').valid).toBe(true);
  });
  it('accepts relative URLs (flagged by caller as warning)', () => {
    expect(validateAssetUrl('/api/assets/123').valid).toBe(true);
    expect(validateAssetUrl('/api/assets/123').code).toBe('ASSET_RELATIVE_URL');
  });
  it('rejects empty URLs', () => {
    expect(validateAssetUrl('').valid).toBe(false);
    expect(validateAssetUrl('').code).toBe('ASSET_NO_URL');
    expect(validateAssetUrl('   ').valid).toBe(false);
  });
  it('rejects malformed URLs', () => {
    const r = validateAssetUrl('not a url at all');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('ASSET_INVALID_URL');
  });
  it('rejects file:// URLs (browser cannot download these)', () => {
    const r = validateAssetUrl('file:///home/user/secret.png');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('ASSET_FILE_URL');
  });
  it('rejects dangerous protocols (javascript:, vbscript:)', () => {
    expect(validateAssetUrl('javascript:alert(1)').valid).toBe(false);
    expect(validateAssetUrl('about:blank').valid).toBe(false);
  });
  it('rejects ftp:// and other unsupported protocols with warning-level code', () => {
    const r = validateAssetUrl('ftp://files.example.com/a.png');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('ASSET_UNSUPPORTED_PROTOCOL');
  });
});

describe('preflight: asset coverage', () => {
  it('blocks export for asset with invalid/malformed URL', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [{ id: 'a1', projectId: 'p1', name: 'bad.png', type: 'image', url: 'not a url', createdAt: '' } as Asset],
    });
    expect(res.canExport).toBe(false);
    expect(res.blocking.some((i) => i.code === 'ASSET_INVALID_URL')).toBe(true);
  });

  it('warns (but does not block) for file:// assets', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [{ id: 'a1', projectId: 'p1', name: 'local.png', type: 'image', url: 'file:///home/u/a.png', createdAt: '' } as Asset],
    });
    // file:// is undownloadable in browser but we mark as warning (not blocking) to allow forced export
    expect(res.canExport).toBe(true);
    expect(res.warnings.some((i) => i.code === 'ASSET_FILE_URL')).toBe(true);
  });

  it('warns for blob: and data: URLs', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [
        { id: 'a1', projectId: 'p1', name: 'b.png', type: 'image', url: 'blob:http://x/abc', createdAt: '' } as Asset,
        { id: 'a2', projectId: 'p1', name: 'd.png', type: 'image', url: 'data:image/png;base64,AA', createdAt: '' } as Asset,
      ],
    });
    expect(res.warnings.filter((i) => i.code === 'ASSET_LOCAL_ONLY_URL')).toHaveLength(2);
  });

  it('warns for duplicate filenames', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [
        { id: 'a1', projectId: 'p1', name: 'same.png', type: 'image', url: 'http://x/1.png', createdAt: '' } as Asset,
        { id: 'a2', projectId: 'p1', name: 'same.png', type: 'image', url: 'http://x/2.png', createdAt: '' } as Asset,
      ],
    });
    expect(res.warnings.some((i) => i.code === 'DUPLICATE_ASSET_NAME')).toBe(true);
  });

  it('blocks for asset with empty URL', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [{ id: 'a1', projectId: 'p1', name: 'x.png', type: 'image', url: '', createdAt: '' } as Asset],
    });
    expect(res.canExport).toBe(false);
    expect(res.blocking.some((i) => i.code === 'ASSET_NO_URL')).toBe(true);
  });

  it('warns for unsupported protocol (ftp, etc.)', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [{ id: 'a1', projectId: 'p1', name: 'f.png', type: 'image', url: 'ftp://example.com/f.png', createdAt: '' } as Asset],
    });
    expect(res.warnings.some((i) => i.code === 'ASSET_UNSUPPORTED_PROTOCOL')).toBe(true);
  });

  it('info for unknown file size', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [{ id: 'a1', projectId: 'p1', name: 'a.png', type: 'image', url: 'http://x/a.png', createdAt: '' } as Asset],
    });
    expect(res.info.some((i) => i.code === 'ASSET_UNKNOWN_SIZE')).toBe(true);
  });
});

describe('preflight: scripts, storyboards, empty content', () => {
  it('warns for script with empty title', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [{ id: 's1', projectId: 'p1', title: '', content: 'something', createdAt: '', updatedAt: '' } as any],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [],
    });
    expect(res.warnings.some((i) => i.code === 'SCRIPT_TITLE_EMPTY')).toBe(true);
  });

  it('warns for storyboard with empty title', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [{ id: 'sb1', projectId: 'p1', title: '', scenes: [{ id: 'x', index: 0, description: 'd' }], createdAt: '', updatedAt: '' } as any],
      keyframes: [],
      videoPlans: [],
      assets: [],
    });
    expect(res.warnings.some((i) => i.code === 'STORYBOARD_TITLE_EMPTY')).toBe(true);
  });

  it('warns for empty script content', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [{ id: 's1', projectId: 'p1', title: 'Intro', content: '  ', createdAt: '', updatedAt: '' } as any],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [],
    });
    expect(res.warnings.some((i) => i.code === 'SCRIPT_EMPTY')).toBe(true);
  });

  it('info for scene with empty description', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [{ id: 'sb1', projectId: 'p1', title: 'X', scenes: [{ id: 'x', index: 0, description: '' }], createdAt: '', updatedAt: '' } as any],
      keyframes: [],
      videoPlans: [],
      assets: [],
    });
    expect(res.info.some((i) => i.code === 'SCENE_DESCRIPTION_EMPTY')).toBe(true);
  });

  it('info when no scripts exist at all', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [],
    });
    expect(res.info.some((i) => i.code === 'NO_SCRIPTS')).toBe(true);
  });
});

describe('preflight: severity summary', () => {
  it('issues are correctly partitioned by severity', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [
        { id: 'a1', projectId: 'p1', name: '', type: 'image', url: '', createdAt: '' } as Asset, // blocking: no url; warning: empty name
        { id: 'a2', projectId: 'p1', name: 'x.png', type: 'image', url: 'not a url', createdAt: '' } as Asset, // blocking
      ],
    });
    expect(res.summary.blockingCount).toBe(res.blocking.length);
    expect(res.summary.warningCount).toBe(res.warnings.length);
    expect(res.summary.infoCount).toBe(res.info.length);
    expect(res.allIssues.length).toBe(res.blocking.length + res.warnings.length + res.info.length);
    expect(res.canExport).toBe(res.blocking.length === 0);
  });

  it('all blocking/warning/info codes are distinct and present', () => {
    const res = runPreflight({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [],
    });
    const allCodes = new Set(res.allIssues.map((i) => i.code));
    // Expect info codes for missing data
    expect(allCodes.has('NO_SCRIPTS')).toBe(true);
    expect(allCodes.has('NO_VIDEO_PLANS')).toBe(true);
    expect(new Set(res.info.map((i) => i.severity)).size).toBeLessThanOrEqual(1);
  });
});
