/**
 * Sensitive Information Redaction
 *
 * Strips API keys, JWTs, passwords, private keys, PII, local absolute paths,
 * and other secrets from any text before it enters an export package.
 *
 * Order of operations matters: longer/more specific patterns run first to
 * avoid partial matches (e.g., a Bearer JWT should be caught before the
 * generic JWT pattern; private key blocks before generic secret strings).
 */

export type RedactionCategory =
  | 'api_key'
  | 'jwt'
  | 'password'
  | 'private_key'
  | 'auth_header'
  | 'email'
  | 'phone_cn'
  | 'id_card_cn'
  | 'credit_card'
  | 'local_path'
  | 'aws_key'
  | 'openai_key'
  | 'generic_secret';

export interface RedactionMatch {
  category: RedactionCategory;
  start: number;
  end: number;
  placeholder: string;
}

export interface RedactionResult {
  redactedText: string;
  totalRedactions: number;
  byCategory: Record<RedactionCategory, number>;
  matches: RedactionMatch[];
}

export const REDACTION_PLACEHOLDER = '[REDACTED]';

interface PatternRule {
  category: RedactionCategory;
  regex: RegExp;
  placeholder?: string;
}

// Order matters — more specific patterns first
const RULES: PatternRule[] = [
  // ── Private key blocks (multi-line) ──────────────────────────
  {
    category: 'private_key',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    category: 'private_key',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PUBLIC KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PUBLIC KEY-----/g,
  },

  // ── AWS keys ────────────────────────────────────────────────
  {
    category: 'aws_key',
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  {
    category: 'aws_key',
    regex: /aws_secret_access_key["':=\s]+[A-Za-z0-9/+=]{40}/gi,
  },

  // ── OpenAI / common LLM API keys ─────────────────────────────
  {
    category: 'openai_key',
    regex: /sk-(?:proj-|ant-|svc-|)[A-Za-z0-9_-]{20,}/g,
  },
  {
    category: 'api_key',
    regex: /(?:api[_-]?key|apikey)["':=\s]+[A-Za-z0-9_\-.]{20,}/gi,
  },

  // ── Authorization: Bearer <token> ───────────────────────────
  {
    category: 'auth_header',
    regex: /(?:Authorization|Bearer)\s+[A-Za-z0-9_\-.]+=*\.[A-Za-z0-9_\-.]+=*\.[A-Za-z0-9_\-.]+=*/gi,
    placeholder: `Authorization: Bearer ${REDACTION_PLACEHOLDER}`,
  },

  // ── JWT (three base64 segments separated by dots) ───────────
  {
    category: 'jwt',
    regex: /eyJ[A-Za-z0-9_\-]+=*\.[A-Za-z0-9_\-]+=*\.[A-Za-z0-9_\-]+=*/g,
  },

  // ── Password / secret assignments ──────────────────────────
  {
    category: 'password',
    regex: /(?:password|passwd|pwd|secret|token|credential)["':=\s]+["']?[^"'\s,;})\]]{8,}["']?/gi,
  },

  // ── Generic secret=value (cover common env var patterns) ────
  {
    category: 'generic_secret',
    regex: /(?:DATABASE_URL|DB_PASSWORD|REDIS_URL|SMTP_PASSWORD|SECRET_KEY|JWT_SECRET|WEBHOOK_SECRET)["':=\s]+\S+/gi,
  },

  // ── Credit card numbers (basic Luhn-agnostic catch) ────────
  {
    category: 'credit_card',
    regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
  },

  // ── China ID card (18 digits, last may be X) ───────────────
  {
    category: 'id_card_cn',
    regex: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  },

  // ── China mobile phone (11 digits starting 1[3-9]) ────────
  {
    category: 'phone_cn',
    regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },

  // ── Email addresses ────────────────────────────────────────
  {
    category: 'email',
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },

  // ── Local absolute paths (user home) ───────────────────────
  // Unix: /home/<username>/..., /Users/<username>/...
  {
    category: 'local_path',
    regex: /\/(?:home|Users)\/[^/\s"'`]+/g,
    placeholder: `/home/${REDACTION_PLACEHOLDER}`,
  },
  // Windows: C:\Users\<username>\...
  {
    category: 'local_path',
    regex: /[A-Z]:\\Users\\[^\\\/\s"'`]+/gi,
    placeholder: `C:\\Users\\${REDACTION_PLACEHOLDER}`,
  },
  // Windows-style Unix paths like /mnt/c/Users/...
  {
    category: 'local_path',
    regex: /\/mnt\/[a-z]\/Users\/[^/\s"'`]+/gi,
    placeholder: `/mnt/c/Users/${REDACTION_PLACEHOLDER}`,
  },
];

/**
 * Redact sensitive information from a text string.
 *
 * Returns the cleaned text, total redactions, per-category counts, and
 * the positions/types of every match (useful for audit logs).
 */
export function redactSensitiveInfo(input: string): RedactionResult {
  if (!input || typeof input !== 'string') {
    return {
      redactedText: input ?? '',
      totalRedactions: 0,
      byCategory: emptyCategoryCounts(),
      matches: [],
    };
  }

  // Collect all non-overlapping matches from all rules
  const allMatches: RedactionMatch[] = [];

  for (const rule of RULES) {
    // Reset regex lastIndex since we reuse global regexes
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(input)) !== null) {
      allMatches.push({
        category: rule.category,
        start: m.index,
        end: m.index + m[0].length,
        placeholder: rule.placeholder ?? REDACTION_PLACEHOLDER,
      });
      // Avoid zero-length matches causing infinite loops
      if (m[0].length === 0) {
        rule.regex.lastIndex++;
      }
    }
  }

  if (allMatches.length === 0) {
    return {
      redactedText: input,
      totalRedactions: 0,
      byCategory: emptyCategoryCounts(),
      matches: [],
    };
  }

  // Sort by start position; remove overlapping matches (first match wins)
  allMatches.sort((a, b) => a.start - b.start);
  const deduped: RedactionMatch[] = [];
  let lastEnd = -1;
  for (const m of allMatches) {
    if (m.start >= lastEnd) {
      deduped.push(m);
      lastEnd = m.end;
    }
  }

  // Build redacted text
  const parts: string[] = [];
  let cursor = 0;
  const byCategory = emptyCategoryCounts();
  for (const m of deduped) {
    parts.push(input.slice(cursor, m.start));
    parts.push(m.placeholder);
    byCategory[m.category]++;
    cursor = m.end;
  }
  parts.push(input.slice(cursor));

  return {
    redactedText: parts.join(''),
    totalRedactions: deduped.length,
    byCategory,
    matches: deduped,
  };
}

/**
 * Redact sensitive info from any JSON-serialisable value (deep).
 * Traverses objects/arrays and redacts string values; leaves numbers/booleans/null alone.
 * Keys that imply secrets (api_key, password, etc.) have their entire value replaced.
 */
export function redactSensitiveDeep<T>(value: T): T {
  if (value == null) return value;

  if (typeof value === 'string') {
    return redactSensitiveInfo(value).redactedText as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveDeep(item)) as unknown as T;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = k.toLowerCase();
      const isSensitiveKey =
        keyLower.includes('apikey') ||
        keyLower.includes('api_key') ||
        keyLower.includes('secret') ||
        keyLower.includes('password') ||
        keyLower.includes('token') ||
        keyLower.includes('credential') ||
        keyLower.includes('authorization') ||
        keyLower === 'key';

      if (isSensitiveKey && typeof v === 'string' && v.length > 8) {
        result[k] = REDACTION_PLACEHOLDER;
      } else {
        result[k] = redactSensitiveDeep(v);
      }
    }
    return result as unknown as T;
  }

  return value;
}

function emptyCategoryCounts(): Record<RedactionCategory, number> {
  return {
    api_key: 0,
    jwt: 0,
    password: 0,
    private_key: 0,
    auth_header: 0,
    email: 0,
    phone_cn: 0,
    id_card_cn: 0,
    credit_card: 0,
    local_path: 0,
    aws_key: 0,
    openai_key: 0,
    generic_secret: 0,
  };
}

/** Human-readable labels per category (Chinese) */
export const CATEGORY_LABELS: Record<RedactionCategory, string> = {
  api_key: 'API Key',
  jwt: 'JWT 令牌',
  password: '密码/密钥字段',
  private_key: '私钥',
  auth_header: 'Authorization 头',
  email: '邮箱地址',
  phone_cn: '手机号',
  id_card_cn: '身份证号',
  credit_card: '银行卡号',
  local_path: '本机绝对路径',
  aws_key: 'AWS 密钥',
  openai_key: 'OpenAI 类密钥',
  generic_secret: '通用密钥字段',
};
