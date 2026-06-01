use axum::{
    extract::{Path, State},
    Json,
};
use sqlx::SqlitePool;
use std::env;
use std::time::Duration;

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::model::*;
use super::repo;

/// 图片生成 API 调用超时时间（秒）
const IMAGE_GEN_TIMEOUT_SECS: u64 = 120;

/// 创建图片生成任务
///
/// 执行顺序：校验 → 扣费 → 创建记录 → 调用 API → 更新状态
/// 先扣费再创建记录，避免崩溃后产生未扣费的 pending 记录导致误退款
pub async fn create_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<CreateImageGenerationReq>,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    if req.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt cannot be empty".to_string()));
    }

    if req.n < 1 || req.n > 10 {
        return Err(AppError::BadRequest(
            "n must be between 1 and 10".to_string(),
        ));
    }

    let cost = calculate_cost(&req.model, &req.size, req.n);

    // 先扣费，避免创建记录后崩溃导致非原子问题
    crate::billing::repo::check_and_deduct(
        &state.db,
        &user_id.0,
        cost,
        "image_generation",
        Some("image_generation"),
        None,
    )
    .await
    .map_err(|error| AppError::PaymentRequired(error.to_string()))?;

    // 扣费成功后创建 generation 记录
    let generation = repo::create_generation(
        &state.db,
        &user_id.0,
        &req.prompt,
        &req.model,
        &req.size,
        req.n,
        cost,
    )
    .await
    .map_err(|error| {
        // 创建记录失败，立即退款
        let user_id_clone = user_id.0.clone();
        let db_clone = state.db.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::billing::repo::refund(
                &db_clone,
                &user_id_clone,
                cost,
                "image_generation_record_create_failed",
                None,
            )
            .await
            {
                tracing::error!(error = %e, "创建记录失败后退款也失败");
            }
        });
        AppError::Internal(error.to_string())
    })?;

    // 更新扣费记录的 ref_id 为 generation id
    if let Err(e) = crate::billing::repo::update_spent_ref_id(
        &state.db,
        &user_id.0,
        "image_generation",
        &generation.id,
    )
    .await
    {
        tracing::warn!(generation_id = %generation.id, error = %e, "更新扣费记录 ref_id 失败，不影响主流程");
    }

    repo::set_processing(&state.db, &generation.id)
        .await
        .map_err(|error| {
            tracing::error!(generation_id = %generation.id, error = %error, "set_processing 失败，积分已扣");
            AppError::Internal(error.to_string())
        })?;

    // 从数据库端点配置解析图片生成能力，支持用户在前端设置页面配置
    let resolved = crate::ai::capabilities::resolve_image_generation_capability(
        &state,
        &user_id.0,
        None,
        Some(&req.model),
    )
    .await
    .map_err(|error| {
        tracing::warn!(error = %error, "图片生成端点解析失败，回退到环境变量");
        let _base_url = env::var("AI_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com".to_string());
        let api_key = env::var("AI_API_KEY").unwrap_or_default();
        if api_key.is_empty() {
            return AppError::Validation(
                "请先在设置里为 API 通道启用图片生成能力，或配置 AI_API_KEY 环境变量".into(),
            );
        }
        AppError::Internal(format!("图片生成端点解析失败: {}", error))
    })?;

    let base_url = resolved.endpoint.base_url.clone();
    let api_key = resolved.endpoint.api_key.clone();
    let model = resolved.model.clone();

    let client = &state.ai_client;

    // 带超时的 API 调用，防止长时间阻塞
    let generate_result = tokio::time::timeout(
        Duration::from_secs(IMAGE_GEN_TIMEOUT_SECS),
        client.generate_image(
            &base_url,
            &api_key,
            &model,
            &req.prompt,
            &req.size,
            req.n as u32,
            "b64_json",
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

            repo::set_completed(
                &state.db,
                &generation.id,
                &urls,
                b64_data.first().map(|value| value.as_str()),
                revised_prompt.as_deref(),
                cost,
            )
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        }
        Ok(Err(error)) => {
            refund_and_fail(&state, &user_id.0, &generation.id, cost, &error.to_string()).await?;
            return Err(AppError::Internal(format!(
                "image generation failed: {}",
                error
            )));
        }
        Err(_) => {
            let timeout_msg = format!(
                "image generation timed out after {}s",
                IMAGE_GEN_TIMEOUT_SECS
            );
            refund_and_fail(&state, &user_id.0, &generation.id, cost, &timeout_msg).await?;
            return Err(AppError::Internal(timeout_msg));
        }
    }

    build_generation_response(&state.db, &generation.id, &user_id.0).await
}

/// 退款并标记 generation 为失败
async fn refund_and_fail(
    state: &AppState,
    user_id: &str,
    generation_id: &str,
    cost: f64,
    error_msg: &str,
) -> Result<(), AppError> {
    if let Err(refund_err) = crate::billing::repo::refund(
        &state.db,
        user_id,
        cost,
        "image_generation_failed",
        Some(generation_id),
    )
    .await
    {
        tracing::error!(
            generation_id = %generation_id,
            error = %refund_err,
            "退款失败，用户积分可能丢失"
        );
    }

    repo::set_failed(&state.db, generation_id, error_msg)
        .await
        .map_err(|repo_error| AppError::Internal(repo_error.to_string()))?;

    Ok(())
}

/// 查询单个图片生成结果（含用户归属校验）
pub async fn get_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(generation_id): Path<String>,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    build_generation_response(&state.db, &generation_id, &user_id.0).await
}

/// 列出当前用户的图片生成记录
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

/// 构建图片生成响应，校验用户归属
async fn build_generation_response(
    db: &SqlitePool,
    generation_id: &str,
    user_id: &str,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    let generation = repo::get_generation(db, generation_id)
        .await
        .map_err(|error| AppError::NotFound(format!("image generation not found: {}", error)))?;

    if generation.user_id != user_id {
        return Err(AppError::Forbidden("无权访问此图片生成记录".to_string()));
    }

    Ok(Json(generation_to_response(generation)))
}

fn generation_to_response(row: crate::image_gen::model::ImageGeneration) -> ImageGenerationResponse {
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
        prompt: row.prompt,
        model: row.model,
        size: row.size,
        status: row.status,
        error_message: row.error_message,
        urls,
        b64_data,
        revised_prompt: row.revised_prompt,
        cost_credits: row.cost_credits,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }
}

/// 根据模型、尺寸、数量计算积分消耗
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
