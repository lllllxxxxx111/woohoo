// Sensitive-data redaction for export payloads.
// Recursively clones input and removes/redacts sensitive keys and home-directory paths.

/** Keys whose values should be replaced with <redacted> when found in an exported object. */
export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'token',
  'jwt',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'privateKey',
  'private_key',
];

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/** Matches absolute paths that look like a user home directory, e.g. /home/alice/foo */
const HOME_PATH_RE = /\/home\/[^/\s"']+(?=\/|$)/g;
const REDACTED = '<redacted>';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(key.toLowerCase());
}

function redactString(value: string): string {
  return value.replace(HOME_PATH_RE, REDACTED);
}

function deepSanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepSanitize(item));
  }

  if (value instanceof Blob || value instanceof File) {
    // Binary blobs pass through; they contain no key/value metadata to redact.
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = deepSanitize(v);
      }
    }
    return out;
  }

  // Primitives (number, boolean, bigint, symbol, function) — return as-is.
  return value;
}

/**
 * Return a deep clone of `obj` with sensitive values redacted.
 *
 * - Any key listed in SENSITIVE_KEYS has its value replaced with `<redacted>`.
 * - String values that contain absolute home-directory paths (`/home/<user>/...`)
 *   have the `/home/<user>` segment replaced with `<redacted>`.
 *
 * The original object is NOT mutated.
 */
export function sanitizeForExport<T>(obj: T): T {
  return deepSanitize(obj) as T;
}
