import { describe, it, expect } from 'vitest';
import { sanitizeForExport, sanitizeStringForExport, SENSITIVE_KEYS } from '../utils/sanitize';

describe('sanitizeForExport (key-based redaction)', () => {
  it('redacts known sensitive keys at top level', () => {
    const input = { name: 'proj', password: 'hunter2', token: 'abc123' };
    const out: any = sanitizeForExport(input);
    expect(out.password).toBe('<redacted>');
    expect(out.token).toBe('<redacted>');
    expect(out.name).toBe('proj');
    expect(input.password).toBe('hunter2'); // original not mutated
  });

  it('redacts nested sensitive keys', () => {
    const input = {
      settings: {
        pipeline: { apiKey: 'sk-1234', model: 'v1' },
        authorization: 'Bearer xyz',
      },
    };
    const out: any = sanitizeForExport(input);
    expect(out.settings.pipeline.apiKey).toBe('<redacted>');
    expect(out.settings.authorization).toBe('<redacted>');
    expect(out.settings.pipeline.model).toBe('v1');
  });

  it('redacts inside arrays', () => {
    const input = { items: [{ secret: 'a' }, { secret: 'b' }] };
    const out: any = sanitizeForExport(input);
    expect(out.items[0].secret).toBe('<redacted>');
    expect(out.items[1].secret).toBe('<redacted>');
  });

  it('matches case-insensitively', () => {
    const input = { Password: 'x', TOKEN: 'y', ApiKey: 'z', client_secret: 'cs' };
    const out: any = sanitizeForExport(input);
    expect(out.Password).toBe('<redacted>');
    expect(out.TOKEN).toBe('<redacted>');
    expect(out.ApiKey).toBe('<redacted>');
    expect(out.client_secret).toBe('<redacted>');
  });

  it('handles null/undefined/primitives without crashing', () => {
    expect(sanitizeForExport(null as any)).toBeNull();
    expect(sanitizeForExport(undefined as any)).toBeUndefined();
    expect(sanitizeForExport(42 as any)).toBe(42);
    expect(sanitizeForExport(true as any)).toBe(true);
  });

  it('includes the canonical expected key families in SENSITIVE_KEYS', () => {
    // SENSITIVE_KEYS uses lowercase; matching is case-insensitive.
    const required = [
      'password', 'token', 'jwt', 'secret', 'apikey', 'api_key', 'authorization',
      'cookie', 'privatekey', 'private_key', 'access_token', 'refresh_token',
      'client_secret', 'session_id', 'connection_string', 'database_url',
    ];
    for (const k of required) {
      expect(SENSITIVE_KEYS).toContain(k);
    }
    // And key matching is case-insensitive
    expect(SENSITIVE_KEYS.map(s => s.toLowerCase())).toEqual(SENSITIVE_KEYS);
  });
});

describe('sanitizeStringForExport (inline-pattern redaction)', () => {
  // --- Path redaction ---
  it('redacts Linux /home/<user> paths in strings', () => {
    const s = 'stored at /home/alice/.ssh/id_rsa and /home/bob/docs/report.md';
    const out = sanitizeStringForExport(s);
    expect(out).not.toContain('/home/alice');
    expect(out).not.toContain('/home/bob');
    expect(out).toContain('<redacted>');
  });

  it('redacts macOS /Users/<user> paths', () => {
    const out = sanitizeStringForExport('file:///Users/alice/Library/Keychains/login.keychain');
    expect(out).not.toContain('/Users/alice');
    expect(out).toContain('<redacted>');
  });

  it('redacts /root paths', () => {
    const out = sanitizeStringForExport('running as root at /root/.bashrc');
    expect(out).not.toContain('/root/.bashrc');
  });

  it('redacts Windows C:\\Users\\<user> paths', () => {
    const out = sanitizeStringForExport('C:\\Users\\Alice\\Documents\\secret.txt');
    expect(out).not.toContain('Alice');
    expect(out).toContain('<redacted>');
  });

  // --- Token / auth redaction ---
  it('redacts Bearer/JWT/Token authorization schemes', () => {
    const cases = [
      'Authorization: Bearer abcDEF123.xyz-789',
      'Token tok_abcdef_0123456789',
      'JWT header.eyJ.payload.sig',
    ];
    for (const c of cases) {
      const out = sanitizeStringForExport(c);
      expect(out).toContain('<redacted>');
      // scheme name is preserved for auditability
      expect(out).toMatch(/Bearer|Token|JWT/);
      // credential body is gone
      expect(out).not.toMatch(/\babcDEF123\b/);
      expect(out).not.toMatch(/\btok_abcdef_0123456789\b/);
    }
  });

  it('redacts inline JWTs (three base64url segments)', () => {
    // Realistic JWT-looking value: header.payload.signature, header starts with eyJ
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = sanitizeStringForExport(`token=${jwt}`);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('<redacted>');
  });

  it('redacts openai-style sk-... keys (keeping prefix visible for audit)', () => {
    const out = sanitizeStringForExport('key=sk-abcdefghijklmnop1234567890qrstuv');
    expect(out).not.toContain('abcdefghijklmnop1234567890');
    expect(out).toContain('sk-');
    expect(out).toContain('<redacted>');
  });

  it('redacts github (ghp_), stripe (sk_live_), slack (xoxb-), google (AIza), aws (AKIA) keys', () => {
    const samples = [
      'ghp_abcdefghijklmnopqrstuv1234567890ABCD',
      'sk_live_abcdefghijklmnopqrstuv1234567890',
      'xoxb-1234567890-abcdefghijklmnopqrstuvwx',
      'AIzaSyabcdefghijklmnopqrstuvwxyz1234567890',
      'AKIAIOSFODNN7EXAMPLE',
    ];
    for (const s of samples) {
      const out = sanitizeStringForExport(s);
      expect(out).toContain('<redacted>');
      // the raw key must not appear
      expect(out).not.toEqual(s);
    }
  });

  it('redacts PEM private key blocks entirely', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh...\n-----END PRIVATE KEY-----';
    const out = sanitizeStringForExport(pem);
    expect(out).not.toContain('MIIEvQIBADANBgkqh');
    expect(out).toContain('[REDACTED PRIVATE KEY]');
  });

  it('redacts secret query params in URLs but leaves the key name', () => {
    const url = 'https://example.com/api?project=p1&token=secrettoken123&limit=10';
    const out = sanitizeStringForExport(url);
    expect(out).toContain('project=p1');
    expect(out).toContain('token=<redacted>');
    expect(out).toContain('limit=10');
    expect(out).not.toContain('secrettoken123');
  });

  it('redacts api_key, password, and signature in query strings', () => {
    const url = 'https://cdn.example.com/webhook?api_key=KEYKEYKEY&password=p&sig=SIGSIG';
    const out = sanitizeStringForExport(url);
    expect(out).toContain('api_key=<redacted>');
    expect(out).toContain('password=<redacted>');
    expect(out).toContain('sig=<redacted>');
    expect(out).not.toContain('KEYKEYKEY');
  });
});

