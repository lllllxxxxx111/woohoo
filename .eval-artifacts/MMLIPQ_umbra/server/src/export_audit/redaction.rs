//! 敏感信息剔除：递归扫描进入导出包的 JSON 和文本，替换 API key、JWT、密码、密钥、绝对路径。
//!
//! 设计原则：
//! 1. **宁可误杀也不能泄露**：对疑似敏感内容直接替换为 `[REDACTED]`，不做解密/校验。
//! 2. **双层防护**：
//!    - JSON 层：按 key 名称白名单命中 → 无条件替换 value。
//!    - 文本层：在任意字符串值/Markdown 里按特征模式扫描替换。
//! 3. **无依赖**：纯手写模式匹配，避免引入 regex crate。
//! 4. **计数**：记录替换命中数，可写入验证报告供人工审计。

use serde_json::{Map, Value};
use std::collections::HashSet;

/// 敏感 key 名称（小写比较，命中即替换 value）
/// 覆盖常见命名：apiKey/api_key, secretKey, password, token, authorization, jwt,
/// private_key, access_token, refresh_token, openai/api key, bearer 等。
const SENSITIVE_KEYS: &[&str] = &[
    "apikey",
    "api_key",
    "apisecret",
    "api_secret",
    "secretkey",
    "secret_key",
    "secret",
    "clientsecret",
    "client_secret",
    "password",
    "passwd",
    "pwd",
    "token",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "authtoken",
    "auth_token",
    "authorization",
    "auth",
    "jwt",
    "bearer",
    "privatekey",
    "private_key",
    "openai_api_key",
    "openaikey",
    "anthropic_api_key",
    "anthropickey",
    "aws_secret_access_key",
    "aws_access_key_id",
    "database_url",
    "databaseurl",
    "db_url",
    "db_password",
    "dbpassword",
    "connectionstring",
    "connection_string",
    "webhook_secret",
    "webhooksecret",
    "signing_key",
    "signingkey",
    "encryption_key",
    "encryptionkey",
];

/// 替换文本
const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Default, Clone)]
pub struct RedactionReport {
    /// 按 key 命中的次数
    pub key_hits: usize,
    /// 在文本/字符串中按模式命中的次数
    pub pattern_hits: usize,
    /// 去重后的敏感 key 名称（小写）
    pub matched_keys: HashSet<String>,
    /// 命中的模式类型标签
    pub matched_patterns: HashSet<String>,
}

impl RedactionReport {
    pub fn total(&self) -> usize {
        self.key_hits + self.pattern_hits
    }
}

// ── 公共入口 ──────────────────────────────────────

/// 递归处理一个 serde_json::Value，原地替换敏感字段和字符串内容。
pub fn redact_value(value: &mut Value) -> RedactionReport {
    let mut report = RedactionReport::default();
    redact_value_inner(value, &mut report);
    report
}

/// 对自由文本（Markdown、消息内容）做敏感模式扫描替换。
pub fn redact_text(input: &str) -> (String, RedactionReport) {
    let mut report = RedactionReport::default();
    let out = redact_string_content(input, &mut report);
    (out, report)
}

/// 对字符串做 JSON 序列后再反序列的便捷方法（用于 JSON 字符串字段内嵌的 JSON）
pub fn redact_json_text(input: &str) -> (String, RedactionReport) {
    let mut report = RedactionReport::default();
    match serde_json::from_str::<Value>(input) {
        Ok(mut v) => {
            let sub = redact_value(&mut v);
            report.merge(sub);
            (serde_json::to_string(&v).unwrap_or_else(|_| input.to_string()), report)
        }
        Err(_) => {
            // 不是合法 JSON，降级为普通文本扫描
            let out = redact_string_content(input, &mut report);
            (out, report)
        }
    }
}

// ── 核心递归 ──────────────────────────────────────

fn redact_value_inner(value: &mut Value, report: &mut RedactionReport) {
    match value {
        Value::Object(map) => {
            redact_object(map, report);
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                redact_value_inner(item, report);
            }
        }
        Value::String(s) => {
            let new = redact_string_content(s, report);
            if new != *s {
                *s = new;
            }
        }
        _ => {}
    }
}

