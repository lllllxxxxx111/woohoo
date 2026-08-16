//! AI Endpoint API Key 加密模块
//!
//! 使用 AES-256-GCM AEAD（Authenticated Encryption with Associated Data）算法
//! 加密存储在数据库 `ai_endpoints.api_key` 字段中的 API Key。
//!
//! ## 设计目标
//!
//! 1. **成熟的 AEAD**：使用 `aes-gcm` crate（RustCrypto 维护），不自定义加密
//! 2. **版本化密文格式**：`enc:v1:{nonce_b64}:{ciphertext_b64}`，便于未来升级算法
//! 3. **主密钥来自环境变量**：`WOOHOO_API_KEY_ENCRYPTION_KEY`（32 字节 hex 编码）
//! 4. **解密只在服务端调用 AI 时发生**：响应、日志、错误信息均不暴露明文
//! 5. **向后兼容**：能识别旧明文和新密文，配置主密钥后自动迁移旧数据
//! 6. **生产安全**：生产环境存在 endpoint 但缺少主密钥时拒绝启动
//!
//! ## 主密钥管理
//!
//! - 主密钥通过 `WOOHOO_API_KEY_ENCRYPTION_KEY` 环境变量配置
//! - 必须是 64 个 hex 字符（32 字节，对应 AES-256）
//! - 启动时通过 `init_from_env()` 加载到全局 `OnceLock`
//! - 测试时通过 `set_test_master_key()` 设置 thread-local 覆盖，避免并行污染
//!
//! ## 安全说明
//!
//! - 每个 API Key 加密时生成随机 12 字节 nonce，绝不复用
//! - GCM 模式自带完整性校验，密文被篡改会解密失败
//! - 主密钥从不写入日志、错误信息或数据库
//! - 解密后的明文只在内存中短暂存在，传给 HTTP 客户端后立即丢弃

use std::cell::RefCell;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

use super::config::AiEndpoint;

/// 加密主密钥环境变量名
pub const ENV_API_KEY_MASTER_KEY: &str = "WOOHOO_API_KEY_ENCRYPTION_KEY";

/// 密文版本前缀，用于识别加密格式的 API Key
const CIPHERTEXT_PREFIX: &str = "enc:v1:";

/// AES-256 密钥长度（字节）
const KEY_LEN: usize = 32;

/// AES-GCM nonce 长度（字节），GCM 规范固定为 12
const NONCE_LEN: usize = 12;

/// AES-256 主密钥类型
type AesKey = [u8; KEY_LEN];

/// 全局主密钥，启动时通过 `init_from_env()` 初始化一次
static GLOBAL_KEY: OnceLock<Option<AesKey>> = OnceLock::new();

// 测试用的 thread-local 覆盖，避免并行测试污染全局状态
thread_local! {
    static TEST_KEY_OVERRIDE: RefCell<Option<Option<AesKey>>> = RefCell::new(None);
}

/// 解析 hex 编码的主密钥字符串
///
/// 接受 64 个 hex 字符（不区分大小写，前后空白会被忽略），
/// 返回 32 字节的 AES-256 密钥。
///
/// @param value hex 编码的密钥字符串
/// @returns 32 字节密钥；Err 表示格式非法
pub fn parse_master_key(value: &str) -> AppResult<AesKey> {
    let trimmed = value.trim();
    if trimmed.len() != KEY_LEN * 2 {
        return Err(AppError::Internal(format!(
            "{} 格式非法：需要 {} 个 hex 字符，实际 {} 个字符",
            ENV_API_KEY_MASTER_KEY,
            KEY_LEN * 2,
            trimmed.len()
        )));
    }

    let mut key = [0u8; KEY_LEN];
    for (i, byte) in trimmed.as_bytes().chunks(2).enumerate() {
        let hex_str = std::str::from_utf8(byte).map_err(|_| {
            AppError::Internal(format!("{} 包含非 ASCII 字符", ENV_API_KEY_MASTER_KEY))
        })?;
        let byte_val = u8::from_str_radix(hex_str, 16).map_err(|_| {
            AppError::Internal(format!(
                "{} 包含非 hex 字符: {}",
                ENV_API_KEY_MASTER_KEY, hex_str
            ))
        })?;
        key[i] = byte_val;
    }
    Ok(key)
}

/// 启动时初始化全局主密钥
///
/// 应在 `main()` 早期调用，且只能调用一次。重复调用会被忽略（保留首次值）。
///
/// @param key 主密钥；None 表示未配置（开发模式可用，生产模式需要后续校验）
pub fn init_global_master_key(key: Option<AesKey>) {
    let _ = GLOBAL_KEY.set(key);
}

/// 测试时设置 thread-local 主密钥覆盖
///
/// 仅影响当前线程，不会污染并行测试。
/// 设置为 `Some(key)` 模拟已配置密钥；设置为 `None` 模拟未配置密钥。
///
/// @param key 主密钥覆盖值
#[cfg(test)]
pub fn set_test_master_key(key: Option<AesKey>) {
    TEST_KEY_OVERRIDE.with(|cell| {
        *cell.borrow_mut() = Some(key);
    });
}

