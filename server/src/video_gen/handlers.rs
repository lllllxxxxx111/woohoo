use axum::{
    extract::{Path, State},
    Json,
};
use sqlx::SqlitePool;
use std::env;
use std::time::Duration;

use crate::ai::ssrf_guard;
use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::model::*;
use super::repo;

const VIDEO_GEN_TIMEOUT_SECS: u64 = 3600;

/**
 * 视频生成任务入队公共入口
 *
 * 提取自 create_generation handler，供 orchestrator 在 dispatch_video_gen_step 中复用。
 * 完整流程：参数校验 → 端点解析 → 扣费 → 建 DB 记录 → set_processing → spawn 后台任务。
 *
 * @param state 应用全局状态
 * @param user_id 触发用户 ID
 * @param project_id 关联项目 ID（可选）
 * @param prompt 视频生成提示词
 * @param model 模型名
 * @param duration_seconds 视频时长（秒，0-60）
 * @param aspect_ratio 宽高比，如 "16:9"
 * @returns 创建好的 VideoGeneration 记录（status=processing）
 */
pub(crate) async fn enqueue_video_generation(
    state: &AppState,
    user_id: &str,
    project_id: Option<&str>,
    prompt: &str,
    model: &str,
    duration_seconds: Option<f64>,
    aspect_ratio: &str,
) -> Result<VideoGeneration, AppError> {
    if prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt cannot be empty".to_string()));
    }

    if let Some(duration) = duration_seconds {
        if duration <= 0.0 || duration > 60.0 {
            return Err(AppError::BadRequest(
                "duration_seconds must be between 0 and 60".to_string(),
            ));
        }
    }

    // 项目归属校验：不能信任前端传入的 project_id。
    // 必须在任何 side effect（扣费 / 建 DB 记录 / spawn 后台任务）之前完成，
    // 否则用户可以用他人的 project_id 触发扣费和资源创建。
    // 与 image_gen/handlers.rs 的 ensure_project_access 行为保持一致。
    let normalized_project_id = normalize_project_id(project_id);
    if let Some(pid) = normalized_project_id.as_deref() {
        ensure_project_access(&state.db, user_id, pid).await?;
    }

    let resolved = crate::ai::capabilities::resolve_video_generation_capability(
        state,
        user_id,
        None,
        Some(model),
    )
    .await
    .map_err(|error| {
        tracing::warn!(error = %error, "video generation endpoint resolution failed");
        let api_key = env::var("AI_API_KEY").unwrap_or_default();
        if api_key.is_empty() {
            return AppError::Validation(
                "Please enable a video generation API channel in settings or configure AI_API_KEY."
                    .into(),
            );
        }
        AppError::Internal(format!(
            "video generation endpoint resolution failed: {}",
            error
        ))
    })?;

    let resolved_model = resolved.model.clone();
    let cost = calculate_cost(&resolved_model, duration_seconds);

    crate::billing::budget_enforce::enforce_budget(
        &state.db,
        user_id,
        cost,
        "video_generation",
        true,
        Some(&resolved_model),
        normalized_project_id.as_deref(),
    )
    .await?;

    crate::billing::repo::check_and_deduct(
        &state.db,
        user_id,
        cost,
        "video_generation",
        Some("video_generation"),
        None,
    )
    .await
    .map_err(|error| AppError::PaymentRequired(error.to_string()))?;

    let generation = match repo::create_generation(
        &state.db,
        user_id,
        normalized_project_id.as_deref(),
        prompt,
        &resolved_model,
        duration_seconds,
        aspect_ratio,
        cost,
    )
    .await
    {
        Ok(generation) => generation,
        Err(error) => {
            if let Err(refund_error) = crate::billing::repo::refund_with_ref_type(
                &state.db,
                user_id,
                cost,
                "video_generation_record_create_failed",
                "video_generation",
                None,
            )
            .await
            {
                tracing::error!(error = %refund_error, "failed to refund after video generation record creation failed");
            }
            return Err(AppError::Internal(error.to_string()));
        }
    };

    if let Err(error) = crate::billing::repo::update_spent_ref_id(
        &state.db,
        user_id,
        "video_generation",
        &generation.id,
    )
    .await
    {
        tracing::warn!(generation_id = %generation.id, error = %error, "failed to update video generation billing ref_id");
    }

    if let Err(error) = repo::set_processing(&state.db, &generation.id).await {
        refund_and_fail(state, user_id, &generation.id, cost, &error.to_string()).await?;
        return Err(AppError::Internal(error.to_string()));
    }

    let base_url = resolved.endpoint.base_url.clone();
    let api_key = resolved.endpoint.api_key.clone();
    let task_model = resolved_model.clone();

    // 计算 video API URL：优先使用 capability.path_override，
    // 其次环境变量 VIDEO_API_URL，最后回退到 base_url + 默认路径。
    // SSRF 防护：path_override 若为绝对 URL，必须独立校验，
    // 防止攻击者用绝对 URL 绕过已校验的 base_url，直连内网/云元数据。
    let path_override_opt = resolved
        .capability
        .as_ref()
        .and_then(|capability| capability.path_override.as_deref())
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| path.to_string());

    if let Some(ref path) = path_override_opt {
        ssrf_guard::validate_path_override(path).await?;
    }

    let video_api_url = if let Some(path) = path_override_opt {
        if ssrf_guard::is_absolute_url(&path) {
            path
        } else {
            format!(
                "{}/{}",
                base_url.trim_end_matches('/'),
                path.trim_start_matches('/')
            )
        }
    } else {
        env::var("VIDEO_API_URL").unwrap_or_else(|_| {
            format!("{}/v1/video/generations", base_url.trim_end_matches('/'))
        })
    };

    let task_req = CreateVideoGenerationReq {
        prompt: prompt.to_string(),
        model: task_model.clone(),
        duration_seconds,
        aspect_ratio: aspect_ratio.to_string(),
        project_id: normalized_project_id.clone(),
    };

    let task_state = state.clone();
    let task_user_id = user_id.to_string();
    let task_generation_id = generation.id.clone();

    tokio::spawn(async move {
        if let Err(error) = run_generation_task(
            task_state,
            task_user_id,
            task_generation_id.clone(),
            video_api_url,
            api_key,
            task_model,
            task_req,
            cost,
        )
        .await
        {
            tracing::error!(
                generation_id = %task_generation_id,
                error = %error,
                "background video generation task failed"
            );
        }
    });

    Ok(generation)
}

