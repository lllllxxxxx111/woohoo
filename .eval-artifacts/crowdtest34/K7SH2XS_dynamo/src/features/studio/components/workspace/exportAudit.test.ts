import { describe, expect, it } from 'vitest';
import {
  BUNDLE_SCHEMA_VERSION,
  sha256Bytes,
  sha256Text,
  detectSensitiveData,
  redactSensitiveData,
  sanitizeUrl,
  sanitizeMetadata,
  runVerificationChecks,
  buildVerificationReport,
  formatBytes,
} from './exportAudit';

// ─── SHA-256 helpers ─────────────────────────────────────────────────────────

describe('sha256Text / sha256Bytes', () => {
  it('sha256Text("") matches the known empty-input digest', async () => {
    await expect(sha256Text('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('sha256Text("hello") matches the known RFC vector', async () => {
    await expect(sha256Text('hello')).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('returns 64 lowercase hex chars for arbitrary input', async () => {
    const hash = await sha256Text('some arbitrary content 🎬 with unicode');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: identical inputs -> identical hashes', async () => {
    const a = await sha256Text('stable payload v1');
    const b = await sha256Text('stable payload v1');
    expect(a).toBe(b);
  });

  it('changes on a single-character edit', async () => {
    const a = await sha256Text('stable payload v1');
    const c = await sha256Text('stable payload v2');
    expect(a).not.toBe(c);
  });

  it('sha256Bytes agrees with sha256Text on the same bytes', async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('cross-check');
    const fromBytes = await sha256Bytes(bytes);
    const fromText = await sha256Text('cross-check');
    expect(fromBytes).toBe(fromText);
    expect(fromBytes).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── formatBytes ─────────────────────────────────────────────────────────────

describe('formatBytes', () => {
  it('renders 0 bytes as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });
  it('renders bytes under 1KB with B suffix', () => {
    expect(formatBytes(512)).toBe('512 B');
  });
  it('renders kilobytes', () => {
    expect(formatBytes(2048)).toMatch(/2\.00?\s*KB|2\s*KB|2\.0\s*KB/);
  });
  it('renders megabytes', () => {
    expect(formatBytes(5 * 1024 * 1024)).toContain('MB');
  });
  it('renders gigabytes for large values', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toContain('GB');
  });
});

// ─── Sensitive data redaction ────────────────────────────────────────────────

describe('redactSensitiveData', () => {
  it('returns non-string input unchanged', () => {
    expect((redactSensitiveData as (t: unknown) => unknown)(null)).toBeNull();
    expect(redactSensitiveData('')).toBe('');
    expect((redactSensitiveData as (t: unknown) => unknown)(42)).toBe(42);
  });

  it('strips OpenAI-style sk- keys (>=20 chars)', () => {
    const key = 'sk-' + 'a'.repeat(48);
    const out = redactSensitiveData('key=' + key);
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED_API_KEY]');
    // short sk- must not be treated as a key
    expect(redactSensitiveData('sk-abc')).toBe('sk-abc');
  });

  it('strips GitHub PAT (ghp_ 36 chars)', () => {
    const tok = 'ghp_' + 'a'.repeat(36);
    expect(redactSensitiveData('t=' + tok)).not.toContain(tok);
  });

  it('strips JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'a'.repeat(30) + '.' + 'b'.repeat(30);
    expect(redactSensitiveData('tok=' + jwt)).toContain('[REDACTED_JWT]');
    expect(redactSensitiveData('tok=' + jwt)).not.toContain('eyJ');
  });

  it('strips AWS access keys', () => {
    const ak = 'AKIA' + 'A'.repeat(16);
    expect(redactSensitiveData('id=' + ak)).toContain('[REDACTED_AWS_KEY]');
  });

  it('strips Bearer tokens', () => {
    const out = redactSensitiveData('Authorization: Bearer ' + 'a'.repeat(40));
    expect(out).toContain('[REDACTED_TOKEN]');
    expect(out).not.toMatch(/Bearer\s+[a-zA-Z0-9]{20,}/);
  });

  it('strips password=/secret=/token=/auth=/private_key= assignments', () => {
    expect(redactSensitiveData('password=hunter222')).toContain('[REDACTED]');
    expect(redactSensitiveData('secret: supersecretvalue')).toContain('[REDACTED]');
    expect(redactSensitiveData(`token: ${'a'.repeat(20)}`)).toContain('[REDACTED]');
    expect(redactSensitiveData(`auth=${'b'.repeat(20)}`)).toContain('[REDACTED]');
    expect(redactSensitiveData('private_key: abcdefghijk')).toContain('[REDACTED]');
    // false-positive guard
    expect(redactSensitiveData('passwordless auth')).toBe('passwordless auth');
  });

  it('redacts credentials embedded in https://user:pass@host URLs while keeping host', () => {
    const out = redactSensitiveData('https://alice:hunter2@api.internal.example.com/v1/upload');
    expect(out).not.toContain('alice:hunter2');
    expect(out).toContain('api.internal.example.com');
    expect(out).toContain('[REDACTED_CREDENTIALS]');
  });

  it('redacts MongoDB/Postgres/Redis connection-string credentials', () => {
    const secret = 'verysecretpw';
    const out = redactSensitiveData(`postgres://appuser:${secret}@db.internal:5432/woohoo`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED_CREDENTIALS]');
    expect(out).toContain('db.internal');
  });

  it('redacts Slack/Discord webhooks', () => {
    const slack = 'https://hooks.slack.com/services/T00000000/B00000000/' + 'a'.repeat(24);
    expect(redactSensitiveData(slack)).toBe('[REDACTED_SLACK_WEBHOOK]');
    const discord = 'https://discord.com/api/webhooks/1234567890/' + 'b'.repeat(32);
    expect(redactSensitiveData(discord)).toBe('[REDACTED_DISCORD_WEBHOOK]');
  });

  it('redacts SSH private key blocks', () => {
    const key =
      '-----BEGIN RSA PRIVATE KEY-----\n' + 'a'.repeat(64) + '\n-----END RSA PRIVATE KEY-----';
    expect(redactSensitiveData(key)).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts home directories across Linux / macOS / Windows', () => {
    const linux = redactSensitiveData('saved to /home/alice/projects/x.png');
    expect(linux).toContain('/[REDACTED_HOME]/');
    expect(linux).not.toContain('alice');

    const mac = redactSensitiveData('/Users/bob/doc');
    expect(mac).toContain('/[REDACTED_HOME]/');
    expect(mac).not.toContain('bob');

    const win = redactSensitiveData('C:\\Users\\AliceDoe\\vid.mp4');
    expect(win).toContain('[REDACTED_HOME]');
    expect(win).not.toContain('AliceDoe');

    const root = redactSensitiveData('/root/.ssh/ak');
    expect(root).toContain('/[REDACTED_HOME]/');
    expect(root).not.toMatch(/\/root\//);
  });

  it('redacts long continuous hex blobs (64+ hex chars)', () => {
    const hex = 'a'.repeat(64);
    expect(redactSensitiveData(`sig=${hex}`)).toContain('[REDACTED_HEX_SECRET]');
  });

  it('is idempotent: redacting already-redacted output is a no-op', () => {
    const once = redactSensitiveData('k=sk-' + 'a'.repeat(48) + ' pw=hunter2');
    expect(redactSensitiveData(once)).toBe(once);
  });
});

// ─── detectSensitiveData (audit-side finding list) ───────────────────────────

describe('detectSensitiveData', () => {
  it('returns a finding for each detected secret and tags it with context', () => {
    const findings = detectSensitiveData(
      `key=sk-${'a'.repeat(48)} password=hunter22`,
      { field: 'prompt', assetId: 'asset-1' },
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.every((f) => f.redacted === true)).toBe(true);
    expect(findings.every((f) => f.field === 'prompt')).toBe(true);
    expect(findings.every((f) => f.assetId === 'asset-1')).toBe(true);
    expect(findings.some((f) => f.type === 'api_key')).toBe(true);
  });

  it('returns [] for clean text', () => {
    expect(detectSensitiveData('The rain in Spain stays mainly on the plain.')).toEqual([]);
  });
});

// ─── sanitizeUrl ─────────────────────────────────────────────────────────────

describe('sanitizeUrl', () => {
  it('strips sensitive query parameters', () => {
    const out = sanitizeUrl('https://example.com/img.png?api_key=SECRET&w=1024');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('w=1024');
  });

  it('redacts embedded credentials', () => {
    const out = sanitizeUrl('https://user:pass@example.com/resource');
    expect(out).not.toContain('user:pass');
    expect(out).toContain('[REDACTED_CREDENTIALS]');
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeUrl('')).toBe('');
  });
});

// ─── sanitizeMetadata ────────────────────────────────────────────────────────

describe('sanitizeMetadata', () => {
  it('redacts string values recursively', () => {
    const input = {
      model: 'gen-v1',
      prompt: 'key=sk-' + 'a'.repeat(48),
      nested: { url: 'https://alice:pw@example.com' },
    };
    const out = sanitizeMetadata(input);
    expect(out).not.toBe(input); // new object
    expect(out.prompt).toContain('[REDACTED_API_KEY]');
    expect(out.nested.url).toContain('[REDACTED_CREDENTIALS]');
    expect(out.model).toBe('gen-v1');
  });

  it('passes non-string leaves through', () => {
    const out = sanitizeMetadata({ n: 42, flag: true, arr: [1, 2, 3] });
    expect(out.n).toBe(42);
    expect(out.flag).toBe(true);
    expect(out.arr).toEqual([1, 2, 3]);
  });
});

// ─── Verification checks & report ────────────────────────────────────────────

describe('runVerificationChecks + buildVerificationReport', () => {
  const healthy = runVerificationChecks({
    totalAssets: 10, includedAssets: 10, missingAssets: 0,
    hasScript: true, hasStoryboard: true, hasChecksums: true,
    sensitiveFindingCount: 0, bundleSizeBytes: 2 * 1024 * 1024,
    shotCount: 20, durationSeconds: 120,
  });
  const healthyReport = buildVerificationReport(healthy);

  it('emits exactly 8 checks', () => {
    expect(healthy).toHaveLength(8);
  });

  it('healthy project: 0 failed, 0 warnings, allPassed=true', () => {
    expect(healthyReport.failedChecks).toBe(0);
    expect(healthyReport.warningChecks).toBe(0);
    expect(healthyReport.allPassed).toBe(true);
    expect(healthyReport.passedChecks + healthyReport.warningChecks).toBe(8);
  });

  it('missing assets downgrades assets.all_included to warning, not error', () => {
    const checks = runVerificationChecks({
      totalAssets: 10, includedAssets: 7, missingAssets: 3,
      hasScript: true, hasStoryboard: true, hasChecksums: true,
      sensitiveFindingCount: 0, bundleSizeBytes: 1_000_000,
      shotCount: 10, durationSeconds: 60,
    });
    const miss = checks.find((c) => c.name === 'assets.all_included');
    expect(miss?.severity).toBe('warning');
    expect(miss?.passed).toBe(false);
    const report = buildVerificationReport(checks);
    expect(report.warningChecks).toBe(1);
    expect(report.failedChecks).toBe(0);
    expect(report.allPassed).toBe(true); // warnings alone never fail the bundle
  });

  it('no script/storyboard/checksums/shot produces 4 warnings, 0 errors', () => {
    const checks = runVerificationChecks({
      totalAssets: 0, includedAssets: 0, missingAssets: 0,
      hasScript: false, hasStoryboard: false, hasChecksums: false,
      sensitiveFindingCount: 0, bundleSizeBytes: 500, shotCount: 0, durationSeconds: 0,
    });
    const warnNames = checks.filter((c) => c.severity === 'warning').map((c) => c.name).sort();
    expect(warnNames).toEqual(
      ['assets.checksums_present', 'content.has_script', 'content.has_storyboard', 'content.shot_count'].sort(),
    );
    expect(buildVerificationReport(checks).failedChecks).toBe(0);
  });

  it('bundle > 500MB raises a size warning', () => {
    const checks = runVerificationChecks({
      totalAssets: 0, includedAssets: 0, missingAssets: 0,
      hasScript: true, hasStoryboard: true, hasChecksums: true,
      sensitiveFindingCount: 0, bundleSizeBytes: 600 * 1024 * 1024,
      shotCount: 1, durationSeconds: 10,
    });
    expect(checks.find((c) => c.name === 'bundle.size_reasonable')?.severity).toBe('warning');
  });

  it('sensitive data findings surface as a warning', () => {
    const checks = runVerificationChecks({
      totalAssets: 0, includedAssets: 0, missingAssets: 0,
      hasScript: true, hasStoryboard: true, hasChecksums: true,
      sensitiveFindingCount: 2, bundleSizeBytes: 1000, shotCount: 1, durationSeconds: 1,
    });
    const sd = checks.find((c) => c.name === 'security.sensitive_data');
    expect(sd?.severity).toBe('warning');
    expect(sd?.passed).toBe(false);
  });

  it('propagates schemaVersion and a valid ISO-8601 checkedAt', () => {
    expect(healthyReport.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(Number.isNaN(Date.parse(healthyReport.checkedAt))).toBe(false);
    expect(healthyReport.totalChecks).toBe(healthy.length);
  });
});
