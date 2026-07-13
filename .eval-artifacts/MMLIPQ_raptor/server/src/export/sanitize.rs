//! 敏感内容剔除模块
//!
//! 在导出包前对所有文本/JSON 内容进行脱敏处理，覆盖：
//! - API Key (sk-, AKIA-, xoxb-, ghp_, AIza, tk. 等前缀)
//! - JWT 令牌 (eyJ... 三段式 Base64URL)
//! - 密码/密钥字段 (password, secret, token, api_key, authorization 等)
//! - 私钥块 (-----BEGIN ... PRIVATE KEY-----)
//! - Authorization 头 (Bearer/Basic xxx)
//! - 本机绝对路径 (/home/<user>/..., /Users/<user>/..., C:\Users\...\)
//! - 数据库连接串 (postgres://user:p***@host, mysql://...)
//! - 邮箱（保留首字母+域名，中间打码）
//! - 中国大陆手机号（中间4位打码）

use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use serde::Serialize;
use serde_json::Value;

/// 敏感信息类别
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SensitiveCategory {
    Jwt,
    ApiKey,
    Password,
    PrivateKey,
    AuthHeader,
    AbsolutePath,
    DbUrl,
    Email,
    Phone,
    GenericSecret,
}

/// 脱敏发现条目
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizeFinding {
    pub category: SensitiveCategory,
    pub redacted: String,
    pub position: usize,
    pub match_length: usize,
}

/// 脱敏结果
#[derive(Debug, Clone)]
pub struct SanitizeResult {
    pub sanitized: String,
    pub findings: Vec<SanitizeFinding>,
}

// ─── 替换占位符 ───
const REDACT: &str = "[REDACTED]";
pub const REDACT_JWT: &str = "[REDACTED_JWT]";
pub const REDACT_API_KEY: &str = "[REDACTED_API_KEY]";
pub const REDACT_PASSWORD: &str = "[REDACTED_PASSWORD]";
pub const REDACT_PRIVATE_KEY: &str = "[REDACTED_PRIVATE_KEY]";
pub const REDACT_AUTH: &str = "[REDACTED_AUTH_HEADER]";
pub const REDACT_PATH: &str = "[REDACTED_PATH]";
pub const REDACT_DB_URL: &str = "[REDACTED_DB_URL]";
pub const REDACT_SECRET: &str = "[REDACTED_SECRET]";

// ─── 正则（编译一次） ───

// 1. 私钥块 (多行)
static RE_PRIVATE_KEY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}[\s\S]*?-{5}END [A-Z0-9 ]*PRIVATE KEY-{5}")
        .unwrap()
});

// 2. 数据库连接串 (含 password@)
static RE_DB_URL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqp|ssh|ftp|smtp)://[^\s"'`<>]*?:[^\s@"'`<>]+@[^\s"'`<>]+"#,
    )
    .unwrap()
});

// 3. Authorization 头
static RE_AUTH_HEADER: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:Authorization\s*[:=]\s*|X-API-Key\s*[:=]\s*)(Bearer|Basic|Token|Api[- ]?Key)\s+["']?([A-Za-z0-9._\-+/=]{16,})["']?"#,
    )
    .unwrap()
});

// 4. 显式字段赋值 (password/token/secret/api_key 等)
//    允许key被引号包裹（JSON风格 "password": "xxx"）
static RE_FIELD_ASSIGN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\b(password|passwd|pwd|secret(?:_key|_token)?|api[_-]?key|access[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id|sessionId|bearer[_-]?token|signing[_-]?key|encryption[_-]?key|private[_-]?key|webhook[_-]?secret|webhookUrl)\b["']?\s*[:=]\s*["']?([^\s,;"'}\n\r\t]{6,})["']?"#,
    )
    .unwrap()
});

// 5. 命令行参数风格 (--password=xxx / -p xxx)
static RE_CLI_ARG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:--(?:password|passwd|token|api[_-]?key|secret|access[_-]?key|secret[_-]?key|auth(?:orization)?)\s*[= ]\s*|-p\s+)(["']?)([^\s"'`&|;<>]{6,})\1"#,
    )
    .unwrap()
});

