import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Project, Script, Storyboard } from '../../../../types';
import {
  sha256Bytes,
  sha256Text,
  isValidAssetUrl,
  precheckExport,
  createProjectSnapshot,
  buildProjectManifest,
} from './workspaceMvp';
import { sanitizeText, sanitizeValue, sanitizeJson } from './sensitiveSanitizer';

// ─── fixtures ───────────────────────────────────────

function emptyWorkflow() {
  return {
    status: 'draft',
    phase: 'script',
    progressPercent: 0,
    assetCount: 0,
    scriptReady: false,
    storyboardReady: false,
    storyboardLineCount: 0,
    conversationCount: 0,
    messageCount: 0,
    assignedAgentCount: 0,
    queuedTaskCount: 0,
    runningTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    roleCounts: { design: 0, review: 0, editor: 0, manager: 0, custom: 0 },
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: '测试项目',
    status: 'draft',
    phase: 'script',
    chatSessions: [],
    agentRoster: [],
    workflow: emptyWorkflow(),
    assetsCount: 0,
    createdAt: 1700000000000,
    ...overrides,
  };
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    projectId: 'proj-1',
    name: 'scene1.png',
    type: 'image',
    url: '/uploads/scene1.png',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function makeScript(overrides: Partial<Script> = {}): Script {
  return {
    id: 'script-1',
    projectId: 'proj-1',
    title: '测试剧本',
    content: '# 第一场\n\n角色A：你好。',
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function makeStoryboard(lines: Array<{ description?: string; duration?: number }> = []): Storyboard {
  return {
    id: 'sb-1',
    projectId: 'proj-1',
    updatedAt: 1700000000000,
    lines: lines.map((l, i) => ({
      id: `line-${i}`,
      sceneNumber: i + 1,
      description: l.description ?? `镜头${i + 1}：森林边缘，黄昏。`,
      duration: l.duration ?? 3,
      assets: [],
    })),
  };
}

// ─── SHA-256 哈希 ──────────────────────────────────

describe('sha256 hash generation', () => {
  it('sha256Text matches known SHA-256 for empty string', async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = await sha256Text('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('sha256Text matches known SHA-256 for "abc"', async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const hash = await sha256Text('abc');
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('sha256Bytes produces hex of length 64', async () => {
    const hash = await sha256Bytes(new TextEncoder().encode('hello world'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256Text and sha256Bytes agree on same content', async () => {
    const text = 'Woohoo Studio 可审计导出';
    const fromText = await sha256Text(text);
    const fromBytes = await sha256Bytes(new TextEncoder().encode(text));
    expect(fromText).toBe(fromBytes);
  });

  it('same input always produces identical hash (determinism)', async () => {
    const input = 'deterministic-test-input-💥';
    const a = await sha256Text(input);
    const b = await sha256Text(input);
    expect(a).toBe(b);
  });
});

// ─── 敏感字段剔除 ──────────────────────────────────

describe('sensitive field sanitization', () => {
  it('redacts OpenAI-style API keys (sk-...)', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz0123456789abcd';
    const input = `my key is ${key}, do not leak`;
    const { sanitized, findings } = sanitizeText(input);
    expect(sanitized).not.toContain(key);
    expect(sanitized).toContain('[REDACTED');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.category === 'api_key')).toBe(true);
  });

  it('redacts AWS access key IDs (AKIA + 16 alnum)', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const input = `aws_access_key_id=${key} set`;
    const { sanitized, findings } = sanitizeText(input);
    expect(sanitized).not.toContain(key);
    expect(findings.some((f) => f.category === 'api_key')).toBe(true);
  });

  it('redacts GitHub personal access tokens (ghp_ + 36 chars)', () => {
    const token = 'ghp_' + 'a'.repeat(36) + 'wxyz';
    const input = `token ${token}`;
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain(token);
  });

  it('redacts JWT tokens (three base64url segments separated by dots)', () => {
    // eyJ... header + payload + signature (三段式)
    const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ';
    const sig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const jwt = `${header}.${payload}.${sig}`;
    const input = `Authorization: Bearer ${jwt}`;
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain(jwt);
    expect(sanitized).toMatch(/REDACT/);
  });

  it('redacts password fields in JSON', () => {
    const json = '{"username":"admin","password":"superSecret123!","host":"db.internal"}';
    const { sanitized } = sanitizeJson(json);
    expect(sanitized).not.toContain('superSecret123!');
    expect(sanitized).toContain('"username"');
    expect(sanitized).toContain('"host"');
    // JSON must still parse
    expect(() => JSON.parse(sanitized)).not.toThrow();
  });

  it('redacts CLI --password flags', () => {
    const input = 'cmd --user root --password hunter2xx --host localhost';
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain('hunter2xx');
  });

  it('redacts PostgreSQL connection URLs', () => {
    const url = 'postgres://user:p%40ssword@db.example.com:5432/app';
    const input = `connect via ${url}`;
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain('p%40ss');
    expect(sanitized).toContain('[REDACTED');
  });

  it('redacts RSA private key blocks (BEGIN/END PRIVATE KEY)', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAxyz123thisIsAFakeKeyBodyForTestingPurposesOnly000',
      'moreFakeDataHereToMakeItLookLikeAPEMBlockForUnitTestsOnlyxxxxxx',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const input = `key material:\n${key}\n`;
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain('MIIEpAIBAAKCAQEA');
    expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts Unix home paths while preserving trailing structure', () => {
    const input = 'file at /home/alice/projects/demo/script.md';
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain('alice');
    expect(sanitized).toContain('/projects/demo/script.md');
  });

  it('redacts macOS user paths', () => {
    const input = 'ls /Users/bob/Downloads/clip.mp4';
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain('/bob/');
  });

  it('redacts emails (local part mostly masked but domain preserved)', () => {
    const input = 'contact john.doe@example.com for details';
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain('john.doe@example.com');
    expect(sanitized).toContain('@example.com');
  });

  it('redacts Chinese mobile phone numbers (11 digits starting with 1)', () => {
    const input = 'call me at 13812345678 please';
    const { sanitized } = sanitizeText(input);
    expect(sanitized).not.toContain('13812345678');
    // 保留前3后4位便于识别是否是同一号码
    expect(sanitized).toContain('138');
    expect(sanitized).toContain('5678');
  });

  it('leaves clean Chinese narrative text intact (no false positives)', () => {
    const input = '林澈站在玻璃门前，看到盒子里的光点忽明忽暗。\n林澈：我可以只忘掉难过的部分吗？';
    const { sanitized, findings } = sanitizeText(input);
    expect(sanitized).toBe(input);
    expect(findings).toHaveLength(0);
  });

  it('leaves clean English prose intact', () => {
    const input = 'The final cut contains 12 shots and 4 keyframes. Duration is 90 seconds.';
    const { sanitized, findings } = sanitizeText(input);
    expect(sanitized).toBe(input);
    expect(findings).toHaveLength(0);
  });

  it('sanitizeValue recursively redacts password-like keys in objects', () => {
    const obj = {
      db: { host: 'x', password: 'abcdefgh', nested: { apiKey: 'sk-realkey1234567890abcdefcdef' } },
      note: 'plain text without any sensitive marker here',
    };
    const out = sanitizeValue(obj) as typeof obj;
    expect(out.db.password).not.toBe('abcdefgh');
    expect(out.db.nested.apiKey).not.toBe('sk-realkey1234567890abcdefcdef');
    expect(out.db.host).toBe('x');
  });

  it('counts findings accurately across mixed content', () => {
    const input = [
      'Contact: a@b.com',
      '"password": "hunter2xx"',
      '/home/lin/secret.txt',
      'sk-realkey1234567890abcdefyz01',
    ].join('\n');
    const { findings } = sanitizeText(input);
    // 至少包含4类：email、password、path、api_key
    const cats = new Set(findings.map((f) => f.category));
    expect(cats.has('email')).toBe(true);
    expect(cats.has('password')).toBe(true);
    expect(cats.has('absolute_path')).toBe(true);
    expect(cats.has('api_key')).toBe(true);
  });
});

// ─── 资产URL合法性校验 ────────────────────────────

describe('isValidAssetUrl', () => {
  it('accepts local upload paths', () => {
    expect(isValidAssetUrl('/uploads/abc.png')).toBe(true);
    expect(isValidAssetUrl('/api/assets/xyz')).toBe(true);
  });

  it('accepts http/https/blob/data URLs', () => {
    expect(isValidAssetUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isValidAssetUrl('http://localhost:8080/x.mp4')).toBe(true);
    expect(isValidAssetUrl('blob:http://localhost/uuid')).toBe(true);
    expect(isValidAssetUrl('data:image/png;base64,AAAA')).toBe(true);
  });

  it('rejects empty / whitespace-only / non-URL strings', () => {
    expect(isValidAssetUrl('')).toBe(false);
    expect(isValidAssetUrl('   ')).toBe(false);
    expect(isValidAssetUrl('javascript:alert(1)')).toBe(false);
    expect(isValidAssetUrl('not a url at all')).toBe(false);
    expect(isValidAssetUrl('../etc/passwd')).toBe(false);
  });
});

// ─── 预检规则 ─────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('precheckExport rules', () => {
  it('empty project triggers NO_SCRIPT, NO_STORYBOARD, NO_ASSETS, DEFAULT_PROJECT_NAME?', async () => {
    const project = makeProject();
    const result = await precheckExport({
      project,
      script: null,
      storyboard: null,
      assets: [],
    });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('NO_SCRIPT');
    expect(codes).toContain('NO_STORYBOARD');
    expect(codes).toContain('NO_ASSETS');
    expect(codes).toContain('NO_CHAT_SESSIONS');
    // 空项目应允许继续（warning/info，不是阻塞）
    expect(result.canExport).toBe(true);
    expect(result.summary.blockingCount).toBe(0);
  });

  it('empty script content triggers EMPTY_SCRIPT warning', async () => {
    const script = makeScript({ content: '   \n\t  ' });
    const result = await precheckExport({
      project: makeProject(),
      script,
      storyboard: null,
      assets: [],
    });
    expect(result.issues.some((i) => i.code === 'EMPTY_SCRIPT')).toBe(true);
  });

  it('very short script triggers SCRIPT_TOO_SHORT info; short script alone does not produce blocking errors', async () => {
    const script = makeScript({ content: '你好' });
    const result = await precheckExport({
      project: makeProject(),
      script,
      storyboard: makeStoryboard([{}]),
      assets: [],
    });
    expect(result.issues.some((i) => i.code === 'SCRIPT_TOO_SHORT' && i.severity === 'info')).toBe(true);
    // 没有阻塞错误
    expect(result.summary.blockingCount).toBe(0);
  });

  it('script without title triggers NO_SCRIPT_TITLE info', async () => {
    const script = makeScript({ title: '' });
    const result = await precheckExport({
      project: makeProject(),
      script,
      storyboard: null,
      assets: [],
    });
    expect(result.issues.some((i) => i.code === 'NO_SCRIPT_TITLE')).toBe(true);
  });

  it('storyboard with zero lines triggers EMPTY_STORYBOARD warning', async () => {
    const emptyStoryboard: Storyboard = {
      id: 'sb-empty',
      projectId: 'proj-1',
      updatedAt: 1700000000000,
      lines: [],
    };
    const result = await precheckExport({
      project: makeProject(),
      script: makeScript(),
      storyboard: emptyStoryboard,
      assets: [],
    });
    expect(result.issues.some((i) => i.code === 'EMPTY_STORYBOARD' && i.severity === 'warning')).toBe(true);
  });

  it('storyboard with many empty description lines triggers EMPTY_SHOT_DESCRIPTION warning', async () => {
    // 3 out of 3 shots have empty descriptions (>50%) → warning
    const storyboard = makeStoryboard([
      { description: '   ' },
      { description: '' },
      { description: '\t' },
    ]);
    const result = await precheckExport({
      project: makeProject(),
      script: makeScript(),
      storyboard,
      assets: [],
    });
    expect(result.issues.some((i) => i.code === 'EMPTY_SHOT_DESCRIPTION' && i.severity === 'warning')).toBe(true);
  });

  it('storyboard with a zero-duration shot triggers ZERO_DURATION_SHOT info', async () => {
    const storyboard = makeStoryboard([
      { duration: 0 },
      { duration: 3 },
    ]);
    const result = await precheckExport({
      project: makeProject(),
      script: makeScript(),
      storyboard,
      assets: [],
    });
    expect(result.issues.some((i) => i.code === 'ZERO_DURATION_SHOT')).toBe(true);
  });

  it('asset with empty URL is a blocking error (MISSING_ASSET_URL)', async () => {
    const result = await precheckExport({
      project: makeProject(),
      script: makeScript(),
      storyboard: makeStoryboard([{}]),
      assets: [makeAsset({ url: '' })],
    });
    const issue = result.issues.find((i) => i.code === 'MISSING_ASSET_URL');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(result.canExport).toBe(false);
    expect(result.summary.blockingCount).toBeGreaterThanOrEqual(1);
  });

  it('asset with invalid URL format triggers INVALID_ASSET_URL error', async () => {
    const result = await precheckExport({
      project: makeProject(),
      script: makeScript(),
      storyboard: makeStoryboard([{}]),
      assets: [makeAsset({ url: 'javascript:alert(1)' })],
    });
    expect(result.issues.some((i) => i.code === 'INVALID_ASSET_URL' && i.severity === 'error')).toBe(true);
    expect(result.canExport).toBe(false);
  });

  it('duplicate asset filenames trigger DUPLICATE_ASSET_NAMES warning', async () => {
    const result = await precheckExport({
      project: makeProject(),
      script: makeScript(),
      storyboard: makeStoryboard([{}]),
      assets: [
        makeAsset({ id: 'a1', name: 'hero.png', url: '' }),
        makeAsset({ id: 'a2', name: 'hero.png', url: '' }),
      ],
    });
    expect(result.issues.some((i) => i.code === 'DUPLICATE_ASSET_NAMES')).toBe(true);
    expect(result.summary.duplicateNames).toBeGreaterThanOrEqual(1);
  });

  it('external URLs do not block export (info/warning only), local /uploads/ URLs are probed', async () => {
    // Stub fetch to always return ok=false for external URLs (warning, not blocking)
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          headers: { get: () => null },
        } as unknown as Response),
      ),
    );
    const result = await precheckExport({
      project: makeProject(),
      script: makeScript(),
      storyboard: makeStoryboard([{}]),
      assets: [makeAsset({ url: 'https://external.example.com/not-found.png', name: 'ext.png' })],
    });
    // 外部URL不可达是warning，不应阻塞
    expect(result.issues.some((i) => i.code === 'EXTERNAL_ASSET_UNREACHABLE' && i.severity === 'warning')).toBe(true);
    expect(result.canExport).toBe(true);
    expect(result.summary.externalAssets).toBeGreaterThanOrEqual(1);
  });

  it('healthy full project produces no blocking issues and counts stats correctly', async () => {
    // Stub fetch to return ok with small content-length for local assets
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? '12345' : null) },
        } as unknown as Response),
      ),
    );
    const storyboard = makeStoryboard([{ duration: 4 }, { duration: 5 }]);
    const assets = [
      makeAsset({ id: 'a1', name: 'a.png' }),
      makeAsset({ id: 'a2', name: 'b.png' }),
    ];
    const result = await precheckExport({
      project: makeProject(),
      script: makeScript({ content: '# 第一场\n\n这是一个长度足够的剧本内容，包含角色对话和场景描述。' }),
      storyboard,
      assets,
    });
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.canExport).toBe(true);
    expect(result.summary.totalAssets).toBe(2);
    expect(result.summary.readyAssets).toBe(2);
    expect(result.summary.shotCount).toBe(2);
  });
});

