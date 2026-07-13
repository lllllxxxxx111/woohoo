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

const VIDEO_GEN_TIMEOUT_SECS: u64 = 3600;

pub async fn create_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<CreateVideoGenerationReq>,
) -> Result<Json<VideoGenerationResponse>, AppError> {
    if req.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt cannot be empty".to_string()));
    }

    if let Some(duration) = req.duration_seconds {
        if duration <= 0.0 || duration > 60.0 {
            return Err(AppError::BadRequest(
                "duration_seconds must be between 0 and 60".to_string(),
            ));
        }
    }

    let resolved = crate::ai::capabilities::resolve_video_generation_capability(
        &state,
        &user_id.0,
        None,
        Some(&req.model),
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

    let cost = calculate_cost(&req.model, req.duration_seconds);

    // 预算检查
    crate::billing::budget_enforce::enforce_budget(
        &state.db,
        &user_id.0,
        cost,
        crate::billing::budget_enforce::TASK_TYPE_VIDEO,
        Some(&req.model),
        req.project_id.as_deref(),
    )
    .await?;

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

    let generation = match repo::create_generation(
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
    {
        Ok(generation) => generation,
        Err(error) => {
            if let Err(refund_error) = crate::billing::repo::refund_with_ref_type(
                &state.db,
                &user_id.0,
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
        &user_id.0,
        "video_generation",
        &generation.id,
    )
    .await
    {
        tracing::warn!(generation_id = %generation.id, error = %error, "failed to update video generation billing ref_id");
    }

    if let Err(error) = repo::set_processing(&state.db, &generation.id).await {
        refund_and_fail(&state, &user_id.0, &generation.id, cost, &error.to_string()).await?;
        return Err(AppError::Internal(error.to_string()));
    }

    let base_url = resolved.endpoint.base_url.clone();
    let api_key = resolved.endpoint.api_key.clone();
    let model = resolved.model.clone();
    let video_api_url = resolved
        .capability
        .as_ref()
        .and_then(|capability| capability.path_override.as_deref())
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            if path.starts_with("http://") || path.starts_with("https://") {
                path.to_string()
            } else {
                format!(
                    "{}/{}",
                    base_url.trim_end_matches('/'),
                    path.trim_start_matches('/')
                )
            }
        })
        .unwrap_or_else(|| {
            env::var("VIDEO_API_URL").unwrap_or_else(|_| {
                format!("{}/v1/video/generations", base_url.trim_end_matches('/'))
            })
        });

    let task_state = state.clone();
    let task_user_id = user_id.0.clone();
    let task_generation_id = generation.id.clone();

    tokio::spawn(async move {
        if let Err(error) = run_generation_task(
            task_state,
            task_user_id,
            task_generation_id.clone(),
            video_api_url,
            api_key,
            model,
            req,
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
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(VIDEO_GEN_TIMEOUT_SECS))
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
