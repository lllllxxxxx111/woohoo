// Sensitive data redaction for export packages.
//
// Goal: Ensure export bundles and manifest.json / workspace_snapshot.json never
// contain API keys, JWTs, passwords, full secret keys, or local absolute paths
// that could leak usernames or directory layout.
//
// Strategy:
//   1. Key-based: recursively walk objects; any key whose name looks sensitive
//      has its value replaced with [REDACTED].
//   2. Value-pattern-based: scan every string value (regardless of key name) for
//      known secret shapes (JWT, sk-..., AKIA..., PEM headers, connection URIs
//      with embedded password, Basic/Bearer auth headers, emails, local paths).
//   3. Post-serialization guard: a JSON-string scrubber catches anything that
//      slipped through (useful when data flows through third-party serializers).

export const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Key-name detection
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /^api[_-]?key$/i,
  /^secret$/i,
  /^secret[_-]?key$/i,
  /^secret[_-]?token$/i,
  /^password$/i,
  /^passwd$/i,
  /^pwd$/i,
  /^token$/i,
  /^auth$/i,
  /^auth[nr]?[_-]?token$/i,
  /^authorization$/i,
  /^credential(s)?$/i,
  /^jwt$/i,
  /^bearer$/i,
  /^access[_-]?key$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^session[_-]?secret$/i,
  /^session[_-]?token$/i,
  /^encryption[_-]?key$/i,
  /^private[_-]?key$/i,
  /^public[_-]?key$/i,
  /^signing[_-]?key$/i,
  /^client[_-]?secret$/i,
  /^database[_-]?url$/i,
  /^db[_-]?(password|pass|pwd|uri|url)$/i,
  /^connection[_-]?string$/i,
  /^cookie$/i,
  /^set[_-]?cookie$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  // camelCase / composite keys: secretToken, accessToken, apiToken, authToken, etc.
  /(?:secret|access|refresh|auth|api|client|session|encryption|signing|private|public)[_-]?(?:key|token|secret)$/i,
  // Fallback: any key containing these sensitive words
  /\b(api[_-]?key|secret|password|passwd|token|jwt|credential|bearer|private[_\-]?key)\b/i,
];

export function isSensitiveKey(key: string): boolean {
  if (!key) return false;
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

// ---------------------------------------------------------------------------
// Value-pattern detection (operates on strings regardless of key name)
// ---------------------------------------------------------------------------

// JWT: three base64url segments separated by dots. eyJ is the base64url of `{"`
// which is the typical JWT header start.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// Common API-key prefixes. Each pattern should match the full plausible token.
const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,            // OpenAI / generic sk-...
  /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/g,  // Stripe
  /\bgh[pousr]_[A-Za-z0-9_-]{20,}\b/g,     // GitHub (PAT, OAuth, user, server, refresh)
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,     // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                 // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g,                 // AWS temp access key
  /\bAIza[0-9A-Za-z_-]{30,50}\b/g,         // Google API key (typically AIzaSy... = 39 chars)
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,        // Anthropic
];

// PEM / key headers (multi-line)
const PEM_RE =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?(?:PRIVATE|PUBLIC) KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?(?:PRIVATE|PUBLIC) KEY-----/g;

// Authorization: <Scheme> <credentials>
const AUTH_HEADER_RE = /\b(Authorization|Proxy-Authorization):\s*(Basic|Bearer|Digest|HOBA|Mutual|Negotiate|OAuth|SCRAM-SHA-1|SCRAM-SHA-256|vapid)\s+([^\s\r\n]+)/gi;

// Standalone Bearer <token> even without header name (common in logs)
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g;

// Basic <base64>
const BASIC_CREDS_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}\b/g;

// scheme://user:password@host  (userinfo with colon-password)
const USERINFO_URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^:/\s@"'`<>]+):([^@\s"'`<>]+)@/gi;

