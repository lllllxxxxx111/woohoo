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

/// 视频 API 调用超时时间（秒），视频生成通常比图片慢
const VIDEO_GEN_TIMEOUT_SECS: u64 = 300;

/// 创建视频生成任务
///
/// 执行顺序：校验 → 扣费 → 创建记录 → 调用 API → 更新状态
/// 先扣费再创建记录，避免崩溃后产生未扣费的 pending 记录
pub async fn create_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<CreateVideoGenerationReq>,
) -> Result<Json<VideoGenerationResponse>, AppError> {
    if req.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt cannot be empty".to_string()));
    }

    if let Some(dur) = req.duration_seconds {
        if dur <= 0.0 || dur > 60.0 {
            return Err(AppError::BadRequest(
                "duration_seconds must be between 0 and 60".to_string(),
            ));
        }
    }

    let cost = calculate_cost(&req.model, req.duration_seconds);

    // 先扣费
    crate::billing::repo::check_and_deduct(
        &state.db,
        &user_id.0,
        cost,
        "video_generation",
        Some("video_generation"),
        None,
    )
    .await
    .map_err(|error| AppError::PaymentRequired(error.to_string()))?;

    // 创建 generation 记录
    let generation = repo::create_generation(
        &state.db,
        &user_id.0,
        req.project_id.as_deref(),
        &req.prompt,
        &req.model,
        req.duration_seconds,
        &req.aspect_ratio,
        cost,
    )
    .await
    .map_err(|error| {
        let user_id_clone = user_id.0.clone();
        let db_clone = state.db.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::billing::repo::refund(
                &db_clone,
                &user_id_clone,
                cost,
                "video_generation_record_create_failed",
                None,
            )
            .await
            {
                tracing::error!(error = %e, "创建记录失败后退款也失败");
            }
        });
        AppError::Internal(error.to_string())
    })?;

    // 更新扣费记录的 ref_id
    if let Err(e) = crate::billing::repo::update_spent_ref_id(
        &state.db,
        &user_id.0,
        "video_generation",
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

    // 从数据库端点配置解析视频生成能力，支持用户在前端设置页面配置
    let resolved = crate::ai::capabilities::resolve_video_generation_capability(
        &state,
        &user_id.0,
        None,
        Some(&req.model),
    )
    .await
    .map_err(|error| {
        tracing::warn!(error = %error, "视频生成端点解析失败，回退到环境变量");
        let api_key = env::var("AI_API_KEY").unwrap_or_default();
        if api_key.is_empty() {
            return AppError::Validation(
                "请先在设置里为 API 通道启用视频生成能力，或配置 AI_API_KEY 环境变量".into(),
            );
        }
        AppError::Internal(format!("视频生成端点解析失败: {}", error))
    })?;

    let base_url = resolved.endpoint.base_url.clone();
    let api_key = resolved.endpoint.api_key.clone();
    let model = resolved.model.clone();

    // 优先使用能力配置中的 path_override，否则从 base_url 推导
    let video_api_url = resolved
        .capability
        .as_ref()
        .and_then(|c| c.path_override.as_deref())
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            if p.starts_with("http://") || p.starts_with("https://") {
                p.to_string()
            } else {
                format!("{}/{}", base_url.trim_end_matches('/'), p.trim_start_matches('/'))
            }
        })
        .unwrap_or_else(|| {
            env::var("VIDEO_API_URL")
                .unwrap_or_else(|_| format!("{}/v1/video/generations", base_url.trim_end_matches('/')))
        });

    // 带超时的 API 调用
    let generate_result = tokio::time::timeout(
        Duration::from_secs(VIDEO_GEN_TIMEOUT_SECS),
        call_video_api(&state, &video_api_url, &api_key, &model, &req),
    )
    .await;

    match generate_result {
        Ok(Ok(response)) => {
            repo::set_completed(
                &state.db,
                &generation.id,
                response.url.as_deref(),
                response.b64_json.as_deref(),
                cost,
            )
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        }
        Ok(Err(error)) => {
            refund_and_fail(&state, &user_id.0, &generation.id, cost, &error.to_string()).await?;
            return Err(AppError::Internal(format!(
                "video generation failed: {}",
                error
            )));
        }
        Err(_) => {
            let timeout_msg = format!(
                "video generation timed out after {}s",
                VIDEO_GEN_TIMEOUT_SECS
            );
            refund_and_fail(&state, &user_id.0, &generation.id, cost, &timeout_msg).await?;
            return Err(AppError::Internal(timeout_msg));
        }
    }

    build_generation_response(&state.db, &generation.id, &user_id.0).await
}

/// 查询单个视频生成结果（含用户归属校验）
pub async fn get_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(generation_id): Path<String>,
) -> Result<Json<VideoGenerationResponse>, AppError> {
    build_generation_response(&state.db, &generation_id, &user_id.0).await
}

/// 列出当前用户的视频生成记录
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

/// 视频生成 API 响应
struct VideoApiResponse {
    url: Option<String>,
    b64_json: Option<String>,
}

/// 调用视频生成 API
///
/// 当前为通用实现，后续接入具体视频 API（如 Wan2.1、Runway、Pika 等）时
/// 只需修改此函数内部的请求构造和响应解析逻辑
async fn call_video_api(
    _state: &AppState,
    api_url: &str,
    api_key: &str,
    model: &str,
    req: &CreateVideoGenerationReq,
) -> Result<VideoApiResponse, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(VIDEO_GEN_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Internal(format!("创建 HTTP 客户端失败: {}", e)))?;

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

    let resp = request
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("视频生成 API 调用失败: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "视频生成 API 返回错误 {}: {}",
            status, body
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("视频生成响应解析失败: {}", e)))?;

    let url = resp_body
        .get("data")
        .and_then(|d| d.get("url"))
        .or_else(|| resp_body.get("url"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let b64_json = resp_body
        .get("data")
        .and_then(|d| d.get("b64_json"))
        .or_else(|| resp_body.get("b64_json"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Ok(VideoApiResponse { url, b64_json })
}

/// 退款并标记为失败
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
        "video_generation_failed",
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

/// 构建视频生成响应，校验用户归属
async fn build_generation_response(
    db: &SqlitePool,
    generation_id: &str,
    user_id: &str,
) -> Result<Json<VideoGenerationResponse>, AppError> {
    let generation = repo::get_generation(db, generation_id)
        .await
        .map_err(|error| AppError::NotFound(format!("video generation not found: {}", error)))?;

    if generation.user_id != user_id {
        return Err(AppError::Forbidden("无权访问此视频生成记录".to_string()));
    }

    Ok(Json(generation_to_response(generation)))
}

/// 数据库模型转 API 响应
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

/// 根据模型和时长计算积分消耗
fn calculate_cost(model: &str, duration_seconds: Option<f64>) -> f64 {
    let base_cost = match model {
        "wan2.1-t2v-480p" => 10.0,
        "wan2.1-t2v-720p" => 20.0,
        "runway-gen3" => 30.0,
        "pika-1.0" => 25.0,
        _ => 15.0,
    };

    let duration_multiplier = duration_seconds
        .map(|d| (d / 5.0).max(1.0))
        .unwrap_or(1.0);

    base_cost * duration_multiplier
}