/// 清除 thread-local 主密钥覆盖
///
/// 测试结束时调用，恢复默认行为（使用全局密钥）。
#[cfg(test)]
pub fn clear_test_master_key() {
    TEST_KEY_OVERRIDE.with(|cell| {
        *cell.borrow_mut() = None;
    });
}

/// 从环境变量初始化全局主密钥
///
/// 启动时调用。读取 `WOOHOO_API_KEY_ENCRYPTION_KEY` 环境变量：
/// - 未设置：全局密钥为 None（生产环境需后续检查）
/// - 设置且合法：全局密钥为 Some(key)
/// - 设置但非法：返回 Err（启动应拒绝）
///
/// @returns Ok(()) 成功初始化；Err(String) 配置非法
pub fn init_from_env() -> Result<(), String> {
    match std::env::var(ENV_API_KEY_MASTER_KEY) {
        Ok(value) if value.trim().is_empty() => {
            init_global_master_key(None);
            Ok(())
        }
        Ok(value) => match parse_master_key(&value) {
            Ok(key) => {
                init_global_master_key(Some(key));
                Ok(())
            }
            Err(error) => Err(format!("{} 配置非法: {}", ENV_API_KEY_MASTER_KEY, error)),
        },
        Err(_) => {
            init_global_master_key(None);
            Ok(())
        }
    }
}

/// 获取当前主密钥
///
/// 优先使用 thread-local 覆盖（测试场景），否则使用全局密钥。
///
/// @returns 32 字节主密钥；Err 表示未配置
pub fn current_master_key() -> AppResult<AesKey> {
    // 优先读取 thread-local 覆盖
    let test_override = TEST_KEY_OVERRIDE.with(|cell| cell.borrow().clone());
    if let Some(test) = test_override {
        return test.ok_or_else(|| {
            AppError::Internal(format!(
                "{} 未配置（测试覆盖为 None）：无法加解密 API Key",
                ENV_API_KEY_MASTER_KEY
            ))
        });
    }

    // 读取全局密钥
    GLOBAL_KEY.get().copied().flatten().ok_or_else(|| {
        AppError::Internal(format!(
            "{} 未配置：无法加解密 API Key。请在环境变量中设置 64 字符 hex 编码的 32 字节主密钥",
            ENV_API_KEY_MASTER_KEY
        ))
    })
}

/// 判断主密钥是否已配置
///
/// 优先检查 thread_local 覆盖（测试场景），否则检查全局密钥。
/// 用于启动时检查生产环境是否需要拒绝启动。
pub fn is_master_key_configured() -> bool {
    // 优先读取 thread-local 覆盖
    let test_override = TEST_KEY_OVERRIDE.with(|cell| cell.borrow().clone());
    if let Some(test) = test_override {
        return test.is_some();
    }

    // 读取全局密钥
    GLOBAL_KEY.get().and_then(|opt| opt.as_ref()).is_some()
}

/// 判断值是否为加密格式（以 `enc:v1:` 开头）
///
/// @param value 待检查的字符串
/// @returns true 表示是密文；false 表示是明文（或空字符串）
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(CIPHERTEXT_PREFIX)
}

/// 加密明文 API Key
///
/// 生成随机 12 字节 nonce，使用 AES-256-GCM 加密，
/// 返回 `enc:v1:{nonce_b64}:{ciphertext_b64}` 格式的字符串。
///
/// @param plaintext 明文 API Key（不能为空）
/// @returns 版本化密文字符串
pub fn encrypt(plaintext: &str) -> AppResult<String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }

    let key_bytes = current_master_key()?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    // 生成随机 nonce，GCM 规范要求 nonce 不复用
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|err| AppError::Internal(format!("API Key 加密失败: {}", err)))?;

    Ok(format!(
        "{}{}:{}",
        CIPHERTEXT_PREFIX,
        BASE64.encode(nonce_bytes),
        BASE64.encode(&ciphertext)
    ))
}

