import { describe, expect, it } from 'vitest';
import { BUNDLE_SCHEMA_VERSION } from './exportAudit';
import type {
  AssetRegistryEntry,
  AuditableManifest,
  MissingAssetEntry,
  ExportResult,
} from './exportAudit';
import { buildAuditableManifest, createProjectSnapshot } from './workspaceMvp';
import type {
  Asset,
  Project,
  Script,
  Storyboard,
} from '../../../../types';

// ─── Minimal fixture builders ───────────────────────────────────────────────

function makeWorkflow() {
  return {
    status: 'draft',
    phase: 'ready',
    progressPercent: 100,
    assetCount: 3,
    scriptReady: true,
    storyboardReady: true,
    storyboardLineCount: 2,
    conversationCount: 1,
    messageCount: 2,
    assignedAgentCount: 0,
    queuedTaskCount: 0,
    runningTaskCount: 0,
    completedTaskCount: 3,
    failedTaskCount: 0,
    roleCounts: { design: 0, review: 0, editor: 0, manager: 0, custom: 0 },
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: '遗忘回收站',
    status: 'draft',
    phase: 'ready',
    chatSessions: [
      {
        id: 'chat-1',
        projectId: 'project-1',
        title: '创意对话',
        messages: [
          { id: 'm-1', role: 'user', content: '来个短剧', timestamp: 1 },
          { id: 'm-2', role: 'ai',   content: '# 完整剧本\n\n林澈：你好。', timestamp: 2 },
        ],
        updatedAt: 2,
      },
    ],
    agentRoster: [],
    workflow: makeWorkflow(),
    assetsCount: 3,
    createdAt: 1,
    ...overrides,
  };
}

const SCRIPT_TEXT = `# 完整剧本

## 第1场 外景 回收站 傍晚

林澈：如果我把这段记忆丢掉，是不是就不会难过了？
小满：可你也会忘记那天为什么开心。

## 第2场 内景 值班室 夜

林澈：那就先存在这里。
小满：我会陪你一起等。
`;

function makeScript(): Script {
  return {
    id: 'script-1',
    projectId: 'project-1',
    title: '《遗忘回收站》剧本',
    content: SCRIPT_TEXT,
    updatedAt: 10,
  };
}

function makeStoryboard(): Storyboard {
  return {
    id: 'sb-1',
    projectId: 'project-1',
    updatedAt: 11,
    lines: [
      {
        id: 'l-1', sceneNumber: 1,
        description: '林澈站在玻璃门前，看到盒子里的光点忽明忽暗。',
        duration: 8, assets: [],
      },
      {
        id: 'l-2', sceneNumber: 2,
        description: '小满把透明盒子交给林澈。',
        duration: 10, assets: [],
      },
    ],
  };
}

function makeAssets(): Asset[] {
  return [
    { id: 'a-1', projectId: 'project-1', name: 'opening.png',  type: 'image', url: 'https://cdn.example.com/a-1.png', createdAt: 20 },
    { id: 'a-2', projectId: 'project-1', name: 'character.jpg', type: 'image', url: 'https://cdn.example.com/a-2.jpg', createdAt: 21 },
    { id: 'a-3', projectId: 'project-1', name: 'score.mp3',   type: 'audio', url: 'https://cdn.example.com/a-3.mp3', createdAt: 22 },
  ];
}

// ─── Manifest shape & contract ──────────────────────────────────────────────

