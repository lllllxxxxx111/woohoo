use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::{SecondsFormat, Utc};
use sqlx::SqlitePool;
use std::env;
use std::path::PathBuf;
use std::time::Duration;
use tokio::fs;
use uuid::Uuid;

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::model::*;
use super::repo;

const IMAGE_GEN_TIMEOUT_SECS: u64 = 3600;

/// 标识 `X-Idempotency-Key` HTTP 头，用于客户端幂等重试。
const IDEMPOTENCY_KEY_HEADER: &str = "x-idempotency-key";

/**
 * 图片生成任务入队公共入口
 *
 * 提取自 create_generation handler，供 orchestrator 在 dispatch_image_gen_step 中复用。
 * 完整流程：项目权限校验 → 端点解析 → 预生成 generation_id → 幂等扣费 →
 *         建 DB 记录（使用预生成 id） → set_processing → spawn 后台任务。
 *
 * Billing 幂等设计：
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
 * @param prompt 图片生成提示词
 * @param size 图片尺寸，如 "1024x1024"
 * @param n 生成数量（1-10）
 * @param endpoint_id 指定端点 ID（可选，None 时自动解析）
 * @param model 指定模型名（可选，None 时使用默认 dall-e-3）
 * @param idempotency_key 客户端幂等键（可选）；Some 时作为 generation_id 使用，
 *        重复请求返回已有记录而不重复扣费
 * @returns 创建好的 ImageGeneration 记录（status=processing）
 */