// 6. JWT (eyJ + base64三段式)
static RE_JWT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+").unwrap()
});

// 7a. OpenAI/Stripe/Anthropic sk- keys
static RE_SK_KEY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bsk(?:-[A-Za-z0-9]{20,}|_(?:live|test|ant|prod|dev)-[A-Za-z0-9]{10,})").unwrap()
});
// 7b. AWS keys (AKIA/ASIA + 16 chars)
static RE_AWS_KEY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").unwrap()
});
// 7c. Google API key (AIza + 35 chars = 39 total)
static RE_GOOGLE_KEY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bAIza[A-Za-z0-9_\-]{33,39}\b").unwrap()
});
// 7d. GitHub token (ghp_/gho_/ghu_/ghs_ + 36 chars)
static RE_GITHUB_TOKEN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b").unwrap()
});
// 7e. Slack tokens (xox[baprs]-)
static RE_SLACK_TOKEN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bxox[baprs]-[A-Za-z0-9\-]{20,}\b").unwrap()
});
// 7f. Vercel token (tk.)
static RE_VERCEL_TOKEN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\btk\.[A-Za-z0-9]{20,}\b").unwrap()
});
// 7g. Replicate/xAI 等 (rk_ / xai-)
static RE_OTHER_KEY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b(?:rk_|xai-)[A-Za-z0-9]{20,}\b").unwrap()
});

// 8. 残留 Bearer <token>
static RE_BEARER: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bBearer\s+[A-Za-z0-9._\-+/=]{24,}\b").unwrap()
});

// 9a. Unix 绝对路径
static RE_UNIX_PATH: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(^|[\s"'`=<>])(/(?:home|Users|root|var/root|private/var|opt|srv|usr/local)/)([a-zA-Z0-9._\-]+)(/[^\s"'`<>|]*)"#,
    )
    .unwrap()
});
// 9b. Windows 绝对路径
static RE_WIN_PATH: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"([A-Z]:\\(?:Users|Documents and Settings|ProgramData|Windows\\System32\\config\\systemprofile)\\)([a-zA-Z0-9._\- ]+)(\\[^\s"'`<>|]*)"#,
    )
    .unwrap()
});

// 10. 邮箱
static RE_EMAIL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b([A-Za-z0-9])[A-Za-z0-9._%+\-]*@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b").unwrap()
});

// 11. 中国大陆手机号
static RE_PHONE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?<![0-9])(1[3-9]\d)(\d{4})(\d{4})(?![0-9])").unwrap()
});

// 12. 通用高熵密钥兜底（上下文关键词 + 长base64串）
static RE_GENERIC_SECRET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:secret|token|key|password|credential|signing|encryption|auth)[^\n]{0,15}?(["'])([A-Za-z0-9+/=_\-]{40,})\1"#,
    )
    .unwrap()
});

