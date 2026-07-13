import { describe, it, expect } from 'vitest';
import { sha256Bytes, sha256String, sha256Blob } from '../utils/crypto';

// Known SHA-256: "abc" -> ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('crypto (sha256)', () => {
  it('sha256String returns lowercase hex of correct length', async () => {
    const hash = await sha256String('abc');
    expect(hash).toBe(ABC_SHA256);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256String of empty string is deterministic', async () => {
    const h1 = await sha256String('');
    const h2 = await sha256String('');
    expect(h1).toBe(h2);
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(h1).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('sha256Bytes digests an ArrayBuffer', async () => {
    const buf = new TextEncoder().encode('abc').buffer;
    const hash = await sha256Bytes(buf);
    expect(hash).toBe(ABC_SHA256);
  });

  it('sha256Blob digests a Blob', async () => {
    const blob = new Blob(['abc'], { type: 'text/plain' });
    const hash = await sha256Blob(blob);
    expect(hash).toBe(ABC_SHA256);
  });

  it('different inputs produce different hashes', async () => {
    const h1 = await sha256String('hello');
    const h2 = await sha256String('world');
    expect(h1).not.toBe(h2);
  });
});
