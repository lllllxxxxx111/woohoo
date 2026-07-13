/**
 * 脱敏模块正则冒烟测试
 * 直接复制定义的核心正则，确保关键模式能正确匹配和替换。
 * 运行: node __test_sanitize.mjs
 */

// 注意：这些正则必须与 sensitiveSanitizer.ts 中保持一致
const RE_JWT = /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g;
const RE_SK_KEY = /\bsk(?:-[A-Za-z0-9]{20,}|_(?:live|test|ant|prod|dev)-[A-Za-z0-9]{10,})/g;
const RE_AWS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const RE_PRIVATE_KEY = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}[\s\S]*?-{5}END [A-Z0-9 ]*PRIVATE KEY-{5}/g;
const RE_DB_URL = /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqp|ssh|ftp|smtp):\/\/[^\s"'`<>]*?:[^\s@"'`<>]+@[^\s"'`<>]+/gi;
const RE_UNIX_PATH = /(^|[\s"'`=<>])(\/(?:home|Users|root|var\/root|private\/var|opt|srv|usr\/local)\/)([a-zA-Z0-9._\-]+)(\/[^\s"'`<>|]*)/g;
const RE_EMAIL = /\b([A-Za-z0-9])[A-Za-z0-9._%+\-]*@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g;
const RE_PHONE = /(?<![0-9])(1[3-9]\d)(\d{4})(\d{4})(?![0-9])/g;
const RE_BEARER = /\bBearer\s+[A-Za-z0-9._\-+/=]{24,}\b/g;
const RE_FIELD_ASSIGN = /\b(password|passwd|pwd|secret(?:_key|_token)?|api[_-]?key|access[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id|sessionId|bearer[_-]?token|signing[_-]?key|encryption[_-]?key|private[_-]?key|webhook[_-]?secret|webhookUrl)\b["']?\s*[:=]\s*["']?([^\s,;"'}\n\r\t]{6,})["']?/gi;
const RE_CLI_ARG = /(?:--(?:password|passwd|token|api[_-]?key|secret|access[_-]?key|secret[_-]?key|auth(?:orization)?)\s*[= ]\s*|-p\s+)(["']?)([^\s"'`&|;<>]{6,})\1/gi;

const RE_AUTH_HEADER = () =>
  /(?:Authorization\s*[:=]\s*|X-API-Key\s*[:=]\s*)(Bearer|Basic|Token|Api[- ]?Key)\s+["']?([A-Za-z0-9._\-+/=]{16,})["']?/gi;

function basicSanitize(text) {
  let result = text;
  result = result.replace(RE_PRIVATE_KEY, '[REDACTED_PRIVATE_KEY]');
  result = result.replace(RE_DB_URL, '[REDACTED_DB_URL]');
  result = result.replace(RE_AUTH_HEADER(), (_m, scheme) => `[REDACTED_AUTH_HEADER]: ${scheme} [REDACTED]`);
  result = result.replace(RE_FIELD_ASSIGN, (_m, field, val) => {
    const lc = String(field).toLowerCase();
    const redacted = (lc.includes('password') || lc.includes('passwd') || lc === 'pwd')
      ? '[REDACTED_PASSWORD]'
      : '[REDACTED_SECRET]';
    return _m.replace(val, redacted);
  });
  result = result.replace(RE_CLI_ARG, '[REDACTED_PASSWORD]');
  result = result.replace(RE_JWT, '[REDACTED_JWT]');
  result = result.replace(RE_SK_KEY, '[REDACTED_API_KEY]');
  result = result.replace(RE_AWS_KEY, '[REDACTED_API_KEY]');
  result = result.replace(RE_BEARER, '[REDACTED_AUTH_HEADER]');
  result = result.replace(RE_UNIX_PATH, (_m, prefix, base, _user, rest) => `${prefix}${base}[REDACTED_PATH]${rest}`);
  result = result.replace(RE_EMAIL, (_m, first, domain) => `${first}***@${domain}`);
  result = result.replace(RE_PHONE, (_m, pre, _mid, suf) => `${pre}****${suf}`);
  return result;
}

// 生成真实长度的假密钥
const fakeJwt = (() => {
  const h = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
  const p = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ';
  const s = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  return `${h}.${p}.${s}`;
})();
const fakeSkKey = 'sk-' + 'a'.repeat(40) + 'b'.repeat(8);
const fakeAwsKey = 'AKIAIOSFODNN7EXAMPLE';
const fakePkcs8 = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...base64...\n-----END RSA PRIVATE KEY-----';

const testCases = [
  {
    name: '1. JWT in Authorization header',
    input: `Authorization: Bearer ${fakeJwt}`,
    mustNotContain: [fakeJwt.slice(-20)],
    mustContain: ['[REDACTED_AUTH_HEADER]'],
  },
  {
    name: '2. Standalone JWT token',
    input: `token=${fakeJwt}`,
    mustNotContain: [fakeJwt.slice(-20)],
    mustContain: ['[REDACTED_JWT]'],
  },
  {
    name: '3. OpenAI sk- key in env var',
    input: `OPENAI_API_KEY=${fakeSkKey}`,
    mustNotContain: [fakeSkKey.slice(-20)],
    mustContain: ['[REDACTED'],  // key is redacted
  },
  {
    name: '4. Password in JSON object',
    input: '{"user":"admin","password":"my_super_secret_pw_123","host":"localhost"}',
    mustNotContain: ['my_super_secret_pw_123'],
    mustContain: ['[REDACTED_PASSWORD]', 'admin', 'localhost'],
  },
  {
    name: '5. apiKey in JSON',
    input: `{"apiKey": "${fakeSkKey}", "endpoint": "https://api.openai.com"}`,
    mustNotContain: [fakeSkKey.slice(-20)],
    mustContain: ['[REDACTED'],  // key is redacted
  },
  {
    name: '6. RSA private key block',
    input: `key = ${fakePkcs8}\nafter`,
    mustNotContain: ['MIIEow', 'BEGIN RSA PRIVATE KEY'],
    mustContain: ['[REDACTED_PRIVATE_KEY]'],
  },
  {
    name: '7. Postgres URL with password',
    input: 'DATABASE_URL=postgres://admin:***@db.prod.example.com:5432/woohoo',
    mustNotContain: ['supersecretpassword', 'supersecretpassword@'],
    mustContain: ['[REDACTED_DB_URL]'],
  },
  {
    name: '8. Redis URL with password',
    input: 'redis://:***@redis.local:6379/0',
    mustNotContain: ['redispass123'],
    mustContain: ['[REDACTED_DB_URL]'],
  },
  {
    name: '9. Unix home directory path',
    input: 'Saved to /home/alice/projects/woohoo/exports/test.tar successfully',
    mustNotContain: ['/home/alice/'],
    mustContain: ['[REDACTED_PATH]', '/projects/woohoo/exports/test.tar'],
  },
  {
    name: '10. macOS home path',
    input: 'workdir = /Users/bob/studio/project1',
    mustNotContain: ['/Users/bob/'],
    mustContain: ['[REDACTED_PATH]'],
  },
  {
    name: '11. /root path',
    input: 'cwd: /root/.woohoo/assets/1.png',
    mustNotContain: ['/root/.woohoo'],
    mustContain: ['[REDACTED_PATH]'],
  },
  {
    name: '12. Email address',
    input: 'Contact: john.doe@example.com for details',
    mustNotContain: ['john.doe@'],
    mustContain: ['j***@example.com'],
  },
  {
    name: '13. Chinese mobile phone',
    input: '请拨打13812345678联系我',
    mustNotContain: ['13812345678'],
    mustContain: ['138****5678'],
  },
  {
    name: '14. AWS access key',
    input: `export AWS_ACCESS_KEY_ID=${fakeAwsKey}`,
    mustNotContain: [fakeAwsKey],
    mustContain: ['[REDACTED_API_KEY]'],
  },
  {
    name: '15. CLI --password flag',
    input: './deploy.sh --password=mysecretpass123 --host prod.example.com',
    mustNotContain: ['mysecretpass123'],
    mustContain: ['[REDACTED_PASSWORD]', '--host prod.example.com'],
  },
  {
    name: '16. Standalone Bearer token (curl)',
    input: `curl -H "Authorization: Bearer ${'a'.repeat(48)}" https://api.com/data`,
    mustNotContain: [`Bearer ${'a'.repeat(48)}`],
    mustContain: ['[REDACTED_AUTH_HEADER]'],
  },
  {
    name: '17. Clean Chinese script text (no false positives)',
    input: '## 第一幕：相遇\n男主角在咖啡厅遇见女主角。阳光透过窗户洒进来。他问她：你也是来写剧本的吗？',
    mustNotContain: ['[REDACTED'],
    mustContain: ['男主角', '咖啡厅'],
  },
  {
    name: '18. Clean English technical text',
    input: 'The export package contains manifest.json, checksums.json, and verification-report.json for audit purposes.',
    mustNotContain: ['[REDACTED'],
    mustContain: ['manifest.json'],
  },
];

let passed = 0;
let failed = 0;
for (const tc of testCases) {
  const out = basicSanitize(tc.input);
  let ok = true;
  const errors = [];
  for (const mustNot of tc.mustNotContain) {
    if (out.includes(mustNot)) {
      ok = false;
      errors.push(`  STILL CONTAINS forbidden: "${mustNot}"`);
    }
  }
  for (const must of tc.mustContain) {
    if (!out.includes(must)) {
      ok = false;
      errors.push(`  MISSING expected: "${must}"`);
    }
  }
  if (ok) {
    console.log(`✓ ${tc.name}`);
    passed++;
  } else {
    console.log(`✗ ${tc.name}`);
    console.log(`  Input (first 100): ${tc.input.slice(0, 100)}`);
    console.log(`  Output (first 150): ${out.slice(0, 150)}`);
    for (const e of errors) console.log(e);
    failed++;
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
