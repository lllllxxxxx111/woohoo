use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use sqlx::SqlitePool;
use std::env;
use std::time::Duration;
use uuid::Uuid;

use crate::ai::ssrf_guard;
use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::model::*;
use super::repo;

const VIDEO_GEN_TIMEOUT_SECS: u64 = 3600;

/// 标识 `X-Idempotency-Key` HTTP 头，用于客户端幂等重试。
const IDEMPOTENCY_KEY_HEADER: &str = "x-idempotency-key";

/**
 * 视频生成任务入队公共入口
 *
 * 提取自 create_generation handler，供 orchestrator 在 dispatch_video_gen_step 中复用。
 * 完整流程：参数校验 → 端点解析 → 预生成 generation_id → 幂等扣费 →
 *         建 DB 记录（使用预生成 id） → set_processing → spawn 后台任务。
 *
 * Billing 幂等设计（与 image_gen 保持一致）：
 *   1. 在扣费前预生成 generation_id（或使用客户端传入的 idempotency_key 作为 id）；
 *   2. 调用 `check_and_deduct_idempotent` 时把 generation_id 作为 ref_id 传入，
 *      在事务内原子完成"扣减余额 + 写入 spent 记录（带 ref_id）"；
 *   3. 依赖 028 migration 的 (ref_type, ref_id) UNIQUE 索引，同一 id 的重复扣费
 *      会因 UNIQUE 冲突回滚，返回当前余额（视为已扣费）；
 *   4. 不再调用 `update_spent_ref_id`，消除旧版"先扣费后关联"的竞态；
 *   5. 退款统一走 `refund_outstanding_for_ref`，按 ref_id 幂等（最多退一次）。
 *
 * @param state 应用全局状态
 * @param user_id 触发用户 ID
 * @param project_id 关联项目 ID（可选）
 * @param prompt 视频生成提示词
 * @param model 模型名
 * @param duration_seconds 视频时长（秒，0-60）
 * @param aspect_ratio 宽高比，如 "16:9"
 * @param idempotency_key 客户端幂等键（可选）；Some 时作为 generation_id 使用，
 *        重复请求返回已有记录而不重复扣费
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
    idempotency_key: Option<&str>,
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

    // 预生成 generation_id：若客户端提供 idempotency_key 则用作 id（支持幂等重试），
    // 否则生成新 UUID。后续扣费 + 建记录均使用此 id 作为 ref_id。
    let generation_id = match idempotency_key {
        Some(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => Uuid::new_v4().to_string(),
    };

    // 幂等快速路径：若使用 idempotency_key 且 generation 已存在，直接返回。
    // 覆盖场景：客户端重试、网络抖动后重复提交。
    if idempotency_key.is_some() {
        if let Ok(Some(existing)) = try_get_own_generation(&state.db, &generation_id, user_id).await
        {
            tracing::info!(
                generation_id = %generation_id,
                "视频生成幂等命中：返回已有记录，不重复扣费"
            );
            return Ok(existing);
        }
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

    // 幂等扣费：ref_id = generation_id，依赖 UNIQUE 索引防止重复扣费。
    crate::billing::repo::check_and_deduct_idempotent(
        &state.db,
        user_id,
        cost,
        "video_generation",
        "video_generation",
        &generation_id,
    )
    .await
    .map_err(|error| AppError::PaymentRequired(error.to_string()))?;

    // 使用预生成 id 创建 generation 记录。
    // 若并发请求用同一 id 先建了记录（PRIMARY KEY 冲突），退款本次扣费并返回已有记录。
    let generation = match repo::create_generation_with_id(
        &state.db,
        &generation_id,
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
            if is_primary_key_violation(&error) {
                // 并发幂等请求已建记录：退款本次扣费，返回已有记录
                if let Ok(Some(existing)) =
                    try_get_own_generation(&state.db, &generation_id, user_id).await
                {
                    let _ = crate::billing::repo::refund_outstanding_for_ref(
                        &state.db,
                        user_id,
                        "video_generation",
                        &generation_id,
                        "video_generation_idempotent_duplicate",
                    )
                    .await;
                    return Ok(existing);
                }
            }
            // 其他 DB 错误：退款本次扣费并返回错误（扣费可恢复）
            if let Err(refund_error) = crate::billing::repo::refund_outstanding_for_ref(
                &state.db,
                user_id,
                "video_generation",
                &generation_id,
                "video_generation_record_create_failed",
            )
            .await
            {
                tracing::error!(error = %refund_error, "failed to refund after video generation record creation failed");
            }
            return Err(AppError::Internal(error.to_string()));
        }
    };

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
        env::var("VIDEO_API_URL")
            .unwrap_or_else(|_| format!("{}/v1/video/generations", base_url.trim_end_matches('/')))
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
 * 尝试获取属于指定用户的 generation 记录。
 *
 * 用于幂等检查：仅当记录存在且 user_id 匹配时返回 Some，避免泄露他人记录。
 *
 * @param db 数据库连接池
 * @param generation_id 待查询的 generation ID
 * @param user_id 当前用户 ID
 * @returns Ok(Some(generation)) 表示存在且属于该用户；Ok(None) 表示不存在或不属于
 */
