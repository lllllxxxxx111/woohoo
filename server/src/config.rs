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
}