/**
 * POST /api/video-gen/generations
 *
 * HTTP handler，薄壳：解析 body → 调用 enqueue_video_generation → 返回响应。
 */
pub async fn create_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<CreateVideoGenerationReq>,
) -> Result<Json<VideoGenerationResponse>, AppError> {
    let generation = enqueue_video_generation(
        &state,
        &user_id.0,
        req.project_id.as_deref(),
        &req.prompt,
        &req.model,
        req.duration_seconds,
        &req.aspect_ratio,
    )
    .await?;

    build_generation_response(&state.db, &generation.id, &user_id.0).await
}

async fn run_generation_task(
    state: AppState,
    user_id: String,
    generation_id: String,
    video_api_url: String,
    api_key: String,
    model: String,
    req: CreateVideoGenerationReq,
    cost: f64,
) -> Result<(), AppError> {
    let generate_result = tokio::time::timeout(
        Duration::from_secs(VIDEO_GEN_TIMEOUT_SECS),
        call_video_api(&state, &video_api_url, &api_key, &model, &req),
    )
    .await;

    match generate_result {
        Ok(Ok(response)) => {
            repo::set_completed(
                &state.db,
                &generation_id,
                response.url.as_deref(),
                response.b64_json.as_deref(),
                cost,
            )
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        }
        Ok(Err(error)) => {
            refund_and_fail(&state, &user_id, &generation_id, cost, &error.to_string()).await?;
        }
        Err(_) => {
            let timeout_msg = format!(
                "video generation timed out after {}s",
                VIDEO_GEN_TIMEOUT_SECS
            );
            refund_and_fail(&state, &user_id, &generation_id, cost, &timeout_msg).await?;
        }
    }

    Ok(())
}

