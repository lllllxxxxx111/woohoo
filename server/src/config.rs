use std::env;

/// 应用配置，从环境变量读取
#[derive(Debug, Clone)]
pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub port_search_limit: u16,
    pub database_url: String,
    pub jwt_secret: String,
    pub jwt_expire_hours: i64,
    pub assets_dir: String,
    /// 分片上传临时目录（未完成分片与会话合并中间态）
    pub upload_tmp_dir: String,
    /// 分片上传会话有效期（秒）
    pub upload_session_ttl_secs: i64,
    pub project_files_dir: String,
    pub ai_max_concurrent_tasks: usize,
    pub runtime_manifest_path: String,
    pub password_hash_cost: u32,
    pub debug_log_path: String,
    pub debug_log_enabled: bool,
    pub debug_log_max_size_mb: u64,
    pub debug_log_max_files: u32,
    pub ops_heartbeat_interval_secs: u64,
    pub ops_inspection_interval_secs: u64,
    pub ops_notification_interval_secs: u64,
    pub ops_notification_timeout_secs: u64,
    pub ops_notification_max_retries: u32,
    pub ops_stale_task_after_secs: u64,
    pub ops_failure_window_minutes: i64,
    /**
     * CORS允许的来源列表，逗号分隔
     * 生产环境应严格限制为前端域名
     * 开发环境默认允许localhost和127.0.0.1
     */
    pub cors_allowed_origins: Vec<String>,
}

impl AppConfig {
    pub fn from_env() -> Self {
        // 检测是否为生产环境
        let is_production = env::var("RUST_ENV")
            .map(|v| v.to_lowercase() == "production")
            .unwrap_or(false);

        // 生产环境默认禁用调试日志
        let default_debug_enabled = if is_production { "false" } else { "true" };

        // 解析CORS允许的来源列表
        let cors_origins_raw = env::var("CORS_ALLOWED_ORIGINS");
        let cors_allowed_origins = match cors_origins_raw {
            Ok(origins) => origins
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
            Err(_) => vec![],
        };

        Self {
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            port: env::var("PORT")
                .unwrap_or_else(|_| "8080".into())
                .parse()
                .expect("PORT must be a number"),
            port_search_limit: env::var("PORT_SEARCH_LIMIT")
                .unwrap_or_else(|_| "12".into())
                .parse()
                .unwrap_or(12),
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "sqlite://data/woohoo.db?mode=rwc".into()),
            jwt_secret: env::var("JWT_SECRET").expect("JWT_SECRET must be set"),
            jwt_expire_hours: env::var("JWT_EXPIRE_HOURS")
                .unwrap_or_else(|_| "72".into())
                .parse()
                .unwrap_or(72),
            assets_dir: env::var("ASSETS_DIR").unwrap_or_else(|_| "./data/assets".into()),
            upload_tmp_dir: env::var("UPLOAD_TMP_DIR")
                .unwrap_or_else(|_| "./data/uploads-tmp".into()),
            upload_session_ttl_secs: env::var("UPLOAD_SESSION_TTL_SECS")
                .unwrap_or_else(|_| "86400".into())
                .parse()
                .unwrap_or(86_400),
            project_files_dir: env::var("PROJECT_FILES_DIR")
                .unwrap_or_else(|_| "./data/project-files".into()),
            ai_max_concurrent_tasks: env::var("AI_MAX_CONCURRENT_TASKS")
                .unwrap_or_else(|_| "10".into())
                .parse()
                .unwrap_or(10),
            runtime_manifest_path: env::var("RUNTIME_MANIFEST_PATH")
                .unwrap_or_else(|_| "./data/runtime/server-info.json".into()),
            password_hash_cost: env::var("BCRYPT_COST")
                .unwrap_or_else(|_| "10".into())
                .parse()
                .ok()
                .map(|value: u32| value.clamp(4, 14))
                .unwrap_or(10),
            debug_log_path: env::var("DEBUG_LOG_PATH")
                .unwrap_or_else(|_| "./data/runtime/usage-debug.log".into()),
            debug_log_enabled: env::var("DEBUG_LOG_ENABLED")
                .unwrap_or_else(|_| default_debug_enabled.into())
                .to_lowercase()
                .parse()
                .unwrap_or(!is_production),
            debug_log_max_size_mb: env::var("DEBUG_LOG_MAX_SIZE_MB")
                .unwrap_or_else(|_| "50".into())
                .parse()
                .unwrap_or(50),
            debug_log_max_files: env::var("DEBUG_LOG_MAX_FILES")
                .unwrap_or_else(|_| "5".into())
                .parse()
                .unwrap_or(5),
            ops_heartbeat_interval_secs: env::var("OPS_HEARTBEAT_INTERVAL_SECS")
                .unwrap_or_else(|_| "15".into())
                .parse()
                .unwrap_or(15),
            ops_inspection_interval_secs: env::var("OPS_INSPECTION_INTERVAL_SECS")
                .unwrap_or_else(|_| "30".into())
                .parse()
                .unwrap_or(30),
            ops_notification_interval_secs: env::var("OPS_NOTIFICATION_INTERVAL_SECS")
                .unwrap_or_else(|_| "10".into())
                .parse()
                .unwrap_or(10),
            ops_notification_timeout_secs: env::var("OPS_NOTIFICATION_TIMEOUT_SECS")
                .unwrap_or_else(|_| "15".into())
                .parse()
                .unwrap_or(15),
            ops_notification_max_retries: env::var("OPS_NOTIFICATION_MAX_RETRIES")
                .unwrap_or_else(|_| "4".into())
                .parse()
                .unwrap_or(4),
            ops_stale_task_after_secs: env::var("OPS_STALE_TASK_AFTER_SECS")
                .unwrap_or_else(|_| "600".into())
                .parse()
                .unwrap_or(600),
            ops_failure_window_minutes: env::var("OPS_FAILURE_WINDOW_MINUTES")
                .unwrap_or_else(|_| "15".into())
                .parse()
                .unwrap_or(15),
            cors_allowed_origins,
        }
    }

    /// 校验启动所需的生产配置契约。
    ///
    /// 该检查必须在绑定监听端口前执行，避免服务以不可用或不安全的配置
    /// 对外提供健康检查和 API。开发/Demo 环境保留本地便利默认值，但生产
    /// 环境必须显式配置强 JWT、严格 CORS 和 API Key 加密主密钥。
    pub fn validate_startup(
        &self,
        is_production: bool,
        api_key_master_key_configured: bool,
    ) -> Result<(), String> {
        if !is_production {
            return Ok(());
        }

        validate_production_security(
            &self.jwt_secret,
            &self.cors_allowed_origins,
            api_key_master_key_configured,
        )
    }
}