pub(crate) async fn enqueue_image_generation(
    state: &AppState,
    user_id: &str,
    project_id: Option<&str>,
    prompt: &str,
    size: &str,
    n: i64,
    endpoint_id: Option<&str>,
    model: Option<&str>,
    idempotency_key: Option<&str>,
) -> Result<ImageGeneration, AppError> {
    if prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt cannot be empty".to_string()));
    }
    if n < 1 || n > 10 {
        return Err(AppError::BadRequest(
            "n must be between 1 and 10".to_string(),
        ));
    }

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
                "图片生成幂等命中：返回已有记录，不重复扣费"
            );
            return Ok(existing);
        }
    }

    let requested_model = model.unwrap_or("dall-e-3").to_string();
    let resolved = crate::ai::capabilities::resolve_image_generation_capability(
        state,
        user_id,
        endpoint_id,
        Some(&requested_model),
    )
    .await
    .map_err(|error| {
        tracing::warn!(error = %error, "image generation endpoint resolution failed");
        let api_key = env::var("AI_API_KEY").unwrap_or_default();
        if api_key.is_empty() {
            AppError::Validation(
                "Please enable an image generation API channel in settings or configure AI_API_KEY."
                    .into(),
            )
        } else {
            AppError::Internal(format!(
                "image generation endpoint resolution failed: {}",
                error
            ))
        }
    })?;

    let resolved_model = resolved.model.clone();
    let cost = calculate_cost(&resolved_model, size, n);

    crate::billing::budget_enforce::enforce_budget(
        &state.db,
        user_id,
        cost,
        "image_generation",
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
        "image_generation",
        "image_generation",
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
        size,
        n,
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
                        "image_generation",
                        &generation_id,
                        "image_generation_idempotent_duplicate",
                    )
                    .await;
                    return Ok(existing);
                }
            }
            // 其他 DB 错误：退款本次扣费并返回错误（扣费可恢复）
            if let Err(refund_error) = crate::billing::repo::refund_outstanding_for_ref(
                &state.db,
                user_id,
                "image_generation",
                &generation_id,
                "image_generation_record_create_failed",
            )
            .await
            {
                tracing::error!(error = %refund_error, "failed to refund after image generation record creation failed");
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
    let task_state = state.clone();
    let task_user_id = user_id.to_string();
    let task_generation_id = generation.id.clone();
    let task_project_id = normalized_project_id.clone();
    let task_prompt = prompt.to_string();
    let task_size = size.to_string();
    let task_n = n;

    tokio::spawn(async move {
        if let Err(error) = run_generation_task(
            task_state,
            task_user_id,
            task_generation_id.clone(),
            task_project_id,
            base_url,
            api_key,
            task_model,
            task_prompt,
            task_size,
            task_n,
            cost,
        )
        .await
        {
            tracing::error!(
                generation_id = %task_generation_id,
                error = %error,
                "background image generation task failed"
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
) -> Result<Option<ImageGeneration>, AppError> {
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
 * "UNIQUE constraint failed: image_generations.id"。
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
                    .contains("UNIQUE constraint failed: image_generations.id")
        }
        _ => false,
    }
}

/**
 * POST /api/image-gen/generations
 *
 * HTTP handler，薄壳：解析 body + X-Idempotency-Key 头 → 调用 enqueue_image_generation → 返回响应。
 * 客户端可通过 X-Idempotency-Key 头实现幂等重试：重复请求返回同一 generation，不重复扣费。
 */
pub async fn create_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    headers: HeaderMap,
    Json(req): Json<CreateImageGenerationReq>,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    let idempotency_key = headers
        .get(IDEMPOTENCY_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let generation = enqueue_image_generation(
        &state,
        &user_id.0,
        req.project_id.as_deref(),
        &req.prompt,
        &req.size,
        req.n,
        req.endpoint_id.as_deref(),
        Some(&req.model),
        idempotency_key.as_deref(),
    )
    .await?;

    build_generation_response(&state.db, &generation.id, &user_id.0).await
}

async fn run_generation_task(
    state: AppState,
    user_id: String,
    generation_id: String,
    project_id: Option<String>,
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    size: String,
    n: i64,
    cost: f64,
) -> Result<(), AppError> {
    let generate_result = tokio::time::timeout(
        Duration::from_secs(IMAGE_GEN_TIMEOUT_SECS),
        state.ai_client.generate_image(
            &base_url, &api_key, &model, &prompt, &size, n as u32, "b64_json",
        ),
    )
    .await;

    match generate_result {
        Ok(Ok(response)) => {
            let mut urls = Vec::new();
            let mut b64_data = Vec::new();
            let revised_prompt = response
                .data
                .first()
                .and_then(|item| item.revised_prompt.clone());

            for item in &response.data {
                if let Some(url) = &item.url {
                    urls.push(url.clone());
                }
                if let Some(b64) = &item.b64_json {
                    b64_data.push(b64.clone());
                }
            }

            let asset_ids = match persist_generated_assets(
                &state,
                project_id.as_deref(),
                &generation_id,
                &prompt,
                &model,
                &size,
                &response.data,
            )
            .await
            {
                Ok(asset_ids) => asset_ids,
                Err(error) => {
                    refund_and_fail(&state, &user_id, &generation_id, cost, &error.to_string())
                        .await?;
                    return Ok(());
                }
            };

            if let Err(error) = repo::set_completed(
                &state.db,
                &generation_id,
                &urls,
                b64_data.first().map(|value| value.as_str()),
                &asset_ids,
                revised_prompt.as_deref(),
                cost,
            )
            .await
            {
                refund_and_fail(&state, &user_id, &generation_id, cost, &error.to_string()).await?;
                return Err(AppError::Internal(error.to_string()));
            }
        }
        Ok(Err(error)) => {
            refund_and_fail(&state, &user_id, &generation_id, cost, &error.to_string()).await?;
        }
        Err(_) => {
            let timeout_msg = format!(
                "image generation timed out after {}s",
                IMAGE_GEN_TIMEOUT_SECS
            );
            refund_and_fail(&state, &user_id, &generation_id, cost, &timeout_msg).await?;
        }
    }

    Ok(())
}

async fn ensure_project_access(
    db: &SqlitePool,
    user_id: &str,
    project_id: &str,
) -> Result<(), AppError> {
    let project = crate::project::repo::find_by_id(db, project_id).await?;
    let project = project.ok_or_else(|| AppError::NotFound("project not found".to_string()))?;
    if project.user_id != user_id {
        return Err(AppError::Forbidden(
            "not allowed to use this project for image generation".to_string(),
        ));
    }
    Ok(())
}

async fn persist_generated_assets(
    state: &AppState,
    project_id: Option<&str>,
    generation_id: &str,
    prompt: &str,
    model: &str,
    size: &str,
    items: &[crate::ai::client::ImageDataItem],
) -> Result<Vec<String>, AppError> {
    let Some(project_id) = project_id else {
        return Ok(Vec::new());
    };

    let mut asset_ids = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let asset = if let Some(b64_json) = item.b64_json.as_deref() {
            persist_b64_image_asset(
                state,
                project_id,
                generation_id,
                index,
                prompt,
                model,
                size,
                b64_json,
                item.revised_prompt.as_deref(),
            )
            .await?
        } else if let Some(url) = item.url.as_deref() {
            persist_remote_image_asset(
                state,
                project_id,
                generation_id,
                index,
                prompt,
                model,
                size,
                url,
                item.revised_prompt.as_deref(),
            )
            .await?
        } else {
            continue;
        };
        asset_ids.push(asset.id);
    }

    Ok(asset_ids)
}

async fn persist_b64_image_asset(
    state: &AppState,
    project_id: &str,
    generation_id: &str,
    index: usize,
    prompt: &str,
    model: &str,
    size: &str,
    b64_json: &str,
    revised_prompt: Option<&str>,
) -> Result<crate::asset::model::Asset, AppError> {
    let extension = image_extension_from_b64(b64_json);
    let bytes = decode_image_b64(b64_json)?;
    let assets_root = resolve_assets_root(state).await?;
    let filename = format!(
        "image-generation-{}-{}.{}",
        generation_id,
        index + 1,
        extension
    );
    let file_path = assets_root.join(&filename);
    if !file_path.starts_with(&assets_root) {
        return Err(AppError::Forbidden(
            "invalid generated image path".to_string(),
        ));
    }

    fs::write(&file_path, &bytes)
        .await
        .map_err(|error| AppError::Internal(format!("failed to write generated image: {error}")))?;

    let asset_url = format!("/uploads/{filename}");
    let metadata = generated_asset_metadata(
        generation_id,
        index,
        prompt,
        model,
        size,
        revised_prompt,
        Some(bytes.len()),
        None,
    );

    crate::asset::repo::create_asset(
        &state.db,
        project_id,
        &generated_asset_name(index),
        "image",
        &asset_url,
        Some(&metadata),
    )
    .await
}

async fn persist_remote_image_asset(
    state: &AppState,
    project_id: &str,
    generation_id: &str,
    index: usize,
    prompt: &str,
    model: &str,
    size: &str,
    url: &str,
    revised_prompt: Option<&str>,
) -> Result<crate::asset::model::Asset, AppError> {
    let metadata = generated_asset_metadata(
        generation_id,
        index,
        prompt,
        model,
        size,
        revised_prompt,
        None,
        Some(url),
    );

    crate::asset::repo::create_asset(
        &state.db,
        project_id,
        &generated_asset_name(index),
        "image",
        url,
        Some(&metadata),
    )
    .await
}

async fn resolve_assets_root(state: &AppState) -> Result<PathBuf, AppError> {
    fs::create_dir_all(&state.config.assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("failed to create assets dir: {error}")))?;
    fs::canonicalize(&state.config.assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("failed to resolve assets dir: {error}")))
}

