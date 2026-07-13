// Tests for sanitization (sensitive field redaction)
import { describe, it, expect } from 'vitest';
import { sanitizeForExport, sanitizeSnapshot } from '../utils/sanitize';

describe('sanitizeForExport', () => {
  it('redacts apiKey fields', () => {
    const input = { name: 'test', apiKey: 'sk-12345' };
    const out = sanitizeForExport(input);
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.name).toBe('test');
  });

  it('redacts password, secret, token, jwt fields', () => {
    const input = { password: 'hunter2', secret: 'xyz', token: 't', jwt: 'j' };
    const out = sanitizeForExport(input);
    expect(out.password).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.jwt).toBe('[REDACTED]');
  });

  it('redacts nested sensitive fields', () => {
    const input = { config: { authorization: 'Bearer abc', nested: { accessToken: 'tok' } } };
    const out = sanitizeForExport(input);
    expect(out.config.authorization).toBe('[REDACTED]');
    expect(out.config.nested.accessToken).toBe('[REDACTED]');
  });

  it('redacts JWT-shaped strings', () => {
    const input = { header: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' };
    const out = sanitizeForExport(input);
    expect(out.header).toBe('[REDACTED_JWT]');
  });

  it('redacts absolute local paths (Linux/macOS)', () => {
    const input = { path: '/home/claude-user/secret/file.png' };
    const out = sanitizeForExport(input);
    expect(out.path).toBe('./file.png');
  });

  it('redacts Windows absolute paths', () => {
    const input = { path: 'C:\\Users\\admin\\secret.docx' };
    const out = sanitizeForExport(input);
    expect(out.path).toBe('./secret.docx');
  });

  it('leaves non-sensitive strings alone', () => {
    const input = { name: 'project', relativePath: './assets/img.png', url: 'https://example.com/a.png' };
    const out = sanitizeForExport(input);
    expect(out.name).toBe('project');
    expect(out.relativePath).toBe('./assets/img.png');
    expect(out.url).toBe('https://example.com/a.png');
  });

  it('handles arrays correctly', () => {
    const input = { items: [{ apiKey: 'a' }, { apiKey: 'b' }] };
    const out = sanitizeForExport(input);
    expect(out.items[0].apiKey).toBe('[REDACTED]');
    expect(out.items[1].apiKey).toBe('[REDACTED]');
  });

  it('passes through primitives', () => {
    expect(sanitizeForExport(null)).toBe(null);
    expect(sanitizeForExport(undefined)).toBe(undefined);
    expect(sanitizeForExport(42)).toBe(42);
    expect(sanitizeForExport(true)).toBe(true);
  });
});

describe('sanitizeSnapshot', () => {
  it('strips userId from top level', () => {
    const out = sanitizeSnapshot({ userId: 'u1', name: 'p' });
    expect(out.userId).toBeUndefined();
    expect(out.name).toBe('p');
  });

  it('converts local file paths in asset URLs', () => {
    const out = sanitizeSnapshot({
      assets: [{ id: 'a1', url: '/home/user/assets/img.png', name: 'img.png' }],
    });
    // URL is replaced with bundle-relative path (filename preserved for traceability)
    expect((out.assets as any[])[0].url).toBe('./assets/img.png');
    // Original absolute path must not leak anywhere in the output
    expect(JSON.stringify(out)).not.toContain('/home/user');
  });

  it('leaves http URLs untouched', () => {
    const out = sanitizeSnapshot({
      assets: [{ id: 'a1', url: 'https://cdn.example.com/img.png' }],
    });
    expect((out.assets as any[])[0].url).toBe('https://cdn.example.com/img.png');
  });
});
