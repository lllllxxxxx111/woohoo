// Tests for sensitive data redaction
import { describe, it, expect } from 'vitest';
import {
  redactSensitiveFields,
  redactSensitiveFieldsWithStats,
  redactString,
  redactJsonString,
  redactPathsInString,
  isSensitiveKey,
  summarizePipelineParams,
  sanitizeForExport,
  REDACTED,
} from '../utils/redaction';

// ---- Deterministic test secrets (match real regex patterns) ----
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiJ0ZXN0MTIzNDU2Nzg5MCIsIm5hbWUiOiJKb2huIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const OPENAI_KEY = 'sk-odJ4wx5Yf1xarERzNjeuSzaQ012KXqEG64d9fDLkBwvu8cAbCD';
const STRIPE_LIVE = 'sk_live_DmWJ6UuVTAIjvFu7WICPhDeOZIiBOBY1234567890';
const GHP_KEY = 'ghp_6sHrFH2ZUCr_lgotu2iXW7GboIRoL3u6aHwn1234';
const SLACK_BOT = 'xoxb-1234567890-abcdefghijklmnopqrstuvwxyz01';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GOOGLE_KEY = 'AIzaSyDpZmtjE2aC5c98K0E3QVxwYhTn7UfKgblE';
const ANTHROPIC_KEY = 'sk-ant-api03-AxByCzDwEvFuGtHsIrJqKxLiM-n4oPq7RsTvU12';

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyz',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop',
  'qrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

describe('redaction: isSensitiveKey', () => {
  const sensitiveKeys = [
    'apiKey', 'api_key', 'API_KEY', 'apikey',
    'secret', 'secretKey',
    'password', 'passwd', 'pwd',
    'token', 'authToken', 'access_token', 'refresh_token',
    'jwt', 'bearer',
    'privateKey', 'private_key', 'publicKey',
    'clientSecret',
    'databaseUrl', 'db_password', 'dbPass', 'connectionString',
    'cookie', 'setCookie', 'authorization', 'x-api-key',
    'encryption_key', 'sessionSecret', 'credential',
  ];
  it.each(sensitiveKeys)('flags %s', (k) => {
    expect(isSensitiveKey(k)).toBe(true);
  });

  it('does not flag safe keys', () => {
    for (const k of ['name', 'title', 'model', 'resolution', 'duration', 'fps', 'count', 'id', 'path']) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });

  it('handles empty', () => {
    expect(isSensitiveKey('')).toBe(false);
  });
});

describe('redaction: JWT', () => {
  it('redacts standalone JWT', () => {
    expect(redactString(JWT)).toBe(REDACTED);
  });

  it('redacts embedded JWT', () => {
    const out = redactString(`token=${JWT} end`);
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain(REDACTED);
    expect(out).toContain('token=');
    expect(out).toContain(' end');
  });

  it('does not redact ordinary dot-separated words', () => {
    expect(redactString('hello.world.foo')).toBe('hello.world.foo');
    expect(redactString('v1.2.3')).toBe('v1.2.3');
  });
});

describe('redaction: API key prefixes', () => {
  const cases: [string, string][] = [
    ['OpenAI', OPENAI_KEY],
    ['Stripe', STRIPE_LIVE],
    ['GitHub PAT', GHP_KEY],
    ['Slack bot', SLACK_BOT],
    ['AWS', AWS_KEY],
    ['Google', GOOGLE_KEY],
    ['Anthropic', ANTHROPIC_KEY],
  ];
  it.each(cases)('redacts %s', (_name, key) => {
    const out = redactString(`use ${key} now`);
    expect(out).not.toContain(key);
    expect(out).toContain(REDACTED);
  });

  it('leaves short sk- lookalikes alone', () => {
    expect(redactString('sk-short')).toBe('sk-short');
  });
});

describe('redaction: PEM / keys', () => {
  it('redacts PEM blocks', () => {
    expect(redactString(PEM)).toBe(REDACTED);
  });

  it('redacts PEM embedded in text', () => {
    const out = redactString(`cfg:\n${PEM}\n--end--`);
    expect(out).not.toContain('BEGIN RSA');
    expect(out).toContain('cfg:');
    expect(out).toContain('--end--');
  });
});

describe('redaction: auth headers', () => {
  it('redacts Bearer tokens', () => {
    const out = redactString(`Authorization: Bearer ${JWT}`);
    expect(out).not.toContain('SflKxwRJSMeKKF2');
    expect(out).toContain('Bearer');
  });

  it('redacts Basic base64 creds', () => {
    const out = redactString('Authorization: Basic dXNlcjpwYXNzd29yZA==');
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA==');
    expect(out).toContain(REDACTED);
  });

  it('redacts standalone Bearer <token>', () => {
    const out = redactString('Got Bearer abcdef0123456789abcdef0123456789 end');
    expect(out).not.toContain('abcdef0123456789abcdef0123456789');
  });
});