// Connection strings: scheme://...?...password=... or key=value format
const CONN_STR_PASSWORD_RE = /([?&](?:password|passwd|pwd|pass|auth)=)([^\s&"'<>]+)/gi;

// Email addresses (PII). Conservative to avoid hitting template placeholders.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Local absolute filesystem paths.
// Unix: /home/<u>/..., /Users/<u>/..., /root/..., /var/..., /etc/..., /opt/..., /tmp/..., /private/...
// Prefix character class: allow start-of-string or whitespace/quotes/parens/brackets/equals/colons
// so that `path=/home/...`, `file="/home/..."`,  '(at /home/...)' all match.
const UNIX_PATH_RE =
  /(^|[\s("'`=:])(\/(?:home|Users|root|private|var|etc|opt|usr|tmp|mnt|media|srv|System|Volumes|Applications)\/[^\s"'`)\]]+)/g;

// Windows: C:\Users\..., C:\Windows\..., etc.
const WIN_PATH_RE =
  /(^|[\s("'`=:])([A-Za-z]:\\(?:Users|Documents and Settings|Program Files|Program Files \(x86\)|ProgramData|Windows|AppData|Temp|Documents)\\[^\s"'`)\]]+)/g;

// Tilde paths: ~/...
const TILDE_PATH_RE = /(^|[\s("'`=:])(~\/[^\s"'`)\]]+)/g;

// ---------------------------------------------------------------------------
// String redaction
// ---------------------------------------------------------------------------

export interface RedactionStats {
  /** Number of distinct hits (counted per pattern invocation, not per match). */
  hits: number;
  /** Pattern categories that triggered redaction. */
  triggers: Set<string>;
}

function createStats(): RedactionStats {
  return { hits: 0, triggers: new Set<string>() };
}

function hit(stats: RedactionStats, name: string) {
  stats.hits += 1;
  stats.triggers.add(name);
}

/** Redact a single string. Pure function; does not mutate input. */
export function redactString(text: string, stats?: RedactionStats): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  const s = stats ?? createStats();
  let out = text;

  // PEM blocks first (multi-line)
  if (PEM_RE.test(out)) {
    out = out.replace(PEM_RE, REDACTED);
    hit(s, 'pem-key');
  }
  PEM_RE.lastIndex = 0;

  // JWTs
  if (JWT_RE.test(out)) {
    out = out.replace(JWT_RE, REDACTED);
    hit(s, 'jwt');
  }
  JWT_RE.lastIndex = 0;

  // Authorization header
  if (AUTH_HEADER_RE.test(out)) {
    out = out.replace(AUTH_HEADER_RE, `$1: $2 ${REDACTED}`);
    hit(s, 'auth-header');
  }
  AUTH_HEADER_RE.lastIndex = 0;

  // Standalone Bearer <token>
  if (BEARER_TOKEN_RE.test(out)) {
    out = out.replace(BEARER_TOKEN_RE, `Bearer ${REDACTED}`);
    hit(s, 'bearer-token');
  }
  BEARER_TOKEN_RE.lastIndex = 0;

  // Basic <base64>
  if (BASIC_CREDS_RE.test(out)) {
    out = out.replace(BASIC_CREDS_RE, `Basic ${REDACTED}`);
    hit(s, 'basic-auth');
  }
  BASIC_CREDS_RE.lastIndex = 0;

  // scheme://user:pass@host
  if (USERINFO_URL_RE.test(out)) {
    out = out.replace(USERINFO_URL_RE, `$1//${REDACTED}:${REDACTED}@`);
    hit(s, 'url-userinfo');
  }
  USERINFO_URL_RE.lastIndex = 0;

  // Connection-string password= parameters
  if (CONN_STR_PASSWORD_RE.test(out)) {
    out = out.replace(CONN_STR_PASSWORD_RE, `$1${REDACTED}`);
    hit(s, 'conn-string');
  }
  CONN_STR_PASSWORD_RE.lastIndex = 0;

  // API key prefix patterns
  for (const re of API_KEY_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
      hit(s, 'api-key-pattern');
    }
    re.lastIndex = 0;
  }

  // Emails (PII)
  if (EMAIL_RE.test(out)) {
    out = out.replace(EMAIL_RE, REDACTED);
    hit(s, 'email');
  }
  EMAIL_RE.lastIndex = 0;

  // Unix absolute paths (skip if inside a URL)
  if (UNIX_PATH_RE.test(out)) {
    out = out.replace(UNIX_PATH_RE, (match, prefix, path) => {
      const idx = out.indexOf(match);
      const before = out.substring(Math.max(0, idx - 8), idx);
      if (/https?:$/.test(before) || /file:$/.test(before)) return match;
      return `${prefix}${REDACTED}`;
    });
    hit(s, 'unix-path');
  }
  UNIX_PATH_RE.lastIndex = 0;

  // Windows absolute paths
  if (WIN_PATH_RE.test(out)) {
    out = out.replace(WIN_PATH_RE, (_m, prefix, _path) => `${prefix}${REDACTED}`);
    hit(s, 'windows-path');
  }
  WIN_PATH_RE.lastIndex = 0;

  // Tilde paths
  if (TILDE_PATH_RE.test(out)) {
    out = out.replace(TILDE_PATH_RE, (_m, prefix, _path) => `${prefix}${REDACTED}`);
    hit(s, 'tilde-path');
  }
  TILDE_PATH_RE.lastIndex = 0;

  return out;
}

/**
 * Backwards-compatible alias (matches old export name). Historically this
 * only scrubbed paths, but for defense-in-depth it now runs the full redactor.
 */
export function redactPathsInString(text: string): string {
  return redactString(text);
}

// ---------------------------------------------------------------------------
// Object/value redaction
// ---------------------------------------------------------------------------

export interface DeepRedactionResult<T> {
  value: T;
  stats: RedactionStats;
}

/**
 * Recursively redact an object/array. Keys matching sensitive patterns have
 * their values replaced wholesale; every string value is scanned for secret
 * patterns; local paths are scrubbed.
 */
export function redactSensitiveFieldsWithStats<T>(obj: T): DeepRedactionResult<T> {
  const stats = createStats();

  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined) return node;

    if (typeof node === 'string') {
      return redactString(node, stats);
    }

    if (typeof node !== 'object') return node;

    if (node instanceof Date) {
      // Dates are safe, don't traverse their internal slots.
      return node;
    }

    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
        hit(stats, `key:${key}`);
      } else if (typeof value === 'string') {
        result[key] = redactString(value, stats);
      } else {
        result[key] = walk(value);
      }
    }
    return result;
  };

  const value = walk(obj) as T;
  return { value, stats };
}

export function redactSensitiveFields<T>(obj: T): T {
  return redactSensitiveFieldsWithStats(obj).value;
}

/** Backwards-compatible alias. */
export function redactObject(obj: unknown): unknown {
  return redactSensitiveFields(obj);
}

// ---------------------------------------------------------------------------
// Post-serialization guard
// ---------------------------------------------------------------------------

/**
 * Scrub an already-serialized JSON string (or any text blob) for secrets that
 * might have leaked through e.g. a third-party serializer, a toString() call,
 * or a Buffer dump. Use this as a final pass before writing to disk.
 */
export function redactJsonString(jsonText: string): string {
  return redactString(jsonText);
}

// ---------------------------------------------------------------------------
// Pipeline parameter summary (safe for README_EXPORT / validation_report)
// ---------------------------------------------------------------------------

export function summarizePipelineParams(
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!params) return {};
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (isSensitiveKey(key)) {
      summary[key] = REDACTED;
      continue;
    }
    if (typeof value === 'string') {
      const cleaned = redactString(value);
      summary[key] =
        cleaned.length > 200 ? `${cleaned.substring(0, 200)}... (truncated)` : cleaned;
    } else if (typeof value === 'object' && value !== null) {
      summary[key] = `[object ${Array.isArray(value) ? 'Array' : 'Object'}]`;
    } else {
      summary[key] = String(value);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Convenience: sanitize any value for export and return JSON that is guaranteed
// free of known secret patterns, plus a small audit record.
// ---------------------------------------------------------------------------

export interface SanitizeForExportResult {
  json: string;
  redactionStats: { hits: number; triggers: string[] };
}

export function sanitizeForExport(obj: unknown, indent = 2): SanitizeForExportResult {
  const { value, stats } = redactSensitiveFieldsWithStats(obj);
  let json = JSON.stringify(value, null, indent) ?? '';
  // Final pass over the serialized form catches anything that escaped via
  // toString(), Buffer, or custom toJSON().
  json = redactJsonString(json);
  return {
    json,
    redactionStats: {
      hits: stats.hits,
      triggers: Array.from(stats.triggers).sort(),
    },
  };
}
