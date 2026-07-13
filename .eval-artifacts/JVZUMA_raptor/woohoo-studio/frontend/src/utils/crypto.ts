// Crypto utilities - uses Web Crypto API for SHA-256 hashing
// No external dependencies; works in browser and Node (for tests)

const textEncoder = new TextEncoder();

export async function sha256Bytes(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return bufferToHex(hashBuffer);
}

export async function sha256String(text: string): Promise<string> {
  return sha256Bytes(textEncoder.encode(text));
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return sha256Bytes(new Uint8Array(buffer));
}

export function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return (
    buf2hex(bytes.slice(0, 4)) + '-' +
    buf2hex(bytes.slice(4, 6)) + '-' +
    buf2hex(bytes.slice(6, 8)) + '-' +
    buf2hex(bytes.slice(8, 10)) + '-' +
    buf2hex(bytes.slice(10, 16))
  );
}

function buf2hex(buf: Uint8Array): string {
  return buf.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