fn redact_object(map: &mut Map<String, Value>, report: &mut RedactionReport) {
    // 先收集需要替换的 key，再遍历值（避免借用冲突）
    let mut keys_to_redact: Vec<String> = Vec::new();
    for (k, v) in map.iter() {
        let key_lower = k.to_ascii_lowercase();
        if SENSITIVE_KEYS.contains(&key_lower.as_str()) {
            keys_to_redact.push(k.clone());
            report.key_hits += 1;
            report.matched_keys.insert(key_lower);
            let _ = v; // don't need the value here
        }
    }
    for k in keys_to_redact {
        map.insert(k, Value::String(REDACTED.into()));
    }

    // 然后递归处理其他值（注意：上面被替换为 REDACTED 的字段仍然是 String，
    // 但它不含敏感内容，redact_value_inner 不会再改动它）
    for (_k, v) in map.iter_mut() {
        if v.is_string() && v.as_str() == Some(REDACTED) {
            continue;
        }
        redact_value_inner(v, report);
    }
}

// ── 字符串内容扫描 ────────────────────────────────

fn redact_string_content(input: &str, report: &mut RedactionReport) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        // 依次尝试各个模式
        let mut matched_len = 0usize;

        // 1) JWT: eyJ....(2+ dots, long base64url segments)
        if let Some(n) = match_jwt(bytes, i) {
            matched_len = n;
            report.pattern_hits += 1;
            report.matched_patterns.insert("jwt".into());
        }
        // 2) Bearer <token>
        else if let Some(n) = match_bearer(bytes, i) {
            matched_len = n;
            report.pattern_hits += 1;
            report.matched_patterns.insert("bearer".into());
        }
        // 3) sk-... / sk-proj-... / sk-ant-... (OpenAI/Anthropic style)
        else if let Some(n) = match_sk_key(bytes, i) {
            matched_len = n;
            report.pattern_hits += 1;
            report.matched_patterns.insert("api_key_sk".into());
        }
        // 4) AI/API key assignments in text: api_key = "xxx" | apiKey: xxx
        else if let Some(n) = match_keyword_assignment(bytes, i) {
            matched_len = n;
            report.pattern_hits += 1;
            report.matched_patterns.insert("keyword_assignment".into());
        }
        // 5) xai- / ak- / pk- / rk- style 20+ char keys
        else if let Some(n) = match_generic_key_prefix(bytes, i) {
            matched_len = n;
            report.pattern_hits += 1;
            report.matched_patterns.insert("generic_key_prefix".into());
        }
        // 6) /home/<user>/... or /Users/<user>/... absolute paths
        else if let Some(n) = match_home_path(bytes, i) {
            matched_len = n;
            report.pattern_hits += 1;
            report.matched_patterns.insert("home_path".into());
        }
        // 7) Long hex strings (64+ hex chars) = likely hash/private key fragment
        else if let Some(n) = match_long_hex(bytes, i) {
            matched_len = n;
            report.pattern_hits += 1;
            report.matched_patterns.insert("long_hex".into());
        }

        if matched_len > 0 {
            out.push_str(REDACTED);
            i += matched_len;
        } else {
            // 逐字符复制（按 UTF-8 边界）
            let c = input[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }

    out
}

// ── 模式匹配器 ────────────────────────────────────
//
// 所有 match 函数都从字节切片的 offset 处尝试匹配；成功返回消耗的字节数，失败返回 None。

/// JWT: `eyJ` 开头，后接 base64url 字符、点号、再来一段 base64url、点号、第三段 base64url。
/// 要求总长度 ≥ 40（三个段各至少若干字符）。
fn match_jwt(bytes: &[u8], i: usize) -> Option<usize> {
    // 前缀: 'e','y','J'
    if i + 3 > bytes.len() || &bytes[i..i + 3] != b"eyJ" {
        return None;
    }
    // 前一个字符不能是字母数字（避免把普通单词中的 eyJ 匹配上）
    if i > 0 {
        let prev = bytes[i - 1];
        if prev.is_ascii_alphanumeric() || prev == b'_' {
            return None;
        }
    }
    let start = i;
    let mut dots = 0u32;
    let mut j = i;
    while j < bytes.len() {
        let b = bytes[j];
        if b == b'.' {
            dots += 1;
            j += 1;
            if dots >= 2 {
                // 还得有第三个 segment
                continue;
            }
        } else if is_base64url(b) {
            j += 1;
        } else {
            break;
        }
    }
    let total = j - start;
    if dots >= 2 && total >= 40 {
        // 确保末尾后一个字符不是字母数字（截断保护）
        if j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-') {
            return None;
        }
        Some(total)
    } else {
        None
    }
}