fn validate_production_security(
    jwt_secret: &str,
    cors_allowed_origins: &[String],
    api_key_master_key_configured: bool,
) -> Result<(), String> {
    const DANGER_PATTERNS: &[&str] = &[
        "change-this-to-a-random-secret-key",
        "your-secret-key",
        "woohoo-demo-jwt-secret",
        "secret",
        "password",
        "jwt_secret",
    ];

    if jwt_secret.len() < 32
        || DANGER_PATTERNS
            .iter()
            .any(|pattern| jwt_secret.to_ascii_lowercase().contains(pattern))
    {
        return Err(format!(
            "生产环境不允许使用弱 JWT_SECRET（当前长度 {}，要求至少 32 个字符的随机值）",
            jwt_secret.len()
        ));
    }

    if cors_allowed_origins.is_empty() {
        return Err("生产环境必须设置 CORS_ALLOWED_ORIGINS，且至少包含一个前端 origin".into());
    }

    for origin in cors_allowed_origins {
        let value = origin.trim();
        if value == "*" {
            return Err("生产环境 CORS_ALLOWED_ORIGINS 不允许使用通配符 *".into());
        }

        let parsed = url::Url::parse(value)
            .map_err(|_| format!("生产环境 CORS_ALLOWED_ORIGINS 包含非法 origin：{}", value))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || parsed.username() != ""
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !matches!(parsed.path(), "" | "/")
        {
            return Err(format!(
                "生产环境 CORS_ALLOWED_ORIGINS 必须是 http(s) origin（不含路径、查询或凭据）：{}",
                value
            ));
        }
    }

    if !api_key_master_key_configured {
        return Err(
            "生产环境必须设置 WOOHOO_API_KEY_ENCRYPTION_KEY（64 位 hex，即 32 字节 AES-256 密钥）"
                .into(),
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_production_security;

    fn valid_origins() -> Vec<String> {
        vec!["https://app.example.com".to_string()]
    }

    #[test]
    fn rejects_demo_jwt_in_production() {
        let error = validate_production_security(
            "woohoo-demo-jwt-secret-change-before-production-2026",
            &valid_origins(),
            true,
        )
        .expect_err("demo secret must be rejected");
        assert!(error.contains("弱 JWT_SECRET"));
    }

    #[test]
    fn rejects_wildcard_or_invalid_cors() {
        let error = validate_production_security(
            "a-strong-random-jwt-value-that-is-long-enough",
            &["*".to_string()],
            true,
        )
        .expect_err("wildcard CORS must be rejected");
        assert!(error.contains("通配符"));

        let error = validate_production_security(
            "a-strong-random-jwt-value-that-is-long-enough",
            &["https://app.example.com/path".to_string()],
            true,
        )
        .expect_err("path CORS must be rejected");
        assert!(error.contains("origin"));
    }

    #[test]
    fn requires_api_key_master_key() {
        let error = validate_production_security(
            "a-strong-random-jwt-value-that-is-long-enough",
            &valid_origins(),
            false,
        )
        .expect_err("production must require the encryption key");
        assert!(error.contains("WOOHOO_API_KEY_ENCRYPTION_KEY"));
    }
}
