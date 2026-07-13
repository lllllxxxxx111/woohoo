// SHA-256 hashing utilities backed by the Web Crypto API (window.crypto.subtle).
// All functions return a lowercase hex string.

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Normalize a BufferSource into an ArrayBuffer suitable for subtle.digest.
 * Accepts ArrayBuffer, TypedArrays (Uint8Array, etc.), DataView, and Node Buffer.
 */
function toArrayBuffer(data: BufferSource | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    // TypedArray or DataView: return a copy of the underlying slice.
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
  }
  // Node Buffer (which is a Uint8Array subclass) will be caught by isView.
  // Last resort: try to coerce.
  return data as ArrayBuffer;
}

/**
 * Compute SHA-256 of a BufferSource and return lowercase hex.
 */
export async function sha256Bytes(buf: BufferSource): Promise<string> {
  const ab = toArrayBuffer(buf);
  const digest = await window.crypto.subtle.digest('SHA-256', ab);
  return bufferToHex(digest);
}

/**
 * Compute SHA-256 of a UTF-8 string and return lowercase hex.
 */
export async function sha256String(s: string): Promise<string> {
  const encoded = new TextEncoder().encode(s);
  return sha256Bytes(encoded);
}

/**
 * Compute SHA-256 of a Blob and return lowercase hex.
 */
export async function sha256Blob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return sha256Bytes(buf);
}
