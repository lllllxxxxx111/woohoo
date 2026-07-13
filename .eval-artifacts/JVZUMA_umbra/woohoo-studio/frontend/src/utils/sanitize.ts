// Sensitive-data redaction for export payloads.
// Recursively clones input and removes/redacts:
//   - values for known-sensitive keys (password, token, apiKey, jwt, cookie, etc.)
//   - inline secret patterns found inside string values (Bearer tokens, JWTs,
//     sk-/ghp-/xoxb-style API keys, PEM private keys, ?token= query params, etc.)
//   - absolute local paths that reveal the operator's home directory
//     (/home/, /Users/, /root/, C:\Users\)
// The original object is NEVER mutated.

/** Keys whose values should be replaced with <redacted> when found in an exported object. */
export const SENSITIVE_KEYS: readonly string[] = [
  // Auth / identity
  'password', 'passwd', 'pwd',
  'token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'idtoken', 'id_token', 'authtoken', 'auth_token',
  'sessionid', 'session_id',
  'jwt', 'authorization', 'cookie', 'cookies', 'set-cookie',
  // Secrets / keys
  'secret', 'secretkey', 'secret_key',
  'clientsecret', 'client_secret',
  'apikey', 'api_key', 'x-api-key', 'apisecret', 'api_secret',
  'privatekey', 'private_key', 'publickey', 'public_key',
  'sshkey', 'ssh_key',
  'personalaccesstoken', 'personal_access_token', 'pat',
  'credentials', 'connectionstring', 'connection_string',
  'dbpassword', 'db_password', 'databaseurl', 'database_url',
];

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/** Redaction marker. */
const REDACTED = '<redacted>';

// ---- String-level redactors ----

/**
 * Absolute home-directory path prefixes (user part replaced with <redacted>).
 *   /home/<user>/...      (Linux)
 *   /Users/<user>/...     (macOS)
 *   /root                 (Linux root)
 *   C:\Users\<user>\...   (Windows, both slashes)
 */
const HOME_PATH_PATTERNS: RegExp[] = [
  /\/home\/[^/\s"'<>|]+(?=\/|$)/g,
  /\/Users\/[^/\s"'<>|]+(?=\/|$)/g,
  /\/root(?=\/|$)/g,
  /[A-Za-z]:\\Users\\[^\\\/\s"'<>|]+/g,
];

/** Authorization header scheme + credential. */
const BEARER_RE = /\b(Bearer|Basic|Digest|Token|JWT)\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** JWT: header starts with "eyJ" (base64url of '{'), then two more dotted segments. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/**
 * Known opaque API-key prefixes (OpenAI sk-, GitHub ghp_/gho_/ghu_/ghr_/ghs_,
 * Slack xoxb-/xoxp-/xoxa-/xoxr-, Stripe sk_live_/sk_test_/rk_live_/pk_,
 * Google AIza..., AWS AKIA...). The prefix itself is kept up to the first
 * delimiter; the secret body is redacted so reviewers can still see WHICH
 * provider key was present without leaking it.
 */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /\b(sk|sk-live|sk-test|rk|pk|rk-live|pk-live|pk-test)[\-_][A-Za-z0-9_\-]{16,}/g,
  /\b(ghp|gho|ghu|ghr|ghs)_[A-Za-z0-9]{20,}/g,
  /\bxox[bpars]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9\-_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** PEM private key block (PKCS#1 / PKCS#8 / EC / OPENSSH). */
const PEM_PRIVATE_KEY_RE =
  /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----/g;

/**
 * URL query string secrets: ?token=... &api_key=... &password=... etc.
 * We redact the value while keeping the key so humans can debug URL shape.
 */
const SECRET_QUERY_PARAMS = [
  'token', 'access_token', 'refresh_token', 'id_token',
  'api_key', 'apikey', 'api_secret',
  'secret', 'password', 'pwd', 'passwd',
  'jwt', 'authorization', 'auth',
  'key', 'sig', 'signature',
  'session', 'session_id',
];
const SECRET_QUERY_RE = new RegExp(
  `([?&])(?:${SECRET_QUERY_PARAMS.join('|')})=([^&\\s"'<>]+)`,
  'gi',
);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(key.toLowerCase());
}

function redactString(value: string): string {
  if (!value) return value;
  let out = value;
  // 1. PEM private key blocks (greediest — replace first).
  out = out.replace(PEM_PRIVATE_KEY_RE, '[REDACTED PRIVATE KEY]');
  // 2. JWTs.
  out = out.replace(JWT_RE, REDACTED);
  // 3. Opaque API keys with known prefixes.
  for (const re of SECRET_KEY_PATTERNS) {
    out = out.replace(re, (m) => {
      // Keep the recognizable prefix (up to first separator) for auditability.
      const sepDash = m.indexOf('-');
      const sepUnd = m.indexOf('_');
      const sep = sepDash > 0 && (sepUnd < 0 || sepDash < sepUnd) ? sepDash
        : sepUnd > 0 ? sepUnd : -1;
      const prefix = sep > 0 ? m.slice(0, sep + 1) : '';
      return `${prefix}${REDACTED}`;
    });
  }
  // 4. Authorization headers.
  out = out.replace(BEARER_RE, `$1 ${REDACTED}`);
  // 5. URL query string secrets.
  out = out.replace(SECRET_QUERY_RE, (_m, prefix: string, _val: string) => {
    // _m is like "?token=SECRET" — extract the key name (between prefix and '=').
    const eqIdx = _m.indexOf('=');
    const key = eqIdx > -1 ? _m.slice(prefix.length, eqIdx) : '';
    return `${prefix}${key}=${REDACTED}`;
  });
  // 6. Home directory paths.
  for (const re of HOME_PATH_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

function deepSanitize(value: unknown, depth = 0): unknown {
  // Avoid runaway recursion on pathological objects.
  if (depth > 64) return REDACTED;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'symbol' || typeof value === 'function') return undefined;

  if (Array.isArray(value)) {
    return value.map((item) => deepSanitize(item, depth + 1));
  }

  if (value instanceof Blob || value instanceof File) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = deepSanitize(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * Sanitize a single string (README text, log lines, free-form metadata, etc.).
 */
export function sanitizeStringForExport(s: string): string {
  return redactString(s);
}

/**
 * Return a deep clone of `obj` with sensitive values redacted.
 *
 * - Values for any key listed in SENSITIVE_KEYS are replaced with `<redacted>`.
 * - String values are scanned for inline secrets (PEM private keys, JWTs,
 *   sk-/ghp-/xoxb-/AIza/AKIA-style API keys, `Bearer <token>`, ?token= query
 *   params) and those substrings are replaced.
 * - Absolute home-directory paths (/home/<user>, /Users/<user>, /root,
 *   C:\Users\<user>) are replaced.
 *
 * The original object is NOT mutated. Functions/symbols are dropped (they
 * cannot be serialized to JSON). Binary Blobs/Files pass through untouched.
 */
export function sanitizeForExport<T>(obj: T): T {
  return deepSanitize(obj) as T;
}
