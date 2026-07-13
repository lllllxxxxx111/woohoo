// Tests for crypto utilities (sha256, manifestHash)
import { describe, it, expect } from 'vitest';
import { sha256Hex, computeManifestHash } from '../utils/crypto';

describe('sha256Hex', () => {
  it('produces a 64-character hex string', async () => {
    const hash = await sha256Hex('hello world');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    const h1 = await sha256Hex('test');
    const h2 = await sha256Hex('test');
    expect(h1).toBe(h2);
  });

  it('differs for different inputs', async () => {
    const h1 = await sha256Hex('abc');
    const h2 = await sha256Hex('abd');
    expect(h1).not.toBe(h2);
  });

  it('handles empty string', async () => {
    const hash = await sha256Hex('');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles Uint8Array input', async () => {
    const bytes = new TextEncoder().encode('hello');
    const hash = await sha256Hex(bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeManifestHash', () => {
  it('produces consistent hash for same file list', async () => {
    const files = [
      { path: 'a.txt', sha256: 'aaa' },
      { path: 'b.txt', sha256: 'bbb' },
    ];
    const h1 = await computeManifestHash(files);
    const h2 = await computeManifestHash(files);
    expect(h1).toBe(h2);
  });

  it('is order-independent (sorts paths internally)', async () => {
    const ordered = [
      { path: 'a.txt', sha256: 'aaa' },
      { path: 'b.txt', sha256: 'bbb' },
    ];
    const reversed = [
      { path: 'b.txt', sha256: 'bbb' },
      { path: 'a.txt', sha256: 'aaa' },
    ];
    const h1 = await computeManifestHash(ordered);
    const h2 = await computeManifestHash(reversed);
    expect(h1).toBe(h2);
  });

  it('differs when file content changes', async () => {
    const f1 = [{ path: 'a.txt', sha256: 'aaa' }];
    const f2 = [{ path: 'a.txt', sha256: 'bbb' }];
    const h1 = await computeManifestHash(f1);
    const h2 = await computeManifestHash(f2);
    expect(h1).not.toBe(h2);
  });

  it('handles empty file list', async () => {
    const hash = await computeManifestHash([]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
