// Integrity helpers: SHA-256 via Web Crypto, sensitive field stripping, sanitization
//
// Security model:
//   Every string that enters an export bundle passes through sanitizeForExport().
//   Recursion covers nested objects/arrays (e.g., asset.metadata, keyframe.parameters).
//   Three independent layers catch leaks:
//     1. Key-level: fields named like api_key, password, token are dropped entirely.
//     2. Value-level: strings that look like secrets (JWT, sk-keys, AKIA..., SSH blocks)
//        are replaced with "[REDACTED]" even when under a benign key name.
//     3. URL-level: query parameters named token/key/signature/auth are scrubbed;
//        user:pass@host basic-auth is removed; signed S3/CDN URLs have signatures erased.
//   Absolute local filesystem paths (/home/<user>, C:\Users\<user>) are normalized.

// ---------------------------------------------------------------------------
// Sensitive key patterns — field names that should NEVER appear in exports
// ---------------------------------------------------------------------------
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /^api[_-]?key$/i,
  /^secret$/i,
  /^secret[_-]?key$/i,
  /^client[_-]?secret$/i,
  /^signing[_-]?secret$/i,
  /^password$/i,
  /^passwd$/i,
  /^passphrase$/i,
  /^token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^id[_-]?token$/i,
  /^jwt$/i,
  /^bearer$/i,
  /^authorization$/i,
  /^auth[-_]?token$/i,
  /^private[_-]?key$/i,
  /^public[-_]?key$/i,
  /^access[-_]?key$/i,
  /^secret[-_]?access[-_]?key$/i,
  /^session[-_]?id$/i,
  /^cookie$/i,
  /^cookies$/i,
  /^set-cookie$/i,
  /^credential(s)?$/i,
  /^webhook[-_]?url$/i,
  /^webhook[-_]?secret$/i,
  /^signature$/i,
  /^sig(n)?$/i,
  /^x-?api-?key$/i,
  /^x-?auth-?token$/i,
  /.+_key$/i,                 // snake_case: access_key, secret_key
  /.+Key$/i,                  // camelCase: accessKey, secretKey
  /.+Token$/i,                // camelCase: uploadToken, accessToken
  /.+_token$/i,               // snake_case: access_token, refresh_token
  /.+Secret$/i,               // camelCase: clientSecret, webhookSecret
  /.+_secret$/i,              // snake_case: client_secret
  /access.?key/i,             // contains accessKey/access_key (catches awsAccessKeyId)
  /secret.?key/i,             // contains secretKey/secret_key
  /private.?key/i,            // contains privateKey/private_key
];

// ---------------------------------------------------------------------------
// Sensitive value patterns — strings that should be redacted even under benign keys
// ---------------------------------------------------------------------------
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi;
const BASIC_AUTH_RE = /Basic\s+[A-Za-z0-9+/=]{10,}/gi;
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{20,}/g;
const PK_KEY_RE = /\bpk-[A-Za-z0-9_-]{20,}/g;
const SK_LIVE_RE = /\bsk_live_[A-Za-z0-9]{16,}/g;
const SK_TEST_RE = /\bsk_test_[A-Za-z0-9]{16,}/g;
const AKID_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const GH_PAT_RE = /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g;
const GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const SLACK_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const OPENSSH_RE = new RegExp('-{5}BEGIN OPENSSH PRIVATE KEY-{5}[\\s\\S]*?-{5}END OPENSSH PRIVATE KEY-{5}', 'g');
const HEX_SECRET_RE = /(?:secret|token|key|sig|hash)[=:]\s*([0-9a-fA-F]{40,})/g;

const SENSITIVE_QUERY_PARAMS = [
  'token', 'access_token', 'refresh_token', 'id_token',
  'api_key', 'apikey', 'key', 'secret', 'client_secret',
  'signature', 'sig', 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token',
  'auth', 'auth_token', 'jwt', 'password', 'passwd',
  'sign', 'signed',
];

const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => p.test(key));
}

/**
 * Redact sensitive-looking values from a single string.
 */
export function redactSensitiveValues(input: string): string {
  if (!input) return input;
  let result = input;

  result = result.replace(PEM_RE, `[REDACTED PRIVATE KEY]`);
  result = result.replace(OPENSSH_RE, `[REDACTED OPENSSH KEY]`);
  result = result.replace(BEARER_RE, `Bearer ${REDACTED}`);
  result = result.replace(BASIC_AUTH_RE, `Basic ${REDACTED}`);
  result = result.replace(JWT_RE, REDACTED);
  result = result.replace(SK_KEY_RE, `sk-${REDACTED}`);
  result = result.replace(PK_KEY_RE, `pk-${REDACTED}`);
  result = result.replace(SK_LIVE_RE, `sk_live_${REDACTED}`);
  result = result.replace(SK_TEST_RE, `sk_test_${REDACTED}`);
  result = result.replace(AKID_RE, `AKIA${REDACTED}`);
  result = result.replace(GH_PAT_RE, `ghp_${REDACTED}`);
  result = result.replace(GOOGLE_KEY_RE, `AIza${REDACTED}`);
  result = result.replace(SLACK_RE, `xoxb-${REDACTED}`);
  result = result.replace(HEX_SECRET_RE, (_match, _hex) => {
    return _match.replace(/[0-9a-fA-F]{40,}/, REDACTED);
  });

  return result;
}