pub async fn get_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(generation_id): Path<String>,
) -> Result<Json<VideoGenerationResponse>, AppError> {
    build_generation_response(&state.db, &generation_id, &user_id.0).await
}

pub async fn list_generations(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<Vec<VideoGenerationResponse>>, AppError> {
    let generations = repo::list_user_generations(&state.db, &user_id.0, 50, 0)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;

    Ok(Json(
        generations
            .into_iter()
            .map(generation_to_response)
            .collect(),
    ))
}

struct VideoApiResponse {
    url: Option<String>,
    b64_json: Option<String>,
}

async fn call_video_api(
    _state: &AppState,
    api_url: &str,
    api_key: &str,
    model: &str,
    req: &CreateVideoGenerationReq,
) -> Result<VideoApiResponse, AppError> {
    // SSRF 运行时校验：在发起 HTTP 请求前重新校验 api_url，
    // 防止 DNS rebinding（enqueue 时校验通过后 DNS 切换到内网）。
    // 也覆盖了 VIDEO_API_URL 环境变量路径（未在 enqueue 时校验）。
    ssrf_guard::validate_endpoint_url(api_url).await?;

    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(VIDEO_GEN_TIMEOUT_SECS))
        // SSRF 防护：禁止自动跟随重定向，防止 302 → 内网 IP 绕过校验
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| AppError::Internal(format!("failed to create HTTP client: {}", error)))?;

    let mut request = client
        .post(api_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");

    if !api_key.trim().is_empty() {
        request = request.header("Authorization", format!("Bearer {}", api_key.trim()));
    }

    let body = serde_json::json!({
        "model": model,
        "prompt": req.prompt,
        "aspect_ratio": req.aspect_ratio,
        "duration": req.duration_seconds,
    });

    let response = request.json(&body).send().await.map_err(|error| {
        AppError::Internal(format!("video generation API call failed: {}", error))
    })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "video generation API returned {}: {}",
            status, body
        )));
    }

    let body: serde_json::Value = response.json().await.map_err(|error| {
        AppError::Internal(format!(
            "failed to parse video generation response: {}",
            error
        ))
    })?;

    let url = body
        .get("data")
        .and_then(|data| data.get("url"))
        .or_else(|| body.get("url"))
        .and_then(|value| value.as_str())
        .map(String::from);

    let b64_json = body
        .get("data")
        .and_then(|data| data.get("b64_json"))
        .or_else(|| body.get("b64_json"))
        .and_then(|value| value.as_str())
        .map(String::from);

    Ok(VideoApiResponse { url, b64_json })
}

async fn refund_and_fail(
    state: &AppState,
    user_id: &str,
    generation_id: &str,
    cost: f64,
    error_msg: &str,
) -> Result<(), AppError> {
    if let Err(refund_error) = crate::billing::repo::refund_with_ref_type(
        &state.db,
        user_id,
        cost,
        "video_generation_failed",
        "video_generation",
        Some(generation_id),
    )
    .await
    {
        tracing::error!(
            generation_id = %generation_id,
            error = %refund_error,
            "failed to refund video generation charge"
        );
    }

    repo::set_failed(&state.db, generation_id, error_msg)
        .await
        .map_err(|repo_error| AppError::Internal(repo_error.to_string()))?;

    Ok(())
}

async fn build_generation_response(
    db: &SqlitePool,
    generation_id: &str,
    user_id: &str,
) -> Result<Json<VideoGenerationResponse>, AppError> {
    let generation = repo::get_generation(db, generation_id)
        .await
        .map_err(|error| AppError::NotFound(format!("video generation not found: {}", error)))?;

    if generation.user_id != user_id {
        return Err(AppError::Forbidden(
            "not allowed to access this video generation".to_string(),
        ));
    }

    Ok(Json(generation_to_response(generation)))
}

fn generation_to_response(row: VideoGeneration) -> VideoGenerationResponse {
    VideoGenerationResponse {
        id: row.id,
        prompt: row.prompt,
        model: row.model,
        duration_seconds: row.duration_seconds,
        aspect_ratio: row.aspect_ratio,
        status: row.status,
        error_message: row.error_message,
        url: row.result_url,
        b64_data: row.result_b64_json,
        cost_credits: row.cost_credits,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }
}

