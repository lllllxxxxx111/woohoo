// Tests for crypto utilities (SHA-256, hex conversion, ID generation)
import { describe, it, expect } from 'vitest';
import { sha256String, sha256Bytes, bufferToHex, generateId } from '../utils/crypto';

describe('crypto utilities', () => {
  describe('sha256String', () => {
    it('produces consistent 64-char hex output', async () => {
      const hash1 = await sha256String('hello world');
      const hash2 = await sha256String('hello world');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different hashes for different inputs', async () => {
      const hash1 = await sha256String('hello');
      const hash2 = await sha256String('world');
      expect(hash1).not.toBe(hash2);
    });

    it('matches known SHA-256 vector', async () => {
      // SHA-256 of empty string is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
      const hash = await sha256String('');
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('sha256Bytes', () => {
    it('hashes Uint8Array correctly', async () => {
      const data = new TextEncoder().encode('test');
      const hash = await sha256Bytes(data);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('bufferToHex', () => {
    it('converts known bytes to hex', () => {
      const buf = new Uint8Array([0x00, 0xff, 0x0a, 0x1b]);
      expect(bufferToHex(buf.buffer)).toBe('00ff0a1b');
    });
  });

  describe('generateId', () => {
    it('generates UUID v4 format strings', () => {
      const id = generateId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });
  });
});