describe('redaction: URL credentials / connection strings', () => {
  it('redacts scheme://user:pass@host', () => {
    const c = 'postgres://admin:***@db.example.com:5432/mydb';
    const out = redactString(c);
    expect(out).not.toContain('hunter2');
    expect(out).toContain(REDACTED);
    expect(out).toContain('db.example.com');
  });

  it('redacts ?password=... in connection strings', () => {
    const c = 'postgresql://host/db?user=alice&password=supersecretpw&ssl=true';
    const out = redactString(c);
    expect(out).not.toContain('supersecretpw');
    expect(out).toContain('user=alice');
    expect(out).toContain('ssl=true');
  });

  it('redacts pwd= and pass= in query strings', () => {
    expect(redactString('mysql://h/db?user=root&pwd=secret123')).toContain(REDACTED);
    expect(redactString('mysql://h/db?user=root&pass=secret123')).toContain(REDACTED);
    expect(redactString('x=root:p...@h')).not.toContain('secret');
  });
});

describe('redaction: emails (PII)', () => {
  it('redacts emails', () => {
    expect(redactString('Contact john.doe@example.com for info')).not.toContain('john.doe@example.com');
    expect(redactString('a@x.com and b@y.co.uk')).not.toContain('a@x.com');
  });
});

describe('redaction: absolute paths', () => {
  it('redacts /home/<u>', () => {
    expect(redactString('at /home/alice/x.txt')).not.toContain('/home/alice');
  });
  it('redacts /Users/<u>', () => {
    expect(redactString('at /Users/bob/y.txt')).not.toContain('/Users/bob');
  });
  it('redacts /root', () => {
    expect(redactString('x=/root/.ssh/id_rsa')).not.toContain('/root/.ssh');
  });
  it('redacts /etc, /var, /opt, /tmp, /usr', () => {
    for (const p of ['/etc/passwd', '/var/log/a.log', '/opt/app/key', '/tmp/sess', '/usr/local/bin/x']) {
      expect(redactString(`in ${p}`)).toContain(REDACTED);
    }
  });
  it('redacts Windows paths', () => {
    expect(redactString('at C:\\Users\\Alice\\f.txt')).not.toContain('Alice');
  });
  it('redacts ~/ paths', () => {
    expect(redactString('file=~/.npmrc')).not.toContain('~/.npmrc');
  });
  it('does NOT redact http(s) URLs', () => {
    const u = 'https://cdn.example.com/assets/img.png';
    expect(redactString(u)).toBe(u);
  });
  it('keeps relative paths', () => {
    expect(redactString('./assets/a.png')).toBe('./assets/a.png');
    expect(redactString('assets/manifest.json')).toBe('assets/manifest.json');
  });
});

describe('redaction: object/array recursion', () => {
  it('redacts top-level sensitive keys', () => {
    const r = redactSensitiveFields({ name: 't', apiKey: OPENAI_KEY, password: 'pw' }) as any;
    expect(r.name).toBe('t');
    expect(r.apiKey).toBe(REDACTED);
    expect(r.password).toBe(REDACTED);
  });

  it('recurses into nested objects', () => {
    const r = redactSensitiveFields({
      a: { b: { secretToken: 'tok_' + 'x'.repeat(30), model: 'm' } },
    }) as any;
    expect(r.a.b.model).toBe('m');
    expect(r.a.b.secretToken).toBe(REDACTED);
  });

  it('walks arrays', () => {
    const r = redactSensitiveFields({
      items: [{ name: 'a', token: 'abc' + '1'.repeat(30) }, { name: 'b' }],
    }) as any;
    expect(r.items[0].name).toBe('a');
    expect(r.items[0].token).toBe(REDACTED);
    expect(r.items[1].name).toBe('b');
  });

  it('catches secret-shaped VALUES under non-sensitive keys', () => {
    const r = redactSensitiveFields({ notes: `debug: ${JWT}` }) as any;
    expect(r.notes).not.toContain('eyJhbGci');
    expect(r.notes).toContain(REDACTED);
  });

  it('catches PEM blocks under non-sensitive keys', () => {
    const r = redactSensitiveFields({ log: PEM }) as any;
    expect(r.log).not.toContain('BEGIN RSA');
  });

  it('catches paths under arbitrary keys', () => {
    const r = redactSensitiveFields({ p: '/home/u/f.txt' }) as any;
    expect(r.p).not.toContain('/home/u');
  });

  it('preserves null/undefined/primitives', () => {
    expect(redactSensitiveFields(null)).toBe(null);
    expect(redactSensitiveFields(undefined)).toBe(undefined);
    expect(redactSensitiveFields(42)).toBe(42);
    expect(redactSensitiveFields(true)).toBe(true);
  });

  it('returns stats with triggers', () => {
    const { stats } = redactSensitiveFieldsWithStats({ apiKey: OPENAI_KEY, note: JWT });
    expect(stats.hits).toBeGreaterThan(0);
    expect(Array.from(stats.triggers).some((t) => t.startsWith('key:'))).toBe(true);
  });
});