fn calculate_cost(model: &str, duration_seconds: Option<f64>) -> f64 {
    let base_cost = match model {
        "wan2.1-t2v-480p" => 10.0,
        "wan2.1-t2v-720p" => 20.0,
        "runway-gen3" => 30.0,
        "pika-1.0" => 25.0,
        _ => 15.0,
    };

    let duration_multiplier = duration_seconds
        .map(|duration| (duration / 5.0).max(1.0))
        .unwrap_or(1.0);

    base_cost * duration_multiplier
}

/**
 * 标准化 project_id：trim + 过滤空字符串 → Option<String>。
 *
 * 与 image_gen/handlers.rs::normalize_project_id 行为一致。
 * 前端可能传入 "" / "  " / None，统一归一化为 None，
 * 避免空字符串被误当作有效 project_id 触发 ensure_project_access 的 NotFound。
 */
fn normalize_project_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/**
 * 校验当前用户拥有指定项目的访问权限。
 *
 * 安全设计：
 *   - 不信任前端传入的 project_id，必须查 DB 验证 project.user_id == user_id。
 *   - 项目不存在 → NotFound（404），不泄露"项目存在但不属于你"的信息。
 *   - 项目存在但 user_id 不匹配 → Forbidden（403）。
 *   - 项目存在且 user_id 匹配 → Ok(())。
 *
 * 调用点：enqueue_video_generation 内，在任何 side effect 之前。
 * 与 image_gen/handlers.rs::ensure_project_access 行为一致。
 *
 * @param db 数据库连接池
 * @param user_id 当前认证用户 ID
 * @param project_id 待校验的项目 ID（已标准化，非空）
 * @returns Ok(()) 表示校验通过；Err(AppError) 表示项目不存在或无权访问
 */