async fn try_get_own_generation(
    db: &SqlitePool,
    generation_id: &str,
    user_id: &str,
) -> Result<Option<VideoGeneration>, AppError> {
    match repo::get_generation(db, generation_id).await {
        Ok(generation) if generation.user_id == user_id => Ok(Some(generation)),
        Ok(_) => Ok(None),
        Err(_) => Ok(None),
    }
}

/**
 * 判断 anyhow 错误链中是否包含 PRIMARY KEY / UNIQUE 约束冲突。
 *
 * `repo::create_generation_with_id` 返回 `anyhow::Result`，所以错误会被
 * 包装为 `anyhow::Error`。需要 downcast 到 `sqlx::Error` 才能拿到数据库
 * 错误码与消息。
 *
 * SQLite PRIMARY KEY 冲突的错误码与 UNIQUE 相同（2067 / 19）。
 * 为防止 SQLx 未正确填充 code，再额外匹配 message 中的
 * "UNIQUE constraint failed: video_generations.id"。
 *
 * @param error 待判断的 anyhow 错误（来自 create_generation_with_id）
 * @returns true 表示底层是 PRIMARY KEY 冲突
 */
fn is_primary_key_violation(error: &anyhow::Error) -> bool {
    let Some(sqlx_err) = error.downcast_ref::<sqlx::Error>() else {
        return false;
    };
    match sqlx_err {
        sqlx::Error::Database(db_err) => {
            // db_err.code() 返回 Option<Cow<'_, str>>，必须 inline 调用 .as_deref()
            // 避免临时 Cow 在语句末尾被 drop 后留下悬空引用。
            matches!(db_err.code().as_deref(), Some("2067") | Some("19"))
                || db_err
                    .message()
                    .contains("UNIQUE constraint failed: video_generations.id")
        }
        _ => false,
    }
}

/**
 * POST /api/video-gen/generations
 *
 * HTTP handler，薄壳：解析 body + X-Idempotency-Key 头 → 调用 enqueue_video_generation → 返回响应。
 * 客户端可通过 X-Idempotency-Key 头实现幂等重试：重复请求返回同一 generation，不重复扣费。
 */