describe('sanitizeForExport (deep inline redaction)', () => {
  it('scrubs inline secrets inside string values of nested objects', () => {
    const input = {
      endpoint: 'https://api.example.com/v1?token=abcd1234',
      log: 'JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.SflKxw',
      path: '/home/alice/.ssh',
    };
    const out: any = sanitizeForExport(input);
    expect(out.endpoint).toContain('token=<redacted>');
    expect(out.endpoint).not.toContain('abcd1234');
    expect(out.log).toContain('<redacted>');
    expect(out.path).toContain('<redacted>');
    expect(out.path).not.toContain('/home/alice');
  });

  it('scrubs inside arrays of strings', () => {
    const input = { logs: ['Bearer tok_abc123xyz', '/root/.env'] };
    const out: any = sanitizeForExport(input);
    expect(out.logs[0]).not.toContain('tok_abc123xyz');
    expect(out.logs[0]).toContain('Bearer');
    expect(out.logs[1]).not.toContain('/root/.env');
  });

  it('passes Blobs through without touching them', () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const out = sanitizeForExport({ file: blob }) as any;
    expect(out.file).toBe(blob);
  });

  it('drops functions and symbols (not JSON-serializable)', () => {
    const sym = Symbol('s');
    const out: any = sanitizeForExport({
      fn: () => 42,
      [sym]: 'x',
      keep: 1,
    } as any);
    expect(out.fn).toBeUndefined();
    expect(out.keep).toBe(1);
  });

  it('sanitizes Error objects (stacks may contain paths)', () => {
    const err = new Error('failed at /home/alice/project/src/main.ts');
    const out: any = sanitizeForExport({ err });
    expect(out.err.name).toBe('Error');
    expect(out.err.message).not.toContain('/home/alice');
    expect(out.err.message).toContain('<redacted>');
  });

  it('does NOT mutate the original object', () => {
    const input = { nested: { password: 'secret', arr: ['/home/alice/file'] } };
    const snapshot = JSON.stringify(input);
    sanitizeForExport(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('sanitizeForExport applied to snapshot/manifest structures', () => {
  it('typical project snapshot: no secrets leak anywhere', () => {
    const snap = {
      project: { id: 'p1', name: 'Demo' },
      scripts: [{ title: 'S1', content: 'stored at /root/pipeline' }],
      assets: [{ id: 'a1', url: 'https://x.com/a.png?token=SECRET123', metadata: { apiKey: 'sk-notshown' } }],
      settings: { authorization: 'Bearer xyz123', cookie: 'session=abc' },
    };
    const out: any = sanitizeForExport(snap);
    const json = JSON.stringify(out);
    expect(json).not.toContain('SECRET123');
    expect(json).not.toContain('sk-notshown');
    expect(json).not.toContain('xyz123');
    expect(json).not.toContain('session=abc');
    expect(json).not.toContain('/root/pipeline');
    expect(json).toContain('<redacted>');
  });
});