describe('buildAuditableManifest', () => {
  it('emits a well-formed AuditableManifest with required top-level sections', async () => {
    const project = makeProject();
    const assets = makeAssets();
    const snapshot = createProjectSnapshot({
      project,
      script: makeScript(),
      scriptText: SCRIPT_TEXT,
      storyboard: makeStoryboard(),
      assets,
    });
    const assetRegistry: AssetRegistryEntry[] = assets.map((a) => ({
      id: a.id, name: a.name, type: a.type, sourceUrl: a.url,
      isRemote: true, sizeBytes: 1024, sha256: `sha-${a.id}`, status: 'included',
      pathInBundle: `assets/${a.name}`, createdAt: a.createdAt,
    }));
    const missingAssets: MissingAssetEntry[] = [];

    const manifest = await buildAuditableManifest(
      project, snapshot, assets, assetRegistry, missingAssets,
      makeScript(), makeStoryboard(), 'full', [], 3 * 1024,
    );

    // Top-level keys
    expect(manifest.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(manifest.exportMeta.exportType).toBe('full');
    expect(manifest.project.id).toBe('project-1');
    expect(manifest.project.name).toBe('遗忘回收站');
    expect(manifest.summary.totalAssets).toBe(3);
    expect(manifest.summary.includedAssets).toBe(3);
    expect(manifest.summary.missingAssets).toBe(0);
    expect(manifest.assetRegistry).toHaveLength(3);
    expect(manifest.missingAssets).toHaveLength(0);
    expect(Array.isArray(manifest.contentVersions)).toBe(true);
    expect(manifest.verification).toBeDefined();
    expect(manifest.verification.allPassed).toBe(true);
    expect(manifest.reproducibility.projectId).toBe('project-1');
    expect(manifest.reproducibility.bundleSchemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(Array.isArray(manifest.chapters)).toBe(true);
    expect(Array.isArray(manifest.characters)).toBe(true);
    expect(Array.isArray(manifest.scenes)).toBe(true);
    expect(Array.isArray(manifest.keyframes)).toBe(true);
    expect(manifest.finalCut).toBeDefined();
    expect(manifest.finalCut.totalShots).toBeGreaterThanOrEqual(2);
    expect(manifest.generationParams).toBeDefined();
    expect(Array.isArray(manifest.sensitiveDataFindings)).toBe(true);
  });

  it('contentVersions carries a sha256 for script, storyboard and finalCut', async () => {
    const project = makeProject();
    const assets = makeAssets();
    const snapshot = createProjectSnapshot({
      project, script: makeScript(), scriptText: SCRIPT_TEXT,
      storyboard: makeStoryboard(), assets,
    });
    const manifest = await buildAuditableManifest(
      project, snapshot, assets, [], [], makeScript(), makeStoryboard(), 'core', [], 500,
    );
    const kinds = manifest.contentVersions.map((v) => v.kind);
    expect(kinds).toContain('script');
    expect(kinds).toContain('storyboard');
    expect(kinds).toContain('finalCut');
    expect(kinds).toContain('conversations');

    for (const v of manifest.contentVersions) {
      if (v.sha256) expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof v.itemCount).toBe('number');
      expect(typeof v.label).toBe('string');
    }
  });

  it('propagates missing asset counts and marks allPassed=true (warnings are not errors)', async () => {
    const project = makeProject();
    const assets = makeAssets();
    const snapshot = createProjectSnapshot({
      project, script: makeScript(), scriptText: SCRIPT_TEXT,
      storyboard: makeStoryboard(), assets,
    });
    const included: AssetRegistryEntry[] = [
      { id: 'a-1', name: 'opening.png', type: 'image', sourceUrl: 'https://x', isRemote: true,
        sizeBytes: 1024, sha256: 'deadbeef', status: 'included', pathInBundle: 'assets/opening.png', createdAt: 20 },
      { id: 'a-2', name: 'character.jpg', type: 'image', sourceUrl: 'https://x', isRemote: true,
        sizeBytes: 2048, sha256: 'cafebabe', status: 'included', pathInBundle: 'assets/character.jpg', createdAt: 21 },
    ];
    const missing: MissingAssetEntry[] = [
      { id: 'a-3', name: 'score.mp3', type: 'audio', reason: 'download_failed', sourceUrl: 'https://x/a-3' },
    ];

    const manifest = await buildAuditableManifest(
      project, snapshot, assets, included, missing,
      makeScript(), makeStoryboard(), 'full', [], 3072,
    );
    expect(manifest.summary.totalAssets).toBe(3);
    expect(manifest.summary.includedAssets).toBe(2);
    expect(manifest.summary.missingAssets).toBe(1);
    expect(manifest.assetRegistry).toHaveLength(2);
    expect(manifest.missingAssets).toHaveLength(1);
    expect(manifest.missingAssets[0].reason).toBe('download_failed');

    // Missing assets is a warning, not an error -> allPassed stays true.
    expect(manifest.verification.failedChecks).toBe(0);
    expect(manifest.verification.warningChecks).toBeGreaterThanOrEqual(1);
    expect(manifest.verification.allPassed).toBe(true);
  });

  it('flags sensitive-data findings as a warning and records them', async () => {
    const project = makeProject();
    const assets = makeAssets();
    const snapshot = createProjectSnapshot({
      project, script: makeScript(), scriptText: SCRIPT_TEXT,
      storyboard: makeStoryboard(), assets,
    });
    const findings = [
      { field: 'script', type: 'api_key' as const, redacted: true },
    ];
    const manifest = await buildAuditableManifest(
      project, snapshot, assets, [], [], makeScript(), makeStoryboard(),
      'full', findings, 100,
    );
    expect(manifest.sensitiveDataFindings).toHaveLength(1);
    const sd = manifest.verification.checks.find((c) => c.name === 'security.sensitive_data');
    expect(sd?.severity).toBe('warning');
    expect(sd?.passed).toBe(false);
    expect(manifest.verification.failedChecks).toBe(0);
  });

  it('includes reproducibility snapshot with workflow + agent roster', async () => {
    const project = makeProject({
      agentRoster: [
        { id: 'agent-1', name: '写手-01', role: 'design', model: 'g' },
      ],
    });
    const assets = makeAssets();
    const snapshot = createProjectSnapshot({
      project, script: makeScript(), scriptText: SCRIPT_TEXT,
      storyboard: makeStoryboard(), assets,
    });
    const manifest = await buildAuditableManifest(
      project, snapshot, assets, [], [], makeScript(), makeStoryboard(), 'full', [], 100,
    );
    expect(manifest.reproducibility.workflowSnapshot).toEqual(project.workflow);
    expect(manifest.reproducibility.agentRosterSnapshot).toHaveLength(1);
    expect(manifest.reproducibility.agentRosterSnapshot[0].id).toBe('agent-1');
    expect(manifest.reproducibility.conversationCount).toBe(1);
    expect(manifest.reproducibility.messageCount).toBe(2);
  });
});

// ─── ExportResult contract (the object the UI consumes) ─────────────────────

describe('ExportResult shape contract', () => {
  // We don't invoke exportFullProjectBundle here because it triggers DOM Blob
  // download; instead we validate the TypeScript-level shape the UI relies on.
  it('success result carries the fields the toast/modal read', () => {
    const result: ExportResult = {
      success: true,
      filename: 'demo-full-bundle.tar',
      exportType: 'full',
      totalAssets: 3,
      includedAssets: 3,
      missingAssets: 0,
      bundleSizeBytes: 12_345,
      scriptSections: 2,
      chapters: 0,
      shots: 2,
      totalDuration: 18,
      scriptSha256: 'a'.repeat(64),
      verification: {
        checkedAt: new Date().toISOString(),
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        checks: [],
        totalChecks: 8, passedChecks: 8, warningChecks: 0, failedChecks: 0,
        allPassed: true,
      },
      sensitiveDataFindings: [],
      durationSeconds: 2,
    };
    // Toast interpolates these four
    expect(typeof result.filename).toBe('string');
    expect(result.filename.endsWith('-bundle.tar')).toBe(true);
    expect(typeof result.includedAssets).toBe('number');
    expect(typeof result.missingAssets).toBe('number');
    expect(typeof result.durationSeconds).toBe('number');
    expect(result.includedAssets + result.missingAssets).toBeLessThanOrEqual(result.totalAssets);
    expect(result.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('core result has .md suffix and zero included binary assets', () => {
    const core: ExportResult = {
      success: true,
      filename: 'demo-core-bundle.md',
      exportType: 'core',
      totalAssets: 3,
      includedAssets: 0,
      missingAssets: 0,
      bundleSizeBytes: 4000,
      scriptSections: 2, chapters: 0, shots: 2, totalDuration: 18,
      scriptSha256: 'b'.repeat(64),
      verification: {
        checkedAt: new Date().toISOString(), schemaVersion: BUNDLE_SCHEMA_VERSION,
        checks: [], totalChecks: 0, passedChecks: 0, warningChecks: 0, failedChecks: 0, allPassed: true,
      },
      sensitiveDataFindings: [], durationSeconds: 1,
    };
    expect(core.filename.endsWith('-bundle.md')).toBe(true);
    expect(core.includedAssets).toBe(0);
  });

  it('error result carries errorMessage and success=false', () => {
    const err: ExportResult = {
      success: false,
      filename: '',
      exportType: 'full',
      totalAssets: 3,
      includedAssets: 0, missingAssets: 0, bundleSizeBytes: 0,
      verification: {
        checkedAt: new Date().toISOString(), schemaVersion: BUNDLE_SCHEMA_VERSION,
        checks: [], totalChecks: 0, passedChecks: 0, warningChecks: 0, failedChecks: 0, allPassed: false,
      },
      sensitiveDataFindings: [], durationSeconds: 0,
      errorMessage: 'Network error',
    };
    expect(err.success).toBe(false);
    expect(err.errorMessage).toBe('Network error');
  });
});

// ─── Sanity: createProjectSnapshot derives stable counts ─────────────────────

describe('createProjectSnapshot', () => {
  it('derives shots, chapters and duration from script + storyboard', () => {
    const project = makeProject();
    const snapshot = createProjectSnapshot({
      project,
      script: makeScript(),
      scriptText: SCRIPT_TEXT,
      storyboard: makeStoryboard(),
      assets: makeAssets(),
    });
    expect(snapshot.scriptText).toContain('林澈');
    expect(snapshot.scriptSections.length).toBeGreaterThan(0);
    expect(snapshot.finalCut.totalShots).toBeGreaterThanOrEqual(2);
    expect(snapshot.finalCut.totalDurationSeconds).toBeGreaterThan(0);
    expect(snapshot.chapters.length).toBeGreaterThan(0);
    expect(snapshot.keyframes.length).toBeGreaterThanOrEqual(2);
  });
});
