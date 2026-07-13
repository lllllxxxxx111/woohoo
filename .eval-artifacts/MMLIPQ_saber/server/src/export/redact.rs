//! Sensitive information redaction.
//!
//! Mirrors the frontend `redaction.ts` module. Strips API keys, JWTs,
//! passwords, private keys, PII, and local absolute paths from text
//! before it enters an export package or audit log.
//!
//! Uses hand-rolled pattern scanners (no regex dependency). False positives
//! are acceptable; the manifest reports redactions for operator review.

use std::collections::HashMap;

pub const PLACEHOLDER: &str = "[REDACTED]";

/// Categories of sensitive information.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RedactionCategory {
    ApiKey,
    Jwt,
    Password,
    PrivateKey,
    AuthHeader,
    Email,
    PhoneCn,
    IdCardCn,
    CreditCard,
    LocalPath,
    AwsKey,
    OpenAiKey,
    GenericSecret,
}

impl RedactionCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::Jwt => "jwt",
            Self::Password => "password",
            Self::PrivateKey => "private_key",
            Self::AuthHeader => "auth_header",
            Self::Email => "email",
            Self::PhoneCn => "phone_cn",
            Self::IdCardCn => "id_card_cn",
            Self::CreditCard => "credit_card",
            Self::LocalPath => "local_path",
            Self::AwsKey => "aws_key",
            Self::OpenAiKey => "openai_key",
            Self::GenericSecret => "generic_secret",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub category: RedactionCategory,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RedactionResult {
    pub redacted_text: String,
    pub total_redactions: usize,
    pub by_category: HashMap<RedactionCategory, usize>,
}

// ─── Scanner helpers ────────────────────────────────────────────────

fn starts_with_at(b: &[u8], i: usize, pat: &[u8]) -> bool {
    b.len() >= i + pat.len() && &b[i..i + pat.len()] == pat
}

// ─── OpenAI-style sk-... keys (20+ alphanum/-/_ after sk-) ────────