/// Bearer <token>  — 匹配 "Bearer " 后跟 ≥20 个非空白字符
fn match_bearer(bytes: &[u8], i: usize) -> Option<usize> {
    // 不区分大小写，但要求完整词 "bearer"
    let word = b"bearer ";
    let word2 = b"Bearer ";
    let word3 = b"BEARER ";
    let wlen = word.len();
    if i + wlen > bytes.len() {
        return None;
    }
    let prefix = &bytes[i..i + wlen];
    if prefix != word && prefix != word2 && prefix != word3 {
        return None;
    }
    // 前面不能是字母
    if i > 0 && bytes[i - 1].is_ascii_alphabetic() {
        return None;
    }
    let mut j = i + wlen;
    while j < bytes.len() && !bytes[j].is_ascii_whitespace() && bytes[j] != b'"' && bytes[j] != b'\'' && bytes[j] != b',' && bytes[j] != b'}' && bytes[j] != b']' {
        j += 1;
    }
    let token_len = j - (i + wlen);
    if token_len >= 20 {
        Some(j - i)
    } else {
        None
    }
}

/// sk- / sk-proj- / sk-ant- / sk-live- / sk-test-
fn match_sk_key(bytes: &[u8], i: usize) -> Option<usize> {
    // 边界
    if i > 0 {
        let prev = bytes[i - 1];
        if prev.is_ascii_alphanumeric() || prev == b'_' {
            return None;
        }
    }
    let prefixes: &[&[u8]] = &[
        b"sk-proj-",
        b"sk-ant-",
        b"sk-live-",
        b"sk-test-",
        b"sk-",
    ];
    for p in prefixes {
        if i + p.len() > bytes.len() {
            continue;
        }
        if &bytes[i..i + p.len()] == *p {
            // 之后必须有 ≥ 20 个 key 字符
            let mut j = i + p.len();
            while j < bytes.len() && is_key_char(bytes[j]) {
                j += 1;
            }
            let key_len = j - (i + p.len());
            if key_len >= 20 {
                return Some(j - i);
            }
        }
    }
    None
}

/// 关键词赋值：`api_key=` / `apiKey = ` / `password:` 等后面的字面值
fn match_keyword_assignment(bytes: &[u8], i: usize) -> Option<usize> {
    // 在位置 i 尝试识别 "<keyword><sep><quote?>...<quote?>" 整体
    // keyword 列表
    static KWS: &[&[u8]] = &[
        b"api_key", b"apikey", b"api-key",
        b"secret_key", b"secretkey", b"secret-key",
        b"access_token", b"accesstoken",
        b"refresh_token", b"refreshtoken",
        b"password", b"passwd", b"pwd",
        b"authorization", b"auth_token", b"authtoken",
        b"private_key", b"privatekey",
        b"database_url", b"connection_string",
        b"jwt", b"bearer",
    ];
    for kw in KWS {
        let klen = kw.len();
        if i + klen > bytes.len() {
            continue;
        }
        // 大小写不敏感比较
        let slice = &bytes[i..i + klen];
        if !slice.eq_ignore_ascii_case(kw) {
            continue;
        }
        // 前面不能是字母
        if i > 0 && bytes[i - 1].is_ascii_alphabetic() {
            continue;
        }
        let mut j = i + klen;
        // 可选空白 + 分隔符 (: =)
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() {
            continue;
        }
        if bytes[j] != b':' && bytes[j] != b'=' {
            continue;
        }
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        // 可选引号
        let quote = if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
            let q = bytes[j];
            j += 1;
            Some(q)
        } else {
            None
        };
        // 读取 value 直到结束符
        let value_start = j;
        while j < bytes.len() {
            let b = bytes[j];
            if let Some(q) = quote {
                if b == q {
                    j += 1;
                    break;
                }
            } else if b == b',' || b == b';' || b == b'\n' || b == b'\r' || b == b'}' || b == b']' {
                break;
            } else if b.is_ascii_whitespace() && quote.is_none() {
                break;
            }
            j += 1;
        }
        let value_len = j - value_start;
        // 要求值 ≥ 8 个字符（否则不像密钥）
        if value_len >= 8 {
            return Some(j - i);
        }
    }
    None
}

