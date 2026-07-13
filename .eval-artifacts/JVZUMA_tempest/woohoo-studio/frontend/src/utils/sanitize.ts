// Sanitization utilities — strip sensitive data before writing to export bundles.
// Prevents API keys, JWTs, passwords, local absolute paths, full secrets from leaking.
//
// Coverage:
//   1. Key-based redaction: any object key whose name matches a sensitive pattern
//      (case-insensitive, matches substrings after separators like _, -, .) is redacted.
//   2. Value-based redaction (applied to every string, even nested inside arrays):
//      - JWTs (three base64url segments) — including "Bearer <jwt>" form
//      - PEM-encoded private keys (-----BEGIN ... PRIVATE KEY----- blocks)
//      - AWS access key IDs (AKIA + 16 alphanumerics)
//      - OpenAI/Anthropic-style API keys (sk-, sk-ant-, sk-proj- prefixes)
//      - GitHub personal access tokens (ghp_, gho_, ghu_, ghs_, ghr_ prefixes)
//      - Slack-style tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
//      - Google API keys (AIza... 39 chars)
//      - Generic bearer/basic authorization header strings
//      - Local absolute filesystem paths (Linux/macOS/Windows/UNC) embedded anywhere in the string
//   3. Project snapshot specific: strips user_id/userId, redacts file:// asset URLs without leaking them.
//
// Design: we redact defensively. False positives on strings that "look like" keys are acceptable
// (a few redacted characters in a free-text script are a minor UX cost vs leaking a credential).

// ---------------------------------------------------------------------------
// Key patterns — any object key whose NAME matches these patterns is fully redacted,
// regardless of value type. Matched case-insensitively against the lowercased key.
// ---------------------------------------------------------------------------
const SENSITIVE_KEY_PATTERNS: Array<RegExp> = [
  /api[_\-]?key/i,              // apiKey, api_key, api-key, x-api-key
  /secret/i,                    // secret, client_secret, appSecret, aws_secret_access_key
  /password/i,                  // password, dbPassword, admin_password
  /passwd/i,                    // passwd
  /\btoken\b/i,                 // token, access_token, refresh_token, id_token
  /\bjwt\b/i,                   // jwt
  /bearer/i,                    // bearer
  /authorization/i,             // authorization, Authorization header
  /access[_\-]?token/i,         // accessToken, access_token
  /refresh[_\-]?token/i,        // refreshToken, refresh_token
  /private[_\-]?key/i,          // privateKey, private_key
  /credential/i,                // credentials, credential
  /auth[_\-]?token/i,           // authToken, auth_token
  /client[_\-]?secret/i,        // client_secret, clientSecret
  /session[_\-]?key/i,          // sessionKey, session_key
  /signing[_\-]?key/i,          // signingKey
  /master[_\-]?key/i,           // masterKey
  /encryption[_\-]?key/i,       // encryptionKey
  /database[_\-]?url/i,         // databaseUrl, DATABASE_URL (may contain credentials)
  /db[_\-]?pass/i,              // dbPass, db_pass
  /^pass(word)?$/i,             // bare "pass" / "password"
];

// Key patterns where the value is a NUMBER or BOOLEAN that is nonetheless sensitive
// (e.g. a user id, tenant id stored under such a name). We don't use these today but kept for future.

// ---------------------------------------------------------------------------
// Value patterns — applied to EVERY string value, regardless of key.
// Order matters: more specific patterns first.
// ---------------------------------------------------------------------------

// JWT: header.payload.signature where header starts with eyJ (base64 of "{").
// Use word boundaries to avoid matching unrelated dotted strings.
// Minimum segment length 3 to catch short test fixtures while avoiding false positives.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}/g;

// PEM private key block
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// AWS Access Key ID: AKIA followed by exactly 16 uppercase alphanumerics
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;

// OpenAI / common LLM provider keys: sk-..., sk-ant-..., sk-proj-..., sk-liv-..., sk-or-...
// Allow base64-ish chars plus dots (used by some providers). Require at least 8 trailing chars.
const OPENAI_KEY = /\bsk-[A-Za-z0-9_.\-]{8,}\b/g;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_.\-]{8,}\b/g;

// GitHub personal access tokens (classic & fine-grained)
const GITHUB_TOKEN = /\bghp_[A-Za-z0-9]{36,}\b/g;
const GITHUB_NEW_TOKEN = /\bgh[opusr]_[A-Za-z0-9]{36,}\b/g;

// Slack tokens
const SLACK_TOKEN = /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/g;

// Google API key (AIzaSy... 39 chars)
const GOOGLE_API_KEY = /\bAIza[A-Za-z0-9_-]{35}\b/g;

// Generic "Basic <base64>" Authorization
const BASIC_AUTH = /\bBasic\s+[A-Za-z0-9+/=]{6,}\b/gi;

// Generic "Bearer <token>" — match the token part (any non-space run after Bearer)
const BEARER_AUTH = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/g;

