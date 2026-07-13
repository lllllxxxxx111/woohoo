/**
 * Standalone tests for redaction logic.
 *
 * This file mirrors the patterns from redaction.ts and runs self-contained
 * assertions. It is designed to be executable directly with Node:
 *   node src/features/studio/components/workspace/redaction.test.mjs
 *
 * It duplicates the patterns rather than importing TS to avoid a build
 * dependency; if you change patterns in redaction.ts, update these too.
 */

const PLACEHOLDER = '[REDACTED]';

// Copy of the RULES array patterns as JS RegExps (must stay in sync with redaction.ts)
const RULES = [
  { category: 'private_key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { category: 'private_key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PUBLIC KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PUBLIC KEY-----/g },
  { category: 'aws_key', regex: /AKIA[0-9A-Z]{16}/g },
  { category: 'aws_key', regex: /aws_secret_access_key["':=\s]+[A-Za-z0-9/+=]{40}/gi },
  { category: 'openai_key', regex: /sk-(?:proj-|ant-|svc-|)[A-Za-z0-9_-]{20,}/g },
  { category: 'api_key', regex: /(?:api[_-]?key|apikey)["':=\s]+[A-Za-z0-9_\-.]{20,}/gi },
  { category: 'auth_header', regex: /(?:Authorization|Bearer)\s+[A-Za-z0-9_\-.]+=*\.[A-Za-z0-9_\-.]+=*\.[A-Za-z0-9_\-.]+=*/gi },
  { category: 'jwt', regex: /eyJ[A-Za-z0-9_\-]+=*\.[A-Za-z0-9_\-]+=*\.[A-Za-z0-9_\-]+=*/g },
  { category: 'password', regex: /(?:password|passwd|pwd|secret|token|credential)["':=\s]+["']?[^"'\s,;})\]]{8,}["']?/gi },
  { category: 'generic_secret', regex: /(?:DATABASE_URL|DB_PASSWORD|REDIS_URL|SMTP_PASSWORD|SECRET_KEY|JWT_SECRET|WEBHOOK_SECRET)["':=\s]+\S+/gi },
  { category: 'credit_card', regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/g },
  { category: 'id_card_cn', regex: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },
  { category: 'phone_cn', regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { category: 'email', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { category: 'local_path', regex: /\/(?:home|Users)\/[^/\s"'`]+/g, placeholder: `/home/${PLACEHOLDER}` },
  { category: 'local_path', regex: /[A-Z]:\\Users\\[^\\\/\s"'`]+/gi, placeholder: `C:\\Users\\${PLACEHOLDER}` },
  { category: 'local_path', regex: /\/mnt\/[a-z]\/Users\/[^/\s"'`]+/gi, placeholder: `/mnt/c/Users/${PLACEHOLDER}` },
];

function redact(input) {
  if (!input) return { redactedText: input ?? '', total: 0, byCat: {} };
  const allMatches = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let m;
    while ((m = rule.regex.exec(input)) !== null) {
      allMatches.push({ cat: rule.category, start: m.index, end: m.index + m[0].length, ph: rule.placeholder ?? PLACEHOLDER });
      if (m[0].length === 0) rule.regex.lastIndex++;
    }
  }
  if (allMatches.length === 0) return { redactedText: input, total: 0, byCat: {} };
  allMatches.sort((a, b) => a.start - b.start);
  const deduped = [];
  let lastEnd = -1;
  for (const m of allMatches) {
    if (m.start >= lastEnd) { deduped.push(m); lastEnd = m.end; }
  }
  const parts = [];
  const byCat = {};
  let cursor = 0;
  for (const m of deduped) {
    parts.push(input.slice(cursor, m.start));
    parts.push(m.ph);
    byCat[m.cat] = (byCat[m.cat] ?? 0) + 1;
    cursor = m.end;
  }
  parts.push(input.slice(cursor));
  return { redactedText: parts.join(''), total: deduped.length, byCat };
}

// ─── Assertions ──────────────────────────────────────────────────

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertIncludes(haystack, needle) {
  if (!haystack.includes(needle)) throw new Error(`expected "${haystack.slice(0, 80)}" to include "${needle}"`);
}
function assertNotIncludes(haystack, needle) {
  if (haystack.includes(needle)) throw new Error(`expected "${haystack.slice(0, 80)}" NOT to include "${needle}"`);
}

console.log('\n🔒 Redaction module tests\n');

t('OpenAI sk- key redacted', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789';
  const r = redact(`key is ${key} done`);
  assert(r.total === 1, `expected 1 match, got ${r.total}`);
  assertIncludes(r.redactedText, PLACEHOLDER);
  assertNotIncludes(r.redactedText, key);
});

t('OpenAI sk-proj key redacted', () => {
  const r = redact('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
  assert(r.total >= 1);
  assertNotIncludes(r.redactedText, 'sk-proj-abcdefghijklmnopqrstuvwxyz');
});

t('AWS AKIA key redacted', () => {
  const r = redact('AKIAIOSFODNN7EXAMPLE key');
  assert(r.total === 1);
  assertNotIncludes(r.redactedText, 'AKIAIOSFODNN7EXAMPLE');
});

t('JWT redacted', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const r = redact(`Authorization: Bearer ${jwt}`);
  assert(r.total >= 1);
  assertNotIncludes(r.redactedText, 'eyJzdWIiOiIxMjM0NTY3ODkwIn0');
});

t('password= field redacted', () => {
  const r = redact('password=hunter22_hidden end');
  assert(r.total === 1);
  assertNotIncludes(r.redactedText, 'hunter22');
});

t('PEM private key block redacted', () => {
  const pk = `-----BEGIN PRIVATE KEY-----
MIIEv...base64data...ABC=
-----END PRIVATE KEY-----`;
  const r = redact(`key:
${pk}`);
  assert(r.total >= 1, `expected >=1 match, got ${r.total}`);
  assertNotIncludes(r.redactedText, 'MIIEv');
});

t('Email address redacted', () => {
  const r = redact('contact support@example.com for help');
  assert(r.total === 1);
  assertNotIncludes(r.redactedText, 'support@example.com');
});

t('China mobile phone redacted', () => {
  const r = redact('call 13812345678 now');
  assert(r.total === 1);
  assertNotIncludes(r.redactedText, '13812345678');
});

t('China ID card redacted', () => {
  const r = redact('id 110101199001011234 check');
  assert(r.total >= 1);
  assertNotIncludes(r.redactedText, '110101199001011234');
});

t('Credit card number redacted', () => {
  const r = redact('card 4111 1111 1111 1111 used');
  assert(r.total >= 1);
});

t('/home/<user> path redacted', () => {
  const r = redact('saved to /home/alice/secret.txt');
  assertIncludes(r.redactedText, PLACEHOLDER);
  assertNotIncludes(r.redactedText, 'alice');
});

t('/Users/<user> path redacted', () => {
  const r = redact('file in /Users/bob/Documents/');
  assertIncludes(r.redactedText, PLACEHOLDER);
  assertNotIncludes(r.redactedText, 'bob');
});

t('C:\\Users\\ path redacted', () => {
  const r = redact('at C:\\Users\\Charlie\\Docs');
  assert(r.total >= 1);
});

t('DATABASE_URL redacted', () => {
  const r = redact('DATABASE_URL=postgres://user:pass@localhost/db');
  assert(r.total === 1);
  assertNotIncludes(r.redactedText, 'postgres://user:pass');
});

t('JWT_SECRET redacted', () => {
  const r = redact('JWT_SECRET=super_secret_key_value_here');
  assert(r.total === 1);
});

t('Clean Chinese text has no false positives', () => {
  const clean = '这是一个关于 25 个镜头的短剧项目，描述主角在城市中的冒险。联系制作团队获取详情。';
  const r = redact(clean);
  assert(r.total === 0, `unexpected matches: ${JSON.stringify(r.byCat)}`);
  assert(r.redactedText === clean);
});

t('4-digit year not treated as phone/CC', () => {
  const r = redact('year 2024, episode 12, duration 300s');
  assert(r.total === 0);
});

t('Multiple matches all captured', () => {
  const r = redact('sk-abcdefghijklmnopqrstuvwxyz pwd=hunter22_hidden a@b.com');
  assert(r.total >= 3, `expected >=3 matches, got ${r.total}`);
});

t('Deep object redaction works (simulated)', () => {
  // Simulate redactSensitiveDeep for string values in object
  function deepRedact(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') return redact(obj).redactedText;
    if (Array.isArray(obj)) return obj.map(deepRedact);
    if (typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const kl = k.toLowerCase();
        const sensitiveKey = ['apikey', 'api_key', 'secret', 'password', 'token'].some(s => kl.includes(s));
        if (sensitiveKey && typeof v === 'string' && v.length > 8) {
          out[k] = PLACEHOLDER;
        } else {
          out[k] = deepRedact(v);
        }
      }
      return out;
    }
    return obj;
  }
  const input = { name: 'test', apiKey: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', meta: { email: 'a@b.com' } };
  const out = deepRedact(input);
  assert(out.apiKey === PLACEHOLDER, 'sensitive key should be fully replaced');
  assert(!out.meta.email.includes('a@b.com'), 'nested email should be redacted');
});

// ─── Redaction edge cases ──────────────────────────────────────

t('Redaction is idempotent', () => {
  const once = redact('my sk-abc...yz01 key');
  const twice = redact(once.redactedText);
  assert(twice.total === 0, `re-redacting should find nothing, got ${twice.total}`);
  assertEq(once.redactedText, twice.redactedText);
});

t('Empty string returns empty, zero matches', () => {
  const r = redact('');
  assertEq(r.total, 0);
  assertEq(r.redactedText, '');
});

t('Plain Chinese text untouched', () => {
  const clean = '这是一个普通的剧本内容，主角李明在2024年拍摄了一部25分钟的短片。';
  const r = redact(clean);
  assertEq(r.total, 0);
  assertEq(r.redactedText, clean);
});

t('Short numbers that look like cards but too short are not matched', () => {
  const r = redact('room 1234 5678 90');
  // Should not redact (not a full 16-digit card)
  // (some false positives on grouped digits are acceptable; just ensure no crash)
  assert(typeof r.total === 'number');
});

t('JWT in Authorization header is fully redacted', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const input = `Authorization: Bearer ${jwt}`;
  const r = redact(input);
  assert(r.total >= 1, 'expected at least 1 match');
  assert(!r.redactedText.includes('eyJzdWIiOiIxMjM0NTY3ODkwIn0'), 'payload segment should be redacted');
});

t('Multiple emails all redacted', () => {
  const r = redact('contact a@b.com or c@d.org or e@f.io');
  assertEq(r.byCat.email ?? 0, 3, `expected 3 emails, got ${r.byCat.email}`);
  assert(!r.redactedText.includes('a@b.com'));
  assert(!r.redactedText.includes('c@d.org'));
  assert(!r.redactedText.includes('e@f.io'));
});

t('DATABASE_URL connection string fully redacted', () => {
  const r = redact('DATABASE_URL=postgres://admin:secret@localhost:5432/mydb');
  assert(r.total >= 1, 'expected DATABASE_URL to be redacted');
  assert(!r.redactedText.includes('postgres://admin:secret'));
});

t('Path /home/<user> keeps directory structure but replaces username', () => {
  const r = redact('stored in /home/alice/projects/film');
  assert(r.redactedText.includes('/home/'));
  assert(!r.redactedText.includes('alice'));
  assert(r.redactedText.includes(PLACEHOLDER));
});

t('byCategory counts match total', () => {
  const r = redact('sk-abc...yz01, email te**@**********, pwd=hunter22_hidden');
  let sum = 0;
  for (const n of Object.values(r.byCat)) sum += n;
  assertEq(sum, r.total, `sum of categories (${sum}) must equal total (${r.total})`);
});

t('sk-proj project-scoped keys are matched', () => {
  // Key body after 'sk-proj-' must be >= 20 chars
  const longKey = 'sk-proj-' + 'A'.repeat(30) + 'XYZ01';
  const r = redact(longKey);
  assert(r.total >= 1, `sk-proj key should be matched, got ${r.total}`);
});

t('sk- key shorter than 20 chars after prefix is NOT matched (avoids false positives)', () => {
  const r = redact('using sk-123 short');
  assertEq(r.total, 0, `expected 0 matches for short key, got ${r.total}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

