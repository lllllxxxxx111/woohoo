// Tests for the export build result summary contract.
// Verifies that buildExportBundle returns a consistent summary:
//   - manifestHash matches manifest.manifestHash
//   - totalFileCount matches the manifest.files.length
//   - packedAssetCount matches the number of entries with packed=true
//   - missingAssetCount matches manifest.counts.missingAssets
//   - totalSizeBytes equals the produced Blob's size
//   - fileName follows the SafeName_type_timestamp.zip pattern
import { describe, it, expect } from 'vitest';
import { buildExportBundle } from '../utils/exportBundle';
import { runPreflight } from '../utils/preflight';
import type { Project, Script, Storyboard, Keyframe, VideoPlan, Asset } from '../types';

function mkProject(name = 'Summary Test'): Project {
  return { id: 'sum-proj', name, userId: 'u', createdAt: '', updatedAt: '' };
}

async function buildSummary(exportType: 'full' | 'core' | 'snapshot' = 'full', assets?: Asset[]) {
  const project = mkProject();
  const scripts: Script[] = [
    { id: 's1', projectId: project.id, title: 'Hi', content: 'content', createdAt: '', updatedAt: '' },
  ];
  const storyboards: Storyboard[] = [];
  const keyframes: Keyframe[] = [];
  const videoPlans: VideoPlan[] = [
    { id: 'vp1', projectId: project.id, config: { resolution: '1080p', fps: 24, duration: 5 }, createdAt: '' },
  ];
  const assetList: Asset[] = assets ?? [
    // one asset that will fail to download (invalid URL scheme)
    { id: 'a1', projectId: project.id, name: 'missing.mp4', type: 'video', url: 'http://127.0.0.1:1/x', createdAt: '' },
  ];
  const preflight = runPreflight({
    project, scripts, storyboards, keyframes, videoPlans, assets: assetList,
  });
  const result = await buildExportBundle({
    project, scripts, storyboards, keyframes, videoPlans, assets: assetList,
    exportType, preflight,
  });
  return { ...result, preflight };
}

describe('buildExportBundle result summary contract', () => {
  it('summary.manifestHash matches manifest.manifestHash (64 hex chars)', async () => {
    const { summary, manifest } = await buildSummary('full');
    expect(summary.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.manifestHash).toBe(manifest.manifestHash);
  });

  it('summary.totalFileCount equals manifest.files.length', async () => {
    const { summary, manifest } = await buildSummary('full');
    expect(summary.totalFileCount).toBe(manifest.files.length);
  });

  it('summary.packedAssetCount equals number of assets with packed=true', async () => {
    const { summary, manifest } = await buildSummary('full');
    const packedCount = manifest.assets.filter((a) => a.packed).length;
    expect(summary.packedAssetCount).toBe(packedCount);
  });

  it('summary.missingAssetCount equals manifest.counts.missingAssets and matches missingAssets list length', async () => {
    const { summary, manifest } = await buildSummary('full');
    expect(summary.missingAssetCount).toBe(manifest.counts.missingAssets);
    expect(summary.missingAssetCount).toBe(manifest.missingAssets.length);
  });

  it('summary.totalSizeBytes equals blob.size (matches the actual payload)', async () => {
    const { summary, blob } = await buildSummary('full');
    expect(summary.totalSizeBytes).toBe(blob.size);
    expect(summary.totalSizeBytes).toBeGreaterThan(0);
  });

  it('fileName matches SafeName_type_timestamp.zip', async () => {
    const { fileName } = await buildSummary('full');
    // "Summary Test" -> "Summary_Test" (non-word chars replaced with _)
    expect(fileName).toMatch(/^Summary_Test_full_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/);
  });

  it('core export has zero packed assets; core assets are listed with packed=false but not counted as "missing"', async () => {
    const { summary, manifest } = await buildSummary('core');
    // core export never attempts to pack binaries
    expect(summary.packedAssetCount).toBe(0);
    expect(summary.missingAssetCount).toBe(0);
    // But asset metadata is still listed in manifest
    expect(manifest.counts.assets).toBe(1);
    expect(manifest.assets[0].packed).toBe(false);
    expect(manifest.assets[0].errorReason).toBe('Not included in core/snapshot export');
    // No assets/ directory in files list
    const assetFileCount = manifest.files.filter((f) => f.path.startsWith('assets/')).length;
    expect(assetFileCount).toBe(0);
  });

  it('snapshot export includes summary with zero asset count (no heavy data)', async () => {
    const { summary, manifest } = await buildSummary('snapshot');
    expect(summary.packedAssetCount).toBe(0);
    expect(manifest.exportType).toBe('snapshot');
    // snapshot still contains manifest/snapshot/project/report
    expect(summary.totalFileCount).toBeGreaterThanOrEqual(4);
  });
});