/// 解密密文 API Key
///
/// 仅接受 `enc:v1:` 格式的密文，返回明文。
///
/// @param ciphertext 版本化密文
/// @returns 明文 API Key
pub fn decrypt(ciphertext: &str) -> AppResult<String> {
    if !is_encrypted(ciphertext) {
        return Err(AppError::Internal(
            "API Key 解密失败：不是有效的加密格式（缺少 enc:v1: 前缀）".to_string(),
        ));
    }

    let body = &ciphertext[CIPHERTEXT_PREFIX.len()..];
    let mut parts = body.splitn(2, ':');
    let nonce_b64 = parts
        .next()
        .ok_or_else(|| AppError::Internal("API Key 密文缺少 nonce 段".to_string()))?;
    let ciphertext_b64 = parts
        .next()
        .ok_or_else(|| AppError::Internal("API Key 密文缺少密文段".to_string()))?;

    let nonce_bytes = BASE64
        .decode(nonce_b64)
        .map_err(|err| AppError::Internal(format!("API Key nonce 解码失败: {}", err)))?;
    let ciphertext_bytes = BASE64
        .decode(ciphertext_b64)
        .map_err(|err| AppError::Internal(format!("API Key 密文解码失败: {}", err)))?;

    if nonce_bytes.len() != NONCE_LEN {
        return Err(AppError::Internal(format!(
            "API Key nonce 长度非法：期望 {} 字节，实际 {} 字节",
            NONCE_LEN,
            nonce_bytes.len()
        )));
    }

    let key_bytes = current_master_key()?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext_bytes.as_ref())
        .map_err(|err| {
            // 解密失败可能是密钥错误、密文被篡改或版本不匹配
            // 不暴露具体密文片段，只返回通用错误
            AppError::Internal(format!(
                "API Key 解密失败：密钥错误、密文损坏或版本不兼容（{}）",
                err
            ))
        })?;

    String::from_utf8(plaintext)
        .map_err(|err| AppError::Internal(format!("API Key 解密后明文不是有效 UTF-8: {}", err)))
}

/// 自动识别明文/密文并返回明文（向后兼容）
///
/// - 空字符串：原样返回
/// - 明文（非 `enc:v1:` 开头）：原样返回（用于旧数据兼容）
/// - 密文：解密后返回
///
/// @param value 数据库中的 api_key 字段值
/// @returns 明文 API Key
pub fn maybe_decrypt(value: &str) -> AppResult<String> {
    if value.trim().is_empty() {
        return Ok(String::new());
    }
    if is_encrypted(value) {
        decrypt(value)
    } else {
        // 旧明文数据，原样返回（用于向后兼容；迁移由 migrate_endpoint_if_needed 负责）
        Ok(value.to_string())
    }
}

/// 解密 endpoint 的 API Key（便捷封装）
///
/// 空字符串视为未设置 API Key，直接返回空。
///
/// @param endpoint AI 端点实体
/// @returns 明文 API Key
pub fn decrypt_endpoint_api_key(endpoint: &AiEndpoint) -> AppResult<String> {
    if endpoint.api_key.trim().is_empty() {
        return Ok(String::new());
    }
    maybe_decrypt(&endpoint.api_key)
}

/// 惰性迁移：若 endpoint 的 api_key 是明文且已配置主密钥，则重新加密并写回数据库
///
/// - 空字符串：跳过
/// - 已是密文：跳过
/// - 明文 + 未配置主密钥：返回 Err（生产环境必须配置主密钥才能继续使用 endpoint）
/// - 明文 + 已配置主密钥：加密并 UPDATE 数据库
///
/// @param pool 数据库连接池
/// @param endpoint AI 端点实体
/// @returns Ok(()) 成功（跳过或已迁移）；Err 表示迁移失败
pub async fn migrate_endpoint_if_needed(pool: &SqlitePool, endpoint: &AiEndpoint) -> AppResult<()> {
    let current = endpoint.api_key.trim();
    if current.is_empty() {
        return Ok(());
    }
    if is_encrypted(current) {
        return Ok(());
    }

    // 明文 → 加密
    let encrypted = encrypt(current)?;
    sqlx::query(
        "UPDATE ai_endpoints
         SET api_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(&encrypted)
    .bind(&endpoint.id)
    .execute(pool)
    .await?;

    tracing::info!(
        endpoint_id = %endpoint.id,
        "API Key 已自动从明文迁移为加密格式"
    );
    Ok(())
}

/// 启动时生产环境安全检查
///
/// 在生产环境（`RUST_ENV=production`）下，若数据库中存在任何 AI endpoint
/// 但未配置加密主密钥，返回错误信息（main 应 panic 拒绝启动）。
///
/// 这是最严重的安全配置：明文 API Key 已存在于数据库，
/// 缺少主密钥意味着无法解密使用，且无法迁移到加密格式。
///
/// @param pool 数据库连接池
/// @returns Ok(()) 安全；Err(String) 不安全（含可读错误信息）
pub async fn assert_production_safe_with_db(pool: &SqlitePool) -> Result<(), String> {
    let is_production = std::env::var("RUST_ENV")
        .map(|value| value.trim().eq_ignore_ascii_case("production"))
        .unwrap_or(false);
    assert_production_safe_with_db_and(pool, is_production).await
}

/// 参数化版本：用于测试，避免修改全局环境变量造成并行污染
///
/// @param pool 数据库连接池
/// @param is_production 是否为生产环境
/// @returns Ok(()) 安全；Err(String) 不安全
pub async fn assert_production_safe_with_db_and(
    pool: &SqlitePool,
    is_production: bool,
) -> Result<(), String> {
    if !is_production {
        return Ok(());
    }

    if is_master_key_configured() {
        return Ok(());
    }

    // 生产环境 + 未配置主密钥：检查数据库是否已有 endpoint
    let endpoint_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM ai_endpoints WHERE api_key != '' AND api_key IS NOT NULL",
    )
    .fetch_one(pool)
    .await
    .map_err(|err| format!("检查 ai_endpoints 表失败: {}", err))?;

    if endpoint_count > 0 {
        return Err(format!(
            "安全配置冲突：生产环境（{}=production）下已存在 {} 个 AI endpoint，\
             但未设置 {} 环境变量。无法解密或安全迁移现有 API Key。\
             请设置 64 字符 hex 编码的 32 字节主密钥后重启服务。",
            "RUST_ENV", endpoint_count, ENV_API_KEY_MASTER_KEY
        ));
    }

    tracing::warn!(
        "生产环境未配置 {}：当前无 AI endpoint，但创建 endpoint 前必须配置",
        ENV_API_KEY_MASTER_KEY
    );
    Ok(())
}