async fn ensure_project_access(
    db: &SqlitePool,
    user_id: &str,
    project_id: &str,
) -> Result<(), AppError> {
    let project = crate::project::repo::find_by_id(db, project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("project not found".to_string()))?;
    if project.user_id != user_id {
        return Err(AppError::Forbidden(
            "not allowed to use this project for video generation".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use uuid::Uuid;

    /// 构造测试用 SQLite 连接池（带完整 schema，通过 init_db 自动迁移）
    async fn create_test_pool() -> SqlitePool {
        let db_path = std::env::temp_dir().join(format!(
            "woohoo-video-gen-perm-{}.sqlite",
            Uuid::new_v4()
        ));
        let database_url = format!(
            "sqlite://{}",
            db_path.to_string_lossy().replace('\\', "/")
        );
        // init_db 会自动运行 schema migrations（含 017_video_gen）
        let pool = init_db(&database_url, 10).await;
        // 保留 db_path，由 OS temp 自动回收
        pool
    }

    /// 创建测试用户
    async fn seed_user(pool: &SqlitePool, user_id: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (?, ?, ?, '')",
        )
        .bind(user_id)
        .bind(format!("user-{}", user_id))
        .bind(format!("{}@test.local", user_id))
        .execute(pool)
        .await
        .expect("failed to seed user");
    }

    /// 创建测试项目（指定 owner）
    async fn seed_project(pool: &SqlitePool, project_id: &str, owner_user_id: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO projects (id, user_id, name, created_at, updated_at) \
             VALUES (?, ?, 'Test Project', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(project_id)
        .bind(owner_user_id)
        .execute(pool)
        .await
        .expect("failed to seed project");
    }

    /// 创建测试视频生成记录（指定 owner 和 project）
    async fn seed_video_generation(
        pool: &SqlitePool,
        generation_id: &str,
        owner_user_id: &str,
        project_id: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO video_generations \
             (id, user_id, project_id, prompt, model, duration_seconds, aspect_ratio, status, cost_credits, created_at) \
             VALUES (?, ?, ?, 'test prompt', 'wan2.1-t2v-480p', 5.0, '16:9', 'completed', 10.0, '2026-01-01T00:00:00Z')",
        )
        .bind(generation_id)
        .bind(owner_user_id)
        .bind(project_id)
        .execute(pool)
        .await
        .expect("failed to seed video generation");
    }

    /// 正常授权场景：用户访问自己的项目 → Ok(())
    /// 验证 ensure_project_access 在用户拥有项目时放行。
    #[tokio::test]
    async fn ensure_project_access_allows_owner() {
        let pool = create_test_pool().await;
        seed_user(&pool, "user-1").await;
        seed_project(&pool, "project-1", "user-1").await;

        let result = ensure_project_access(&pool, "user-1", "project-1").await;
        assert!(
            result.is_ok(),
            "项目所有者应通过权限校验，got: {:?}",
            result
        );

        pool.close().await;
    }

    /// 跨用户访问场景：user-2 尝试用 user-1 的 project_id → Forbidden
    /// 验证 ensure_project_access 拒绝跨用户访问，不能信任前端传入的 project_id。
    #[tokio::test]
    async fn ensure_project_access_rejects_cross_user() {
        let pool = create_test_pool().await;
        seed_user(&pool, "user-1").await;
        seed_user(&pool, "user-2").await;
        seed_project(&pool, "project-1", "user-1").await;

        let result = ensure_project_access(&pool, "user-2", "project-1").await;
        assert!(
            matches!(result, Err(AppError::Forbidden(_))),
            "跨用户访问应返回 Forbidden（403），got: {:?}",
            result
        );

        pool.close().await;
    }

    /// 无效项目场景：用户传入不存在的 project_id → NotFound
    /// 验证 ensure_project_access 对无效项目返回 NotFound，不泄露项目存在性。
    #[tokio::test]
    async fn ensure_project_access_returns_not_found_for_invalid_project() {
        let pool = create_test_pool().await;
        seed_user(&pool, "user-1").await;

        let result = ensure_project_access(&pool, "user-1", "nonexistent-project").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "无效项目应返回 NotFound（404），got: {:?}",
            result
        );

        pool.close().await;
    }

    /// 回调越权场景：user-2 通过 generation_id 读取 user-1 的视频生成结果 → Forbidden
    /// 验证 build_generation_response（GET /api/video-gen/generations/{id} 的核心逻辑）
    /// 不能仅凭 generation_id 放行，必须校验 generation.user_id == 当前 user_id。
    /// 这覆盖了"回调越权"风险：即使攻击者猜到 generation_id，也无法读取他人结果。
    #[tokio::test]
    async fn build_generation_response_rejects_cross_user_access() {
        let pool = create_test_pool().await;
        seed_user(&pool, "user-1").await;
        seed_user(&pool, "user-2").await;
        seed_project(&pool, "project-1", "user-1").await;
        // user-1 的视频生成记录，关联 project-1
        seed_video_generation(&pool, "gen-1", "user-1", Some("project-1")).await;

        // user-2 尝试读取 user-1 的 generation → Forbidden
        let result = build_generation_response(&pool, "gen-1", "user-2").await;
        assert!(
            matches!(result, Err(AppError::Forbidden(_))),
            "跨用户读取 generation 应返回 Forbidden（403），got: {:?}",
            result
        );

        // user-1 读取自己的 generation → Ok
        let result = build_generation_response(&pool, "gen-1", "user-1").await;
        assert!(
            result.is_ok(),
            "所有者读取自己的 generation 应成功，got: {:?}",
            result
        );

        // 不存在的 generation_id → NotFound
        let result = build_generation_response(&pool, "nonexistent-gen", "user-1").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "不存在的 generation_id 应返回 NotFound（404），got: {:?}",
            result
        );

        pool.close().await;
    }

    /// normalize_project_id 单元测试：验证空字符串 / 纯空白 / None 均归一化为 None。
    #[test]
    fn normalize_project_id_handles_empty_and_whitespace() {
        assert_eq!(normalize_project_id(None), None);
        assert_eq!(normalize_project_id(Some("")), None);
        assert_eq!(normalize_project_id(Some("   ")), None);
        assert_eq!(
            normalize_project_id(Some("project-1")),
            Some("project-1".to_string())
        );
        assert_eq!(
            normalize_project_id(Some("  project-1  ")),
            Some("project-1".to_string())
        );
    }
}