fn normalize_project_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn decode_image_b64(value: &str) -> Result<Vec<u8>, AppError> {
    let raw = strip_data_url_prefix(value);
    let cleaned: String = raw.chars().filter(|ch| !ch.is_whitespace()).collect();
    general_purpose::STANDARD
        .decode(cleaned)
        .map_err(|error| AppError::Internal(format!("failed to decode generated image: {error}")))
}

fn strip_data_url_prefix(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.starts_with("data:") {
        return trimmed
            .split_once(',')
            .map(|(_, data)| data)
            .unwrap_or(trimmed);
    }
    trimmed
}

fn image_extension_from_b64(value: &str) -> &'static str {
    let lower_prefix = value
        .get(..value.len().min(32))
        .unwrap_or(value)
        .to_ascii_lowercase();
    if lower_prefix.starts_with("data:image/jpeg") || lower_prefix.starts_with("data:image/jpg") {
        "jpg"
    } else if lower_prefix.starts_with("data:image/webp") {
        "webp"
    } else {
        "png"
    }
}

fn generated_asset_name(index: usize) -> String {
    format!(
        "AI Image {} {}",
        Utc::now().format("%Y-%m-%d %H-%M-%S"),
        index + 1
    )
}

fn generated_asset_metadata(
    generation_id: &str,
    index: usize,
    prompt: &str,
    model: &str,
    size: &str,
    revised_prompt: Option<&str>,
    size_bytes: Option<usize>,
    source_url: Option<&str>,
) -> String {
    let mut metadata = serde_json::json!({
        "origin": "image_generation",
        "source": "image_generation",
        "generationId": generation_id,
        "generationIndex": index,
        "prompt": prompt,
        "model": model,
        "size": size,
        "generatedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
    });

    if let Some(map) = metadata.as_object_mut() {
        if let Some(revised_prompt) = revised_prompt {
            map.insert(
                "revisedPrompt".to_string(),
                serde_json::json!(revised_prompt),
            );
        }
        if let Some(size_bytes) = size_bytes {
            map.insert("sizeBytes".to_string(), serde_json::json!(size_bytes));
        }
        if let Some(source_url) = source_url {
            map.insert("sourceUrl".to_string(), serde_json::json!(source_url));
        }
    }

    metadata.to_string()
}

