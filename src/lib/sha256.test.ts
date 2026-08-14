import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex } from './sha256';

describe('Sha256 标准向量', () => {
  it('空字符串', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('abc', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('56 字节输入（正好落在单块填充边界）', () => {
    expect(sha256Hex('a'.repeat(56))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
  });

  it('FIPS 双块向量', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('分多次 update 与一次性 update 结果一致', () => {
    const data = new TextEncoder().encode('the quick brown fox jumps over the lazy dog');
    const once = new Sha256().update(data).digestHex();

    const streamed = new Sha256();
    for (let i = 0; i < data.length; i += 7) {
      streamed.update(data.subarray(i, i + 7));
    }
    expect(streamed.digestHex()).toBe(once);
  });

  it('与 WebCrypto 对随机数据交叉验证', async () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 1000, 65537]) {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) {
        data[i] = (i * 31 + 7) % 256;
      }
      const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const streamed = new Sha256();
      for (let offset = 0; offset < data.length; offset += 1000) {
        streamed.update(data.subarray(offset, offset + 1000));
      }
      expect(streamed.digestHex()).toBe(expected);
    }
  });
});