// Token-like strings with explicit key=value or "key: value" form where we can't know the prefix.
// We intentionally DO NOT try to catch all high-entropy strings (too many false positives);
// we rely on key-based redaction for those and only match known token formats above.

// ---------------------------------------------------------------------------
// Local absolute path pattern (Linux/macOS/Windows/UNC).
// Matches:
//   /home/..., /Users/..., /root/..., /var/..., /tmp/..., /opt/..., /etc/...,
//   /data/..., /mnt/..., /srv/..., /proc/..., /usr/...
//   C:\..., D:\..., etc.
//   \\server\share\... (UNC)
// Appears anywhere in the string (e.g. "file:///home/u/x.png", "config=/etc/app.conf").
// Character class: any non-whitespace, non-quote, non-angle-bracket, non-pipe char.
// We deliberately include `.` inside paths (needed for .ssh, .env, .git, file.txt, etc.).
// Trailing punctuation (.,;:) is trimmed after matching.
// ---------------------------------------------------------------------------
const NOT_PATH_END = "[^\\s'\"<>|]*";
// Trailing punctuation to strip from a matched path (e.g. "/tmp/run.log." -> "/tmp/run.log")
const TRAILING_PUNCT = /[.,;:)]+$/;
const LOCAL_PATH_PATTERN = new RegExp(
  '(' +
    // file:// URL form (2 or 3 leading slashes, then a path)
    'file:\\/\\/+(?:' + NOT_PATH_END + ')?' +
    '|' +
    // Unix absolute paths starting with common sensitive directories.
    // Match both the bare directory (e.g. "/root") and paths with a subcomponent (e.g. "/root/.bashrc").
    '(?<![A-Za-z0-9_./-])\\/(?:home|Users|root|var|tmp|opt|etc|data|mnt|srv|proc|usr)(?:\\/' + NOT_PATH_END + ')?' +
    '|' +
    // Windows drive letter paths like C:\foo\bar or just C:\
    '(?<![A-Za-z])[A-Za-z]:\\\\(?:' + NOT_PATH_END.replace(/\\\\/g, '\\\\\\\\') + ')?' +
    '|' +
    // Windows UNC paths like \\server\share\...
    '\\\\\\\\[A-Za-z0-9._$-]+\\\\' + NOT_PATH_END.replace(/\\\\/g, '\\\\\\\\') +
  ')',
  'g',
);

// Placeholder constants
const REDACTED = '[REDACTED]';
const REDACTED_JWT = '[REDACTED_JWT]';
const REDACTED_KEY = '[REDACTED_KEY]';
const REDACTED_PEM = '[REDACTED_PRIVATE_KEY]';
const REDACTED_PATH = '[LOCAL_PATH_REDACTED]';

export interface SanitizeOptions {
  /** If true, replace absolute paths with a "./<filename>" placeholder instead of a fixed string. */
  preserveFilename?: boolean;
}

const DEFAULT_OPTIONS: SanitizeOptions = { preserveFilename: true };

/**
 * Recursively walk an object and redact sensitive values.
 *
 * 1. Any key matching SENSITIVE_KEY_PATTERNS is replaced with "[REDACTED]" (no matter the value type).
 * 2. All string values are scanned for embedded secrets (JWTs, PEM blocks, known key prefixes, auth headers, local paths).
 * 3. Arrays and nested objects are traversed.
 */
export function sanitizeForExport<T>(input: T, options: SanitizeOptions = DEFAULT_OPTIONS): T {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return sanitizeString(input, opts) as unknown as T;
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) return input.map((v) => sanitizeForExport(v, opts)) as unknown as T;
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERNS.some((re) => re.test(key))) {
        out[key] = REDACTED;
      } else {
        out[key] = sanitizeForExport(value, opts);
      }
    }
    return out as T;
  }
  return input;
}

/**
 * Sanitize a single string: redact embedded secrets & absolute paths.
 */