async fn refund_and_fail(
    state: &AppState,
    user_id: &str,
    generation_id: &str,
    cost: f64,
    error_msg: &str,
) -> Result<(), AppError> {
    // 幂等退款：按 (ref_type=image_generation, ref_id=generation_id) 退款，
    // 重复调用（如重复失败回调）不会重复退款。refund_outstanding_for_ref
    // 内部检查是否已有 refund 记录 + 028 migration 的 UNIQUE 索引双保险。
    if let Err(refund_error) = crate::billing::repo::refund_outstanding_for_ref(
        &state.db,
        user_id,
        "image_generation",
        generation_id,
        "image_generation_failed",
    )
    .await
    {
        tracing::error!(
            generation_id = %generation_id,
            cost = cost,
            error = %refund_error,
            "failed to refund image generation charge"
        );
    }

    repo::set_failed(&state.db, generation_id, error_msg)
        .await
        .map_err(|repo_error| AppError::Internal(repo_error.to_string()))?;

    Ok(())
}

pub async fn get_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(generation_id): Path<String>,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    build_generation_response(&state.db, &generation_id, &user_id.0).await
}

pub async fn list_generations(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<Vec<ImageGenerationResponse>>, AppError> {
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

async fn build_generation_response(
    db: &SqlitePool,
    generation_id: &str,
    user_id: &str,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    let generation = repo::get_generation(db, generation_id)
        .await
        .map_err(|error| AppError::NotFound(format!("image generation not found: {}", error)))?;

    if generation.user_id != user_id {
        return Err(AppError::Forbidden(
            "not allowed to access this image generation".to_string(),
        ));
    }

    Ok(Json(generation_to_response(generation)))
}

fn generation_to_response(
    row: crate::image_gen::model::ImageGeneration,
) -> ImageGenerationResponse {
    let urls: Vec<String> = row
        .result_urls
        .as_ref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_default();

    let b64_data: Vec<String> = row
        .result_b64_json
        .as_ref()
        .filter(|value| !value.is_empty())
        .map(|value| vec![value.clone()])
        .unwrap_or_default();

    ImageGenerationResponse {
        id: row.id,
        project_id: row.project_id,
        prompt: row.prompt,
        model: row.model,
        size: row.size,
        n: row.n,
        status: row.status,
        error_message: row.error_message,
        urls,
        b64_data,
        asset_ids: parse_json_string_list(row.asset_ids.as_deref()),
        revised_prompt: row.revised_prompt,
        cost_credits: row.cost_credits,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }
}

fn parse_json_string_list(value: Option<&str>) -> Vec<String> {
    value
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .unwrap_or_default()
}

fn calculate_cost(model: &str, size: &str, n: i64) -> f64 {
    let base_cost = match model {
        "dall-e-3" => 5.0,
        _ => 3.0,
    };

    let size_multiplier = match size {
        "1024x1792" | "1792x1024" => 1.5,
        _ => 1.0,
    };

    base_cost * size_multiplier * (n as f64).max(1.0)
}
