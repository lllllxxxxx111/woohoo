//! Pure helpers for preflight rule classification.
//!
//! Extracted from the async handler so the rules can be unit-tested without DB/IO.

/// Classification of an asset URL after static inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetUrlKind {
    /// Local upload (`/uploads/<uuid>.<ext>`); needs disk check.
    Local,
    /// External http(s):// or other remote URL; binary won't be packed.
    External,
    /// Empty URL — always invalid.
    Empty,
    /// URL starts with `/uploads/` but has illegal characters (path traversal).
    InvalidLocalPath,
}

pub fn classify_asset_url(url: &str) -> AssetUrlKind {
    if url.is_empty() {
        return AssetUrlKind::Empty;
    }
    if let Some(rest) = url.strip_prefix(LOCAL_UPLOAD_PREFIX) {
        if rest.is_empty() || rest.contains('/') || rest.contains('\\') {
            return AssetUrlKind::InvalidLocalPath;
        }
        AssetUrlKind::Local
    } else {
        AssetUrlKind::External
    }
}

/// Classify asset filename for sensitive-info hints. Conservative: only warns when
/// the sensitive word appears as a likely standalone token (surrounded by non-letters)
/// to avoid false positives like "keyframe.mp4".
pub fn is_sensitive_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == ".env" || lower.ends_with(".env") {
        return true;
    }
    for kw in ["secret", "password", "passwd", "密码"] {
        if contains_whole_lowerword(&lower, kw) {
            return true;
        }
    }
    // "key" must appear as a non-prefix substring (avoid "keyboard", "keyframe", "keynote")
    // or as a prefix before a separator (. _ -).
    if contains_key_token(&lower) {
        return true;
    }
    false
}

fn contains_whole_lowerword(hay: &str, kw: &str) -> bool {
    let mut idx = 0;
    while let Some(rel) = hay[idx..].find(kw) {
        let start = idx + rel;
        let end = start + kw.len();
        let before_ok = start == 0 || {
            let b = hay.as_bytes()[start - 1];
            !b.is_ascii_alphabetic()
        };
        let after_ok = end >= hay.len() || {
            let a = hay.as_bytes()[end];
            !a.is_ascii_alphabetic()
        };
        if before_ok && after_ok {
            return true;
        }
        idx = end;
    }
    false
}

fn contains_key_token(hay: &str) -> bool {
    // Match ".key", "_key", "-key", "key.", "key_", "key-", or equals "key"
    let bytes = hay.as_bytes();
    if hay == "key" {
        return true;
    }
    for i in 0..=hay.len().saturating_sub(3) {
        if &bytes[i..i + 3] == b"key" {
            let before_ok = i == 0 || !bytes[i.saturating_sub(1)].is_ascii_alphabetic();
            let after_pos = i + 3;
            let after_ok = after_pos >= bytes.len() || !bytes[after_pos].is_ascii_alphabetic();
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
}

/// Whether a hex string is long enough to be considered a private-key-like blob.
pub fn looks_like_long_hex(s: &str) -> bool {
    s.len() >= 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether a scene_number list has duplicates (sorted input).
pub fn duplicate_scene_numbers(sorted_nums: &[i64]) -> Vec<i64> {
    let mut out = Vec::new();
    for win in sorted_nums.windows(2) {
        if win[0] == win[1] && !out.contains(&win[0]) {
            out.push(win[0]);
        }
    }
    out
}

const LOCAL_UPLOAD_URL_PREFIX: &str = "/uploads/";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_asset_url_cases() {
        assert_eq!(classify_asset_url(""), AssetUrlKind::Empty);
        assert_eq!(
            classify_asset_url("/uploads/abc123.png"),
            AssetUrlKind::Local
        );
        assert_eq!(
            classify_asset_url("/uploads/"),
            AssetUrlKind::InvalidLocalPath
        );
        assert_eq!(
            classify_asset_url("/uploads/../etc/passwd"),
            AssetUrlKind::InvalidLocalPath
        );
        assert_eq!(
            classify_asset_url("https://cdn.example.com/x.png"),
            AssetUrlKind::External
        );
        assert_eq!(
            classify_asset_url("data:image/png;base64,aaaa"),
            AssetUrlKind::External
        );
    }

    #[test]
    fn sensitive_filename_matches() {
        assert!(is_sensitive_filename("api-secret.txt"));
        assert!(is_sensitive_filename("db_password.conf"));
        assert!(is_sensitive_filename("my_private.key"));
        assert!(is_sensitive_filename("access-key.json"));
        assert!(is_sensitive_filename(".env"));
        assert!(is_sensitive_filename("prod.env"));
        // false-positive checks
        assert!(!is_sensitive_filename("scene-01.png"));
        assert!(!is_sensitive_filename("keyframe.mp4"));
        assert!(!is_sensitive_filename("keyboard-layout.svg"));
        assert!(!is_sensitive_filename("monkey-paw.jpg")); // contains "key" but "monkey"
    }

    #[test]
    fn long_hex_detection() {
        assert!(looks_like_long_hex(&"a".repeat(64)));
        assert!(looks_like_long_hex(&"0123456789abcdef".repeat(4))); // 64 hex chars
        assert!(!looks_like_long_hex(&"a".repeat(63)));
        assert!(!looks_like_long_hex(&"g".repeat(64))); // not hex
    }

    #[test]
    fn duplicate_scenes_detection() {
        assert!(duplicate_scene_numbers(&[1, 2, 3]).is_empty());
        assert_eq!(duplicate_scene_numbers(&[1, 2, 2, 3]), vec![2]);
        assert_eq!(duplicate_scene_numbers(&[1, 1, 2, 2, 3]), vec![1, 2]);
        assert!(duplicate_scene_numbers(&[]).is_empty());
    }
}
