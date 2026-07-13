// Tests for validation report and workspace snapshot generation
import { describe, it, expect } from 'vitest';
import { generateValidationReport } from '../utils/validationReport';
import { buildWorkspaceSnapshot } from '../utils/workspaceSnapshot';
import type { ExportManifest, PreflightResult, Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

function makeProject(): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    userId: 'u1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

describe('generateValidationReport', () => {
  const baseManifest: ExportManifest = {
    projectId: 'p1',
    projectName: 'Test',
    exportedAt: '2024-01-01T00:00:00Z',
    schemaVersion: '1.0.0',
    exportType: 'full',
    counts: { files: 3, assets: 2, missingAssets: 1, scripts: 1, storyboards: 1, keyframes: 0, videoPlans: 1 },
    files: [
      { path: 'project.json', kind: 'data', sizeBytes: 100, sha256: 'a'.repeat(64) },
      { path: 'assets/img.png', kind: 'asset', sizeBytes: 2048, sha256: 'b'.repeat(64) },
      { path: 'manifest.json', kind: 'metadata', sizeBytes: 500, sha256: 'c'.repeat(64) },
    ],
    assets: [
      { assetId: 'a1', name: 'img.png', type: 'image', url: 'http://example.com/img.png', packed: true },
      { assetId: 'a2', name: 'missing.png', type: 'image', url: 'http://example.com/missing.png', packed: false, errorReason: 'HTTP 404' },
    ],
    missingAssets: ['a2'],
    generationParams: { resolution: '1920x1080', fps: 24 },
    manifestHash: 'd'.repeat(64),
  };

  it('generates valid markdown with header', () => {
    const md = generateValidationReport({ manifest: baseManifest });
    expect(md).toContain('# Test — Export Validation Report');
    expect(md).toContain('Project ID');
    expect(md).toContain('p1');
  });

  it('includes manifest hash when present', () => {
    const md = generateValidationReport({ manifest: baseManifest });
    expect(md).toContain('Manifest Hash');
    expect(md).toContain('dddd');
  });

  it('lists all files with their checksums', () => {
    const md = generateValidationReport({ manifest: baseManifest });
    expect(md).toContain('project.json');
    expect(md).toContain('assets/img.png');
    expect(md).toContain('manifest.json');
  });

  it('lists missing assets', () => {
    const md = generateValidationReport({ manifest: baseManifest });
    expect(md).toContain('Missing Assets');
    expect(md).toContain('a2');
  });

  it('includes preflight results when provided', () => {
    const preflight: PreflightResult = {
      projectId: 'p1',
      checkedAt: '2024-01-01T00:00:00Z',
      blocking: [],
      warnings: [{ severity: 'warning', code: 'DUP', message: 'Duplicate name' }],
      info: [],
      allIssues: [{ severity: 'warning', code: 'DUP', message: 'Duplicate name' }],
      canExport: true,
      summary: { blockingCount: 0, warningCount: 1, infoCount: 0 },
    };
    const md = generateValidationReport({ manifest: baseManifest, preflight });
    expect(md).toContain('Preflight Results');
    expect(md).toContain('Duplicate name');
  });

  it('includes verification instructions', () => {
    const md = generateValidationReport({ manifest: baseManifest });
    expect(md).toContain('How to Verify');
    expect(md).toContain('SHA-256');
  });

  it('includes sanitization notice', () => {
    const md = generateValidationReport({ manifest: baseManifest });
    expect(md).toContain('Sanitization Notice');
  });
});

describe('buildWorkspaceSnapshot', () => {
  it('creates a snapshot with correct structure', () => {
    const project = makeProject();
    const scripts: Script[] = [
      { id: 's1', projectId: 'p1', title: 'Intro', content: 'Hello\nWorld', createdAt: '', updatedAt: '' } as Script,
    ];
    const storyboards: Storyboard[] = [
      {
        id: 'sb1',
        projectId: 'p1',
        title: 'Main',
        scenes: [{ id: 'sc1', index: 0, description: 'Opening shot', keyframeIds: ['k1'] }],
        createdAt: '',
        updatedAt: '',
      } as unknown as Storyboard,
    ];
    const keyframes: Keyframe[] = [
      { id: 'k1', projectId: 'p1', storyboardId: 'sb1', assetId: 'a1', prompt: 'sunset', timestamp: 0 } as Keyframe,
    ];
    const videoPlans: VideoPlan[] = [
      { id: 'vp1', projectId: 'p1', config: { resolution: '1080p', fps: 24, duration: 60 }, createdAt: '' } as VideoPlan,
    ];
    const assets: Asset[] = [
      { id: 'a1', projectId: 'p1', name: 'img.png', type: 'image', url: 'http://example.com/img.png', fileSize: 1024, createdAt: '' } as Asset,
    ];

    const snap = buildWorkspaceSnapshot({ project, scripts, storyboards, keyframes, videoPlans, assets });

    expect(snap.version).toBe('1.0.0');
    expect(snap.project.id).toBe('p1');
    expect(snap.project.name).toBe('Test Project');
    expect(snap.scripts).toHaveLength(1);
    expect(snap.scripts[0].lineCount).toBe(2);
    expect(snap.scripts[0].charCount).toBe(11);
    expect(snap.storyboards[0].sceneCount).toBe(1);
    expect(snap.storyboards[0].totalKeyframes).toBe(1);
    expect(snap.keyframes[0].hasImage).toBe(true);
    expect(snap.assets[0].sizeBytes).toBe(1024);
    expect(snap.videoPlans[0].config.fps).toBe(24);
    expect(snap.pipeline.outputs).toEqual([]);
  });

  it('captures pipeline outputs when provided', () => {
    const snap = buildWorkspaceSnapshot({
      project: makeProject(),
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [],
      pipelineOutputs: [{ stage: 'render', status: 'complete', summary: '30fps' }],
    });
    expect(snap.pipeline.outputs).toHaveLength(1);
    expect(snap.pipeline.outputs[0].stage).toBe('render');
  });

  it('sanitizes sensitive fields', () => {
    const project = makeProject();
    (project as any).apiKey = 'secret-key';
    const snap = buildWorkspaceSnapshot({
      project,
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [],
    });
    expect((snap as any).apiKey).toBeUndefined();
    expect((snap as any).project.apiKey).toBeUndefined();
  });
});