/// 对一段文本执行全量脱敏
pub fn sanitize_text(text: &str) -> SanitizeResult {
    if text.is_empty() {
        return SanitizeResult {
            sanitized: text.to_string(),
            findings: vec![],
        };
    }

    let mut findings: Vec<SanitizeFinding> = Vec::new();
    let mut result = text.to_string();

    // 规则顺序：从大到小、从强到弱

    // 1. 私钥块
    result = apply_regex(
        &RE_PRIVATE_KEY,
        result,
        |_| REDACT_PRIVATE_KEY.to_string(),
        SensitiveCategory::PrivateKey,
        &mut findings,
    );

    // 2. 数据库连接串
    result = apply_regex(
        &RE_DB_URL,
        result,
        |_| REDACT_DB_URL.to_string(),
        SensitiveCategory::DbUrl,
        &mut findings,
    );

    // 3. Authorization 头
    result = apply_regex(
        &RE_AUTH_HEADER,
        result,
        |caps| format!("{}: {} {}", REDACT_AUTH, &caps[1], REDACT),
        SensitiveCategory::AuthHeader,
        &mut findings,
    );

    // 4. 显式字段赋值
    result = apply_regex(
        &RE_FIELD_ASSIGN,
        result,
        |caps| {
            let full = caps.get(0).unwrap().as_str();
            let field = &caps[1];
            let value = &caps[2];
            let lc = field.to_lowercase();
            let redacted = if lc.contains("password") || lc.contains("passwd") || lc == "pwd" {
                REDACT_PASSWORD
            } else {
                REDACT_SECRET
            };
            // 保留原文本中的key格式（引号、冒号），只替换value部分
            full.replacen(value, redacted, 1)
        },
        SensitiveCategory::Password,
        &mut findings,
    );

    // 5. CLI参数
    result = apply_regex(
        &RE_CLI_ARG,
        result,
        |_| REDACT_PASSWORD.to_string(),
        SensitiveCategory::Password,
        &mut findings,
    );

    // 6. JWT
    result = apply_regex(
        &RE_JWT,
        result,
        |_| REDACT_JWT.to_string(),
        SensitiveCategory::Jwt,
        &mut findings,
    );

    // 7. API Keys (各种前缀)
    for (re, cat) in [
        (&RE_SK_KEY, SensitiveCategory::ApiKey),
        (&RE_AWS_KEY, SensitiveCategory::ApiKey),
        (&RE_GOOGLE_KEY, SensitiveCategory::ApiKey),
        (&RE_GITHUB_TOKEN, SensitiveCategory::ApiKey),
        (&RE_SLACK_TOKEN, SensitiveCategory::ApiKey),
        (&RE_VERCEL_TOKEN, SensitiveCategory::ApiKey),
        (&RE_OTHER_KEY, SensitiveCategory::ApiKey),
    ] {
        result = apply_regex(
            re,
            result,
            |_| REDACT_API_KEY.to_string(),
            cat,
            &mut findings,
        );
    }

    // 8. Bearer token (残留)
    result = apply_regex(
        &RE_BEARER,
        result,
        |_| REDACT_AUTH.to_string(),
        SensitiveCategory::AuthHeader,
        &mut findings,
    );

    // 9. 绝对路径
    result = apply_regex(
        &RE_UNIX_PATH,
        result,
        |caps| format!("{}{}{}{}", &caps[1], &caps[2], REDACT_PATH, &caps[4]),
        SensitiveCategory::AbsolutePath,
        &mut findings,
    );
    result = apply_regex(
        &RE_WIN_PATH,
        result,
        |caps| format!("{}{}{}", &caps[1], REDACT_PATH, &caps[3]),
        SensitiveCategory::AbsolutePath,
        &mut findings,
    );

    // 10. 邮箱
    result = apply_regex(
        &RE_EMAIL,
        result,
        |caps| format!("{}***@{}", &caps[1], &caps[2]),
        SensitiveCategory::Email,
        &mut findings,
    );

    // 11. 手机号
    result = apply_regex(
        &RE_PHONE,
        result,
        |caps| format!("{}****{}", &caps[1], &caps[3]),
        SensitiveCategory::Phone,
        &mut findings,
    );

    // 12. 通用高熵密钥兜底
    result = apply_regex(
        &RE_GENERIC_SECRET,
        result,
        |_| REDACT_SECRET.to_string(),
        SensitiveCategory::GenericSecret,
        &mut findings,
    );

    SanitizeResult {
        sanitized: result,
        findings,
    }
}

