use axum::{
    extract::{Path, State},
    Json,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::{SecondsFormat, Utc};
use sqlx::SqlitePool;
use std::env;
use std::path::PathBuf;
use std::time::Duration;
use tokio::fs;

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::model::*;
use super::repo;

const IMAGE_GEN_TIMEOUT_SECS: u64 = 3600;

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

    let project_id = normalize_project_id(req.project_id.as_deref());
    if let Some(project_id) = project_id.as_deref() {
        ensure_project_access(&state.db, &user_id.0, project_id).await?;
    }

    // Use the unified smart router for endpoint selection
    let routing_request = crate::ai::router::RoutingRequest {
        user_id: user_id.0.clone(),
        operation: crate::ai::router::RoutingOperation::ImageGeneration,
        explicit_endpoint_id: req.endpoint_id.clone(),
        requested_model: Some(req.model.clone()),
        requires_stream: false,
        requires_tools: false,
        project_id: project_id.clone(),
        allow_fallback: true,
        max_attempts: 3,
        ..Default::default()
    };

    let plan = crate::ai::router::build_routing_plan(&state.db, routing_request).await
        .map_err(|error| {
            tracing::warn!(error = %error, "image generation endpoint resolution failed");
            let api_key = env::var("AI_API_KEY").unwrap_or_default();
            if api_key.is_empty() {
                return AppError::Validation(
                    "Please enable an image generation API channel in settings or configure AI_API_KEY.".into(),
                );
            }
            AppError::Internal(format!(
                "image generation endpoint resolution failed: {}",
                error
            ))
        })?;

    let primary = plan.primary().ok_or_else(|| {
        AppError::Validation("请先在设置里为 API 通道启用图片生成能力".into())
    })?;

    let resolved_model = primary.model.clone();
    let routing_request_id = plan.request_id.clone();
    let cost = calculate_cost(&resolved_model, &req.size, req.n);

    crate::billing::budget_enforce::enforce_budget(
        &state.db,
        &user_id.0,
        cost,
        "image_generation",
        true,
        Some(&resolved_model),
        project_id.as_deref(),
    )
    .await?;

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

    let generation = match repo::create_generation(
        &state.db,
        &user_id.0,
        project_id.as_deref(),
        &req.prompt,
        &resolved_model,
        &req.size,
        req.n,
        cost,
    )
    .await
    {
        Ok(generation) => generation,
        Err(error) => {
            if let Err(refund_error) = crate::billing::repo::refund(
                &state.db,
                &user_id.0,
                cost,
                "image_generation_record_create_failed",
                None,
            )
            .await
            {
                tracing::error!(error = %refund_error, "failed to refund after image generation record creation failed");
            }
            return Err(AppError::Internal(error.to_string()));
        }
    };

    if let Err(error) = crate::billing::repo::update_spent_ref_id(
        &state.db,
        &user_id.0,
        "image_generation",
        &generation.id,
    )
    .await
    {
        tracing::warn!(generation_id = %generation.id, error = %error, "failed to update image generation billing ref_id");
    }

    if let Err(error) = repo::set_processing(&state.db, &generation.id).await {
        refund_and_fail(&state, &user_id.0, &generation.id, cost, &error.to_string()).await?;
        return Err(AppError::Internal(error.to_string()));
    }

    // Build list of (base_url, api_key, model, endpoint_id) for fallback attempts
    let fallback_candidates: Vec<(String, String, String, String)> = plan.candidates.iter().map(|c| {
        (c.endpoint.base_url.clone(), c.endpoint.api_key.clone(), c.model.clone(), c.endpoint.id.clone())
    }).collect();

    let task_state = state.clone();
    let task_user_id = user_id.0.clone();
    let task_generation_id = generation.id.clone();
    let task_project_id = project_id.clone();
    let task_prompt = req.prompt.clone();
    let task_size = req.size.clone();
    let task_n = req.n;
    let task_routing_request_id = routing_request_id;

    tokio::spawn(async move {
        if let Err(error) = run_generation_task(
            task_state,
            task_user_id,
            task_generation_id.clone(),
            task_project_id,
            fallback_candidates,
            task_prompt,
            task_size,
            task_n,
            cost,
            task_routing_request_id,
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

    build_generation_response(&state.db, &generation.id, &user_id.0).await
}

async fn run_generation_task(
    state: AppState,
    user_id: String,
    generation_id: String,
    project_id: Option<String>,
    candidates: Vec<(String, String, String, String)>, // (base_url, api_key, model, endpoint_id)
    prompt: String,
    size: String,
    n: i64,
    cost: f64,
    routing_request_id: String,
) -> Result<(), AppError> {
    if candidates.is_empty() {
        refund_and_fail(&state, &user_id, &generation_id, cost, "No available endpoints").await?;
        return Ok(());
    }

    let mut last_error: Option<String> = None;
    let total_candidates = candidates.len();

    for (idx, (base_url, api_key, model, endpoint_id)) in candidates.iter().enumerate() {
        let generate_result = tokio::time::timeout(
            Duration::from_secs(IMAGE_GEN_TIMEOUT_SECS),
            state.ai_client.generate_image(
                base_url, api_key, model, &prompt, &size, n as u32, "b64_json",
            ),
        )
        .await;

        match generate_result {
            Ok(Ok(response)) => {
                // Record routing success
                crate::ai::router::record_routing_event_safe(&state.db, &crate::ai::router::RoutingEventRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    user_id: user_id.clone(),
                    request_id: Some(routing_request_id.clone()),
                    task_id: None,
                    pipeline_run_id: None,
                    pipeline_step_id: None,
                    conversation_id: None,
                    project_id: project_id.clone(),
                    agent_id: None,
                    operation: "image_generation".to_string(),
                    capability: "image_generation".to_string(),
                    requested_endpoint_id: None,
                    requested_model: Some(model.clone()),
                    requires_stream: false,
                    requires_tools: false,
                    min_context_tokens: None,
                    candidate_endpoint_id: Some(endpoint_id.clone()),
                    candidate_model: Some(model.clone()),
                    candidate_priority: None,
                    candidate_index: idx as i64,
                    final_endpoint_id: Some(endpoint_id.clone()),
                    final_model: Some(model.clone()),
                    status: if idx > 0 { "fallback".to_string() } else { "success".to_string() },
                    error_classification: None,
                    error_message: None,
                    fallback_from_index: if idx > 0 { Some((idx - 1) as i64) } else { None },
                    attempt_count: (idx + 1) as i64,
                    max_attempts: total_candidates as i64,
                    latency_ms: None,
                    created_at: chrono::Utc::now().to_rfc3339(),
                }).await;

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
            return Ok(());
        }
        Ok(Err(error)) => {
            let error_msg = error.to_string();
            let classification = crate::ai::router::classify_error(&error_msg);

            // Record failure event
            crate::ai::router::record_routing_event_safe(&state.db, &crate::ai::router::RoutingEventRecord {
                id: uuid::Uuid::new_v4().to_string(),
                user_id: user_id.clone(),
                request_id: Some(routing_request_id.clone()),
                task_id: None,
                pipeline_run_id: None,
                pipeline_step_id: None,
                conversation_id: None,
                project_id: project_id.clone(),
                agent_id: None,
                operation: "image_generation".to_string(),
                capability: "image_generation".to_string(),
                requested_endpoint_id: None,
                requested_model: Some(model.clone()),
                requires_stream: false,
                requires_tools: false,
                min_context_tokens: None,
                candidate_endpoint_id: Some(endpoint_id.clone()),
                candidate_model: Some(model.clone()),
                candidate_priority: None,
                candidate_index: idx as i64,
                final_endpoint_id: None,
                final_model: None,
                status: "failed".to_string(),
                error_classification: Some(classification.as_str().to_string()),
                error_message: Some(error_msg.clone()),
                fallback_from_index: None,
                attempt_count: (idx + 1) as i64,
                max_attempts: total_candidates as i64,
                latency_ms: None,
                created_at: chrono::Utc::now().to_rfc3339(),
            }).await;

            last_error = Some(error_msg);
            if classification.is_retryable() && idx + 1 < total_candidates {
                tracing::warn!(endpoint = %endpoint_id, ?classification, "Image gen attempt failed, trying next endpoint");
                continue;
            }
            // Non-retryable or exhausted
            break;
        }
        Err(_) => {
            let timeout_msg = format!(
                "image generation timed out after {}s",
                IMAGE_GEN_TIMEOUT_SECS
            );
            let classification = crate::ai::router::ErrorClassification::NetworkTimeout;
            last_error = Some(timeout_msg.clone());

            // Record timeout event
            crate::ai::router::record_routing_event_safe(&state.db, &crate::ai::router::RoutingEventRecord {
                id: uuid::Uuid::new_v4().to_string(),
                user_id: user_id.clone(),
                request_id: Some(routing_request_id.clone()),
                task_id: None,
                pipeline_run_id: None,
                pipeline_step_id: None,
                conversation_id: None,
                project_id: project_id.clone(),
                agent_id: None,
                operation: "image_generation".to_string(),
                capability: "image_generation".to_string(),
                requested_endpoint_id: None,
                requested_model: Some(model.clone()),
                requires_stream: false,
                requires_tools: false,
                min_context_tokens: None,
                candidate_endpoint_id: Some(endpoint_id.clone()),
                candidate_model: Some(model.clone()),
                candidate_priority: None,
                candidate_index: idx as i64,
                final_endpoint_id: None,
                final_model: None,
                status: "failed".to_string(),
                error_classification: Some(classification.as_str().to_string()),
                error_message: Some(timeout_msg),
                fallback_from_index: None,
                attempt_count: (idx + 1) as i64,
                max_attempts: total_candidates as i64,
                latency_ms: Some(IMAGE_GEN_TIMEOUT_SECS as i64 * 1000),
                created_at: chrono::Utc::now().to_rfc3339(),
            }).await;

            if idx + 1 < total_candidates {
                tracing::warn!(endpoint = %endpoint_id, "Image gen timed out, trying next endpoint");
                continue;
            }
            break;
        }
    }

    // All candidates exhausted
    let error_msg = last_error.unwrap_or_else(|| "All image generation endpoints failed".to_string());
    refund_and_fail(&state, &user_id, &generation_id, cost, &error_msg).await?;
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
    if let Err(refund_error) = crate::billing::repo::refund(
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