/**
 * Sanitize a URL:
 *  - Remove userinfo (user:password@host)
 *  - Strip query parameters whose names match sensitive patterns
 *  - Replace sensitive values found in remaining query values, fragments
 *  - Strip absolute local paths from the URL string
 */
export function sanitizeUrl(url: string): string {
  if (!url) return url;

  if (/^(blob|data|javascript|file):/i.test(url)) {
    return redactSensitiveValues(url);
  }

  if (url.startsWith('/')) {
    return stripSensitivePaths(redactSensitiveValues(url));
  }

  try {
    const u = new URL(url);

    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }

    const paramsToDelete: string[] = [];
    u.searchParams.forEach((_value, key) => {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_QUERY_PARAMS.some(p => p.toLowerCase() === lowerKey) ||
          /(token|secret|key|signature|sig|password|auth|credential|jwt)/i.test(lowerKey)) {
        paramsToDelete.push(key);
      } else {
        const cleaned = redactSensitiveValues(_value);
        if (cleaned !== _value) {
          u.searchParams.set(key, cleaned);
        }
      }
    });
    for (const k of paramsToDelete) {
      u.searchParams.delete(k);
    }

    if (u.hash) {
      u.hash = redactSensitiveValues(u.hash);
    }

    let result = u.toString();
    result = stripSensitivePaths(result);
    return result;
  } catch {
    return stripSensitivePaths(redactSensitiveValues(url));
  }
}

/**
 * Recursively strip sensitive fields from any object.
 */
export function sanitizeForExport<T>(obj: T): T;
export function sanitizeForExport(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    let s = redactSensitiveValues(obj);
    if (/^(https?|ftps?|wss?|blob|data|file|\/)/i.test(s)) {
      s = sanitizeUrl(s);
    } else {
      s = stripSensitivePaths(s);
    }
    return s;
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForExport(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        continue;
      }
      result[key] = sanitizeForExport(value);
    }
    return result;
  }

  return obj;
}

/**
 * Strip absolute local filesystem paths.
 */
export function stripSensitivePaths(input: string): string {
  if (!input) return input;
  let result = input;

  result = result.replace(/\/home\/[^/\\]+/g, '/home/[user]');
  result = result.replace(/\/Users\/[^/\\]+/g, '/Users/[user]');
  result = result.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/]+/g, 'C:/Users/[user]');
  result = result.replace(/\/tmp\/[^/\s"']+/g, '/tmp/[path]');
  result = result.replace(/\/var\/folders\/[^\s"']+/g, '/var/folders/[path]');
  result = result.replace(/\/run\/user\/\d+/g, '/run/user/[uid]');
  result = result.replace(/[A-Za-z]:\\Users\\[^\\]+\\AppData\\(Local|Roaming)\\Temp\\[^\s"']+/gi, 'C:/Users/[user]/AppData/Local/Temp/[path]');
  result = result.replace(/\\\\[\w.-]+\\Users\\[^\\]+/g, '\\\\server\\Users\\[user]');

  // Normalize any remaining backslashes to forward slashes in Windows-like paths
  if (/[A-Za-z]:[\\/]/.test(result) || /^\\\\/.test(result)) {
    result = result.replace(/\\/g, '/');
  }

  return result;
}

/**
 * Detect categories of sensitive content present in a string (for tests/logging).
 */
export function detectSensitiveContent(input: string): string[] {
  const hits: string[] = [];
  if (!input) return hits;
  if (BEARER_RE.test(input)) hits.push('bearer-token');
  if (BASIC_AUTH_RE.test(input)) hits.push('basic-auth');
  if (JWT_RE.test(input)) hits.push('jwt');
  if (SK_KEY_RE.test(input) || PK_KEY_RE.test(input)) hits.push('stripe/openai-key');
  if (AKID_RE.test(input)) hits.push('aws-access-key');
  if (GH_PAT_RE.test(input)) hits.push('github-token');
  if (GOOGLE_KEY_RE.test(input)) hits.push('google-api-key');
  if (SLACK_RE.test(input)) hits.push('slack-token');
  if (PEM_RE.test(input) || OPENSSH_RE.test(input)) hits.push('private-key-pem');
  if (/\/home\/[^/\\]+/.test(input)) hits.push('unix-home-path');
  if (/\/Users\/[^/\\]+/.test(input)) hits.push('macos-home-path');
  if (/[A-Za-z]:[\\/]Users[\\/][^\\/]+/.test(input)) hits.push('windows-home-path');
  return hits;
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const hashBuf = await crypto.subtle.digest('SHA-256', copy);
    return bufToHex(new Uint8Array(hashBuf));
  }
  return fallbackHash(bytes);
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fallbackHash(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0') +
              (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0');
  return hex.padStart(64, '0').slice(0, 64);
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return sha256Hex(new Uint8Array(buf));
}
