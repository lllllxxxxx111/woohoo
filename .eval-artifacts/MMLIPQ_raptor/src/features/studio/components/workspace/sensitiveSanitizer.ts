/**
 * 敏感内容剔除工具
 *
 * 在导出包前对所有文本/JSON 内容进行脱敏处理，确保：
 * - API Key (sk-, AKIA-, xoxb-, ghp_, AIza, tk. 等前缀)
 * - JWT 令牌 (eyJ... 三段式 Base64)
 * - 密码/密钥字段 (password, passwd, secret, token, apiKey, api_key, authorization)
 * - 完整私钥/密钥块 (-----BEGIN ... PRIVATE KEY-----)
 * - Authorization 头 (Bearer xxx, Basic xxx)
 * - 本机绝对路径 (/home/xxx, /Users/xxx, /root/, C:\Users\xxx)
 * - 数据库连接串 (postgres://, mysql://, redis:// 含密码)
 * - 邮箱地址 (保留首字母+域名，中间打码)
 * - 中国大陆手机号 (中间4位打码)
 *
 * 使用 REDACTED 占位符替换，并记录所有发现项。
 */

export type SensitiveCategory =
  | 'jwt'
  | 'api_key'
  | 'password'
  | 'private_key'
  | 'auth_header'
  | 'absolute_path'
  | 'db_url'
  | 'email'
  | 'phone'
  | 'generic_secret';

export type SanitizeFinding = {
  category: SensitiveCategory;
  redacted: string;       // 替换后的占位文本
  position: number;       // 在原文中的起始位置
  matchLength: number;    // 原始匹配长度
};

export type SanitizeResult = {
  sanitized: string;
  findings: SanitizeFinding[];
  totalReplacements: number;
};

/* ─── 替换占位符 ─── */
const REDACT = '[REDACTED]';
const REDACT_JWT = '[REDACTED_JWT]';
const REDACT_API_KEY = '[REDACTED_API_KEY]';
const REDACT_PASSWORD = '[REDACTED_PASSWORD]';
const REDACT_PRIVATE_KEY = '[REDACTED_PRIVATE_KEY]';
const REDACT_AUTH = '[REDACTED_AUTH_HEADER]';
const REDACT_PATH = '[REDACTED_PATH]';
const REDACT_DB_URL = '[REDACTED_DB_URL]';
const REDACT_EMAIL = '[REDACTED_EMAIL]';
const REDACT_PHONE = '[REDACTED_PHONE]';
const REDACT_SECRET = '[REDACTED_SECRET]';

/**
 * 对一段文本进行全量脱敏
 */
