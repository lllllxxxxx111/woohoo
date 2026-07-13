// Edge-case tests for the sanitizer: arrays, nested objects, non-string primitives,
// deep nesting, large strings, idempotence, and preservation of non-sensitive data.
import { describe, it, expect } from 'vitest';
import { sanitizeForExport, sanitizeString, containsSecret } from '../utils/sanitize';

describe('sanitizer preserves non-sensitive primitive types', () => {
  it('keeps numbers, booleans, null unchanged', () => {
    const input = { n: 42, flag: true, nil: null, zero: 0, f: 3.14, b: false };
    const out = sanitizeForExport(input);
    expect(out).toEqual(input);
  });

  it('keeps innocent strings untouched', () => {
    expect(sanitizeString('hello world')).toBe('hello world');
    expect(sanitizeString('The project contains 3 scenes and 2 characters.')).toContain('3 scenes');
    expect(sanitizeString('')).toBe('');
  });
});

describe('sanitizer handles arrays', () => {
  it('walks array elements and redacts sensitive keys inside objects in arrays', () => {
    const input = {
      users: [
        { name: 'Alice', apiKey: 'sk-abcdef0123456789abcdef', role: 'admin' },
        { name: 'Bob', password: 'hunter2', role: 'editor' },
      ],
    };
    const out = sanitizeForExport(input) as typeof input;
    expect(out.users[0].apiKey).toBe('[REDACTED]');
    expect(out.users[0].name).toBe('Alice');
    expect(out.users[1].password).toBe('[REDACTED]');
    expect(out.users[1].role).toBe('editor');
  });

  it('scans string elements in arrays for embedded secrets', () => {
    const input = { logs: ['ok', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc', 'done'] };
    const out = sanitizeForExport(input) as typeof input;
    expect(out.logs[1]).not.toContain('eyJhbGci');
    expect(out.logs[1]).toContain('[REDACTED_JWT]');
  });

  it('handles empty arrays', () => {
    expect(sanitizeForExport({ items: [] })).toEqual({ items: [] });
  });
});

describe('sanitizer handles deep nesting', () => {
  it('traverses arbitrarily nested objects', () => {
    const input = {
      a: { b: { c: { d: { password: 'topsecret', note: 'hi' } } } },
    };
    const out = sanitizeForExport(input) as any;
    expect(out.a.b.c.d.password).toBe('[REDACTED]');
    expect(out.a.b.c.d.note).toBe('hi');
  });

  it('traverses arrays nested in objects nested in arrays', () => {
    const input = [{ config: [{ apiKey: 'abc' }] }];
    const out = sanitizeForExport(input) as any;
    expect(out[0].config[0].apiKey).toBe('[REDACTED]');
  });
});

describe('sanitizer key matching edge cases', () => {
  it('is case-insensitive', () => {
    const out = sanitizeForExport({ APIKEY: 'x', Password: 'y', bEarEr: 'z', Client_Secret: 'q' }) as any;
    expect(out.APIKEY).toBe('[REDACTED]');
    expect(out.Password).toBe('[REDACTED]');
    expect(out.bEarEr).toBe('[REDACTED]');
    expect(out.Client_Secret).toBe('[REDACTED]');
  });

  it('matches keys containing sensitive fragments anywhere', () => {
    // nestedConfig.apiKey should be caught, also `xApiKeyHeader`.
    const out = sanitizeForExport({
      nestedConfig: { apiKey: 'sk-abcdefghijklmnopqrstuvwx' },
      xApiKeyHeader: 'tok',
      authToken: 'abc',
    }) as any;
    expect(out.nestedConfig.apiKey).toBe('[REDACTED]');
    expect(out.xApiKeyHeader).toBe('[REDACTED]');
    expect(out.authToken).toBe('[REDACTED]');
  });

  it('does NOT redact innocent keys like "name" or "keyboard", "keyword"', () => {
    const out = sanitizeForExport({
      name: 'my-api-key-project',
      keyboard: 'mechanical',
      keyword: 'search',
    }) as any;
    expect(out.name).toBe('my-api-key-project');
    expect(out.keyboard).toBe('mechanical');
    expect(out.keyword).toBe('search');
  });
});

describe('sanitizer idempotence and stability', () => {
  it('sanitizing twice yields the same result (already-redacted markers stay)', () => {
    const input = { apiKey: 'sk-abcdef0123456789abcdef', note: 'see /home/u/secret.pem' };
    const once = sanitizeForExport(input) as any;
    const twice = sanitizeForExport(once) as any;
    expect(twice).toEqual(once);
  });
});

describe('containsSecret helper', () => {
  it('returns true for strings with JWTs, keys, or paths', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjMifQ.' + 'abcdefghijk';
    expect(containsSecret('Bearer ' + jwt)).toBe(true);
    expect(containsSecret('AKIA' + 'ABCDEFGHIJKLMNOP')).toBe(true);
    expect(containsSecret('sk-abcdefghijklmnopqrst')).toBe(true);
    expect(containsSecret('config=/etc/shadow')).toBe(true);
  });

  it('returns false for innocent prose', () => {
    expect(containsSecret('The quick brown fox')).toBe(false);
    expect(containsSecret('https://example.com/home/dashboard')).toBe(false);
    expect(containsSecret('version 1.2.3')).toBe(false);
    expect(containsSecret('')).toBe(false);
  });
});

describe('sanitizer handles large inputs efficiently', () => {
  it('scans a 1MB string without error', () => {
    // Build a valid-looking AWS key: AKIA + 16 uppercase/digits
    const fakeAkid = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const big = 'A'.repeat(1024 * 1024) + ' ' + fakeAkid + ' ' + 'B'.repeat(100);
    const out = sanitizeString(big);
    expect(out).not.toContain(fakeAkid);
    expect(out).toContain('[REDACTED_KEY]');
  });
});