// ─── Manifest 清单 & 导出摘要 ─────────────────────

describe('buildProjectManifest manifest file listing & summary', () => {
  it('records project id/name/status/phase verbatim', () => {
    const project = makeProject({ id: 'p-x', name: 'Demo', status: 'active', phase: 'post' });
    const snapshot = createProjectSnapshot({
      project,
      script: null,
      scriptText: '',
      storyboard: null,
      assets: [],
    });
    const manifest = buildProjectManifest(project, snapshot, []);
    expect(manifest.project.id).toBe('p-x');
    expect(manifest.project.name).toBe('Demo');
    expect(manifest.project.status).toBe('active');
    expect(manifest.project.phase).toBe('post');
  });

  it('lists every asset with id/name/type/url', () => {
    const assets: Asset[] = [
      makeAsset({ id: 'a1', name: 'one.png', type: 'image', url: '/uploads/one.png' }),
      makeAsset({ id: 'a2', name: 'two.mp4', type: 'video', url: 'https://cdn/two.mp4' }),
    ];
    const project = makeProject();
    const snapshot = createProjectSnapshot({
      project, script: null, scriptText: '', storyboard: null, assets,
    });
    const manifest = buildProjectManifest(project, snapshot, assets);
    expect(manifest.assets).toHaveLength(2);
    expect(manifest.assets[0].id).toBe('a1');
    expect(manifest.assets[0].type).toBe('image');
    expect(manifest.assets[1].url).toContain('two.mp4');
    expect(manifest.summary.assets).toBe(2);
  });

  it('summary counts match storyboard line count and script sections', () => {
    // 使用中文场号（"第X场"）作为段落标记，stripMarkdown不会把它们去掉
    const script = makeScript({
      content: [
        '第一场 外景 回收站 傍晚',
        '',
        '林澈站在玻璃门前，看到盒子里的光点忽明忽暗。',
        '林澈：我可以只忘掉难过的部分吗？',
        '',
        '第二场 内景 值班室 夜',
        '',
        '回收站AI把暂存单投到桌面。',
        '小满：如果只剪掉痛，快乐也会没有来处。',
      ].join('\n'),
    });
    const storyboard = makeStoryboard([
      { description: '镜头1', duration: 2 },
      { description: '镜头2', duration: 3 },
      { description: '镜头3', duration: 4 },
    ]);
    const project = makeProject();
    const snapshot = createProjectSnapshot({
      project, script, scriptText: script.content, storyboard, assets: [],
    });
    const manifest = buildProjectManifest(project, snapshot, []);
    expect(manifest.summary.shots).toBe(3);
    // "第X场" 中文场号会被 splitScriptSections 识别为独立段落
    expect(manifest.summary.scriptSections).toBeGreaterThanOrEqual(2);
    expect(manifest.summary.chapters).toBeGreaterThanOrEqual(1);
  });

  it('finalCut.totalDurationSeconds propagates to summary', () => {
    const storyboard = makeStoryboard([
      { description: 'x', duration: 6 },
      { description: 'y', duration: 4 },
    ]);
    const project = makeProject();
    const snapshot = createProjectSnapshot({
      project, script: null, scriptText: '', storyboard, assets: [],
    });
    const manifest = buildProjectManifest(project, snapshot, []);
    expect(manifest.summary.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(manifest.finalCut.totalShots).toBe(2);
  });

  it('exportedAt is a valid ISO-8601 timestamp', () => {
    const project = makeProject();
    const snapshot = createProjectSnapshot({ project, script: null, scriptText: '', storyboard: null, assets: [] });
    const manifest = buildProjectManifest(project, snapshot, []);
    expect(() => new Date(manifest.exportedAt)).not.toThrow();
    expect(new Date(manifest.exportedAt).toISOString()).toBe(manifest.exportedAt);
  });

  it('asset with metadata includes it; null when metadata is absent', () => {
    const assets = [
      makeAsset({ id: 'a1', metadata: { sizeBytes: 999 } }),
      makeAsset({ id: 'a2', metadata: null }),
    ];
    const project = makeProject();
    const snapshot = createProjectSnapshot({ project, script: null, scriptText: '', storyboard: null, assets });
    const manifest = buildProjectManifest(project, snapshot, assets);
    expect(manifest.assets[0].metadata).toEqual({ sizeBytes: 999 });
    expect(manifest.assets[1].metadata).toBeNull();
  });
});

// ─── createProjectSnapshot 摘要计数一致性 ─────────

describe('createProjectSnapshot summary consistency', () => {
  it('empty input yields zero counts', () => {
    const snap = createProjectSnapshot({
      project: makeProject(), script: null, scriptText: '', storyboard: null, assets: [],
    });
    expect(snap.chapters).toHaveLength(0);
    expect(snap.characters).toHaveLength(0);
    expect(snap.scenes).toHaveLength(0);
    expect(snap.keyframes).toHaveLength(0);
    expect(snap.videoShots).toHaveLength(0);
    expect(snap.finalCut.totalShots).toBe(0);
    expect(snap.finalCut.totalDurationSeconds).toBe(0);
  });

  it('script dialogue speakers are extracted as characters', () => {
    const snap = createProjectSnapshot({
      project: makeProject(),
      script: makeScript(),
      scriptText: [
        '# 第一场',
        '林澈：你好。',
        '小满：你好呀。',
        '林澈：今天天气不错。',
      ].join('\n'),
      storyboard: null,
      assets: [],
    });
    const names = snap.characters.map((c) => c.name);
    expect(names).toContain('林澈');
    expect(names).toContain('小满');
    expect(snap.characters.length).toBeGreaterThanOrEqual(2);
  });

  it('storyboard lines translate to videoShots 1:1', () => {
    const storyboard = makeStoryboard([
      { description: '镜头A', duration: 2 },
      { description: '镜头B', duration: 5 },
    ]);
    const snap = createProjectSnapshot({
      project: makeProject(),
      script: null,
      scriptText: '',
      storyboard,
      assets: [],
    });
    expect(snap.videoShots).toHaveLength(2);
    expect(snap.finalCut.totalShots).toBe(2);
    expect(snap.finalCut.totalDurationSeconds).toBeGreaterThanOrEqual(7);
  });
});