/// 通用 key 前缀：xai-... ak-... pk-_live-... 后跟 ≥20 key 字符
fn match_generic_key_prefix(bytes: &[u8], i: usize) -> Option<usize> {
    if i > 0 {
        let prev = bytes[i - 1];
        if prev.is_ascii_alphanumeric() || prev == b'_' {
            return None;
        }
    }
    let prefixes: &[&[u8]] = &[b"xai-", b"ak-", b"pk-", b"rk-", b"ghp_", b"github_pat_", b"gho_"];
    for p in prefixes {
        if i + p.len() > bytes.len() {
            continue;
        }
        if &bytes[i..i + p.len()] == *p {
            let mut j = i + p.len();
            while j < bytes.len() && is_key_char(bytes[j]) {
                j += 1;
            }
            let key_len = j - (i + p.len());
            if key_len >= 20 {
                return Some(j - i);
            }
        }
    }
    None
}

/// /home/<name>/... 或 /Users/<name>/... 路径：替换到下一个空白/引号/逗号/括号，同时脱敏用户名
fn match_home_path(bytes: &[u8], i: usize) -> Option<usize> {
    // 前缀
    let prefixes: &[&[u8]] = &[b"/home/", b"/Users/"];
    for p in prefixes {
        if i + p.len() > bytes.len() {
            continue;
        }
        if &bytes[i..i + p.len()] == *p {
            let mut j = i + p.len();
            // 读取 username（直到下一个 / 或空白）
            while j < bytes.len() && bytes[j] != b'/' && !bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            // 现在 j 指向 / 或结尾。继续吞路径直到分隔符
            while j < bytes.len() && !bytes[j].is_ascii_whitespace()
                && bytes[j] != b'"' && bytes[j] != b'\'' && bytes[j] != b','
                && bytes[j] != b')' && bytes[j] != b'}' && bytes[j] != b']'
            {
                j += 1;
            }
            let total = j - i;
            if total > p.len() + 1 {
                return Some(total);
            }
        }
    }
    None
}

/// 长 hex 串（64+ 个连续 hex 字符）：很可能是私钥片段/hash
fn match_long_hex(bytes: &[u8], i: usize) -> Option<usize> {
    if !bytes[i].is_ascii_hexdigit() {
        return None;
    }
    // 边界
    if i > 0 {
        let prev = bytes[i - 1];
        if prev.is_ascii_hexdigit() {
            return None;
        }
    }
    let mut j = i;
    while j < bytes.len() && bytes[j].is_ascii_hexdigit() {
        j += 1;
    }
    let run = j - i;
    if run >= 64 {
        // 后边界
        if j < bytes.len() && bytes[j].is_ascii_hexdigit() {
            return None;
        }
        Some(run)
    } else {
        None
    }
}

// ── 字符类别辅助 ──────────────────────────────────

fn is_base64url(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// 常见 API key 字符集：字母数字 + - _ .
fn is_key_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.'
}

