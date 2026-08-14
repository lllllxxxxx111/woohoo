/**
 * 零依赖增量 SHA-256（FIPS 180-4）。
 *
 * 为什么不用 `crypto.subtle.digest`：WebCrypto 只支持一次性消化整个缓冲区，
 * 大文件会被迫完整读入内存。这里实现流式更新，可以按分片边读边算，
 * 内存占用恒定为一个分片大小。
 *
 * 正确性由 `sha256.test.ts` 用 NIST 标准向量与 WebCrypto 随机数据交叉验证。
 */

const K: Uint32Array = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK_SIZE = 64;

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class Sha256 {
  private state: Uint32Array;
  private buffer: Uint8Array;
  private bufferLength = 0;
  // 已消化总字节数，用两个 32 位字承载 64 位长度。
  private bytesLo = 0;
  private bytesHi = 0;
  private finished = false;

  constructor() {
    this.state = Uint32Array.from([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19,
    ]);
    this.buffer = new Uint8Array(BLOCK_SIZE);
  }

  update(data: Uint8Array): this {
    if (this.finished) {
      throw new Error('Sha256: digest() 之后不能再 update');
    }

    // 长度累加（32 位进位）。
    const before = this.bytesLo;
    this.bytesLo = (this.bytesLo + data.length) >>> 0;
    if (this.bytesLo < before) {
      this.bytesHi = (this.bytesHi + 1) >>> 0;
    }

    let offset = 0;
    if (this.bufferLength > 0) {
      const needed = BLOCK_SIZE - this.bufferLength;
      const take = Math.min(needed, data.length);
      this.buffer.set(data.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset = take;
      if (this.bufferLength === BLOCK_SIZE) {
        this.compress(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (offset + BLOCK_SIZE <= data.length) {
      this.compress(data, offset);
      offset += BLOCK_SIZE;
    }

    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLength = data.length - offset;
    }

    return this;
  }

  digestHex(): string {
    if (this.finished) {
      throw new Error('Sha256: digest() 只能调用一次');
    }
    this.finished = true;

    // 追加 0x80。
    this.buffer[this.bufferLength] = 0x80;
    this.bufferLength += 1;

    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this.compress(this.buffer, 0);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);

    // 64 位大端比特长度：字节数 × 8。
    const bitLo = Math.imul(this.bytesLo, 8) >>> 0;
    const bitHi = (Math.imul(this.bytesHi, 8) + Math.floor(this.bytesLo / 0x20000000)) >>> 0;
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, bitHi);
    view.setUint32(60, bitLo);
    this.compress(this.buffer, 0);

    let hex = '';
    for (let i = 0; i < 8; i += 1) {
      hex += this.state[i].toString(16).padStart(8, '0');
    }
    return hex;
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset + offset, BLOCK_SIZE);
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

/** 一次性计算小数据的 SHA-256（十六进制小写）。 */
export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  return new Sha256().update(bytes).digestHex();
}