export function sanitizeText(text: string): SanitizeResult {
  if (!text) return { sanitized: text, findings: [], totalReplacements: 0 };

  const findings: SanitizeFinding[] = [];
  let result = text;

  // 注意：规则按"从大到小、从强到弱"顺序应用，避免误替换
  // 1. 私钥块（多行，必须最先处理）
  result = replacePattern(
    result,
    /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}[\s\S]*?-{5}END [A-Z0-9 ]*PRIVATE KEY-{5}/g,
    REDACT_PRIVATE_KEY,
    'private_key',
    findings,
  );

  // 2. 数据库连接串 (含password@)
  //    匹配: scheme://user:password@host:port/db?params
  result = replacePattern(
    result,
    /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqp|ssh|ftp|smtp):\/\/[^\s"'`<>]*?:[^\s@"'`<>]+@[^\s"'`<>]+/gi,
    REDACT_DB_URL,
    'db_url',
    findings,
  );

  // 3. Authorization 头 (Bearer/Basic/Token 后跟空白+非空白序列)
  result = replacePattern(
    result,
    /(?:Authorization\s*[:=]\s*|X-API-Key\s*[:=]\s*)(Bearer|Basic|Token|Api[- ]?Key)\s+["']?([A-Za-z0-9._\-+/=]{16,})["']?/gi,
    (_m, scheme) => `${REDACT_AUTH}: ${scheme} ${REDACT}`,
    'auth_header',
    findings,
  );

  // 4. 显式字段赋值: (password|passwd|pwd|secret|token|api_key|apiKey|apikey|access_key|secret_key|client_secret|accessToken|refreshToken|auth_token|sessionId)["']?\s*[:=]\s*["']? value
  //    覆盖 JSON/YAML/ENV/代码 风格，允许key带引号（如 "password": "xxx"）
  result = replacePattern(
    result,
    /\b(password|passwd|pwd|secret(?:_key|_token)?|api[_-]?key|access[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id|sessionId|bearer[_-]?token|signing[_-]?key|encryption[_-]?key|private[_-]?key|webhook[_-]?secret|webhookUrl)\b["']?\s*[:=]\s*["']?([^\s,;"'}\n\r\t]{6,})["']?/gi,
    (_m, field, _val) => {
      const lc = String(field).toLowerCase();
      const redacted = (lc.includes('password') || lc.includes('passwd') || lc === 'pwd')
        ? REDACT_PASSWORD
        : REDACT_SECRET;
      // 保留原文格式（key名、引号、冒号），只替换value部分
      return _m.replace(_val, redacted);
    },
    'password',
    findings,
  );

  // 5. 命令行参数风格: --password=xxx / -p xxx / --token=xxx / --api-key=xxx
  result = replacePattern(
    result,
    /(?:--(?:password|passwd|token|api[_\-]?key|secret|access[_\-]?key|secret[_\-]?key|auth(?:orization)?)\s*[= ]\s*|-p\s+)(["']?)([^\s"'`&|;<>]{6,})\1/gi,
    (_m, _q, _v) => `${REDACT_PASSWORD}`,
    'password',
    findings,
  );

  // 6. JWT: eyJ 开头，三段式（两逗点），至少50字符
  result = replacePattern(
    result,
    /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
    REDACT_JWT,
    'jwt',
    findings,
  );

  // 7. 已知前缀 API Key
  //    sk- / sk_live_ / sk_test_  (OpenAI/Stripe风格)
  //    AKIA / ASIA  (AWS)
  //    AIza  (Google)
  //    ghp_ / gho_ / ghu_ / ghs_  (GitHub)
  //    xoxb- / xoxp- / xoxa- / xoxr-  (Slack)
  //    tk.  (Vercel)
  //    sk-ant- (Anthropic)
  //    rk_  (Replicate)
  //    xai-  (xAI/Grok)
  //    hooks.slack.com/services/  (Slack webhook，已在上面的webhook_secret处理)
  //    也匹配 sk-[a-zA-Z0-9]{20,} 通用模式
  result = replacePattern(
    result,
    /\b(?:sk(?:-[a-zA-Z0-9]{20,}|_(?:live|test|ant|prod|dev)-[a-zA-Z0-9]{10,}))/g,
    REDACT_API_KEY,
    'api_key',
    findings,
  );
  result = replacePattern(
    result,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    REDACT_API_KEY,
    'api_key',
    findings,
  );
  result = replacePattern(
    result,
    /\bAIza[A-Za-z0-9_\-]{33,39}\b/g,
    REDACT_API_KEY,
    'api_key',
    findings,
  );
  result = replacePattern(
    result,
    /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b/g,
    REDACT_API_KEY,
    'api_key',
    findings,
  );
  result = replacePattern(
    result,
    /\bxox[abpr]-[A-Za-z0-9\-]{20,}\b/g,
    REDACT_API_KEY,
    'api_key',
    findings,
  );
  result = replacePattern(
    result,
    /\btk\.[A-Za-z0-9]{20,}\b/g,
    REDACT_API_KEY,
    'api_key',
    findings,
  );
  result = replacePattern(
    result,
    /\b(?:rk_|xai-)[A-Za-z0-9]{20,}\b/g,
    REDACT_API_KEY,
    'api_key',
    findings,
  );

  // 8. 通用 Bearer <token> 模式（残留）
  result = replacePattern(
    result,
    /\bBearer\s+[A-Za-z0-9._\-+/=]{24,}\b/g,
    REDACT_AUTH,
    'auth_header',
    findings,
  );

  // 9. 本机绝对路径脱敏
  //    Unix: /home/<user>/...  /Users/<user>/...  /root/...  /var/root/...
  //    保留前两段（/home/[REDACTED]/...），用户名部分脱敏
  result = replacePattern(
    result,
    /(^|[\s"'`=<>])(\/(?:home|Users|root|var\/root|private\/var|opt|srv|usr\/local)\/)([a-zA-Z0-9._\-]+)(\/[^\s"'`<>|]*)/g,
    (_m, prefix, base, _user, rest) => `${prefix}${base}${REDACT_PATH}${rest}`,
    'absolute_path',
    findings,
  );
  // Windows: C:\Users\<user>\...
  result = replacePattern(
    result,
    /([A-Z]:\\(?:Users|Documents and Settings|ProgramData|Windows\\System32\\config\\systemprofile)\\)([a-zA-Z0-9._\- ]+)(\\[^\s"'`<>|]*)/g,
    (_m, base, _user, rest) => `${base}${REDACT_PATH}${rest}`,
    'absolute_path',
    findings,
  );

  // 10. 邮箱：保留首字母+域名，用户名其余打码
  //     如: john.doe@example.com → j***@example.com
  result = replacePattern(
    result,
    /\b([A-Za-z0-9])[A-Za-z0-9._%+\-]*@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g,
    (_m, first, domain) => `${first}***@${domain}`,
    'email',
    findings,
  );

  // 11. 中国大陆手机号：1开头11位，中间4位打码 138****1234
  //     使用前后边界，避免匹配长数字串
  result = replacePattern(
    result,
    /(?<![0-9])(1[3-9]\d)(\d{4})(\d{4})(?![0-9])/g,
    (_m, pre, _mid, suf) => `${pre}****${suf}`,
    'phone',
    findings,
  );

  // 12. 通用高熵密钥兜底：
  //     在引号内或赋值后出现的长度>32的 base64/hex 串（通常是密钥）
  //     仅在前面有 secret/token/key/password 等关键词或 = 赋值时才触发，避免误伤普通内容
  result = replacePattern(
    result,
    /(?:(?:secret|token|key|password|credential|signing|encryption|auth)[^\n]{0,15}?)(["'])([A-Za-z0-9+/=_\-]{40,})\1/gi,
    REDACT_SECRET,
    'generic_secret',
    findings,
  );

  return {
    sanitized: result,
    findings,
    totalReplacements: findings.length,
  };
}

/**
 * 对一个值递归脱敏（用于 JSON 对象/数组）
 */
export function sanitizeValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeText(value).sanitized as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // 字段名本身是password/secret等时，值直接替换（避免值太短没被正则匹配到）
      const lc = k.toLowerCase();
      if (
        typeof v === 'string' &&
        (lc.includes('password') ||
          lc.includes('passwd') ||
          lc === 'pwd' ||
          (lc.includes('secret') && !lc.includes('secret_findings') && !lc.includes('sensitive_findings')) ||
          lc.includes('token') ||
          lc.includes('api_key') ||
          lc.includes('apikey') ||
          lc.includes('access_key') ||
          lc.includes('private_key') ||
          lc.includes('client_secret'))
      ) {
        result[k] = v.length > 0 ? REDACT_PASSWORD : v;
      } else {
        result[k] = sanitizeValue(v);
      }
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * 对 JSON 字符串进行安全脱敏（先解析 → 递归脱敏 → 再序列化）
 * 解析失败时回退到文本级脱敏
 */
export function sanitizeJson(jsonText: string, indent = 2): SanitizeResult {
  if (!jsonText) return { sanitized: jsonText, findings: [], totalReplacements: 0 };

  try {
    const parsed = JSON.parse(jsonText);
    const sanitized = sanitizeValue(parsed);
    return {
      sanitized: JSON.stringify(sanitized, null, indent),
      findings: sanitizeText(jsonText).findings, // 保留原文中的发现报告
      totalReplacements: 0,
    };
  } catch {
    // 不是合法JSON，退回到文本脱敏
    return sanitizeText(jsonText);
  }
}

/* ─── 内部辅助 ─── */

function replacePattern(
  text: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...groups: string[]) => string),
  category: SensitiveCategory,
  findings: SanitizeFinding[],
): string {
  return text.replace(pattern, (match: string, ...args: unknown[]) => {
    // args 结构: [groups..., offset, fullstring] — String.replace 规范
    const offset = args[args.length - 2] as number;
    const repl = typeof replacement === 'function' ? replacement(match, ...(args.slice(0, -2) as string[])) : replacement;

    findings.push({
      category,
      redacted: repl,
      position: offset,
      matchLength: match.length,
    });

    return repl;
  });
}