export function sanitizeString(s: string, options: SanitizeOptions = DEFAULT_OPTIONS): string {
  if (typeof s !== 'string') return s;
  let out = s;

  // PEM private key blocks (most specific — multi-line)
  out = out.replace(PEM_PRIVATE_KEY, REDACTED_PEM);

  // JWT (standalone or mid-string). Do this BEFORE bearer so "Bearer eyJ..." -> bearer catches the prefix too.
  // But we need to be careful: JWT already covers the token in "Bearer eyJ..."; handle bearer separately to
  // also catch non-JWT bearer tokens.
  out = out.replace(JWT_PATTERN, REDACTED_JWT);

  // AWS access keys
  out = out.replace(AWS_ACCESS_KEY, REDACTED_KEY);

  // LLM / cloud provider keys
  out = out.replace(ANTHROPIC_KEY, REDACTED_KEY);
  out = out.replace(OPENAI_KEY, REDACTED_KEY);

  // GitHub tokens
  out = out.replace(GITHUB_NEW_TOKEN, REDACTED_KEY);
  out = out.replace(GITHUB_TOKEN, REDACTED_KEY);

  // Slack
  out = out.replace(SLACK_TOKEN, REDACTED_KEY);

  // Google API keys
  out = out.replace(GOOGLE_API_KEY, REDACTED_KEY);

  // Basic auth header
  out = out.replace(BASIC_AUTH, `Basic ${REDACTED}`);

  // Bearer <token> (catches non-JWT bearer tokens after we already replaced JWTs with placeholders)
  out = out.replace(BEARER_AUTH, (_match, prefix: string) => `${prefix}${REDACTED_KEY}`);

  // Absolute local paths (do this last so replacements don't get re-scanned)
  out = out.replace(LOCAL_PATH_PATTERN, (rawMatch) => {
    // Strip trailing sentence punctuation that the greedy match may have captured
    const match = rawMatch.replace(TRAILING_PUNCT, '');
    if (!options.preserveFilename) return REDACTED_PATH;
    // Extract filename after last / or \.
    const parts = match.split(/[\\/]/).filter((p) => p.length > 0);
    // If the match ends with a slash or contains only a prefix (file:, drive letter), redact entirely.
    const lastPart = parts[parts.length - 1];
    // If the "filename" is actually just a sensitive directory name with nothing after it,
    // treat as a bare root dir (no file to preserve) and redact fully.
    const SENSITIVE_DIRS = new Set(['home', 'Users', 'root', 'var', 'tmp', 'opt', 'etc', 'data', 'mnt', 'srv', 'proc', 'usr']);
    if (!lastPart || SENSITIVE_DIRS.has(lastPart) || /^[A-Za-z]:$/.test(lastPart)) return REDACTED_PATH;
    // Fully redact if the filename itself is a known sensitive file (even when preserving filenames).
    const SENSITIVE_FILES = new Set([
      'shadow', 'passwd', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub',
      '.env', '.env.local', '.env.production', '.env.development',
      'credentials', 'config.json', 'keystore', 'keystore.jks', '.npmrc', '.netrc',
      '.ssh', 'known_hosts', 'authorized_keys',
      'aws_access_key', 'aws_secret', 'private_key.pem', 'private.pem',
    ]);
    const lower = lastPart.toLowerCase();
    if (SENSITIVE_FILES.has(lower) || lower.endsWith('.pem') || lower.endsWith('.p12') || lower.endsWith('.key')) {
      return REDACTED_PATH;
    }
    return `./${lastPart}`;
  });

  return out;
}

/**
 * Sanitize a project/workspace snapshot specifically.
 * - Removes userId / user_id (privacy).
 * - Rewrites file:/// and absolute-path asset URLs to "./" without leaking the original path.
 * - Runs full sanitizeForExport on the result.
 */
export function sanitizeSnapshot(snapshot: Record<string, unknown>, options: SanitizeOptions = DEFAULT_OPTIONS): Record<string, unknown> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Process asset URLs: rewrite any local/file:// URLs to placeholders.
  // IMPORTANT: do NOT copy the original URL into `source` — that would leak it.
  if (snapshot && typeof snapshot === 'object') {
    const obj = snapshot as Record<string, unknown>;
    if (Array.isArray(obj.assets)) {
      obj.assets = obj.assets.map((a: Record<string, unknown>) => {
        if (a && typeof a === 'object') {
          const copy: Record<string, unknown> = { ...a };
          if (typeof copy.url === 'string') {
            const url = copy.url;
            if (
              url.startsWith('file://') ||
              /^\/(?:home|Users|root|var|tmp|opt|etc|data|mnt|srv|proc|usr)\//.test(url) ||
              /^[A-Za-z]:\\/.test(url)
            ) {
              // Replace URL with a relative placeholder. Preserve filename for traceability.
              const parts = url.split(/[\\/]/);
              const filename = parts[parts.length - 1] || '';
              copy.url = filename ? `./assets/${filename}` : './assets/';
              // If the caller previously stashed the original URL in `source`, wipe that too.
              if (typeof copy.source === 'string' && copy.source !== copy.url) {
                copy.source = REDACTED_PATH;
              }
            }
          }
          return copy;
        }
        return a;
      });
    }
  }

  const out = sanitizeForExport(snapshot, opts);

  // Explicitly strip known sensitive top-level fields (privacy / PII)
  if (out && typeof out === 'object') {
    const obj = out as Record<string, unknown>;
    delete obj.userId;
    delete obj.user_id;
    delete obj.ownerId;
    delete obj.owner_id;
    delete obj.creatorId;
    delete obj.creator_id;
  }
  return out;
}

/**
 * Returns true if the given string appears to contain any redactable secret.
 * Useful for tests and UI warnings.
 */
export function containsSecret(s: string): boolean {
  if (typeof s !== 'string') return false;
  const sanitized = sanitizeString(s);
  return sanitized !== s;
}