/// 启动时批量迁移：扫描所有明文 API Key 并加密
///
/// 在数据库初始化后、HTTP 服务启动前调用。
/// 仅当已配置主密钥时执行；未配置时跳过（生产环境由 assert_production_safe_with_db 拦截）。
///
/// @param pool 数据库连接池
/// @returns Ok(()) 成功；Err 表示数据库错误
pub async fn migrate_all_endpoints(pool: &SqlitePool) -> AppResult<()> {
    if !is_master_key_configured() {
        tracing::info!(
            "未配置 {}，跳过 API Key 批量迁移（生产环境将在启动检查中拒绝）",
            ENV_API_KEY_MASTER_KEY
        );
        return Ok(());
    }

    let endpoints = sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints")
        .fetch_all(pool)
        .await?;

    let mut migrated = 0usize;
    for endpoint in endpoints {
        if endpoint.api_key.trim().is_empty() || is_encrypted(&endpoint.api_key) {
            continue;
        }

        match migrate_endpoint_if_needed(pool, &endpoint).await {
            Ok(()) => migrated += 1,
            Err(error) => {
                tracing::error!(
                    endpoint_id = %endpoint.id,
                    error = %error,
                    "API Key 迁移失败"
                );
                // 不中断启动，但记录错误；该 endpoint 在使用时会因解密失败而暴露问题
            }
        }
    }

    if migrated > 0 {
        tracing::info!(
            "已批量迁移 {} 个 AI endpoint 的 API Key 为加密格式",
            migrated
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的固定主密钥（32 字节全 0xAA，仅用于测试）
    ///
    /// 安全说明：此密钥仅用于单元测试，不会写入生产环境或真实数据库。
    /// 真实密钥必须通过环境变量配置，且不得提交到代码仓库。
    const TEST_MASTER_KEY: AesKey = [0xAA_u8; KEY_LEN];

    /// 测试用的另一个主密钥（用于测试密钥不匹配场景）
    const TEST_WRONG_KEY: AesKey = [0xBB_u8; KEY_LEN];

    /// 在每个测试前后自动设置/清理测试密钥
    struct TestKeyGuard {
        _private: (),
    }

    impl TestKeyGuard {
        fn new(key: Option<AesKey>) -> Self {
            set_test_master_key(key);
            Self { _private: () }
        }
    }

    impl Drop for TestKeyGuard {
        fn drop(&mut self) {
            clear_test_master_key();
        }
    }

    fn with_test_key<F: FnOnce()>(key: Option<AesKey>, f: F) {
        let _guard = TestKeyGuard::new(key);
        f();
    }

    #[test]
    fn parse_master_key_accepts_valid_hex() {
        let hex = "aa".repeat(KEY_LEN);
        let key = parse_master_key(&hex).expect("valid hex should parse");
        assert_eq!(key, [0xAA_u8; KEY_LEN]);
    }

    #[test]
    fn parse_master_key_accepts_uppercase_hex() {
        let hex = "AA".repeat(KEY_LEN);
        let key = parse_master_key(&hex).expect("uppercase hex should parse");
        assert_eq!(key, [0xAA_u8; KEY_LEN]);
    }

    #[test]
    fn parse_master_key_rejects_wrong_length() {
        assert!(parse_master_key("abcd").is_err());
        assert!(parse_master_key(&"a".repeat(KEY_LEN * 2 - 1)).is_err());
        assert!(parse_master_key(&"a".repeat(KEY_LEN * 2 + 1)).is_err());
    }

    #[test]
    fn parse_master_key_rejects_non_hex() {
        let bad = "xz".repeat(KEY_LEN);
        assert!(parse_master_key(&bad).is_err());
    }

    #[test]
    fn parse_master_key_trims_whitespace() {
        let hex = "aa".repeat(KEY_LEN);
        let key = parse_master_key(&format!("  {}  ", hex)).expect("should trim");
        assert_eq!(key, [0xAA_u8; KEY_LEN]);
    }

    #[test]
    fn is_encrypted_detects_prefix() {
        assert!(is_encrypted("enc:v1:abc:def"));
        assert!(is_encrypted("enc:v1::"));
        assert!(!is_encrypted(""));
        assert!(!is_encrypted("sk-openai-key"));
        assert!(!is_encrypted("ENC:V1:abc:def"));
    }

    #[test]
    fn encrypt_then_decrypt_roundtrip() {
        with_test_key(Some(TEST_MASTER_KEY), || {
            let plaintext = "sk-test-key-12345";
            let ciphertext = encrypt(plaintext).expect("encryption should succeed");
            assert!(is_encrypted(&ciphertext));
            assert_ne!(ciphertext, plaintext);

            let decrypted = decrypt(&ciphertext).expect("decryption should succeed");
            assert_eq!(decrypted, plaintext);
        });
    }

    #[test]
    fn encrypt_produces_different_ciphertexts_for_same_plaintext() {
        // 同一明文每次加密的密文应不同（因为 nonce 随机）
        with_test_key(Some(TEST_MASTER_KEY), || {
            let plaintext = "sk-same-key";
            let c1 = encrypt(plaintext).expect("first encrypt");
            let c2 = encrypt(plaintext).expect("second encrypt");
            assert_ne!(c1, c2, "random nonce should produce different ciphertexts");

            // 两个密文都应能解密为同一明文
            assert_eq!(decrypt(&c1).unwrap(), plaintext);
            assert_eq!(decrypt(&c2).unwrap(), plaintext);
        });
    }

    #[test]
    fn encrypt_empty_returns_empty() {
        with_test_key(Some(TEST_MASTER_KEY), || {
            assert_eq!(encrypt("").unwrap(), "");
        });
    }

    #[test]
    fn decrypt_with_wrong_key_returns_error() {
        // 用 TEST_MASTER_KEY 加密，用 TEST_WRONG_KEY 解密应失败
        with_test_key(Some(TEST_MASTER_KEY), || {
            let ciphertext = encrypt("sk-secret").unwrap();
            // 切换到错误密钥
            set_test_master_key(Some(TEST_WRONG_KEY));
            let result = decrypt(&ciphertext);
            assert!(result.is_err(), "decrypt with wrong key should fail");
        });
    }

    #[test]
    fn decrypt_tampered_ciphertext_fails() {
        with_test_key(Some(TEST_MASTER_KEY), || {
            let ciphertext = encrypt("sk-original").unwrap();
            // 篡改密文最后几个字符
            let mut tampered = ciphertext.clone();
            let last_char = tampered.chars().last().unwrap();
            let replacement = if last_char == 'A' { 'B' } else { 'A' };
            tampered.pop();
            tampered.push(replacement);

            let result = decrypt(&tampered);
            assert!(result.is_err(), "decrypt tampered ciphertext should fail");
        });
    }

    #[test]
    fn maybe_decrypt_passes_through_plaintext() {
        with_test_key(Some(TEST_MASTER_KEY), || {
            let plaintext = "sk-legacy-key";
            let result = maybe_decrypt(plaintext).unwrap();
            assert_eq!(result, plaintext);
        });
    }

    #[test]
    fn maybe_decrypt_decrypts_ciphertext() {
        with_test_key(Some(TEST_MASTER_KEY), || {
            let plaintext = "sk-real-key";
            let ciphertext = encrypt(plaintext).unwrap();
            let result = maybe_decrypt(&ciphertext).unwrap();
            assert_eq!(result, plaintext);
        });
    }

    #[test]
    fn maybe_decrypt_handles_empty() {
        with_test_key(Some(TEST_MASTER_KEY), || {
            assert_eq!(maybe_decrypt("").unwrap(), "");
            assert_eq!(maybe_decrypt("   ").unwrap(), "");
        });
    }

    #[test]
    fn maybe_decrypt_without_master_key_passes_plaintext() {
        // 未配置主密钥时，明文应原样返回（向后兼容）
        with_test_key(None, || {
            let plaintext = "sk-legacy-key";
            let result = maybe_decrypt(plaintext).unwrap();
            assert_eq!(result, plaintext);
        });
    }

    #[test]
    fn maybe_decrypt_without_master_key_fails_on_ciphertext() {
        // 未配置主密钥时，密文应解密失败（明确错误）
        with_test_key(Some(TEST_MASTER_KEY), || {
            let ciphertext = encrypt("sk-real").unwrap();
            // 切换到无密钥
            set_test_master_key(None);
            let result = maybe_decrypt(&ciphertext);
            assert!(result.is_err(), "decrypt without key should fail");
        });
    }

    #[test]
    fn current_master_key_uses_test_override() {
        // 设置测试覆盖
        set_test_master_key(Some(TEST_MASTER_KEY));
        let key = current_master_key().unwrap();
        assert_eq!(key, TEST_MASTER_KEY);

        // 切换覆盖
        set_test_master_key(Some(TEST_WRONG_KEY));
        let key = current_master_key().unwrap();
        assert_eq!(key, TEST_WRONG_KEY);

        // 清除覆盖
        clear_test_master_key();
        // 清除后应使用全局密钥（测试中未设置，应失败）
        assert!(current_master_key().is_err());
    }

    #[test]
    fn encrypted_format_includes_version_prefix() {
        with_test_key(Some(TEST_MASTER_KEY), || {
            let ciphertext = encrypt("sk-test").unwrap();
            assert!(ciphertext.starts_with("enc:v1:"));
            // 应包含两个冒号分隔的段：nonce 和 ciphertext
            let body = &ciphertext["enc:v1:".len()..];
            let colon_count = body.chars().filter(|c| *c == ':').count();
            assert_eq!(colon_count, 1, "expected exactly one colon in body");
        });
    }

    #[test]
    fn decrypt_invalid_format_returns_error() {
        with_test_key(Some(TEST_MASTER_KEY), || {
            assert!(decrypt("enc:v1:").is_err());
            assert!(decrypt("enc:v1:onlyonepart").is_err());
            assert!(decrypt("enc:v1::").is_err()); // 空段
            assert!(decrypt("not-encrypted").is_err());
        });
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::ai::config::{AiEndpoint, AiEndpointView};
    use sqlx::sqlite::SqlitePoolOptions;

    /// 测试用的固定主密钥（32 字节全 0xAA，仅用于测试）
    const TEST_MASTER_KEY: AesKey = [0xAA_u8; KEY_LEN];

    /// 测试用的另一个主密钥（用于测试密钥不匹配场景）
    const TEST_WRONG_KEY: AesKey = [0xBB_u8; KEY_LEN];

    /// 在每个测试前后自动设置/清理测试密钥
    struct TestKeyGuard {
        _private: (),
    }

    impl TestKeyGuard {
        fn new(key: Option<AesKey>) -> Self {
            set_test_master_key(key);
            Self { _private: () }
        }
    }

    impl Drop for TestKeyGuard {
        fn drop(&mut self) {
            clear_test_master_key();
        }
    }

    /// 辅助：让 with_test_key 支持 async 闭包
    async fn with_test_key_async<F, Fut>(key: Option<AesKey>, f: F)
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future,
    {
        let _guard = TestKeyGuard::new(key);
        f().await;
    }

    /// 创建内存数据库并建好 ai_endpoints 表
    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("failed to create in-memory sqlite pool");

        sqlx::query(
            "CREATE TABLE ai_endpoints (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                provider TEXT NOT NULL,
                base_url TEXT NOT NULL,
                api_key TEXT NOT NULL,
                default_model TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create ai_endpoints table");

        pool
    }

    /// 插入一条 endpoint 记录（api_key 字段直接使用传入值，不加密）
    async fn insert_endpoint(pool: &SqlitePool, id: &str, api_key: &str) {
        sqlx::query(
            "INSERT INTO ai_endpoints (id, user_id, name, provider, base_url, api_key)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind("test-user")
        .bind("test-endpoint")
        .bind("openai")
        .bind("https://api.openai.com/v1")
        .bind(api_key)
        .execute(pool)
        .await
        .expect("failed to insert endpoint");
    }

    /// 读取 endpoint 的 api_key 字段
    async fn fetch_api_key(pool: &SqlitePool, id: &str) -> String {
        sqlx::query_scalar::<_, String>("SELECT api_key FROM ai_endpoints WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("failed to fetch api_key")
    }

    /// 测试场景 1：加密后的 API Key 在数据库中不是明文
    #[tokio::test]
    async fn encrypted_api_key_is_not_plaintext_in_db() {
        with_test_key_async(Some(TEST_MASTER_KEY), || async {
            let pool = setup_pool().await;
            let plaintext = "sk-test-plaintext-key-12345";

            // 模拟 create_endpoint 的写入路径：先加密再 INSERT
            let encrypted = encrypt(plaintext).unwrap();
            insert_endpoint(&pool, "ep-1", &encrypted).await;

            let stored = fetch_api_key(&pool, "ep-1").await;

            // 数据库中不应包含明文
            assert_ne!(stored, plaintext);
            assert!(!stored.contains(plaintext));
            assert!(is_encrypted(&stored));
            assert!(stored.starts_with("enc:v1:"));
        })
        .await;
    }

    /// 测试场景 2：更新 API Key 后可以正确解密
    #[tokio::test]
    async fn updated_api_key_can_be_decrypted() {
        with_test_key_async(Some(TEST_MASTER_KEY), || async {
            let pool = setup_pool().await;

            // 初始插入加密的 key A
            let key_a = "sk-key-a-aaaaa";
            let encrypted_a = encrypt(key_a).unwrap();
            insert_endpoint(&pool, "ep-2", &encrypted_a).await;

            // 模拟 update_endpoint 更新为 key B
            let key_b = "sk-key-b-bbbbb";
            let encrypted_b = encrypt(key_b).unwrap();
            sqlx::query("UPDATE ai_endpoints SET api_key = ? WHERE id = ?")
                .bind(&encrypted_b)
                .bind("ep-2")
                .execute(&pool)
                .await
                .unwrap();

            // 读取并解密
            let endpoint =
                sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ?")
                    .bind("ep-2")
                    .fetch_one(&pool)
                    .await
                    .unwrap();

            let decrypted = decrypt_endpoint_api_key(&endpoint).unwrap();
            assert_eq!(decrypted, key_b, "should decrypt to new key, not old");
            assert_ne!(decrypted, key_a);
        })
        .await;
    }

    /// 测试场景 3：API 响应不泄露明文 API Key
    #[tokio::test]
    async fn api_response_does_not_leak_plaintext() {
        with_test_key_async(Some(TEST_MASTER_KEY), || async {
            let pool = setup_pool().await;
            let plaintext = "sk-leak-test-987654321";

            let encrypted = encrypt(plaintext).unwrap();
            insert_endpoint(&pool, "ep-3", &encrypted).await;

            let endpoint =
                sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ?")
                    .bind("ep-3")
                    .fetch_one(&pool)
                    .await
                    .unwrap();

            // 转换为 view（模拟 API 响应）
            let view: AiEndpointView = endpoint.into();

            // 序列化为 JSON 检查不包含明文
            let json = serde_json::to_string(&view).unwrap();
            assert!(
                !json.contains(plaintext),
                "API response must not contain plaintext API key"
            );
            assert!(
                !json.contains("enc:v1:"),
                "API response must not contain ciphertext either (only hasApiKey boolean)"
            );
            // has_api_key 字段应为 true
            assert!(view.has_api_key);
        })
        .await;
    }

    /// 测试场景 4：旧明文数据可以迁移为密文
    #[tokio::test]
    async fn legacy_plaintext_can_be_migrated() {
        with_test_key_async(Some(TEST_MASTER_KEY), || async {
            let pool = setup_pool().await;
            let plaintext = "sk-legacy-plaintext-key";

            // 直接插入明文（模拟旧版本数据库）
            insert_endpoint(&pool, "ep-4", plaintext).await;

            // 验证迁移前是明文
            let before = fetch_api_key(&pool, "ep-4").await;
            assert_eq!(before, plaintext);
            assert!(!is_encrypted(&before));

            // 读取 endpoint 并执行迁移
            let endpoint =
                sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ?")
                    .bind("ep-4")
                    .fetch_one(&pool)
                    .await
                    .unwrap();

            migrate_endpoint_if_needed(&pool, &endpoint).await.unwrap();

            // 验证迁移后是密文
            let after = fetch_api_key(&pool, "ep-4").await;
            assert!(is_encrypted(&after));
            assert_ne!(after, plaintext);

            // 验证解密后能还原明文
            let endpoint_after =
                sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ?")
                    .bind("ep-4")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let decrypted = decrypt_endpoint_api_key(&endpoint_after).unwrap();
            assert_eq!(decrypted, plaintext);
        })
        .await;
    }

    /// 测试场景 5：密钥错误时解密返回明确错误
    #[tokio::test]
    async fn wrong_master_key_returns_clear_error() {
        with_test_key_async(Some(TEST_MASTER_KEY), || async {
            let pool = setup_pool().await;

            // 用 TEST_MASTER_KEY 加密
            let plaintext = "sk-secret-key-zzz";
            let encrypted = encrypt(plaintext).unwrap();
            insert_endpoint(&pool, "ep-5", &encrypted).await;

            let endpoint =
                sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ?")
                    .bind("ep-5")
                    .fetch_one(&pool)
                    .await
                    .unwrap();

            // 切换到错误密钥
            set_test_master_key(Some(TEST_WRONG_KEY));
            let result = decrypt_endpoint_api_key(&endpoint);
            assert!(result.is_err(), "decrypt with wrong key must fail");

            let error_msg = result.unwrap_err().to_string();
            assert!(
                error_msg.contains("解密失败") || error_msg.contains("API Key"),
                "error should mention decryption failure, got: {}",
                error_msg
            );
        })
        .await;
    }

    /// 测试场景 6：生产环境 + 已有 endpoint + 未配置主密钥 → 拒绝启动
    #[tokio::test]
    async fn production_refuses_without_master_key_when_endpoints_exist() {
        with_test_key_async(None, || async {
            let pool = setup_pool().await;

            // 插入一条有 api_key 的 endpoint
            insert_endpoint(&pool, "ep-6", "some-plaintext-key").await;

            // 生产环境 + 未配置主密钥 + 已有 endpoint → 拒绝
            let result = assert_production_safe_with_db_and(&pool, true).await;
            assert!(result.is_err(), "production with endpoints must refuse");
            let err = result.unwrap_err();
            assert!(
                err.contains("生产环境") && err.contains(ENV_API_KEY_MASTER_KEY),
                "error should mention production and env var, got: {}",
                err
            );
        })
        .await;
    }

    /// 测试场景 6b：生产环境 + 无 endpoint + 未配置主密钥 → 允许启动（但警告）
    #[tokio::test]
    async fn production_allows_without_master_key_when_no_endpoints() {
        with_test_key_async(None, || async {
            let pool = setup_pool().await;
            // 不插入任何 endpoint
            let result = assert_production_safe_with_db_and(&pool, true).await;
            assert!(
                result.is_ok(),
                "production without endpoints should allow startup"
            );
        })
        .await;
    }

    /// 测试场景 6c：生产环境 + 已有 endpoint + 已配置主密钥 → 允许启动
    #[tokio::test]
    async fn production_allows_with_master_key_and_endpoints() {
        with_test_key_async(Some(TEST_MASTER_KEY), || async {
            let pool = setup_pool().await;
            insert_endpoint(&pool, "ep-6c", "enc:v1:dGVzdA==:dGVzdA==").await;
            let result = assert_production_safe_with_db_and(&pool, true).await;
            assert!(
                result.is_ok(),
                "production with master key should allow startup"
            );
        })
        .await;
    }

    /// 测试场景 6d：非生产环境 → 总是允许启动
    #[tokio::test]
    async fn non_production_always_allows() {
        with_test_key_async(None, || async {
            let pool = setup_pool().await;
            insert_endpoint(&pool, "ep-6d", "plaintext-key").await;
            let result = assert_production_safe_with_db_and(&pool, false).await;
            assert!(result.is_ok(), "non-production should always allow");
        })
        .await;
    }

    /// 测试场景 7：清空 API Key 后旧密钥不可继续使用
    #[tokio::test]
    async fn cleared_api_key_makes_old_key_unusable() {
        with_test_key_async(Some(TEST_MASTER_KEY), || async {
            let pool = setup_pool().await;

            // 初始加密存储
            let plaintext = "sk-original-key-abc";
            let encrypted = encrypt(plaintext).unwrap();
            insert_endpoint(&pool, "ep-7", &encrypted).await;

            // 验证初始可解密
            let endpoint =
                sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ?")
                    .bind("ep-7")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let decrypted = decrypt_endpoint_api_key(&endpoint).unwrap();
            assert_eq!(decrypted, plaintext);

            // 清空 API Key（模拟用户清空）
            sqlx::query("UPDATE ai_endpoints SET api_key = '' WHERE id = ?")
                .bind("ep-7")
                .execute(&pool)
                .await
                .unwrap();

            // 验证 api_key 为空
            let stored = fetch_api_key(&pool, "ep-7").await;
            assert!(stored.is_empty(), "api_key should be empty after clear");

            // 验证解密返回空字符串（不是旧明文）
            let endpoint_after =
                sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ?")
                    .bind("ep-7")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let decrypted_after = decrypt_endpoint_api_key(&endpoint_after).unwrap();
            assert!(decrypted_after.is_empty(), "decrypted should be empty");
            assert_ne!(decrypted_after, plaintext, "old key must not be usable");

            // 验证 has_api_key 字段为 false
            let view: AiEndpointView = endpoint_after.into();
            assert!(!view.has_api_key, "has_api_key should be false after clear");
        })
        .await;
    }

    /// 测试场景 8：批量迁移所有旧明文 API Key
    #[tokio::test]
    async fn migrate_all_endpoints_migrates_plaintext_only() {
        with_test_key_async(Some(TEST_MASTER_KEY), || async {
            let pool = setup_pool().await;

            // 三条记录：明文、密文、空
            insert_endpoint(&pool, "ep-plain", "sk-plain-key").await;
            let encrypted_already = encrypt("sk-already-encrypted").unwrap();
            insert_endpoint(&pool, "ep-encrypted", &encrypted_already).await;
            insert_endpoint(&pool, "ep-empty", "").await;

            migrate_all_endpoints(&pool).await.unwrap();

            // 明文应被迁移
            let plain_stored = fetch_api_key(&pool, "ep-plain").await;
            assert!(is_encrypted(&plain_stored), "plaintext should be migrated");

            // 已加密的应保持不变
            let encrypted_stored = fetch_api_key(&pool, "ep-encrypted").await;
            assert_eq!(
                encrypted_stored, encrypted_already,
                "already encrypted should be unchanged"
            );

            // 空的应保持空
            let empty_stored = fetch_api_key(&pool, "ep-empty").await;
            assert!(empty_stored.is_empty(), "empty should remain empty");
        })
        .await;
    }

    /// 测试场景 9：未配置主密钥时 migrate_all_endpoints 跳过（不报错）
    #[tokio::test]
    async fn migrate_all_skips_without_master_key() {
        with_test_key_async(None, || async {
            let pool = setup_pool().await;
            insert_endpoint(&pool, "ep-skip", "sk-plain-key").await;

            // 未配置主密钥时不应报错，也不应迁移
            migrate_all_endpoints(&pool).await.unwrap();

            let stored = fetch_api_key(&pool, "ep-skip").await;
            assert_eq!(stored, "sk-plain-key", "should remain plaintext");
        })
        .await;
    }

    /// 测试场景 10：maybe_decrypt 向后兼容明文（无密钥时）
    #[tokio::test]
    async fn maybe_decrypt_backward_compatible_with_plaintext() {
        with_test_key_async(None, || async {
            // 无主密钥时，明文应原样返回（向后兼容旧数据）
            let plaintext = "sk-legacy-backward-compat";
            let result = maybe_decrypt(plaintext).unwrap();
            assert_eq!(result, plaintext);
        })
        .await;
    }
}
