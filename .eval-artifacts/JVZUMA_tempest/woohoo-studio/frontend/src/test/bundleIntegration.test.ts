// Integration test: actually builds a bundle and inspects the resulting ZIP
// to verify manifest.json and workspace_snapshot.json are physically present.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildExportBundle } from '../utils/exportBundle';
import type { Project, Script, Storyboard, VideoPlan } from '../types';

function makeProject(): Project {
  return {
    id: 'audit-test-proj',
    name: 'Audit Test Project',
    userId: 'tester',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('export bundle integrity (integration)', () => {
  it('full bundle contains manifest.json with valid hash and file entries', async () => {
    const project = makeProject();
    const scripts: Script[] = [
      { id: 's1', projectId: project.id, title: 'Opening', content: 'FADE IN:\n\nA quiet morning.', createdAt: '', updatedAt: '' },
    ];
    const storyboards: Storyboard[] = [
      {
        id: 'sb1',
        projectId: project.id,
        title: 'Main',
        scenes: [{ id: 'sc1', index: 0, description: 'Establishing shot' }],
        createdAt: '',
        updatedAt: '',
      } as unknown as Storyboard,
    ];
    const videoPlans: VideoPlan[] = [
      {
        id: 'vp1',
        projectId: project.id,
        config: { resolution: '1920x1080', fps: 24, duration: 30, model: 'test-model' },
        createdAt: '',
      } as VideoPlan,
    ];

    const result = await buildExportBundle({
      project,
      scripts,
      storyboards,
      keyframes: [],
      videoPlans,
      assets: [],
      exportType: 'full',
    });

    const zip = await JSZip.loadAsync(result.blob);

    // All required files must physically exist in the ZIP
    for (const expected of [
      'project.json',
      'workspace_snapshot.json',
      'manifest.json',
      'validation_report.md',
      'README_EXPORT.md',
    ]) {
      const f = zip.file(expected);
      expect(f, `expected ${expected} in ZIP`).not.toBeNull();
    }

    // manifest.json is valid JSON with all required fields
    const manifestRaw = await zip.file('manifest.json')!.async('string');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.schemaVersion).toBe('1.0.0');
    expect(manifest.projectId).toBe(project.id);
    expect(manifest.projectName).toBe(project.name);
    expect(manifest.exportType).toBe('full');
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(Array.isArray(manifest.assets)).toBe(true);
    expect(Array.isArray(manifest.missingAssets)).toBe(true);
    expect(manifest.counts.files).toBeGreaterThan(0);
    expect(manifest.counts.scripts).toBe(1);
    expect(manifest.counts.storyboards).toBe(1);
    expect(manifest.counts.videoPlans).toBe(1);

    // Every file entry has path, kind, sizeBytes, sha256
    for (const fe of manifest.files) {
      expect(fe.path).toBeTypeOf('string');
      expect(['data', 'asset', 'document', 'metadata']).toContain(fe.kind);
      expect(typeof fe.sizeBytes).toBe('number');
      expect(fe.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // manifest.json lists itself as one of the files
    const manifestEntry = manifest.files.find((f: any) => f.path === 'manifest.json');
    expect(manifestEntry).toBeDefined();

    // workspace_snapshot.json lists itself
    const snapEntry = manifest.files.find((f: any) => f.path === 'workspace_snapshot.json');
    expect(snapEntry).toBeDefined();

    // workspace_snapshot.json is valid and correctly structured
    const snapRaw = await zip.file('workspace_snapshot.json')!.async('string');
    const snap = JSON.parse(snapRaw);
    expect(snap.version).toBe('1.0.0');
    expect(snap.project.id).toBe(project.id);
    expect(snap.project.name).toBe(project.name);
    expect(Array.isArray(snap.scripts)).toBe(true);
    expect(snap.scripts[0].title).toBe('Opening');
    expect(snap.scripts[0].lineCount).toBe(3);
    expect(Array.isArray(snap.storyboards)).toBe(true);
    expect(Array.isArray(snap.assets)).toBe(true);
    expect(Array.isArray(snap.videoPlans)).toBe(true);
    expect(snap.videoPlans[0].config.fps).toBe(24);
    expect(snap.pipeline.outputs).toEqual([]);

    // project.json contains sanitized data
    const projRaw = await zip.file('project.json')!.async('string');
    const proj = JSON.parse(projRaw);
    expect(proj.project.id).toBe(project.id);
    expect(Array.isArray(proj.scripts)).toBe(true);
    expect(Array.isArray(proj.storyboards)).toBe(true);

    // validation_report.md references manifest hash and verification
    const report = await zip.file('validation_report.md')!.async('string');
    expect(report).toContain('Manifest Hash');
    expect(report).toContain('How to Verify');
    expect(report).toContain(manifest.manifestHash.substring(0, 16));

    // README_EXPORT.md is identical to validation_report.md
    const readme = await zip.file('README_EXPORT.md')!.async('string');
    expect(readme).toBe(report);

    // counts.files matches actual ZIP entries (excluding directories)
    const actualZipFiles = Object.keys(zip.files).filter((k) => !zip.files[k].dir);
    expect(manifest.counts.files).toBe(actualZipFiles.length);

    // result summary matches manifest
    expect(result.summary.manifestHash).toBe(manifest.manifestHash);
  }, 30000);

  it('core export does not include assets directory but still includes manifest and snapshot', async () => {
    const project = makeProject();
    const result = await buildExportBundle({
      project,
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [{
        id: 'a1',
        projectId: project.id,
        name: 'img.png',
        type: 'image',
        url: 'http://example.com/img.png',
        createdAt: '',
      }],
      exportType: 'core',
    });

    const zip = await JSZip.loadAsync(result.blob);

    expect(zip.file('manifest.json')).not.toBeNull();
    expect(zip.file('workspace_snapshot.json')).not.toBeNull();
    expect(zip.file('project.json')).not.toBeNull();
    expect(zip.file('validation_report.md')).not.toBeNull();

    // core export should NOT pack assets into the assets/ folder
    const assetFiles = Object.keys(zip.files).filter((k) => k.startsWith('assets/'));
    expect(assetFiles.length).toBe(0);

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.exportType).toBe('core');
    // assets are listed but marked as not packed
    expect(manifest.assets.length).toBe(1);
    expect(manifest.assets[0].packed).toBe(false);
  }, 30000);

  it('snapshot export contains manifest, snapshot, and project data', async () => {
    const project = makeProject();
    const result = await buildExportBundle({
      project,
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [],
      exportType: 'snapshot',
    });

    const zip = await JSZip.loadAsync(result.blob);
    expect(zip.file('manifest.json')).not.toBeNull();
    expect(zip.file('workspace_snapshot.json')).not.toBeNull();

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.exportType).toBe('snapshot');
  }, 30000);

  it('full export scrubs secrets and absolute paths from every file in the bundle', async () => {
    const SECRET_API_KEY = 'sk-abc...1234';
    const SECRET_JWT = 'eyJhbGc...adQssw5c';
    const SECRET_AWS = 'AKIAIOSF...AMPLE';
    const LEAKY_PATH = '/home/alice/secret/leak.png';
    const LEAKY_CONFIG_PATH = '/etc/shadow';

    const project = {
      ...makeProject(),
      name: 'Project With Secrets',
    };
    const scripts: Script[] = [{
      id: 's1',
      projectId: project.id,
      title: 'Script mentioning key',
      content: `Backup key is ${SECRET_API_KEY}. Model at ${LEAKY_CONFIG_PATH}.`,
      createdAt: '',
      updatedAt: '',
    }];

    const result = await buildExportBundle({
      project,
      scripts,
      storyboards: [],
      keyframes: [],
      videoPlans: [{
        id: 'vp1', projectId: project.id,
        config: {
          resolution: '1920x1080', fps: 24, duration: 10,
          model: 'test-model',
          // intentional extra fields to test key-based redaction
          ...({
            apiKey: SECRET_API_KEY,
            authorization: `Bearer ${SECRET_JWT}`,
          } as Record<string, unknown>),
        },
        createdAt: '',
      }],
      assets: [
        { id: 'a1', projectId: project.id, name: 'leak.png', type: 'image',
          url: `file://${LEAKY_PATH}`, createdAt: '' },
        { id: 'a2', projectId: project.id, name: 'x.png', type: 'image',
          url: 'http://cdn.example.com/x.png', createdAt: '',
          // intentional extra field to test key-based redaction on assets
          ...({ aws_access_key_id: SECRET_AWS } as Record<string, unknown>) },
      ],
      exportType: 'full',
    });

    const zip = await JSZip.loadAsync(result.blob);

    // Read every file in the zip and concatenate to a string; no secret or absolute path must appear.
    const allContents: string[] = [];
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      allContents.push(await zip.file(name)!.async('string'));
    }
    const bundleText = allContents.join('\n---FILE-BOUNDARY---\n');

    // Secrets MUST NOT appear verbatim anywhere in the bundle.
    expect(bundleText).not.toContain(SECRET_API_KEY);
    expect(bundleText).not.toContain(SECRET_JWT);
    expect(bundleText).not.toContain(SECRET_AWS);
    // Absolute paths MUST NOT leak
    expect(bundleText).not.toContain('/home/alice');
    expect(bundleText).not.toContain(LEAKY_CONFIG_PATH);

    // The video plan config.apiKey should have been redacted via key-based matching
    const projectJson = JSON.parse(await zip.file('project.json')!.async('string'));
    expect(projectJson.videoPlans[0].config.apiKey).toBe('[REDACTED]');
    expect(projectJson.videoPlans[0].config.authorization).toBe('[REDACTED]');
  }, 30000);
});
