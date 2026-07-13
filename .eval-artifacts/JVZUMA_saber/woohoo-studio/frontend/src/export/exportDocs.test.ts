// Tests for export docs generation and manifest summary

import { describe, it, expect } from 'vitest';
import { buildExportReadme, buildValidationReport } from '../export/exportDocs';
import type { ExportManifest, PreflightResult, AssetEntry, FileEntry } from '../types';

function makeManifest(overrides: Partial<ExportManifest> = {}): ExportManifest {
  const assets: AssetEntry[] = [
    {
      assetId: 'a1',
      name: 'image.png',
      type: 'image',
      source: 'https://example.com/image.png',
      packedInBundle: true,
      bundlePath: 'assets/image.png',
      sizeBytes: 12345,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  ];
  const files: FileEntry[] = [
    { path: 'manifest.json', kind: 'meta', sizeBytes: 2000, sha256: 'abc123' },
    { path: 'workspace_snapshot.json', kind: 'data', sizeBytes: 5000, sha256: 'def456' },
    { path: 'assets/image.png', kind: 'asset', sizeBytes: 12345, sha256: 'e3b0c4...' },
  ];

  return {
    schemaVersion: '1.0.0',
    projectId: 'proj-1',
    projectName: 'Test Project',
    exportedAt: '2024-06-01T12:00:00Z',
    exportType: 'full',
    exportOptions: { includeAssets: true, includeKeyframes: true, includeVideoPlans: true },
    counts: {
      scripts: 3,
      storyboards: 5,
      keyframes: 10,
      videoPlans: 1,
      assets: 1,
      files: files.length,
    },
    files,
    assets,
    missingAssets: [],
    generator: { name: 'woohoo-studio-export', version: '0.2.0' },
    ...overrides,
  };
}

function makePreflight(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return {
    passed: true,
    blockingCount: 0,
    warningCount: 0,
    infoCount: 2,
    issues: [],
    checkedAt: '2024-06-01T12:00:00Z',
    ...overrides,
  };
}

describe('buildExportReadme', () => {
  it('includes project name and manifest hash', () => {
    const manifest = makeManifest();
    const readme = buildExportReadme(manifest, 'abcdef1234567890', makePreflight());

    expect(readme).toContain('Test Project');
    expect(readme).toContain('abcdef1234567890');
    expect(readme).toContain('Full Project Bundle');
  });

  it('includes counts table', () => {
    const manifest = makeManifest();
    const readme = buildExportReadme(manifest, 'hash123', makePreflight());

    expect(readme).toContain('Scripts | 3');
    expect(readme).toContain('Storyboards | 5');
    expect(readme).toContain('Keyframes | 10');
  });

  it('shows core bundle label for core export type', () => {
    const manifest = makeManifest({ exportType: 'core' });
    const readme = buildExportReadme(manifest, 'hash123', makePreflight());

    expect(readme).toContain('Core Planning Bundle');
  });

  it('lists missing assets when present', () => {
    const assets: AssetEntry[] = [
      {
        assetId: 'a-fail',
        name: 'missing.png',
        type: 'image',
        source: 'https://bad.url/x.png',
        packedInBundle: false,
        failureReason: 'HTTP 404 Not Found',
      },
    ];
    const manifest = makeManifest({
      assets,
      missingAssets: ['a-fail'],
      counts: { ...makeManifest().counts, assets: 0 },
    });
    const readme = buildExportReadme(manifest, 'hash123', makePreflight());

    expect(readme).toContain('Missing / Failed Assets');
    expect(readme).toContain('missing.png');
    expect(readme).toContain('HTTP 404 Not Found');
  });

  it('shows blocking issues when present (overridden)', () => {
    const preflight = makePreflight({
      passed: false,
      blockingCount: 1,
      issues: [
        {
          severity: 'blocking',
          category: 'asset',
          message: 'Asset "broken.png" has invalid URL',
          entityName: 'broken.png',
        },
      ],
    });
    const manifest = makeManifest();
    const readme = buildExportReadme(manifest, 'hash123', preflight);

    expect(readme).toContain('Blocking Issues (Overridden)');
    expect(readme).toContain('broken.png');
  });

  it('includes verification instructions', () => {
    const manifest = makeManifest();
    const readme = buildExportReadme(manifest, 'hash123', makePreflight());

    expect(readme).toContain('How to Verify This Package');
    expect(readme).toContain('SHA-256');
  });

  it('includes security notes', () => {
    const manifest = makeManifest();
    const readme = buildExportReadme(manifest, 'hash123', makePreflight());

    expect(readme).toContain('Security & Privacy');
    expect(readme).toContain('API keys');
    expect(readme).toContain('tokens');
  });

  it('includes parameter summary when present', () => {
    const manifest = makeManifest({
      parameterSummary: { keyframes: { total: 10, withParameters: 8 } },
    });
    const readme = buildExportReadme(manifest, 'hash123', makePreflight());

    expect(readme).toContain('Generation Parameters Summary');
  });

  it('is a non-empty markdown document', () => {
    const readme = buildExportReadme(makeManifest(), 'hash123', makePreflight());
    expect(readme.length).toBeGreaterThan(500);
    expect(readme).toContain('# ');
  });

  it('includes all count categories in the summary table', () => {
    const m = makeManifest({
      counts: { scripts: 3, storyboards: 5, keyframes: 10, videoPlans: 2, assets: 4, files: 25 },
      assets: [
        { assetId: 'a1', name: 'packed.png', type: 'image', source: 'x', packedInBundle: true },
        { assetId: 'a2', name: 'missing.png', type: 'image', source: 'y', packedInBundle: false, failureReason: '404' },
      ] as AssetEntry[],
      missingAssets: ['a2'],
    });
    const readme = buildExportReadme(m, 'hash123', makePreflight());
    expect(readme).toContain('Scripts | 3');
    expect(readme).toContain('Storyboards | 5');
    expect(readme).toContain('Keyframes | 10');
    expect(readme).toContain('Video Plans | 2');
    expect(readme).toContain('Assets (total) | 4');
    expect(readme).toContain('Files in bundle | 25');
    expect(readme).toContain('Assets successfully packed | 1');
    expect(readme).toContain('Assets missing/failed | 1');
  });

  it('lists missing assets with failure reasons in a table', () => {
    const m = makeManifest({
      assets: [
        { assetId: 'fail-1', name: 'missing.png', type: 'image', source: 'bad', packedInBundle: false, failureReason: 'HTTP 404' },
      ] as AssetEntry[],
      missingAssets: ['fail-1'],
    });
    const readme = buildExportReadme(m, 'hash123', makePreflight());
    expect(readme).toContain('Missing / Failed Assets');
    expect(readme).toContain('missing.png');
    expect(readme).toContain('HTTP 404');
  });

  it('shows preflight blocking issues as overridden when present', () => {
    const m = makeManifest();
    const pf = makePreflight({
      passed: false,
      blockingCount: 1,
      warningCount: 2,
      infoCount: 3,
      issues: [
        { severity: 'blocking', category: 'asset', message: 'Asset X has bad URL', entityName: 'X' },
      ],
    });
    const readme = buildExportReadme(m, 'hash123', pf);
    expect(readme).toContain('Blocking Issues (Overridden)');
    expect(readme).toContain('Asset X has bad URL');
    expect(readme).toContain('**Blocking issues:** 1');
    expect(readme).toContain('**Warnings:** 2');
    expect(readme).toContain('**Info:** 3');
  });

  it('validation report lists every file with size and sha256', () => {
    const files: FileEntry[] = [
      { path: 'workspace_snapshot.json', kind: 'data', sizeBytes: 1000, sha256: 'a'.repeat(64) },
      { path: 'data/project.json', kind: 'data', sizeBytes: 200, sha256: 'b'.repeat(64) },
    ];
    const m = makeManifest({ files });
    const report = buildValidationReport(m, 'hash123');
    expect(report).toContain('workspace_snapshot.json');
    expect(report).toContain('data/project.json');
    expect(report).toContain('1000');
    expect(report).toContain('200');
    expect(report).toContain('a'.repeat(64));
    expect(report).toContain('b'.repeat(64));
    expect(report).toContain('| Path |');
    expect(report).toContain('| SHA-256 |');
  });
});

describe('buildValidationReport', () => {
  it('lists all file checksums', () => {
    const manifest = makeManifest();
    const report = buildValidationReport(manifest, 'manifesthash');

    expect(report).toContain('manifest.json');
    expect(report).toContain('workspace_snapshot.json');
    expect(report).toContain('assets/image.png');
    expect(report).toContain('abc123');
    expect(report).toContain('def456');
  });

  it('includes manifest hash at top', () => {
    const report = buildValidationReport(makeManifest(), 'abcdef0000000000');
    expect(report).toContain('Manifest Hash: abcdef0000000000');
  });

  it('has a table header', () => {
    const report = buildValidationReport(makeManifest(), 'hash');
    expect(report).toContain('| Path |');
    expect(report).toContain('| SHA-256 |');
  });
});

describe('manifest structure', () => {
  it('manifest has all required fields', () => {
    const m = makeManifest();
    expect(m).toHaveProperty('schemaVersion');
    expect(m).toHaveProperty('projectId');
    expect(m).toHaveProperty('projectName');
    expect(m).toHaveProperty('exportedAt');
    expect(m).toHaveProperty('exportType');
    expect(m).toHaveProperty('exportOptions');
    expect(m).toHaveProperty('counts');
    expect(m).toHaveProperty('files');
    expect(m).toHaveProperty('assets');
    expect(m).toHaveProperty('missingAssets');
    expect(m).toHaveProperty('generator');
  });

  it('file entries have path, kind, sizeBytes, sha256', () => {
    const m = makeManifest();
    for (const f of m.files) {
      expect(f).toHaveProperty('path');
      expect(f).toHaveProperty('kind');
      expect(f).toHaveProperty('sizeBytes');
      expect(f).toHaveProperty('sha256');
      expect(typeof f.sizeBytes).toBe('number');
      expect(f.sha256.length).toBeGreaterThan(0);
    }
  });

  it('asset entries have required fields', () => {
    const m = makeManifest();
    for (const a of m.assets) {
      expect(a).toHaveProperty('assetId');
      expect(a).toHaveProperty('name');
      expect(a).toHaveProperty('type');
      expect(a).toHaveProperty('source');
      expect(a).toHaveProperty('packedInBundle');
      expect(typeof a.packedInBundle).toBe('boolean');
    }
  });
});
