import { describe, it, expect } from 'vitest';
import { sanitizeForExport, SENSITIVE_KEYS } from '../utils/sanitize';

describe('sanitizeForExport', () => {
  it('redacts known sensitive keys at top level', () => {
    const input = { name: 'proj', password: 'hunter2', token: 'abc123' };
    const out = sanitizeForExport(input);
    expect(out.password).toBe('<redacted>');
    expect(out.token).toBe('<redacted>');
    expect(out.name).toBe('proj');
    // Original not mutated
    expect(input.password).toBe('hunter2');
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

  it('redacts home-directory paths in strings', () => {
    const input = { log: 'stored at /home/alice/.ssh/key and /home/bob/docs' };
    const out: any = sanitizeForExport(input);
    expect(out.log).not.toContain('/home/alice');
    expect(out.log).not.toContain('/home/bob');
    expect(out.log).toContain('<redacted>');
  });

  it('handles null/undefined/primitives without crashing', () => {
    expect(sanitizeForExport(null as any)).toBeNull();
    expect(sanitizeForExport(undefined as any)).toBeUndefined();
    expect(sanitizeForExport(42 as any)).toBe(42);
    expect(sanitizeForExport(true as any)).toBe(true);
  });

  it('matches case-insensitively for sensitive keys', () => {
    const input = { Password: 'x', TOKEN: 'y', ApiKey: 'z' };
    const out: any = sanitizeForExport(input);
    expect(out.Password).toBe('<redacted>');
    expect(out.TOKEN).toBe('<redacted>');
    expect(out.ApiKey).toBe('<redacted>');
  });

  it('SENSITIVE_KEYS includes expected fields', () => {
    const expected = ['password', 'token', 'jwt', 'secret', 'apiKey', 'api_key',
      'authorization', 'cookie', 'privateKey', 'private_key'];
    for (const k of expected) {
      expect(SENSITIVE_KEYS).toContain(k);
    }
  });
});
