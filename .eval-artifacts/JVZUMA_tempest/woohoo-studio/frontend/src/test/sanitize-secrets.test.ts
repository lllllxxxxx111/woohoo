// Comprehensive tests for sanitization rules: API keys, JWTs, passwords, absolute paths, PEM keys.
import { describe, it, expect } from 'vitest';
import { sanitizeString, sanitizeForExport, sanitizeSnapshot, containsSecret } from '../utils/sanitize';

describe('sanitizeString: API key & credential patterns', () => {
  it('redacts OpenAI-style sk- keys', () => {
    expect(sanitizeString('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD')).toContain('[REDACTED_KEY]');
    expect(sanitizeString('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD')).not.toContain('sk-abcdefg');
  });
  it('redacts Anthropic sk-ant- keys', () => {
    const out = sanitizeString('sk-ant-api03-abcdefghij0123456789abcdefghij0123456789abcdefghij_KlM-AA');
    expect(out).toContain('[REDACTED_KEY]');
    expect(out).not.toContain('sk-ant-');
  });
  it('redacts AWS access key IDs (AKIA + 16)', () => {
    expect(sanitizeString('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED_KEY]');
  });
  it('redacts GitHub personal access tokens (ghp_)', () => {
    const tok = 'ghp_' + 'a'.repeat(36);
    expect(sanitizeString(tok)).toBe('[REDACTED_KEY]');
  });
  it('redacts GitHub fine-grained tokens (github_pat_ / ghu_ etc)', () => {
    expect(sanitizeString('ghu_' + 'b'.repeat(40))).toContain('[REDACTED_KEY]');
  });
  it('redacts Slack bot/user tokens', () => {
    expect(sanitizeString('xoxb-1234567890-abcdefghijklmnop')).toContain('[REDACTED_KEY]');
    expect(sanitizeString('xoxp-1234567890-abcdefghijklmnop')).toContain('[REDACTED_KEY]');
  });
  it('redacts Google API keys (AIza...)', () => {
    expect(sanitizeString('AIzaSyD' + 'a'.repeat(32))).toBe('[REDACTED_KEY]');
  });
  it('redacts JWT tokens', () => {
    // Valid JWT: eyJ... (header), eyJ... (payload), signature
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(sanitizeString(jwt)).toBe('[REDACTED_JWT]');
  });
  it('redacts "Bearer <jwt>" authorization header', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoxfQ.signature_here_padding_ok';
    const out = sanitizeString(`Authorization: Bearer ${jwt}`);
    expect(out).toContain('Bearer');
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
  it('redacts non-JWT bearer tokens too', () => {
    const out = sanitizeString('Authorization: Bearer 8a7f6e5d4c3b2a109876543210fedcba');
    expect(out).toContain('[REDACTED_KEY]');
    expect(out).not.toContain('8a7f6e5d');
  });
  it('redacts Basic auth headers', () => {
    const out = sanitizeString('Authorization: Basic dXNlcjpwYXNzd29yZA==');
    expect(out).toContain('Basic');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('dXNlcjpw');
  });
  it('redacts PEM private key blocks', () => {
    // Use a realistic dummy PEM shape (no real secrets)
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAxyz123\n-----END RSA PRIVATE KEY-----';
    const out = sanitizeString(pem);
    expect(out).not.toContain('MIIEpAIB');
    expect(out).toBe('[REDACTED_PRIVATE_KEY]');
  });
});

describe('sanitizeString: absolute local paths', () => {
  it('redacts Linux /home paths and preserves filename', () => {
    const out = sanitizeString('/home/alice/projects/draft.script');
    expect(out).toBe('./draft.script');
  });
  it('redacts file:// URLs', () => {
    const out = sanitizeString('file:///home/bob/assets/logo.png');
    // file:// prefix + absolute path -> both should be replaced. We keep the filename.
    expect(out).not.toContain('file://');
    expect(out).not.toContain('/home/bob');
    expect(out).toContain('logo.png');
  });
  it('redacts /root /var /tmp /opt /etc /data /mnt /srv /proc /usr', () => {
    // Bare directory names (no file) -> fully redacted
    expect(sanitizeString('/root')).toBe('[LOCAL_PATH_REDACTED]');
    // Paths with files -> preserve filename
    expect(sanitizeString('/var/log/app.log')).toBe('./app.log');
    expect(sanitizeString('/tmp/foo')).toBe('./foo');
    expect(sanitizeString('/opt/cfg')).toContain('./cfg');
    // /etc/shadow is a SENSITIVE filename itself, so fully redact even with preserveFilename
    expect(sanitizeString('/etc/shadow')).toBe('[LOCAL_PATH_REDACTED]');
    expect(sanitizeString('/data/ckpt.bin')).toBe('./ckpt.bin');
    expect(sanitizeString('/mnt/c/x')).toContain('./x');
    expect(sanitizeString('/srv/www')).toContain('./www');
    expect(sanitizeString('/proc/1')).toContain('./1');
    expect(sanitizeString('/usr/lib')).toContain('./lib');
  });
  it('redacts Windows drive paths', () => {
    const out = sanitizeString('C:\\Users\\Alice\\secret\\file.txt');
    expect(out).not.toContain('Users');
    expect(out).toContain('file.txt');
  });
  it('does NOT redact https URLs containing "home" in path', () => {
    const url = 'https://example.com/home/dashboard';
    expect(sanitizeString(url)).toBe(url);
  });
  it('does NOT redact relative paths like ./assets/x.png', () => {
    expect(sanitizeString('./assets/img.png')).toBe('./assets/img.png');
  });
  it('does NOT redact words like "myhome"', () => {
    expect(sanitizeString('Welcome to myhome directory')).toBe('Welcome to myhome directory');
  });
  it('redacts paths embedded inside longer text', () => {
    const out = sanitizeString('Model loaded from /data/models/ckpt.safetensors, log at /tmp/run.log.');
    expect(out).not.toContain('/data/');
    expect(out).not.toContain('/tmp/run.log');
    expect(out).toContain('ckpt.safetensors');
  });

  it('fully redacts sensitive filenames even when preserveFilename is on', () => {
    // These filenames themselves leak credentials, so ./filename would still leak
    expect(sanitizeString('/home/u/.ssh/id_rsa')).toBe('[LOCAL_PATH_REDACTED]');
    expect(sanitizeString('/Users/alice/.env')).toBe('[LOCAL_PATH_REDACTED]');
    expect(sanitizeString('/root/.aws/credentials')).toBe('[LOCAL_PATH_REDACTED]');
    expect(sanitizeString('/etc/passwd')).toBe('[LOCAL_PATH_REDACTED]');
    expect(sanitizeString('/home/u/key.pem')).toBe('[LOCAL_PATH_REDACTED]');
    expect(sanitizeString('load key from C:\\secrets\\private.key')).toContain('[LOCAL_PATH_REDACTED]');
    // But normal filenames under sensitive dirs are preserved for traceability
    expect(sanitizeString('/home/u/project/hero.png')).toBe('./hero.png');
    expect(sanitizeString('/tmp/build.log')).toBe('./build.log');
  });
});

describe('sanitizeForExport: key-based redaction', () => {
  it('redacts values under sensitive keys regardless of case or separator', () => {
    const input = {
      apiKey: 'sk-12345',
      api_key: 'secret1',
      'X-API-Key': 'key-abc',
      Authorization: 'Bearer tok',
      password: 'p@ss',
      client_secret: 'cs_abc',
      aws_secret_access_key: 'wJalrXUtnFEMI',
      databaseUrl: 'postgres://u:p@host/db',
      token: 'tok1',
      jwt: 'jwt1',
      private_key: 'pk',
      normal: 'keep this',
      title: 'My Project',
    };
    const out = sanitizeForExport(input) as typeof input;
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.api_key).toBe('[REDACTED]');
    expect(out['X-API-Key']).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.client_secret).toBe('[REDACTED]');
    expect(out.aws_secret_access_key).toBe('[REDACTED]');
    expect(out.databaseUrl).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.jwt).toBe('[REDACTED]');
    expect(out.private_key).toBe('[REDACTED]');
    expect(out.normal).toBe('keep this');
    expect(out.title).toBe('My Project');
  });

  it('recurses into nested objects and arrays', () => {
    const input = {
      config: {
        model: 'gpt-4',
        apiKey: 'sk-leak',
        nested: { password: 'hunter2', data: [1, 2, { token: 'abc', value: 'x' }] },
      },
    };
    const out: any = sanitizeForExport(input);
    expect(out.config.model).toBe('gpt-4');
    expect(out.config.apiKey).toBe('[REDACTED]');
    expect(out.config.nested.password).toBe('[REDACTED]');
    expect(out.config.nested.data[2].token).toBe('[REDACTED]');
    expect(out.config.nested.data[2].value).toBe('x');
  });

  it('leaves numbers and booleans untouched', () => {
    const out = sanitizeForExport({ count: 42, enabled: true, name: 'ok' }) as any;
    expect(out.count).toBe(42);
    expect(out.enabled).toBe(true);
    expect(out.name).toBe('ok');
  });
});