pub async fn create_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    headers: HeaderMap,
    Json(req): Json<CreateVideoGenerationReq>,
) -> Result<Json<VideoGenerationResponse>, AppError> {
    let idempotency_key = headers
        .get(IDEMPOTENCY_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let generation = enqueue_video_generation(
        &state,
        &user_id.0,
        req.project_id.as_deref(),
        &req.prompt,
        &req.model,
        req.duration_seconds,
        &req.aspect_ratio,
        idempotency_key.as_deref(),
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

            // 产物资产化（best-effort）：落盘 + 注册 assets + 回写 result_asset_id。
            // 失败只记 warn —— 生成结果本身已成功，不应因此判任务失败或退款；
            // 剪辑合成端点对远程 URL 仍有兜底下载路径。
            if let Some(asset) = persist_video_result_asset(
                &state,
                &generation_id,
                req.project_id.as_deref(),
                &req.prompt,
                &model,
                req.duration_seconds,
                &req.aspect_ratio,
                response.url.as_deref(),
                response.b64_json.as_deref(),
            )
            .await
            {
                if let Err(error) =
                    repo::set_result_asset(&state.db, &generation_id, &asset.id).await
                {
                    tracing::warn!(
                        generation_id = %generation_id,
                        asset_id = %asset.id,
                        "failed to record result_asset_id: {error}"
                    );
                }
            }
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

/**
 * 退款并将 generation 标记为失败。
 *
 * 幂等设计：使用 `refund_outstanding_for_ref` 按 (ref_type="video_generation", ref_id=generation_id)
 * 幂等退款：
 *   - 应用层：事务内 SELECT 已存在 refund → 跳过；
 *   - DB 层：028 migration 的 `idx_credit_txn_refund_ref_unique` UNIQUE 索引兜底，
 *     防止并发请求同时通过应用层检查后双重 INSERT。
 *
 * 这样在以下场景下退款只执行一次：
 *   1. 任务失败（run_generation_task 返回 Err）
 *   2. 任务超时（tokio::time::timeout 命中）
 *   3. 重复回调（外部 API 重复触发回调，导致 set_failed 被多次调用）
 *   4. main.rs 中的 reconcile_interrupted_video_generations 启动时补偿退款
 *
 * @param state 应用全局状态
 * @param user_id 用户 ID
 * @param generation_id 视频生成任务 ID（即 billing 中的 ref_id）
 * @param cost 原扣费金额（仅用于日志，实际金额从 spent 记录中读取）
 * @param error_msg 失败原因（写入 video_generations.error_message）
 */
async fn refund_and_fail(
    state: &AppState,
    user_id: &str,
    generation_id: &str,
    cost: f64,
    error_msg: &str,
) -> Result<(), AppError> {
    if let Err(refund_error) = crate::billing::repo::refund_outstanding_for_ref(
        &state.db,
        user_id,
        "video_generation",
        generation_id,
        "video_generation_failed",
    )
    .await
    {
        tracing::error!(
            generation_id = %generation_id,
            cost = cost,
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

/// 视频产物下载的大小上限：512 MB，防御异常 provider 返回超大响应。
const VIDEO_DOWNLOAD_MAX_BYTES: usize = 512 * 1024 * 1024;
/// 视频产物下载超时：10 分钟。
const VIDEO_DOWNLOAD_TIMEOUT_SECS: u64 = 600;

/**
 * 把已完成的视频产物落盘为本地资产（best-effort）。
 *
 * 来源二选一：
 *   - result_b64_json：base64 解码后直接写文件；
 *   - result_url：provider 返回的远程 URL，经 SSRF 校验后带大小上限下载。
 *
 * 成功后注册 assets(type='video', url='/uploads/{filename}')，调用方再把
 * asset.id 写回 video_generations.result_asset_id（migration 036）。
 *
 * 失败语义：返回 None 并记 warn，不向上传播错误 —— 生成结果本身已成功，
 * 资产化失败不应使任务判失败或退款；剪辑合成端点对远程 URL 仍有兜底下载。
 * project_id 为 None 时同样跳过（assets.project_id NOT NULL，无处归属）。
 */
#[allow(clippy::too_many_arguments)]
async fn persist_video_result_asset(
    state: &AppState,
    generation_id: &str,
    project_id: Option<&str>,
    prompt: &str,
    model: &str,
    duration_seconds: Option<f64>,
    aspect_ratio: &str,
    result_url: Option<&str>,
    result_b64_json: Option<&str>,
) -> Option<crate::asset::model::Asset> {
    let Some(project_id) = normalize_project_id(project_id) else {
        tracing::info!(
            generation_id = %generation_id,
            "video generation has no project context, skip asset persistence"
        );
        return None;
    };

    let bytes: Vec<u8> = if let Some(b64) = result_b64_json.map(str::trim).filter(|v| !v.is_empty())
    {
        match decode_video_b64(b64) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(generation_id = %generation_id, "failed to decode video b64: {error}");
                return None;
            }
        }
    } else if let Some(url) = result_url.map(str::trim).filter(|v| !v.is_empty()) {
        match download_video_asset(url).await {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(
                    generation_id = %generation_id,
                    url = %url,
                    "failed to download generated video: {error}"
                );
                return None;
            }
        }
    } else {
        return None;
    };

    if bytes.is_empty() {
        tracing::warn!(generation_id = %generation_id, "video result is empty, skip asset persistence");
        return None;
    }

    // 落盘目录与 image_gen 的 resolve_assets_root 保持一致（assets_dir）。
    if let Err(error) = tokio::fs::create_dir_all(&state.config.assets_dir).await {
        tracing::warn!(generation_id = %generation_id, "failed to create assets dir: {error}");
        return None;
    }
    let assets_root = match tokio::fs::canonicalize(&state.config.assets_dir).await {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(generation_id = %generation_id, "failed to resolve assets dir: {error}");
            return None;
        }
    };

    let filename = format!("video-generation-{generation_id}.mp4");
    let file_path = assets_root.join(&filename);
    if !file_path.starts_with(&assets_root) {
        tracing::warn!(generation_id = %generation_id, "invalid generated video path");
        return None;
    }
    if let Err(error) = tokio::fs::write(&file_path, &bytes).await {
        tracing::warn!(generation_id = %generation_id, "failed to write generated video: {error}");
        return None;
    }

    let metadata = serde_json::json!({
        "origin": "video_generation",
        "source": "video_generation",
        "generationId": generation_id,
        "prompt": prompt,
        "model": model,
        "durationSeconds": duration_seconds,
        "aspectRatio": aspect_ratio,
        "sourceUrl": result_url,
        "sizeBytes": bytes.len(),
        "generatedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });

    match crate::asset::repo::create_asset(
        &state.db,
        &project_id,
        &format!("AI 视频 {}", chrono::Utc::now().format("%Y-%m-%d %H-%M-%S")),
        "video",
        &format!("/uploads/{filename}"),
        Some(&metadata.to_string()),
    )
    .await
    {
        Ok(asset) => Some(asset),
        Err(error) => {
            tracing::warn!(generation_id = %generation_id, "failed to register video asset: {error}");
            None
        }
    }
}

/** 解码 provider 返回的 base64 视频数据（容忍 data URL 前缀与空白字符）。 */
fn decode_video_b64(value: &str) -> Result<Vec<u8>, AppError> {
    let raw = value
        .strip_prefix("data:")
        .and_then(|v| v.split_once(','))
        .map(|v| v.1)
        .unwrap_or(value);
    let cleaned: String = raw.chars().filter(|ch| !ch.is_whitespace()).collect();
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|error| AppError::Internal(format!("failed to decode generated video: {error}")))
}

/**
 * 下载 provider 返回的远程视频到内存。
 *
 * 安全设计：下载前用 ssrf_guard 校验 URL（provider 响应里的地址不可信，
 * 可能指向内网/云元数据）；带大小上限与超时，避免异常响应拖垮内存。
 */
async fn download_video_asset(url: &str) -> Result<Vec<u8>, AppError> {
    ssrf_guard::validate_endpoint_url(url).await?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(VIDEO_DOWNLOAD_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| AppError::Internal(format!("failed to create HTTP client: {error}")))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::Internal(format!("video download failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "video download returned {}",
            response.status()
        )));
    }

    if let Some(length) = response.content_length() {
        if length as usize > VIDEO_DOWNLOAD_MAX_BYTES {
            return Err(AppError::Internal(format!(
                "video exceeds download size limit ({length} bytes)"
            )));
        }
    }

    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|error| AppError::Internal(format!("video download interrupted: {error}")))?
    {
        if bytes.len() + chunk.len() > VIDEO_DOWNLOAD_MAX_BYTES {
            return Err(AppError::Internal(
                "video exceeds download size limit".to_string(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use uuid::Uuid;

    /// 构造测试用 SQLite 连接池（带完整 schema，通过 init_db 自动迁移）
    async fn create_test_pool() -> SqlitePool {
        let db_path =
            std::env::temp_dir().join(format!("woohoo-video-gen-perm-{}.sqlite", Uuid::new_v4()));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
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
