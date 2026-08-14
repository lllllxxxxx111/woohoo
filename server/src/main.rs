mod ai;
mod asset;
mod auth;
mod billing;
mod collaboration;
mod config;
mod content_version;
mod conversation;
mod db;
mod error;
mod export;
mod image_gen;
mod middleware; // 速率限制中间件
mod ops; // 分页查询支持
mod pagination; // 分页查询支持
mod pipeline; // 流程运行模型
mod project;
mod script;
mod storyboard;
mod video_gen;
mod workspace;

use axum::{
    http::{header, header::HeaderValue, Method},
    middleware as axum_middleware,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;
use std::{
    io::{ErrorKind, IsTerminal},
    net::SocketAddr,
    path::Path,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use ai::client::AiClient;
use config::AppConfig;

/// 全局应用状态
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: AppConfig,
    pub ai_client: AiClient,
    pub ai_runtime: ai::runtime::AiTaskRuntime,
    pub collaboration_broadcaster: collaboration::broadcast::CollaborationBroadcaster,
    pub started_at: i64,
}

#[tokio::main]
async fn main() {
    load_env_files();

    // 初始化日志
    let log_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "woohoo_server=info,tower_http=info".into());
    let has_terminal = std::io::stdout().is_terminal() || std::io::stderr().is_terminal();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(log_filter)
        .with_ansi(has_terminal);
    if has_terminal {
        subscriber.init();
    } else {
        subscriber.with_writer(std::io::sink).init();
    }

    // ─── SSRF 防护：开发模式开关生产安全检查 ──────────────
    //
    // 启动时拦截最严重的 SSRF 防护失效配置：
    // 若 `WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS=true` 且 `RUST_ENV=production`，
    // 直接 panic 拒绝启动。
    //
    // 必须在 AiClient 创建、数据库初始化、任何 HTTP 请求发起之前执行。
    // 检查本身只读环境变量，无副作用，开销可忽略。
    if let Err(error) = ai::ssrf_guard::assert_dev_mode_safe_at_startup() {
        tracing::error!("{}", error);
        panic!("{}", error);
    }

    // ─── API Key 加密：加载主密钥 ──────────────
    //
    // 从 `WOOHOO_API_KEY_ENCRYPTION_KEY` 环境变量加载 32 字节 AES-256 主密钥。
    // 未设置时全局密钥为 None（生产环境后续会检查是否已有 endpoint）。
    // 设置但格式非法（非 64 字符 hex）时直接 panic 拒绝启动。
    if let Err(error) = ai::api_key_crypto::init_from_env() {
        tracing::error!("{}", error);
        panic!("{}", error);
    }

    // 加载配置
    let mut config = AppConfig::from_env();
    tracing::info!("Starting Woohoo Server on {}:{}", config.host, config.port);

    let listener = bind_listener(&config).await;
    let bound_addr = listener.local_addr().expect("Failed to read bound address");
    if bound_addr.port() != config.port {
        tracing::warn!(
            "Port {} unavailable, switched to {}",
            config.port,
            bound_addr.port()
        );
        config.port = bound_addr.port();
    }
    if let Err(error) = write_runtime_manifest(&config, bound_addr) {
        tracing::warn!("Failed to write runtime manifest: {}", error);
    }
    let started_at = Utc::now().timestamp_millis();

    // 初始化数据库
    let pool = db::init_db(&config.database_url, config.ai_max_concurrent_tasks).await;

    // ─── API Key 加密：启动时安全检查 + 批量迁移 ──────────────
    //
    // 1. 生产环境若已有 AI endpoint 但未配置主密钥，拒绝启动（最严重配置）
    // 2. 已配置主密钥时，批量将数据库中的旧明文 API Key 迁移为密文
    //
    // 必须在数据库初始化后、AI 客户端创建前执行。
    if let Err(error) = ai::api_key_crypto::assert_production_safe_with_db(&pool).await {
        tracing::error!("{}", error);
        panic!("{}", error);
    }
    if let Err(error) = ai::api_key_crypto::migrate_all_endpoints(&pool).await {
        tracing::warn!("API Key 批量迁移失败（将继续启动）: {}", error);
    }

    // 创建 AI 客户端
    let ai_client = AiClient::new();
    let ai_runtime =
        ai::runtime::AiTaskRuntime::new(config.ai_max_concurrent_tasks, Some(pool.clone()));

    /*
     * 从数据库恢复任务状态
     * 运行中/排队中的任务会被标记为失败（服务重启导致中断）
     */
    match ai_runtime.restore_from_db().await {
        Ok(count) if count > 0 => {
            tracing::info!("已从数据库恢复 {} 个任务（运行中任务已标记为失败）", count);
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!("恢复任务状态失败: {} (将使用空内存启动)", e);
        }
    }

    reconcile_interrupted_image_generations(&pool).await;
    reconcile_interrupted_video_generations(&pool).await;

    let state = AppState {
        db: pool,
        config: config.clone(),
        ai_client,
        ai_runtime,
        collaboration_broadcaster: collaboration::broadcast::CollaborationBroadcaster::new(),
        started_at,
    };
    pipeline::orchestrator::reconcile_pipeline_document_assets(&state).await;
    if let Ok(paths) = asset::handlers::upload_paths(&state).await {
        asset::upload_session::start_cleanup_worker(state.db.clone(), paths);
    }
    ops::monitor::start_background_workers(state.clone());
    ops::dispatcher::start_dispatcher_worker(state.clone());
    pipeline::orchestrator::start_orchestrator_worker(state.clone());
    collaboration::worker::start_worker(state.clone());

    let is_production = std::env::var("RUST_ENV")
        .map(|value| value.eq_ignore_ascii_case("production"))
        .unwrap_or(false);

    // CORS 配置 - 根据环境变量限制允许的来源
    let allowed_origins: Vec<HeaderValue> = config
        .cors_allowed_origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect();

    if allowed_origins.is_empty() && is_production {
        tracing::error!("CORS_ALLOWED_ORIGINS 未配置且处于生产模式，将拒绝所有跨域请求！");
    }

    /*
     * 安全的CORS配置策略：
     * - 生产环境：严格限制为配置的前端域名
     * - 开发环境：默认允许localhost和127.0.0.1
     * - 如果没有配置任何来源，将返回空列表导致所有请求被拒绝
     */
    let cors = if allowed_origins.is_empty() {
        if is_production {
            tracing::warn!(
                mode = "production",
                origins = 0,
                "CORS 策略：无允许来源（生产模式），所有跨域请求将被拒绝"
            );
            CorsLayer::new()
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::AUTHORIZATION,
                    header::ACCEPT,
                    header::ORIGIN,
                    header::HeaderName::from_static("x-request-id"),
                    header::HeaderName::from_static("x-force-stream-fallback"),
                    header::HeaderName::from_static("forcestreamfallback"),
                ])
                .expose_headers([header::HeaderName::from_static("x-request-id")])
        } else {
            tracing::info!(
                mode = "development",
                "CORS 策略：开发模式，允许所有来源（AllowOrigin::Any）"
            );
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers(Any)
                .expose_headers([header::HeaderName::from_static("x-request-id")])
        }
    } else {
        tracing::info!(
            mode = if is_production {
                "production"
            } else {
                "development"
            },
            origins = allowed_origins.len(),
            "CORS 策略：已配置允许来源列表"
        );
        CorsLayer::new()
            .allow_origin(allowed_origins.into_iter().collect::<Vec<_>>())
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([
                header::CONTENT_TYPE,
                header::AUTHORIZATION,
                header::ACCEPT,
                header::ORIGIN,
                header::HeaderName::from_static("x-request-id"),
                header::HeaderName::from_static("x-force-stream-fallback"),
                header::HeaderName::from_static("forcestreamfallback"),
            ])
            .expose_headers([header::HeaderName::from_static("x-request-id")])
            .allow_credentials(true)
    };

    // ─── 安全性验证 ──────────────────────────────
    /**
     * JWT Secret 安全检查
     * 防止使用默认或弱密钥导致的安全风险
     *
     * 检查项：
     * 1. 密钥长度是否足够（至少32字符）
     * 2. 是否使用了示例文件中的默认值
     * 3. 是否包含常见弱密码模式
     */
    const DANGER_PATTERNS: &[&str] = &[
        "change-this-to-a-random-secret-key",
        "your-secret-key",
        "secret",
        "password",
        "jwt_secret",
    ];

    let is_weak_jwt_secret = config.jwt_secret.len() < 32
        || DANGER_PATTERNS
            .iter()
            .any(|pattern| config.jwt_secret.to_lowercase().contains(pattern));

    if is_weak_jwt_secret {
        tracing::error!(
            jwt_length = config.jwt_secret.len(),
            "⚠️  警告: JWT_SECRET 可能过于简单或不安全！请设置至少32个字符的随机字符串"
        );
        tracing::error!("建议使用以下命令生成安全的JWT Secret:");
        tracing::error!("  powershell -Command '[System.Guid]::NewGuid().ToString(\"N\")'");

        if std::env::var("RUST_ENV").map_or(false, |v| v.to_lowercase() == "production") {
            panic!(
                "生产环境不允许使用弱JWT Secret！当前长度: {}，要求至少32字符\n\
                 请设置环境变量 JWT_SECRET 为强随机值后重试。",
                config.jwt_secret.len()
            );
        }
        tracing::warn!("开发模式：将继续启动，但建议尽快更换为安全密钥");
    } else {
        tracing::info!(
            jwt_length = config.jwt_secret.len(),
            "✅ JWT Secret 配置通过安全检查"
        );
    }

    // ─── 路由 ────────────────────────────────────────

    // 公开路由（无需认证）
    let mut public_routes = Router::new()
        .route("/api/auth/register", post(auth::handlers::register))
        .route("/api/auth/login", post(auth::handlers::login))
        .route("/health", get(health_check));

    // Mock 端点仅在非生产环境下暴露
    if !is_production {
        tracing::info!("Mock 端点已启用（仅限非生产环境）");
        public_routes = public_routes
            .route(
                "/mock/v1/chat/completions",
                post(ai::mock::chat_completions),
            )
            .route("/mock/v1/models", get(ai::mock::models));
    }

    // 需要认证的路由
    let protected_routes = Router::new()
        // 用户
        .route("/api/auth/me", get(auth::handlers::me))
        .route(
            "/api/workspace/bootstrap",
            get(workspace::handlers::bootstrap),
        )
        .route(
            "/api/workspace/export/precheck/{project_id}",
            get(export::handlers::precheck),
        )
        .route(
            "/api/workspace/export/audits",
            get(export::handlers::list_audits).post(export::handlers::record_audit),
        )
        // 项目
        .route(
            "/api/projects",
            get(project::handlers::list_projects).post(project::handlers::create_project),
        )
        .route(
            "/api/projects/{id}",
            get(project::handlers::get_project)
                .put(project::handlers::update_project)
                .delete(project::handlers::delete_project),
        )
        // 对话
        .route(
            "/api/projects/{project_id}/conversations",
            get(conversation::handlers::list_conversations)
                .post(conversation::handlers::create_conversation),
        )
        .route(
            "/api/projects/{project_id}/agents",
            get(ai::catalog_handlers::list_project_agents)
                .post(ai::catalog_handlers::create_project_agent),
        )
        .route(
            "/api/projects/{project_id}/agents/assign",
            post(ai::catalog_handlers::assign_project_agent),
        )
        .route(
            "/api/projects/{project_id}/agents/{agent_id}",
            axum::routing::delete(ai::catalog_handlers::remove_project_agent),
        )
        .route(
            "/api/conversations/{id}/messages",
            get(conversation::handlers::list_messages).post(conversation::handlers::send_message),
        )
        .route(
            "/api/conversations/{id}/messages/{message_id}",
            delete(conversation::handlers::delete_message)
                .put(conversation::handlers::update_message),
        )
        .route(
            "/api/conversations/{id}/rewind",
            post(conversation::handlers::rewind_conversation),
        )
        .route(
            "/api/conversations/{id}",
            axum::routing::put(conversation::handlers::update_conversation)
                .delete(conversation::handlers::delete_conversation),
        )
        // 资产
        .route(
            "/api/projects/{project_id}/assets",
            get(asset::handlers::list_assets).post(asset::handlers::create_asset),
        )
        .route(
            "/api/projects/{project_id}/assets/upload",
            post(asset::handlers::upload_asset),
        )
        // 大文件分片上传协议（旧的 multipart 上传继续保留）
        .route(
            "/api/projects/{project_id}/uploads",
            post(asset::handlers::init_upload_session),
        )
        .route(
            "/api/projects/{project_id}/uploads/{session_id}",
            get(asset::handlers::get_upload_session)
                .delete(asset::handlers::abort_upload_session),
        )
        .route(
            "/api/projects/{project_id}/uploads/{session_id}/complete",
            post(asset::handlers::complete_upload_session),
        )
        .merge(asset::handlers::chunk_upload_routes())
        .route("/api/assets/search", get(asset::handlers::search_assets))
        .route(
            "/api/assets/{id}",
            get(asset::handlers::get_asset)
                .put(asset::handlers::update_asset)
                .delete(asset::handlers::delete_asset),
        )
        .route(
            "/api/assets/{id}/references",
            get(asset::handlers::get_asset_references),
        )
        .route(
            "/api/assets/{id}/tags",
            axum::routing::put(asset::handlers::update_asset_tags),
        )
        .route(
            "/api/assets/{id}/file",
            get(asset::handlers::get_asset_file),
        )
        // 剧本
        .route(
            "/api/projects/{project_id}/script",
            get(script::handlers::get_script)
                .put(script::handlers::upsert_script)
                .delete(script::handlers::delete_script),
        )
        // 分镜
        .route(
            "/api/projects/{project_id}/storyboard",
            get(storyboard::handlers::get_storyboard)
                .put(storyboard::handlers::upsert_storyboard)
                .delete(storyboard::handlers::delete_storyboard),
        )
        // 剧本版本历史 / 差异 / 恢复
        .route(
            "/api/projects/{project_id}/script/versions",
            get(content_version::handlers::list_script_versions),
        )
        .route(
            "/api/projects/{project_id}/script/versions/{version}",
            get(content_version::handlers::get_script_version_detail),
        )
        .route(
            "/api/projects/{project_id}/script/versions/{version}/diff",
            get(content_version::handlers::get_script_version_diff),
        )
        .route(
            "/api/projects/{project_id}/script/versions/{version}/restore",
            axum::routing::post(content_version::handlers::restore_script_version),
        )
        // 分镜版本历史 / 差异 / 恢复
        .route(
            "/api/projects/{project_id}/storyboard/versions",
            get(content_version::handlers::list_storyboard_versions),
        )
        .route(
            "/api/projects/{project_id}/storyboard/versions/{version}",
            get(content_version::handlers::get_storyboard_version_detail),
        )
        .route(
            "/api/projects/{project_id}/storyboard/versions/{version}/diff",
            get(content_version::handlers::get_storyboard_version_diff),
        )
        .route(
            "/api/projects/{project_id}/storyboard/versions/{version}/restore",
            axum::routing::post(content_version::handlers::restore_storyboard_version),
        )
        // AI
        .route(
            "/api/ai/endpoints",
            get(ai::catalog_handlers::list_endpoints).post(ai::catalog_handlers::create_endpoint),
        )
        .route(
            "/api/ai/endpoints/models",
            post(ai::catalog_handlers::list_endpoint_models),
        )
        .route(
            "/api/ai/endpoints/{id}",
            axum::routing::put(ai::catalog_handlers::update_endpoint)
                .delete(ai::catalog_handlers::delete_endpoint),
        )
        .route(
            "/api/ai/endpoints/{id}/capabilities",
            get(ai::catalog_handlers::list_endpoint_capabilities)
                .put(ai::catalog_handlers::upsert_endpoint_capability),
        )
        .route(
            "/api/ai/endpoints/{id}/test",
            post(ai::handlers::test_endpoint_with_saved_key),
        )
        .route(
            "/api/ai/agents",
            get(ai::catalog_handlers::list_agents).post(ai::catalog_handlers::create_agent),
        )
        .route(
            "/api/ai/agents/{id}",
            axum::routing::put(ai::catalog_handlers::update_agent)
                .delete(ai::catalog_handlers::delete_agent),
        )
        .route("/api/ai/test", post(ai::handlers::test_endpoint))
        .route("/api/ai/tasks/stream", get(ai::task_handlers::stream_tasks))
        .route(
            "/api/ai/tasks",
            get(ai::task_handlers::list_tasks).post(ai::task_handlers::create_task),
        )
        .route(
            "/api/ai/tasks/{id}",
            get(ai::task_handlers::get_task).delete(ai::task_handlers::cancel_task),
        )
        .route(
            "/api/ai/tasks/{id}/remove",
            delete(ai::task_handlers::remove_task),
        )
        .route(
            "/api/ai/usage/summary",
            get(ai::task_handlers::usage_summary),
        )
        .route(
            "/api/ai/usage/records",
            get(ai::task_handlers::usage_records),
        )
        .route("/api/ai/chat", post(ai::handlers::ai_chat))
        .route("/api/ai/chat/stream", post(ai::handlers::ai_chat_stream))
        .route(
            "/api/pipelines/review-queue",
            get(pipeline::handlers::list_review_queue),
        )
        // 流程运行（Pipeline Runs）
        .route(
            "/api/pipelines/runs",
            get(pipeline::handlers::list_pipeline_runs)
                .post(pipeline::handlers::create_pipeline_run),
        )
        .route(
            "/api/pipelines/runs/{id}",
            get(pipeline::handlers::get_pipeline_run),
        )
        .route(
            "/api/pipelines/runs/{id}/optimizations",
            get(pipeline::handlers::list_pipeline_optimizations),
        )
        // Prompt 优化建议：应用 / 回滚 / 版本差异 / 效果对比 / 回滚建议
        .route(
            "/api/pipelines/runs/{id}/optimizations/{optimization_id}/apply",
            post(pipeline::prompt_optimizations::apply_optimization),
        )
        .route(
            "/api/pipelines/runs/{id}/optimizations/{optimization_id}/rollback",
            post(pipeline::prompt_optimizations::rollback_optimization),
        )
        .route(
            "/api/pipelines/runs/{id}/optimizations/{optimization_id}/diff",
            get(pipeline::prompt_optimizations::get_optimization_diff),
        )
        .route(
            "/api/pipelines/runs/{id}/optimizations/{optimization_id}/effect",
            get(pipeline::prompt_optimizations::get_effect_comparison),
        )
        .route(
            "/api/pipelines/runs/{id}/optimizations/{optimization_id}/rollback-recommendation",
            get(pipeline::prompt_optimizations::get_rollback_recommendation),
        )
        // 项目级 / 步骤级 Prompt 自动应用配置（默认关闭）
        .route(
            "/api/pipelines/projects/{project_id}/prompt-auto-apply",
            get(pipeline::prompt_optimizations::get_auto_apply_config)
                .put(pipeline::prompt_optimizations::set_auto_apply_config),
        )
        .route(
            "/api/pipelines/runs/{id}/pause",
            post(pipeline::handlers::pause_pipeline_run),
        )
        .route(
            "/api/pipelines/runs/{id}/resume",
            post(pipeline::handlers::resume_pipeline_run),
        )
        .route(
            "/api/pipelines/runs/{id}/cancel",
            post(pipeline::handlers::cancel_pipeline_run),
        )
        .route(
            "/api/pipelines/runs/{id}/retry-step",
            post(pipeline::handlers::retry_pipeline_step),
        )
        .route(
            "/api/pipelines/runs/{id}/steps/{step_id}/reviews",
            get(pipeline::handlers::list_step_reviews),
        )
        .route(
            "/api/pipelines/runs/{id}/steps/{step_id}/review-decision",
            post(pipeline::handlers::submit_review_decision),
        )
        .route(
            "/api/pipelines/runs/{id}/stream",
            get(pipeline::handlers::stream_pipeline_run),
        )
        // 助理动作权限与审计
        .route(
            "/api/ai/policy",
            get(ai::policy_handlers::get_action_policy)
                .put(ai::policy_handlers::update_action_policy),
        )
        .route(
            "/api/ai/action-audits",
            get(ai::policy_handlers::list_action_audits),
        )
        .route(
            "/api/ai/action-audits/{id}/confirm-token",
            post(ai::policy_handlers::create_confirmation_token),
        )
        .route(
            "/api/ai/action-audits/consume-token",
            post(ai::policy_handlers::consume_confirmation_token),
        )
        // 协同会话
        .route(
            "/api/collaboration/sessions",
            post(collaboration::handlers::create_session),
        )
        .route(
            "/api/collaboration/sessions/active",
            get(collaboration::handlers::get_active_session),
        )
        .route(
            "/api/collaboration/readiness",
            get(collaboration::handlers::get_readiness),
        )
        .route(
            "/api/collaboration/events/stream",
            get(collaboration::handlers::stream_collaboration_events),
        )
        .route(
            "/api/collaboration/sessions/{id}",
            get(collaboration::handlers::get_session),
        )
        .route(
            "/api/collaboration/sessions/{id}/dispatch",
            post(collaboration::handlers::dispatch),
        )
        .route(
            "/api/collaboration/sessions/{id}/messages",
            get(collaboration::handlers::list_messages).post(collaboration::handlers::send_message),
        )
        .route(
            "/api/collaboration/sessions/{id}/loop-check",
            post(collaboration::handlers::loop_check),
        )
        .route(
            "/api/collaboration/sessions/{id}/admit",
            post(collaboration::handlers::admit),
        )
        .route(
            "/api/collaboration/sessions/{id}/halt",
            post(collaboration::handlers::halt),
        )
        .route(
            "/api/collaboration/sessions/{id}/resume",
            post(collaboration::handlers::resume),
        )
        .route(
            "/api/collaboration/sessions/{id}/queue",
            get(collaboration::handlers::get_queue),
        )
        .route("/api/ops/overview", get(ops::handlers::overview))
        .route("/api/ops/heartbeats", get(ops::handlers::list_heartbeats))
        .route("/api/ops/findings", get(ops::handlers::list_findings))
        .route(
            "/api/ops/notification-events",
            get(ops::handlers::list_notification_events),
        )
        .route(
            "/api/ops/notification-channels",
            get(ops::handlers::list_notification_channels)
                .post(ops::handlers::create_notification_channel),
        )
        .route(
            "/api/ops/notification-channels/test",
            post(ops::handlers::test_notification_channel),
        )
        .route(
            "/api/ops/notification-channels/{id}",
            axum::routing::put(ops::handlers::update_notification_channel)
                .delete(ops::handlers::delete_notification_channel),
        )
        // 图片生成（Image Studio）
        .route(
            "/api/image-gen/generations",
            post(image_gen::handlers::create_generation).get(image_gen::handlers::list_generations),
        )
        .route(
            "/api/image-gen/generations/{id}",
            get(image_gen::handlers::get_generation),
        )
        // 视频生成
        .route(
            "/api/video-gen/generations",
            post(video_gen::handlers::create_generation).get(video_gen::handlers::list_generations),
        )
        .route(
            "/api/video-gen/generations/{id}",
            get(video_gen::handlers::get_generation),
        )
        // 计费
        .route("/api/billing/credits", get(billing::handlers::get_credits))
        .route(
            "/api/billing/transactions",
            get(billing::handlers::list_credit_transactions),
        )
        .route(
            "/api/billing/budget",
            get(billing::budget_handlers::get_budget_status)
                .put(billing::budget_handlers::update_budget_settings),
        )
        .route(
            "/api/billing/budget/blocks",
            get(billing::budget_handlers::list_budget_blocks),
        )
        .route_layer(axum_middleware::from_fn_with_state(
            state.clone(),
            auth::middleware::auth_middleware,
        ));

    /*
     * 创建速率限制器实例
     *
     * 安全配置：
     * - 通用API: 100次/分钟
     * - 认证端点: 20次/分钟（防暴力破解）
     */
    let rate_limiter = crate::middleware::create_rate_limiter();
    let auth_rate_limiter = crate::middleware::create_auth_rate_limiter();

    let app = public_routes
        .layer(axum::middleware::from_fn_with_state(
            auth_rate_limiter.clone(),
            crate::middleware::rate_limit_middleware,
        )) // 认证端点应用严格限制
        .merge(protected_routes)
        .layer(axum::middleware::from_fn(
            crate::middleware::request_id_middleware,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(axum::middleware::from_fn_with_state(
            rate_limiter,
            crate::middleware::rate_limit_middleware,
        )) // 所有路由应用通用限制
        .layer(cors)
        .with_state(state);

    // 启动服务
    tracing::info!("🚀 Server listening on {}", bound_addr);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap();
}

fn load_env_files() {
    for path in ["server/.env.local", "server/.env", ".env.local", ".env"] {
        let _ = dotenvy::from_filename(path);
    }
}

async fn reconcile_interrupted_image_generations(pool: &SqlitePool) {
    let interrupted = match image_gen::repo::list_interrupted_generations(pool).await {
        Ok(generations) => generations,
        Err(error) => {
            tracing::warn!(
                "Failed to list interrupted image generation tasks: {}",
                error
            );
            return;
        }
    };

    for generation in &interrupted {
        match billing::repo::refund_outstanding_for_ref(
            pool,
            &generation.user_id,
            "image_generation",
            &generation.id,
            "image_generation_interrupted",
        )
        .await
        {
            Ok(amount) if amount > 0.0 => {
                tracing::info!(
                    generation_id = %generation.id,
                    amount,
                    "Refunded interrupted image generation charge"
                );
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(
                    generation_id = %generation.id,
                    error = %error,
                    "Failed to refund interrupted image generation charge"
                );
            }
        }
    }

    match image_gen::repo::fail_interrupted_generations(pool).await {
        Ok(count) if count > 0 => {
            tracing::info!(
                "Marked {} interrupted image generation tasks as failed",
                count
            );
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(
                "Failed to reconcile interrupted image generation tasks: {}",
                error
            );
        }
    }
}

/// 对账中断的视频生成任务
async fn reconcile_interrupted_video_generations(pool: &SqlitePool) {
    let interrupted = match video_gen::repo::list_interrupted_generations(pool).await {
        Ok(generations) => generations,
        Err(error) => {
            tracing::warn!(
                "Failed to list interrupted video generation tasks: {}",
                error
            );
            return;
        }
    };

    for generation in &interrupted {
        match billing::repo::refund_outstanding_for_ref(
            pool,
            &generation.user_id,
            "video_generation",
            &generation.id,
            "video_generation_interrupted",
        )
        .await
        {
            Ok(amount) if amount > 0.0 => {
                tracing::info!(
                    generation_id = %generation.id,
                    amount,
                    "Refunded interrupted video generation charge"
                );
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(
                    generation_id = %generation.id,
                    error = %error,
                    "Failed to refund interrupted video generation charge"
                );
            }
        }
    }

    match video_gen::repo::fail_interrupted_generations(pool).await {
        Ok(count) if count > 0 => {
            tracing::info!(
                "Marked {} interrupted video generation tasks as failed",
                count
            );
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(
                "Failed to reconcile interrupted video generation tasks: {}",
                error
            );
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheckResponse {
    status: &'static str,
    service: &'static str,
    host: String,
    port: u16,
    base_url: String,
    pid: u32,
    started_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    service: &'static str,
    host: String,
    port: u16,
    base_url: String,
    health_url: String,
    pid: u32,
    started_at: i64,
}

async fn health_check(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<HealthCheckResponse> {
    let host = external_host(&state.config.host);
    Json(HealthCheckResponse {
        status: "ok",
        service: "woohoo-server",
        host: host.clone(),
        port: state.config.port,
        base_url: format!("http://{}:{}", host, state.config.port),
        pid: std::process::id(),
        started_at: state.started_at,
    })
}

async fn bind_listener(config: &AppConfig) -> tokio::net::TcpListener {
    for offset in 0..=config.port_search_limit {
        let port = config.port.saturating_add(offset);
        let addr: SocketAddr = format!("{}:{}", config.host, port)
            .parse()
            .expect("Invalid address");

        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => return listener,
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::AddrInUse | ErrorKind::PermissionDenied
                ) && offset < config.port_search_limit =>
            {
                tracing::warn!(
                    "Port {} unavailable ({:?}), trying {}",
                    port,
                    error.kind(),
                    port + 1
                );
            }
            Err(error) => panic!("Failed to bind server listener: {}", error),
        }
    }

    unreachable!("listener binding loop must return or panic")
}

fn write_runtime_manifest(config: &AppConfig, bound_addr: SocketAddr) -> anyhow::Result<()> {
    let path = Path::new(&config.runtime_manifest_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let host = external_host(&config.host);
    let manifest = RuntimeManifest {
        service: "woohoo-server",
        host: host.clone(),
        port: bound_addr.port(),
        base_url: format!("http://{}:{}", host, bound_addr.port()),
        health_url: format!("http://{}:{}/health", host, bound_addr.port()),
        pid: std::process::id(),
        started_at: Utc::now().timestamp_millis(),
    };

    std::fs::write(path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(())
}

fn external_host(host: &str) -> String {
    match host.trim() {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_string(),
        value => value.to_string(),
    }
}