fn scan_openai_keys(s: &str) -> Vec<Match> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 23 <= b.len() {
        if b[i] == b's' && b[i + 1] == b'k' && b[i + 2] == b'-' {
            let mut j = i + 3;
            while j < b.len() {
                let c = b[j];
                if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' {
                    j += 1;
                } else {
                    break;
                }
            }
            if j - (i + 3) >= 20 {
                out.push(Match { category: RedactionCategory::OpenAiKey, start: i, end: j });
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

// ─── AWS AKIA... keys (16 uppercase alnum after AKIA) ─────────────

fn scan_aws_keys(s: &str) -> Vec<Match> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 20 <= b.len() {
        if starts_with_at(b, i, b"AKIA") {
            let mut j = i + 4;
            let mut valid = true;
            for _ in 0..16 {
                if j >= b.len() || !(b[j].is_ascii_uppercase() || b[j].is_ascii_digit()) {
                    valid = false;
                    break;
                }
                j += 1;
            }
            if valid {
                out.push(Match { category: RedactionCategory::AwsKey, start: i, end: j });
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

// ─── JWT: eyJ...seg1.seg2.seg3 (3+ segments, dots) ───────────────

fn scan_jwt(s: &str) -> Vec<Match> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if i + 3 <= b.len() && starts_with_at(b, i, b"eyJ") {
            let start = i;
            let mut j = i;
            let mut dots = 0u32;
            while j < b.len() {
                let c = b[j];
                if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c == b'+' || c == b'/'
                    || c == b'='
                {
                    j += 1;
                } else if c == b'.' && dots < 2 {
                    dots += 1;
                    j += 1;
                } else {
                    break;
                }
            }
            if dots == 2 && j - start >= 30 {
                out.push(Match { category: RedactionCategory::Jwt, start, end: j });
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

// ─── Generic key=value secret assignments ────────────────────────

fn scan_kv(s: &str, keys: &[&str], category: RedactionCategory) -> Vec<Match> {
    let b = s.as_bytes();
    let lower = s.to_lowercase();
    let lb = lower.as_bytes();
    let mut out = Vec::new();

    for key in keys {
        let kb = key.to_lowercase().into_bytes();
        let mut i = 0;
        while i + kb.len() < b.len() {
            if lb[i..i + kb.len()] == *kb {
                let mut j = i + kb.len();
                while j < b.len() && matches!(b[j], b' ' | b'"' | b'\'' | b'=' | b':') {
                    j += 1;
                }
                let val_start = j;
                while j < b.len() {
                    let c = b[j];
                    if matches!(
                        c,
                        b' ' | b',' | b';' | b'}' | b')' | b']' | b'"' | b'\'' | b'\n' | b'\r' | b'\t'
                    ) {
                        break;
                    }
                    j += 1;
                }
                if j - val_start >= 6 {
                    out.push(Match { category, start: i, end: j });
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
    }
    out
}

// ─── PEM private key blocks ──────────────────────────────────────

fn scan_private_keys(s: &str) -> Vec<Match> {
    let pairs: &[(&str, &str)] = &[
        ("-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"),
        ("-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"),
        ("-----BEGIN EC PRIVATE KEY-----", "-----END EC PRIVATE KEY-----"),
        ("-----BEGIN DSA PRIVATE KEY-----", "-----END DSA PRIVATE KEY-----"),
        ("-----BEGIN OPENSSH PRIVATE KEY-----", "-----END OPENSSH PRIVATE KEY-----"),
        ("-----BEGIN PGP PRIVATE KEY BLOCK-----", "-----END PGP PRIVATE KEY BLOCK-----"),
    ];

    let mut out = Vec::new();
    for (begin, end) in pairs {
        let mut search_from = 0;
        while let Some(start) = s[search_from..].find(begin) {
            let abs_start = search_from + start;
            if let Some(rel_end) = s[abs_start..].find(end) {
                let abs_end = abs_start + rel_end + end.len();
                out.push(Match {
                    category: RedactionCategory::PrivateKey,
                    start: abs_start,
                    end: abs_end,
                });
                search_from = abs_end;
            } else {
                break;
            }
        }
    }
    out
}

// ─── Email addresses ─────────────────────────────────────────────

fn scan_emails(s: &str) -> Vec<Match> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'@' {
            let mut start = i;
            while start > 0 {
                let c = b[start - 1];
                if c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'%' || c == b'+'
                    || c == b'-'
                {
                    start -= 1;
                } else {
                    break;
                }
            }
            let mut end = i + 1;
            while end < b.len() {
                let c = b[end];
                if c.is_ascii_alphanumeric() || c == b'.' || c == b'-' {
                    end += 1;
                } else {
                    break;
                }
            }
            if s[i..end].contains('.') && end - start > 5 {
                out.push(Match { category: RedactionCategory::Email, start, end });
            }
            i = end;
            continue;
        }
        i += 1;
    }
    out
}

// ─── China mobile: 1[3-9] + 9 digits, word boundaries ───────────

fn scan_phone_cn(s: &str) -> Vec<Match> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    if b.len() < 11 {
        return out;
    }
    for i in 0..=b.len() - 11 {
        if b[i] == b'1' && b[i + 1].is_ascii_digit() && (b'3'..=b'9').contains(&b[i + 1]) {
            let mut all_digits = true;
            for j in 0..11 {
                if !b[i + j].is_ascii_digit() {
                    all_digits = false;
                    break;
                }
            }
            if !all_digits {
                continue;
            }
            let before_ok = i == 0 || !b[i - 1].is_ascii_digit();
            let after_ok = i + 11 >= b.len() || !b[i + 11].is_ascii_digit();
            if before_ok && after_ok {
                out.push(Match { category: RedactionCategory::PhoneCn, start: i, end: i + 11 });
            }
        }
    }
    out
}

// ─── China ID card: 18 digits (last may be X) ───────────────────

fn scan_id_card_cn(s: &str) -> Vec<Match> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    if b.len() < 18 {
        return out;
    }
    for i in 0..=b.len() - 18 {
        let mut valid = true;
        for j in 0..17 {
            if !b[i + j].is_ascii_digit() {
                valid = false;
                break;
            }
        }
        if !valid {
            continue;
        }
        let last = b[i + 17];
        if !(last.is_ascii_digit() || last == b'X' || last == b'x') {
            continue;
        }
        let before_ok = i == 0 || !b[i - 1].is_ascii_digit();
        let after_ok = i + 18 >= b.len() || !b[i + 18].is_ascii_digit();
        if before_ok && after_ok {
            out.push(Match { category: RedactionCategory::IdCardCn, start: i, end: i + 18 });
        }
    }
    out
}

// ─── Credit-card-like 13-19 digit runs ───────────────────────────

fn scan_credit_cards(s: &str) -> Vec<Match> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 13 <= b.len() {
        let mut j = i;
        let mut digits = 0u32;
        while j < b.len() && digits < 19 {
            if b[j].is_ascii_digit() {
                digits += 1;
                j += 1;
            } else if (b[j] == b' ' || b[j] == b'-') && digits > 0 && digits < 16 {
                j += 1;
            } else {
                break;
            }
        }
        if (13..=19).contains(&digits) {
            let before_ok = i == 0 || !b[i - 1].is_ascii_digit();
            let after_ok = j >= b.len() || !b[j].is_ascii_digit();
            if before_ok && after_ok {
                out.push(Match { category: RedactionCategory::CreditCard, start: i, end: j });
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

// ─── Local paths: /home/<user>, /Users/<user>, C:\Users\<user> ──

fn scan_local_paths(s: &str) -> Vec<Match> {
    let mut out = Vec::new();

    for prefix in ["/home/", "/Users/"] {
        let prefix_bytes = prefix.as_bytes();
        let mut search_from = 0;
        let b = s.as_bytes();
        while let Some(p_idx) = s[search_from..].find(prefix) {
            let abs_p = search_from + p_idx + prefix_bytes.len();
            let mut end = abs_p;
            while end < b.len()
                && !matches!(
                    b[end],
                    b'/' | b' ' | b'"' | b'\'' | b'\n' | b'\r' | b'\t' | b',' | b')' | b'}' | b']'
                )
            {
                end += 1;
            }
            if end > abs_p {
                out.push(Match {
                    category: RedactionCategory::LocalPath,
                    start: search_from + p_idx,
                    end,
                });
            }
            search_from = end.max(search_from + p_idx + prefix_bytes.len() + 1);
        }
    }

    let lower = s.to_lowercase();
    let mut search_from = 0;
    while let Some(p_idx) = lower[search_from..].find(":\\users\\") {
        let abs_p = search_from + p_idx + 8;
        let b = s.as_bytes();
        let mut end = abs_p;
        while end < b.len() && !matches!(b[end], b'\\' | b'/' | b' ' | b'"' | b'\'' | b'\n') {
            end += 1;
        }
        if end > abs_p {
            out.push(Match { category: RedactionCategory::LocalPath, start: search_from + p_idx, end });
        }
        search_from = end.max(abs_p + 1);
    }

    out
}

// ─── Authorization: Bearer <token> ──────────────────────────────

fn scan_auth_headers(s: &str) -> Vec<Match> {
    let lower = s.to_lowercase();
    let b = s.as_bytes();
    let lb = lower.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 7 < b.len() {
        if &lb[i..i + 7] == b"bearer " {
            let start = i;
            let mut j = i + 7;
            while j < b.len() && matches!(b[j], b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' | b'.' | b'_' | b'-' | b'=') {
                j += 1;
            }
            if j - (i + 7) >= 10 {
                out.push(Match { category: RedactionCategory::AuthHeader, start, end: j });
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

// ─── Public API ────────────────────────────────────────────────────

/// Redact sensitive information from a text string.
pub fn redact_text(input: &str) -> RedactionResult {
    if input.is_empty() {
        return RedactionResult {
            redacted_text: String::new(),
            total_redactions: 0,
            by_category: HashMap::new(),
        };
    }

    let mut all_matches: Vec<Match> = Vec::new();
    all_matches.extend(scan_private_keys(input));
    all_matches.extend(scan_openai_keys(input));
    all_matches.extend(scan_aws_keys(input));
    all_matches.extend(scan_jwt(input));
    all_matches.extend(scan_auth_headers(input));
    all_matches.extend(scan_kv(
        input,
        &[
            "api_key", "apikey", "api key", "api-key",
            "secret_key", "secret key", "secret=", "secret:",
            "password", "passwd", "pwd", "token", "credential",
        ],
        RedactionCategory::Password,
    ));
    all_matches.extend(scan_kv(
        input,
        &[
            "database_url", "db_password", "redis_url", "smtp_password",
            "jwt_secret", "webhook_secret",
        ],
        RedactionCategory::GenericSecret,
    ));
    all_matches.extend(scan_emails(input));
    all_matches.extend(scan_phone_cn(input));
    all_matches.extend(scan_id_card_cn(input));
    all_matches.extend(scan_credit_cards(input));
    all_matches.extend(scan_local_paths(input));
    all_matches.extend(scan_kv(
        input,
        &["api_", "app_key", "access_key"],
        RedactionCategory::ApiKey,
    ));

    if all_matches.is_empty() {
        return RedactionResult {
            redacted_text: input.to_string(),
            total_redactions: 0,
            by_category: HashMap::new(),
        };
    }

    // Sort by start, longest first for same start; drop overlaps
    all_matches.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut deduped: Vec<Match> = Vec::new();
    let mut last_end = 0;
    for m in all_matches {
        if m.start >= last_end {
            last_end = m.end;
            deduped.push(m);
        }
    }

    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    let mut by_category: HashMap<RedactionCategory, usize> = HashMap::new();
    for m in &deduped {
        out.push_str(&input[cursor..m.start]);
        if m.category == RedactionCategory::LocalPath {
            // Preserve the "/home/" or "/Users/" prefix for readability
            let text = &input[m.start..m.end];
            if let Some(slash_idx) = text.find('/') {
                let prefix_end = m.start + slash_idx + 1;
                if let Some(next_slash) = text[slash_idx + 1..].find('/') {
                    let username_end = m.start + slash_idx + 1 + next_slash;
                    out.push_str(&input[m.start..username_end]);
                    out.push_str(PLACEHOLDER);
                    // Keep trailing path
                    // Actually replace just the username portion
                    // Re-do: write prefix up to second slash, then PLACEHOLDER
                } else {
                    out.push_str(&input[m.start..prefix_end]);
                    out.push_str(PLACEHOLDER);
                }
            } else {
                out.push_str(PLACEHOLDER);
            }
        } else {
            out.push_str(PLACEHOLDER);
        }
        *by_category.entry(m.category).or_insert(0) += 1;
        cursor = m.end;
    }
    out.push_str(&input[cursor..]);

    RedactionResult {
        redacted_text: out,
        total_redactions: deduped.len(),
        by_category,
    }
}

/// Returns true if any scanner would flag this text.
pub fn has_sensitive_info(input: &str) -> bool {
    redact_text(input).total_redactions > 0
}

// ─── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_openai_key() {
        let r = redact_text("key is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ01 done");
        assert_eq!(r.total_redactions, 1);
        assert!(r.redacted_text.contains(PLACEHOLDER));
        assert!(!r.redacted_text.contains("ABCDEFGHIJKLMNOPQRSTUVWXYZ01"));
    }

    #[test]
    fn test_aws_key() {
        let r = redact_text("AKIAIOSFODNN7EXAMPLE key");
        assert_eq!(r.total_redactions, 1);
        assert!(!r.redacted_text.contains("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn test_jwt() {
        let token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let r = redact_text(&format!("Bearer {}", token));
        assert!(r.total_redactions >= 1);
        assert!(!r.redacted_text.contains("eyJzdWIi"));
    }

    #[test]
    fn test_password_kv() {
        let r = redact_text("password=hunter22_notshown end");
        assert_eq!(r.total_redactions, 1);
        assert!(!r.redacted_text.contains("hunter22"));
    }

    #[test]
    fn test_email() {
        let r = redact_text("contact support@example.com for help");
        assert_eq!(r.total_redactions, 1);
        assert!(!r.redacted_text.contains("support@example.com"));
    }

    #[test]
    fn test_phone_cn() {
        let r = redact_text("call 13812345678 please");
        assert_eq!(r.total_redactions, 1);
        assert!(!r.redacted_text.contains("13812345678"));
    }

    #[test]
    fn test_id_card_cn() {
        let r = redact_text("id 110101199001011234 check");
        assert!(r.total_redactions >= 1);
        assert!(!r.redacted_text.contains("110101199001011234"));
    }

    #[test]
    fn test_home_path() {
        let r = redact_text("file at /home/alice/documents/secret.txt");
        assert!(r.redacted_text.contains(PLACEHOLDER));
        assert!(!r.redacted_text.contains("alice"));
    }

    #[test]
    fn test_users_path() {
        let r = redact_text("in /Users/bob/Library/");
        assert!(r.redacted_text.contains(PLACEHOLDER));
        assert!(!r.redacted_text.contains("bob"));
    }

    #[test]
    fn test_clean_text_no_false_positive() {
        let clean = "这是一个关于 25 个镜头的短剧项目，描述主角在城市中的冒险。";
        let r = redact_text(clean);
        assert_eq!(r.total_redactions, 0);
        assert_eq!(r.redacted_text, clean);
    }

    #[test]
    fn test_year_not_phone() {
        let r = redact_text("year 2024 episode 12");
        assert_eq!(r.total_redactions, 0);
    }

    #[test]
    fn test_multiple_matches() {
        let txt = "sk-abcdefghijklmnopqrstuvwxyz01 password=hunter22 a@b.com";
        let r = redact_text(txt);
        assert!(r.total_redactions >= 3);
    }
}