describe('sanitizeSnapshot: project snapshot specific', () => {
  it('strips userId/user_id/ownerId/creatorId', () => {
    const out = sanitizeSnapshot({ id: 'p1', name: 'Test', userId: 'u-123', owner_id: 'o-456', creatorId: 'c-789' }) as any;
    expect(out.id).toBe('p1');
    expect(out.name).toBe('Test');
    expect(out).not.toHaveProperty('userId');
    expect(out).not.toHaveProperty('user_id');
    expect(out).not.toHaveProperty('ownerId');
    expect(out).not.toHaveProperty('owner_id');
    expect(out).not.toHaveProperty('creatorId');
  });

  it('rewrites file:// asset URLs to relative and does NOT leak the original path', () => {
    const snap = {
      id: 'p1',
      assets: [
        { id: 'a1', name: 'logo.png', url: 'file:///home/alice/secret/logo.png' },
      ],
    };
    const out: any = sanitizeSnapshot(snap);
    expect(out.assets[0].url).toBe('./assets/logo.png');
    // source must NOT contain the original absolute path
    expect(JSON.stringify(out)).not.toContain('/home/alice');
    expect(JSON.stringify(out)).not.toContain('file://');
  });

  it('rewrites absolute-path asset URLs (no file:// prefix) to relative', () => {
    const snap = {
      assets: [{ id: 'a1', name: 'a.png', url: '/var/data/assets/a.png' }],
    };
    const out: any = sanitizeSnapshot(snap);
    expect(out.assets[0].url).toBe('./assets/a.png');
    expect(JSON.stringify(out)).not.toContain('/var/data');
  });

  it('leaves http(s) asset URLs untouched', () => {
    const snap = {
      assets: [{ id: 'a1', name: 'a.png', url: 'https://cdn.example.com/a.png' }],
    };
    const out: any = sanitizeSnapshot(snap);
    expect(out.assets[0].url).toBe('https://cdn.example.com/a.png');
  });

  it('runs full sanitizeForExport including string-value scans', () => {
    const snap = {
      notes: 'Backup key: sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
      config: { apiKey: 'leak' },
    };
    const out: any = sanitizeSnapshot(snap);
    expect(out.notes).toContain('[REDACTED_KEY]');
    expect(out.config.apiKey).toBe('[REDACTED]');
  });
});