describe('redaction: redactJsonString (post-serialization guard)', () => {
  it('scrubs toJSON() leaks', () => {
    const obj = { x: { toJSON() { return `tok=${JWT}`; } } };
    const out = redactJsonString(JSON.stringify(obj));
    expect(out).not.toContain('eyJhbGci');
  });
  it('scrubs paths in raw JSON', () => {
    const out = redactJsonString('{"log":"/var/log/a.log"}');
    expect(out).not.toContain('/var/log');
  });
  it('scrubs credentials in raw JSON', () => {
    const out = redactJsonString('{"db":"postgres://a:***@h/db"}');
    expect(out).not.toContain('"a":"b"');
    expect(out).toContain(REDACTED);
  });
});

describe('redaction: sanitizeForExport end-to-end', () => {
  it('produces valid JSON with dirty input', () => {
    const { json, redactionStats } = sanitizeForExport({
      name: 'Demo',
      apiKey: OPENAI_KEY,
      path: '/home/dev/x.txt',
      debug: `Bearer ${JWT}`,
    });
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe('Demo');
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed.path).not.toContain('/home/dev');
    expect(parsed.debug).toContain(REDACTED);
    expect(redactionStats.hits).toBeGreaterThan(0);
  });

  it('catches toJSON() leaks after serialization', () => {
    const tricky = {
      toJSON() {
        return { leaked: OPENAI_KEY };
      },
    };
    const { json } = sanitizeForExport(tricky);
    expect(json).not.toContain(OPENAI_KEY);
    expect(json).toContain(REDACTED);
  });

  it('leaves clean data unchanged', () => {
    const clean = { id: 'p1', name: 'Demo', items: [{ id: 's1', title: 'Intro' }] };
    const { json, redactionStats } = sanitizeForExport(clean);
    expect(JSON.parse(json)).toEqual(clean);
    expect(redactionStats.hits).toBe(0);
    expect(redactionStats.triggers).toEqual([]);
  });
});

describe('redaction: summarizePipelineParams', () => {
  it('redacts sensitive keys, keeps others', () => {
    const s = summarizePipelineParams({ model: 'm', apiKey: OPENAI_KEY, temperature: 0.7 });
    expect(s.model).toBe('m');
    expect(s.apiKey).toBe(REDACTED);
    expect(s.temperature).toBe('0.7');
  });
  it('handles undefined', () => {
    expect(summarizePipelineParams(undefined)).toEqual({});
  });
  it('truncates long strings', () => {
    const s = summarizePipelineParams({ prompt: 'a'.repeat(300) });
    expect(s.prompt.length).toBeLessThan(300);
    expect(s.prompt).toContain('(truncated)');
  });
  it('tags objects/arrays', () => {
    const s = summarizePipelineParams({ a: [1], b: { x: 1 } });
    expect(s.a).toBe('[object Array]');
    expect(s.b).toBe('[object Object]');
  });
});

describe('redaction: backwards-compatible exports', () => {
  it('redactPathsInString redacts paths (and now other secrets too)', () => {
    expect(redactPathsInString('/home/u/x.txt')).toContain(REDACTED);
    expect(redactPathsInString(`tok=${JWT}`)).not.toContain('eyJhbGci');
  });
});

describe('redaction: edge cases', () => {
  it('handles empty/non-string', () => {
    expect(redactString('')).toBe('');
    // @ts-expect-error defensive
    expect(redactString(null)).toBe(null);
    // @ts-expect-error defensive
    expect(redactString(undefined)).toBe(undefined);
  });
  it('leaves benign strings alone', () => {
    expect(redactString('Hello, world!')).toBe('Hello, world!');
    expect(redactString('resolution: 1920x1080, fps: 30')).toBe('resolution: 1920x1080, fps: 30');
  });
  it('preserves surrounding text when multiple patterns hit', () => {
    const out = redactString(
      `User a@b.com used ${OPENAI_KEY} at /home/u/.env via https://api.example.com/v1`,
    );
    expect(out).toMatch(/^User /);
    expect(out).toContain(' used ');
    expect(out).toContain(' at ');
    expect(out).toContain(' via ');
    expect(out).toContain('https://api.example.com/v1');
    expect(out).not.toContain('a@b.com');
    expect(out).not.toContain(OPENAI_KEY);
    expect(out).not.toContain('/home/u');
  });
});
