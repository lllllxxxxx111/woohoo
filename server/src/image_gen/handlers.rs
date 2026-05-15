use axum::{
    extract::{Path, State},
    Json,
};
use sqlx::SqlitePool;
use std::env;

use crate::ai::client::AiClient;
use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::model::*;
use super::repo;

/**
 * 创建图片生成任务
 * 调用 OpenAI 兼容的图片生成 API（如 DALL-E 3）
 * 支持计费扣减和失败回退
 */
pub async fn create_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<CreateImageGenerationReq>,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    if req.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt 不能为空".to_string()));
    }
    if !(1..=4).contains(&req.n) {
        return Err(AppError::BadRequest(
            "生成数量必须在 1 到 4 之间".to_string(),
        ));
    }
    if !matches!(req.size.as_str(), "1024x1024" | "1024x1792" | "1792x1024") {
        return Err(AppError::BadRequest("暂不支持该图片尺寸".to_string()));
    }

    let cost = calculate_cost(&req.model, &req.size, req.n);

    let generation = repo::create_generation(
        &state.db,
        &user_id.0,
        &req.prompt,
        &req.model,
        &req.size,
        req.n,
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    if let Err(e) = crate::billing::repo::check_and_deduct(
        &state.db,
        &user_id.0,
        cost,
        "image_generation",
        Some("image_generation"),
        Some(&generation.id),
    )
    .await
    {
        let _ = repo::set_failed(&state.db, &generation.id, &e.to_string()).await;
        return Err(AppError::PaymentRequired(e.to_string()));
    }

    repo::set_processing(&state.db, &generation.id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let base_url = env::var("AI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com".to_string());
    let api_key = env::var("AI_API_KEY").unwrap_or_default();
    let client = AiClient::new();

    match client
        .generate_image(
            &base_url,
            &api_key,
            &req.model,
            &req.prompt,
            &req.size,
            req.n as u32,
            "b64_json",
        )
        .await
    {
        Ok(resp) => {
            let mut urls = Vec::new();
            let mut b64_data = Vec::new();
            let revised_prompt = resp.data.first().and_then(|d| d.revised_prompt.clone());

            for item in &resp.data {
                if let Some(ref url) = item.url {
                    urls.push(url.clone());
                }
                if let Some(ref b64) = item.b64_json {
                    b64_data.push(b64.clone());
                }
            }

            repo::set_completed(
                &state.db,
                &generation.id,
                &urls,
                &b64_data,
                revised_prompt.as_deref(),
                cost,
            )
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        }
        Err(err) => {
            crate::billing::repo::refund(
                &state.db,
                &user_id.0,
                cost,
                "image_generation_failed",
                Some(&generation.id),
            )
            .await
            .ok();

            repo::set_failed(&state.db, &generation.id, &err.to_string())
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;

            return Err(AppError::Internal(format!("图片生成失败: {}", err)));
        }
    }

    build_generation_response(&state.db, &generation.id, &user_id.0).await
}

/**
 * 查询图片生成记录详情
 */
pub async fn get_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(generation_id): Path<String>,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    build_generation_response(&state.db, &generation_id, &user_id.0).await
}

/**
 * 查询用户的图片生成历史
 */
pub async fn list_generations(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<Vec<ImageGenerationResponse>>, AppError> {
    let gens = repo::list_user_generations(&state.db, &user_id.0, 50, 0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let results: Vec<ImageGenerationResponse> = gens.into_iter().map(gen_to_response).collect();

    Ok(Json(results))
}

/**
 * 从数据库记录构建响应对象
 */
async fn build_generation_response(
    db: &SqlitePool,
    generation_id: &str,
    user_id: &str,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    let gen = repo::get_generation_for_user(db, generation_id, user_id)
        .await
        .map_err(|e| AppError::NotFound(format!("图片生成记录不存在: {}", e)))?;

    Ok(Json(gen_to_response(gen)))
}

/**
 * 将数据库行转换为响应对象（用于列表查询）
 */
fn gen_to_response(row: crate::image_gen::model::ImageGeneration) -> ImageGenerationResponse {
    let result_urls: Vec<String> = row
        .result_urls
        .as_ref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let result_b64: Vec<String> = row
        .result_b64_json
        .as_ref()
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    ImageGenerationResponse {
        id: row.id,
        prompt: row.prompt,
        model: row.model,
        size: row.size,
        n: row.n,
        status: row.status,
        error_message: row.error_message,
        urls: result_urls,
        b64_data: result_b64,
        revised_prompt: row.revised_prompt,
        cost_credits: row.cost_credits,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }
}

/**
 * 根据模型、尺寸和数量计算消耗的积分
 */
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