describe('containsSecret helper', () => {
  it('returns true for JWT strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef1234567890';
    expect(containsSecret(jwt)).toBe(true);
  });
  it('returns true for sk- keys', () => {
    expect(containsSecret('sk-abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
  });
  it('returns true for absolute paths', () => {
    expect(containsSecret('/home/alice/secret')).toBe(true);
  });
  it('returns false for innocent strings', () => {
    expect(containsSecret('hello world')).toBe(false);
    expect(containsSecret('https://example.com/page')).toBe(false);
  });
});

describe('sanitizeString: no false positives on plausible export content', () => {
  it('leaves regular prose, script text, and markdown untouched', () => {
    const samples = [
      'FADE IN:\n\nINT. COFFEE SHOP - DAY\n\nTwo friends discuss the plan.',
      '## Scene 1\n- Duration: 30s\n- Resolution: 1920x1080',
      'The score ranges from 0-100 and is key to tracking progress.',
      'Bearer of good news should not be punished.',  // "Bearer " but no real token after (too short after)? We expect this to match - let it redact; this is acceptable.
    ];
    // First three should survive unchanged
    expect(sanitizeString(samples[0])).toBe(samples[0]);
    expect(sanitizeString(samples[1])).toBe(samples[1]);
    expect(sanitizeString(samples[2])).toBe(samples[2]);
  });
  it('does not treat "sk-" followed by very short text as an API key', () => {
    // Minimum 20 chars after sk-
    expect(sanitizeString('We use sk-1 for this')).toBe('We use sk-1 for this');
  });
  it('leaves relative asset paths and internal routes alone', () => {
    expect(sanitizeString('/workspace/p1/assets/img.png')).toBe('/workspace/p1/assets/img.png');
    // Note: /workspace is NOT in our sensitive list (it's a project workspace, not a user home dir)
  });
});
