// Web Crypto helpers — uses browser's native SubtleCrypto for SHA-256
// Falls back to a simple deterministic hash when SubtleCrypto is unavailable (e.g. Node.js test env)

/**
 * Compute SHA-256 hex digest of a string or ArrayBuffer using Web Crypto.
 */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const buffer =
    typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', buffer as BufferSource);
    return bufferToHex(new Uint8Array(hash));
  }
  // Fallback for non-browser environments (Node.js tests, SSR)
  return fallbackHash(buffer);
}

/**
 * Compute SHA-256 hex of a Blob/File (used for asset files in export bundles).
 */
export async function sha256Blob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return sha256Hex(new Uint8Array(buffer));
}

function bufferToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Deterministic non-cryptographic fallback hash when SubtleCrypto is absent.
 * This is NOT for security — it provides a stable checksum for test environments.
 * Uses FNV-1a 256-bit style expanded to hex.
 */
function fallbackHash(buf: Uint8Array): string {
  // Simple but deterministic hash combining multiple FNV primes for longer output
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  let h3 = 0xcafebabe;
  let h4 = 0x12345678;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x01000193);
    h3 = Math.imul(h3 ^ b, 0x01000193);
    h4 = Math.imul(h4 ^ b, 0x01000193);
  }
  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + '00000000000000000000000000000000';
}

/**
 * Compute a combined manifest hash from all file entries.
 * Sorts file paths for determinism, concatenates "path:sha256" strings, hashes the result.
 */
export async function computeManifestHash(files: Array<{ path: string; sha256: string }>): Promise<string> {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const canonical = sorted.map((f) => `${f.path}:${f.sha256}`).join('\n');
  return sha256Hex(canonical);
}