/// 递归对 serde_json::Value 进行脱敏
/// - 字符串值走文本级脱敏
/// - 字段名是 password/secret/token 等时，值直接替换
pub fn sanitize_value(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(sanitize_text(&s).sanitized),
        Value::Array(arr) => Value::Array(arr.into_iter().map(sanitize_value).collect()),
        Value::Object(mut obj) => {
            // 先处理敏感字段名
            let sensitive_keys: Vec<String> = obj
                .iter()
                .filter(|(k, v)| {
                    let lc = k.to_lowercase();
                    v.is_string()
                        && (lc.contains("password")
                            || lc.contains("passwd")
                            || lc == "pwd"
                            || (lc.contains("secret")
                                && !lc.contains("secret_findings")
                                && !lc.contains("sensitive_findings"))
                            || lc.contains("token")
                            || lc.contains("api_key")
                            || lc.contains("apikey")
                            || lc.contains("access_key")
                            || lc.contains("private_key")
                            || lc.contains("client_secret"))
                })
                .map(|(k, _)| k.clone())
                .collect();

            for key in &sensitive_keys {
                if let Some(Value::String(s)) = obj.get(key) {
                    if !s.is_empty() {
                        obj.insert(key.clone(), Value::String(REDACT_PASSWORD.to_string()));
                    }
                }
            }

            // 递归处理其他值
            let mut new_obj = serde_json::Map::new();
            for (k, v) in obj {
                new_obj.insert(k, sanitize_value(v));
            }
            Value::Object(new_obj)
        }
        other => other,
    }
}

/// 对JSON字符串脱敏（先解析再递归脱敏，失败则退回到文本脱敏）
pub fn sanitize_json(json_str: &str) -> SanitizeResult {
    if json_str.is_empty() {
        return SanitizeResult {
            sanitized: json_str.to_string(),
            findings: vec![],
        };
    }

    match serde_json::from_str::<Value>(json_str) {
        Ok(parsed) => {
            let sanitized = sanitize_value(parsed);
            let text_result = sanitize_text(json_str);
            SanitizeResult {
                sanitized: serde_json::to_string_pretty(&sanitized)
                    .unwrap_or_else(|_| text_result.sanitized.clone()),
                findings: text_result.findings,
            }
        }
        Err(_) => sanitize_text(json_str),
    }
}

// ─── 内部辅助 ───