// ── 测试 ──────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_jwt_in_text() {
        // Realistic JWT with 3 segments: header.payload.signature (all ≥ 20 chars base64url)
        let token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        let input = format!("Authorization: Bearer {}", token);
        let (out, r) = redact_text(&input);
        assert!(out.contains(REDACTED), "output: {}", out);
        assert!(!out.contains("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"), "token leaked: {}", out);
        assert!(r.pattern_hits >= 1);
    }

    #[test]
    fn redacts_openai_sk_key() {
        let key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzGHIJ";
        let input = format!("openai_api_key = \"{}\"", key);
        let (out, _) = redact_text(&input);
        assert!(!out.contains("sk-proj-ABCDEFG"), "key leaked: {}", out);
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn redacts_anthropic_style_key() {
        let key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyzlong";
        let (out, _) = redact_text(&format!("key: {}", key));
        assert!(!out.contains("sk-ant-api03"));
    }

    #[test]
    fn redacts_sk_plain() {
        let key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
        let (out, _) = redact_text(&format!("token = {}", key));
        assert!(!out.contains("sk-abcdefgh"), "leaked: {}", out);
    }

    #[test]
    fn redacts_password_assignment_inline() {
        let input = "database_url=postgres://user:secretpass123@db:5432/app";
        let (out, r) = redact_text(input);
        assert!(!out.contains("secretpass123"), "out={}", out);
        assert!(r.pattern_hits >= 1);
    }

    #[test]
    fn redacts_home_path() {
        let input = "source_path: /home/claude-user/projects/myproject/main.rs";
        let (out, _) = redact_text(input);
        assert!(!out.contains("/home/claude-user"), "leaked: {}", out);
    }

    #[test]
    fn redacts_users_path() {
        let input = "cwd is /Users/alice/Developer/app";
        let (out, _) = redact_text(input);
        assert!(!out.contains("/Users/alice"), "leaked: {}", out);
    }

    #[test]
    fn redacts_github_pat() {
        let key = "ghp_abcdefghijklmnopqrstuvwxyz01234567890ABCDEFGHIJabcd";
        let (out, _) = redact_text(&format!("GITHUB_TOKEN={}", key));
        assert!(!out.contains("ghp_abcdefghijk"), "leaked: {}", out);
    }

    #[test]
    fn leaves_short_strings_alone() {
        let input = "hello world, this is normal text with no secrets";
        let (out, r) = redact_text(input);
        assert_eq!(out, input);
        assert_eq!(r.pattern_hits, 0);
    }

    #[test]
    fn leaves_non_key_sk_words_alone() {
        // "skeleton" starts with sk but should NOT be matched (no dash, word boundary)
        let input = "the skeleton of the skill system works";
        let (out, r) = redact_text(input);
        assert_eq!(out, input, "mangled to: {}", out);
        assert_eq!(r.pattern_hits, 0);
    }

    #[test]
    fn redacts_json_by_key_name() {
        let mut v = json!({
            "name": "my-project",
            "apiKey": "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopGKEY",
            "database": {
                "password": "super-secret-pw-123",
                "host": "db.example.com"
            },
            "items": [
                {"authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"},
                {"normal": "value"}
            ]
        });
        let r = redact_value(&mut v);
        let s = serde_json::to_string(&v).unwrap();
        assert!(s.contains(REDACTED), "no redaction in {}", s);
        assert!(!s.contains("sk-proj-ABCDEFG"), "key leaked: {}", s);
        assert!(!s.contains("super-secret-pw"), "pw leaked: {}", s);
        assert!(!s.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "jwt leaked: {}", s);
        // normal fields preserved
        assert!(s.contains("my-project"));
        assert!(s.contains("db.example.com"));
        assert!(s.contains("value"));
        assert!(r.key_hits >= 3);
    }

    #[test]
    fn redacts_long_hex_private_key_looking_strings() {
        let hex: String = "a".repeat(80);
        let input = format!("private_key_hex = {}", hex);
        let (out, _) = redact_text(&input);
        assert!(!out.contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "hex leaked");
    }

    #[test]
    fn idempotent_on_redacted_text() {
        let input = "api_key = [REDACTED]";
        let (out, r) = redact_text(input);
        assert_eq!(out, input);
        assert_eq!(r.pattern_hits, 0, "should not re-redact");
    }

    #[test]
    fn redacts_xai_prefix_key() {
        let key = "xai-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHlongenuf";
        let (out, _) = redact_text(&format!("token={}", key));
        assert!(!out.contains("xai-abcdefgh"), "leaked: {}", out);
    }
