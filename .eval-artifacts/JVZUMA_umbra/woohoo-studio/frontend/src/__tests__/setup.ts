// Vitest setup file
import '@testing-library/jest-dom';

// Blob.arrayBuffer polyfill for jsdom.
if (typeof Blob !== 'undefined') {
  (Blob.prototype as any).arrayBuffer = async function (): Promise<ArrayBuffer> {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// Provide a reliable SHA-256 digest using Node's crypto.
// jsdom + Node WebCrypto interop is flaky, so we replace globalThis.crypto entirely.
const nodeCrypto: any = await import('node:crypto');

function toBuffer(data: any): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (data && typeof data === 'object' && data.type === 'Buffer' && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  return Buffer.from(data);
}

const fakeSubtle = {
  async digest(algo: string, data: any): Promise<ArrayBuffer> {
    if (algo !== 'SHA-256') throw new Error(`Unsupported algo ${algo}`);
    const hash = nodeCrypto.createHash('sha256').update(toBuffer(data)).digest();
    const ab = new ArrayBuffer(hash.length);
    new Uint8Array(ab).set(hash);
    return ab;
  },
};

const fakeCrypto: any = {
  subtle: fakeSubtle,
  getRandomValues(arr: any) {
    const bytes = nodeCrypto.randomBytes(arr.length);
    arr.set(bytes);
    return arr;
  },
};

// Replace globalThis.crypto with our fake (works in jsdom and Node).
Object.defineProperty(globalThis, 'crypto', {
  value: fakeCrypto,
  writable: true,
  configurable: true,
});
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'crypto', {
    value: fakeCrypto,
    writable: true,
    configurable: true,
  });
}
