// Additional redaction / sanitization tests for edge cases
import { describe, it, expect } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  redactString,
  redactPathsInString,
  redactSensitiveFields,
  redactSensitiveFieldsWithStats,
  redactJsonString,
  summarizePipelineParams,
  sanitizeForExport,
} from '../utils/redaction';

// Build tokens of the right lengths to trigger each regex.
const JWT = () => {
  // eyJ... . b64u(8+) . b64u(8+)
  const b = (n: number) => 'A'.repeat(n);
  return 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' + b(20) + '.' + b(32);
};
const SK = () => 'sk-' + 'a'.repeat(40);
const SK_LIVE = () => 'sk_live_' + 'a'.repeat(40);
const GHP = () => 'ghp_' + 'a'.repeat(36);
const XOXB = () => 'xoxb-' + '1234567890-' + 'a'.repeat(24);
const AKIA = () => 'AKIA' + 'ABCDEFGHIJKLMNOP';
const AIZA = () => 'AIza' + 'a'.repeat(35);
const SK_ANT = () => 'sk-ant-' + 'a'.repeat(40);

describe('redaction helpers', () => {
  describe('isSensitiveKey', () => {
    const sensitiveKeys = [
      'apiKey', 'api_key', 'apikey',
      'token', 'accessToken', 'access_token', 'refreshToken',
      'password', 'passwd', 'pwd', 'secret', 'clientSecret',
      'authorization', 'Authorization', 'auth', 'bearer',
      'jwt', 'privateKey', 'private_key', 'secretKey',
      'credential', 'credentials', 'x-api-key',
    ];
    for (const k of sensitiveKeys) {
      it('treats "' + k + '" as sensitive', () => {
        expect(isSensitiveKey(k)).toBe(true);
      });
    }

    it('treats non-sensitive keys as safe', () => {
      for (const k of ['name', 'title', 'url', 'id', 'projectId', 'count', 'type']) {
        expect(isSensitiveKey(k)).toBe(false);
      }
    });

    it('handles mixed-case / case-insensitive match', () => {
      expect(isSensitiveKey('APIToken')).toBe(true);
      expect(isSensitiveKey('Client_Secret')).toBe(true);
      expect(isSensitiveKey('Jwt')).toBe(true);
    });
  });

  describe('redactString value patterns', () => {
    it('redacts JWT tokens (eyJ.a.b form)', () => {
      const token = JWT();
      const result = redactString('Bearer ' + token);
      expect(result).not.toContain(token);
      expect(result).toContain(REDACTED);
    });

    it('redacts OpenAI-style sk- keys', () => {
      const key = SK();
      const result = redactString('OPENAI_KEY=' + key);
      expect(result).not.toContain(key);
    });

    it('redacts Stripe sk_live_ keys', () => {
      const key = SK_LIVE();
      const result = redactString('stripe: ' + key);
      expect(result).not.toContain('sk_live_');
    });

    it('redacts GitHub ghp_ tokens', () => {
      const tok = GHP();
      const result = redactString('GITHUB_TOKEN=' + tok);
      expect(result).not.toContain('ghp_');
    });

    it('redacts Slack xoxb- tokens', () => {
      const tok = XOXB();
      const result = redactString(tok);
      expect(result).not.toContain('xoxb-');
    });

    it('redacts AWS AKIA access key ids', () => {
      const key = AKIA();
      const result = redactString('aws=' + key);
      expect(result).not.toContain('AKIA');
    });

    it('redacts Google AIza keys', () => {
      const key = AIZA();
      const result = redactString('google: ' + key);
      expect(result).not.toContain('AIza');
    });

    it('redacts Anthropic sk-ant- keys', () => {
      const key = SK_ANT();
      const result = redactString(key);
      expect(result).not.toContain('sk-ant-');
    });

    it('redacts HTTP Basic auth (user:password@host)', () => {
      const result = redactString('https://admin:s3cret-password@example.com/path');
      expect(result).not.toContain('s3cret-password');
    });

    it('redacts query-string password= / passwd= / pwd= / pass= / auth= parameters', () => {
      expect(redactString('https://db.example.com/connect?password=hunter2xyz&db=main'))
        .not.toContain('hunter2xyz');
      expect(redactString('https://x.com/?passwd=verySecret123&x=1'))
        .not.toContain('verySecret123');
      expect(redactString('https://x.com/?pwd=TopSecret12345'))
        .not.toContain('TopSecret12345');
    });

    it('preserves normal non-sensitive text', () => {
      const normal = 'Exported project "Demo" with 5 scripts and 10 assets.';
      expect(redactString(normal)).toBe(normal);
    });

    it('preserves ordinary https URLs without credentials', () => {
      const u = 'https://cdn.example.com/assets/img.png';
      expect(redactString(u)).toBe(u);
    });

    it('redacts standalone "Bearer <JWT>" form', () => {
      const tok = JWT();
      const s = 'Authorization: Bearer ' + tok;
      const r = redactString(s);
      expect(r).not.toContain(tok);
    });

    it('redacts email addresses (PII)', () => {
      const s = 'Contact user.name+tag@example.co.uk for details.';
      const r = redactString(s);
      expect(r).not.toContain('user.name+tag@example.co.uk');
    });
  });

  describe('redactPathsInString', () => {
    it('redacts Unix /home/<user>/...', () => {
      const r = redactPathsInString('src=/home/alice/projects/woohoo/audio.wav');
      expect(r).not.toContain('/home/alice');
      expect(r).toContain(REDACTED);
    });

    it('redacts /Users/<user>/... (macOS)', () => {
      const r = redactPathsInString('at /Users/bob/Library/Application Support/stuff');
      expect(r).not.toContain('/Users/bob');
    });

    it('redacts /root/...', () => {
      const r = redactPathsInString('path=/root/.ssh/id_rsa');
      expect(r).not.toContain('/root/.ssh');
    });

    it('redacts Windows C:\\Users\\...', () => {
      const r = redactPathsInString('source=C:\\Users\\Alice\\Documents\\file.txt');
      expect(r).not.toContain('Alice');
    });

    it('redacts tilde paths (~/...)', () => {
      const r = redactPathsInString('found in ~/Downloads/asset.png');
      expect(r).not.toContain('~/Downloads');
    });

    it('preserves relative paths like ./assets/img.png', () => {
      expect(redactPathsInString('./assets/image/img.png')).toBe('./assets/image/img.png');
    });

    it('preserves archive-relative paths like assets/image/foo.png', () => {
      expect(redactPathsInString('assets/image/foo.png')).toBe('assets/image/foo.png');
    });
  });

  describe('redactSensitiveFields (deep)', () => {
    it('redacts top-level sensitive keys', () => {
      const input = { name: 'p', apiKey: SK() };
      const out = redactSensitiveFields(input) as any;
      expect(out.name).toBe('p');
      expect(out.apiKey).toBe(REDACTED);
    });

    it('recursively redacts nested objects and arrays', () => {
      const input = {
        meta: { password: 'pw1', safe: 'ok' },
        list: [{ token: JWT() }, { token: JWT() }],
      };
      const out = redactSensitiveFields(input) as any;
      expect(out.meta.safe).toBe('ok');
      expect(out.meta.password).toBe(REDACTED);
      expect(out.list[0].token).toBe(REDACTED);
      expect(out.list[1].token).toBe(REDACTED);
    });

    it('returns primitives unchanged', () => {
      expect(redactSensitiveFields(42)).toBe(42);
      expect(redactSensitiveFields(null)).toBe(null);
      expect(redactSensitiveFields('hello world')).toBe('hello world');
    });

    it('does not mutate the input object', () => {
      const original = SK();
      const input = { apiKey: original };
      const out = redactSensitiveFields(input);
      expect(input.apiKey).toBe(original);
      expect((out as any).apiKey).toBe(REDACTED);
    });
  });

  describe('redactSensitiveFieldsWithStats', () => {
    it('reports hit count and triggers set', () => {
      const { value, stats } = redactSensitiveFieldsWithStats({
        token: JWT(), password: 'p', name: 'ok',
      });
      expect(stats.hits).toBeGreaterThanOrEqual(2);
      expect(stats.triggers.size).toBeGreaterThanOrEqual(1);
      expect((value as any).token).toBe(REDACTED);
    });
  });

  describe('redactJsonString', () => {
    it('scrubs password= in leaked URL inside JSON', () => {
      const leaked = '{"msg":"ok","url":"https://db.example.com/?password=LEAKED_SECRET_12345"}';
      const scrubbed = redactJsonString(leaked);
      expect(scrubbed).not.toContain('LEAKED_SECRET_12345');
      expect(scrubbed).toContain(REDACTED);
    });

    it('scrubs absolute Unix paths inside JSON strings', () => {
      const out = redactJsonString('{"log":"/home/claude-user/secrets.txt"}');
      expect(out).not.toContain('/home/claude-user');
    });

    it('leaves clean JSON untouched', () => {
      const clean = '{"projectId":"p","name":"Demo","count":3}';
      expect(redactJsonString(clean)).toBe(clean);
    });

    it('scrubs sk- keys that appear anywhere in the serialized form', () => {
      const leaked = '{"note":"my key is ' + SK() + '"}';
      const out = redactJsonString(leaked);
      expect(out).not.toContain('sk-');
    });
  });

  describe('summarizePipelineParams', () => {
    it('returns {} for undefined', () => {
      expect(summarizePipelineParams(undefined)).toEqual({});
    });

    it('converts numbers to their string form', () => {
      const s = summarizePipelineParams({ seed: 42, steps: 30 });
      expect(s.seed).toBe('42');
      expect(s.steps).toBe('30');
    });

    it('truncates long strings and appends "(truncated)"', () => {
      const long = 'x'.repeat(300);
      const s = summarizePipelineParams({ prompt: long });
      expect(s.prompt.length).toBeLessThan(250);
      expect(s.prompt).toContain('(truncated)');
    });

    it('redacts sensitive-key values and applies string redaction', () => {
      const s = summarizePipelineParams({ model: 'sdxl-turbo', apiKey: SK() });
      expect(s.model).toBe('sdxl-turbo');
      expect(s.apiKey).toBe(REDACTED);
    });

    it('describes objects/arrays with shape markers', () => {
      const s = summarizePipelineParams({ nested: { a: 1 }, items: [1, 2, 3] });
      expect(s.nested).toBe('[object Object]');
      expect(s.items).toBe('[object Array]');
    });
  });

  describe('sanitizeForExport', () => {
    it('produces valid JSON and records stats', () => {
      const { json, redactionStats } = sanitizeForExport({ name: 'p', token: JWT() });
      expect(() => JSON.parse(json)).not.toThrow();
      expect(redactionStats.hits).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(redactionStats.triggers)).toBe(true);
    });

    it('redacts secrets nested deep in arrays', () => {
      const { json } = sanitizeForExport({
        layers: [
          { name: 'L1', config: { apiKey: SK() } },
          { name: 'L2', config: { apiKey: SK() } },
        ],
      });
      expect(json).not.toContain('sk-');
      expect(json).toContain(REDACTED);
    });

    it('scrubs absolute paths', () => {
      const { json } = sanitizeForExport({ sourceFile: '/home/claude-user/woohoo/test.mp4' });
      expect(json).not.toContain('/home/claude-user');
    });

    it('preserves non-sensitive data', () => {
      const { json } = sanitizeForExport({
        projectId: 'proj-123', name: 'Demo', counts: { scripts: 3 },
      });
      const parsed = JSON.parse(json);
      expect(parsed.projectId).toBe('proj-123');
      expect(parsed.name).toBe('Demo');
      expect(parsed.counts.scripts).toBe(3);
    });

    it('roundtrips clean objects without structural changes', () => {
      const { json } = sanitizeForExport({ complex: { a: [1, 2, 3], b: null, c: true } });
      expect(JSON.parse(json)).toEqual({ complex: { a: [1, 2, 3], b: null, c: true } });
    });

    it('scrubs URL userinfo (user:pass@) inside strings', () => {
      const { json } = sanitizeForExport({
        endpoint: 'https://user:s3cr3tP@ss@internal.example.com/api',
      });
      expect(json).not.toContain('s3cr3tP@ss');
    });
  });
});