fn apply_regex<F>(
    re: &Regex,
    text: String,
    replacement: F,
    category: SensitiveCategory,
    findings: &mut Vec<SanitizeFinding>,
) -> String
where
    F: Fn(&Captures) -> String,
{
    let mut result = String::with_capacity(text.len());
    let mut last_match = 0usize;

    for cap in re.captures_iter(&text) {
        let m = cap.get(0).unwrap();
        let start = m.start();
        let end = m.end();

        result.push_str(&text[last_match..start]);
        let repl = replacement(&cap);
        findings.push(SanitizeFinding {
            category: category.clone(),
            redacted: repl.clone(),
            position: start,
            match_length: end - start,
        });
        result.push_str(&repl);
        last_match = end;
    }

    result.push_str(&text[last_match..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // 生成一个看起来像JWT的假token（三段式，每段足够长）
    fn fake_jwt() -> String {
        let h = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
        let p = "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
        let s = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        format!("{}.{}.{}", h, p, s)
    }

    // 生成一个假的OpenAI风格API Key
    fn fake_sk_key() -> String {
        format!("sk-{}{}", "a".repeat(40), "b".repeat(8))
    }

    fn fake_aws_key() -> String {
        "AKIAIOSFODNN7EXAMPLE".to_string()
    }

    #[test]
    fn test_jwt_redaction() {
        let token = fake_jwt();
        let input = format!("Authorization: Bearer {}", token);
        let r = sanitize_text(&input);
        assert!(
            r.sanitized.contains(REDACT_JWT) || r.sanitized.contains(REDACT_AUTH),
            "JWT should be redacted in: {}",
            r.sanitized
        );
        assert!(!r.sanitized.contains("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"), "JWT signature must not remain");
        assert!(r.findings.iter().any(|f| f.category == SensitiveCategory::Jwt));
    }

    #[test]
    fn test_api_key_sk() {
        let key = fake_sk_key();
        let input = format!("OPENAI_API_KEY={}", key);
        let r = sanitize_text(&input);
        assert!(r.sanitized.contains(REDACT_API_KEY) || r.sanitized.contains(REDACT_PASSWORD));
        assert!(!r.sanitized.contains(&key));
    }

    #[test]
    fn test_private_key_block() {
        let key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfakekeydata\n-----END RSA PRIVATE KEY-----";
        let r = sanitize_text(key);
        assert!(r.sanitized.contains(REDACT_PRIVATE_KEY));
        assert!(!r.sanitized.contains("MIIEowIBAAKCAQEA"));
    }

    #[test]
    fn test_password_field_json() {
        let input = r#"{"password": "my_secret_pw_123", "username": "admin"}"#;
        let r = sanitize_text(input);
        assert!(r.sanitized.contains(REDACT_PASSWORD));
        assert!(!r.sanitized.contains("my_secret_pw_123"));
        assert!(r.sanitized.contains("admin"));
    }

    #[test]
    fn test_db_url() {
        let url = "postgres://admin:s***@db.example.com:5432/mydb";
        let r = sanitize_text(url);
        assert!(r.sanitized.contains(REDACT_DB_URL));
        assert!(!r.sanitized.contains("supersecretpass"));
    }

    #[test]
    fn test_absolute_path_unix() {
        let input = "File saved at /home/john/projects/test.py";
        let r = sanitize_text(input);
        assert!(r.sanitized.contains(REDACT_PATH));
        assert!(!r.sanitized.contains("/home/john/"));
        assert!(r.sanitized.contains("/projects/test.py"));
    }

    #[test]
    fn test_email_masking() {
        let input = "Contact: john.doe@example.com for more info";
        let r = sanitize_text(input);
        assert!(r.sanitized.contains("j***@example.com"));
        assert!(!r.sanitized.contains("john.doe@"));
    }

    #[test]
    fn test_phone_masking() {
        let input = "我的手机号是13812345678，请联系我";
        let r = sanitize_text(input);
        assert!(r.sanitized.contains("138****5678"));
        assert!(!r.sanitized.contains("13812345678"));
    }

    #[test]
    fn test_aws_key() {
        let key = fake_aws_key();
        let input = format!("AWS_ACCESS_KEY_ID=*** key);
        let r = sanitize_text(&input);
        assert!(r.sanitized.contains(REDACT_API_KEY) || r.sanitized.contains(REDACT_PASSWORD));
        assert!(!r.sanitized.contains(&key));
    }

    #[test]
    fn test_sanitize_json_nested() {
        let key = fake_sk_key();
        let input = serde_json::json!({
            "db": {"password": "secret123"},
            "config": {"apiKey": key},
            "name": "test-project"
        })
        .to_string();
        let r = sanitize_json(&input);
        assert!(!r.sanitized.contains("secret123"), "password must be redacted");
        assert!(!r.sanitized.contains(&key), "apiKey must be redacted");
        assert!(r.sanitized.contains("test-project"), "safe field preserved");
    }

    #[test]
    fn test_clean_text_unchanged() {
        let input = "这是一个正常的短剧剧本，讲述一个普通人的故事。Hello world, this is a script.";
        let r = sanitize_text(input);
        assert_eq!(r.findings.len(), 0);
        assert_eq!(r.sanitized, input);
    }

    #[test]
    fn test_cli_password_arg() {
        let input = "./deploy.sh --password=mysecret123 --host example.com";
        let r = sanitize_text(input);
        assert!(r.sanitized.contains(REDACT_PASSWORD));
        assert!(!r.sanitized.contains("mysecret123"));
        assert!(r.sanitized.contains("--host example.com"));
    }

    #[test]
    fn test_sanitize_value_recursive() {
        let key = fake_sk_key();
        let val = serde_json::json!({
            "name": "demo",
            "db": {
                "password": "topsecret",
                "host": "localhost"
            },
            "tokens": ["abc", {"api_key": key}]
        });
        let out = sanitize_value(val);
        let s = serde_json::to_string(&out).unwrap();
        assert!(s.contains(REDACT_PASSWORD) || s.contains(REDACT_API_KEY));
        assert!(!s.contains("topsecret"));
        assert!(!s.contains(&key));
        assert!(s.contains("demo"));
        assert!(s.contains("localhost"));
    }
}
