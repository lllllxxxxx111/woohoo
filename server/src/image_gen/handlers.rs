use axum::{
    extract::{Path, State},
    Json,
};
use sqlx::SqlitePool;
use std::path::PathBuf;
use tokio::fs;
use uuid::Uuid;

use crate::ai::{capabilities::ResolvedAiCapability, client::AiClient};
use crate::asset;
use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::project;
use crate::AppState;

use super::model::*;
use super::repo;

pub async fn create_generation(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<CreateImageGenerationReq>,
) -> Result<Json<ImageGenerationResponse>, AppError> {
    if req.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt 不能为空".to_string()));
    }
    let project_id = req.project_id.trim();
    if project_id.is_empty() {
        return Err(AppError::BadRequest("projectId 不能为空".to_string()));
    }
    if !(1..=4).contains(&req.n) {
        return Err(AppError::BadRequest(
            "生成数量必须在 1 到 4 之间".to_string(),
        ));
    }
    if !matches!(req.size.as_str(), "1024x1024" | "1024x1536" | "1536x1024") {
        return Err(AppError::BadRequest("暂不支持该图片尺寸".to_string()));
    }

    ensure_project_access(&state.db, &user_id.0, project_id).await?;
    let route = crate::ai::capabilities::resolve_image_generation_capability(
        &state,
        &user_id.0,
        req.endpoint_id.as_deref(),
        Some(&req.model),
    )
    .await?;
    let model = route.model.clone();
    let cost = calculate_cost(&model, &req.size, req.n);

    let credits = crate::billing::repo::get_user_credits(&state.db, &user_id.0).await?;
    if credits.balance < cost {
        return Err(AppError::PaymentRequired(format!(
            "积分不足：当前 {}，需要 {}",
            credits.balance, cost
        )));
    }

    let generation = repo::create_generation(
        &state.db,
        &user_id.0,
        project_id,
        &req.prompt,
        &model,
        &req.size,
        req.n,
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    repo::set_processing(&state.db, &generation.id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let task_state = state.clone();
    let task_user_id = user_id.0.clone();
    let task_project_id = project_id.to_string();
    let task_generation_id = generation.id.clone();
    let task_prompt = req.prompt.clone();
    let task_size = req.size.clone();
    let task_n = req.n;
    tokio::spawn(async move {
        run_generation_task(
            task_state,
            task_user_id,
            task_project_id,
            task_generation_id,
            task_prompt,
            model,
            task_size,
            task_n,
            cost,
            route,
        )
        .await;
    });

    build_generation_response(&state.db, &generation.id, &user_id.0).await
}

async fn run_generation_task(
    state: AppState,
    user_id: String,
    project_id: String,
    generation_id: String,
    prompt: String,
    model: String,
    size: String,
    n: i64,
    cost: f64,
    route: ResolvedAiCapability,
) {
    let client = state.ai_client.clone();
    let image_base_url = build_image_generation_base_url(&route.endpoint.base_url);

    match generate_images_with_count(
        &client,
        &image_base_url,
        &route.endpoint.api_key,
        &model,
        &prompt,
        &size,
        n as u32,
    )
    .await
    {
        Ok(resp) => {
            let revised_prompt = resp.data.first().and_then(|d| d.revised_prompt.clone());
            if let Err(error) = crate::billing::repo::check_and_deduct(
                &state.db,
                &user_id,
                cost,
                "image_generation",
                Some("image_generation"),
                Some(&generation_id),
            )
            .await
            {
                tracing::warn!(
                    generation_id = %generation_id,
                    error = %error,
                    "Image generation succeeded but credits could not be deducted"
                );
                let _ = repo::set_failed(
                    &state.db,
                    &generation_id,
                    &format!("生成成功但积分不足，结果未保存：{}", error),
                )
                .await;
                return;
            }

            let persist_result = persist_generation_result(
                &state,
                &project_id,
                &generation_id,
                &prompt,
                &model,
                &size,
                n,
                revised_prompt.as_deref(),
                cost,
                &resp.data,
            )
            .await;

            match persist_result {
                Ok((urls, b64_data, asset_ids)) => {
                    if let Err(error) = repo::set_completed(
                        &state.db,
                        &generation_id,
                        &urls,
                        &b64_data,
                        &asset_ids,
                        revised_prompt.as_deref(),
                        cost,
                    )
                    .await
                    {
                        tracing::error!(
                            generation_id = %generation_id,
                            error = %error,
                            "Failed to mark image generation completed"
                        );
                    }
                }
                Err(error) => {
                    crate::billing::repo::refund(
                        &state.db,
                        &user_id,
                        cost,
                        "image_generation_asset_failed",
                        Some(&generation_id),
                    )
                    .await
                    .ok();

                    if let Err(update_error) =
                        repo::set_failed(&state.db, &generation_id, &error.to_string()).await
                    {
                        tracing::error!(
                            generation_id = %generation_id,
                            error = %update_error,
                            "Failed to mark image generation asset persistence failure"
                        );
                    }
                }
            }
        }
        Err(err) => {
            let error_message = user_facing_generation_error(&err);
            if let Err(update_error) =
                repo::set_failed(&state.db, &generation_id, &error_message).await
            {
                tracing::error!(
                    generation_id = %generation_id,
                    error = %update_error,
                    "Failed to mark image generation API failure"
                );
            }
        }
    }
}

fn user_facing_generation_error(error: &AppError) -> String {
    match error {
        AppError::ServiceUnavailable(message)
        | AppError::BadRequest(message)
        | AppError::Validation(message)
        | AppError::PaymentRequired(message)
        | AppError::Forbidden(message)
        | AppError::Conflict(message) => message.clone(),
        AppError::Internal(message) => sanitize_generation_error_text(message),
        _ => sanitize_generation_error_text(&error.to_string()),
    }
}

fn sanitize_generation_error_text(message: &str) -> String {
    let cleaned = message
        .replace("内部错误:", "")
        .replace("图片生成失败:", "")
        .replace("图片生成 API 调用失败:", "")
        .trim()
        .to_string();
    let lowered = cleaned.to_ascii_lowercase();

    if cleaned.contains("os error 10013")
        || cleaned.contains("访问权限不允许")
        || cleaned.contains("访问套接字")
    {
        return "图片生成通道被本机网络权限拦截：后端进程没有外网 socket 权限。请用正常网络权限重启后端，或检查 Windows 防火墙/代理后重试。".into();
    }

    if lowered.contains("timeout") || lowered.contains("timed out") || cleaned.contains("超时") {
        return "图片生成请求超时：上游生成耗时过长或连接中断。失败不会扣积分，请稍后重试。".into();
    }

    if lowered.contains("bad gateway") || cleaned.contains("502") {
        return "图片生成通道暂时不可用（上游返回 502）。通常是上游算力或代理短暂不可用，失败不会扣积分，请稍后重试。".into();
    }

    if lowered.contains("connect")
        || lowered.contains("error sending request for url")
        || cleaned.contains("无法连接")
    {
        return "无法连接图片生成通道：请检查后端网络权限、代理和 API 地址配置后重试。".into();
    }

    if cleaned.is_empty() {
        return "图片生成没有完成，请稍后重试。".into();
    }

    cleaned
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
    let gens = repo::list_user_generations(&state.db, &user_id.0, 50, 0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let results: Vec<ImageGenerationResponse> = gens.into_iter().map(gen_to_response).collect();

    Ok(Json(results))
}

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
    let asset_ids: Vec<String> = row
        .asset_ids
        .as_ref()
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(s).ok())
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
        urls: result_urls,
        b64_data: result_b64,
        asset_ids,
        revised_prompt: row.revised_prompt,
        cost_credits: row.cost_credits,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }
}

fn calculate_cost(model: &str, size: &str, n: i64) -> f64 {
    let base_cost = match model {
        "dall-e-3" => 5.0,
        _ => 3.0,
    };

    let size_multiplier = match size {
        "1024x1536" | "1536x1024" => 1.5,
        _ => 1.0,
    };

    base_cost * size_multiplier * (n as f64).max(1.0)
}

fn build_image_generation_base_url(base_url: &str) -> String {
    let normalized = base_url.trim().trim_end_matches('/');

    for suffix in [
        "/chat/completions",
        "/images/generations",
        "/responses",
        "/chat",
    ] {
        if normalized.to_ascii_lowercase().ends_with(suffix) {
            let api_root = normalized[..normalized.len() - suffix.len()].trim_end_matches('/');
            return append_api_path(api_root, "responses");
        }
    }

    append_api_path(normalized, "responses")
}

fn append_api_path(base_url: &str, path: &str) -> String {
    let lower = base_url.to_ascii_lowercase();
    let normalized_path = path.trim_matches('/');
    if lower.ends_with(&format!("/{}", normalized_path)) {
        return base_url.to_string();
    }
    if lower.ends_with("/v1") || lower.ends_with("/v2") {
        return format!("{}/{}", base_url, normalized_path);
    }
    if lower.contains("/v1/") || lower.contains("/v2/") {
        return base_url.to_string();
    }
    format!("{}/v1/{}", base_url, normalized_path)
}

async fn generate_images_with_count(
    client: &AiClient,
    image_base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    size: &str,
    count: u32,
) -> Result<crate::ai::client::ImageGenerateResponse, AppError> {
    let expected_count = count.clamp(1, 4) as usize;
    let mut response = client
        .generate_image(
            image_base_url,
            api_key,
            model,
            prompt,
            size,
            expected_count as u32,
            "b64_json",
        )
        .await?;

    while response.data.len() < expected_count {
        let next_response = client
            .generate_image(image_base_url, api_key, model, prompt, size, 1, "b64_json")
            .await?;
        response.data.extend(next_response.data);
    }

    response.data.truncate(expected_count);
    Ok(response)
}

async fn ensure_project_access(
    db: &SqlitePool,
    user_id: &str,
    project_id: &str,
) -> Result<(), AppError> {
    let project = project::repo::find_by_id(db, project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;

    if project.user_id != user_id {
        return Err(AppError::Forbidden("无权访问该项目".into()));
    }

    Ok(())
}

async fn persist_generation_result(
    state: &AppState,
    project_id: &str,
    generation_id: &str,
    prompt: &str,
    model: &str,
    size: &str,
    expected_count: i64,
    revised_prompt: Option<&str>,
    cost_credits: f64,
    data: &[crate::ai::client::ImageDataItem],
) -> Result<(Vec<String>, Vec<String>, Vec<String>), AppError> {
    let mut urls = Vec::new();
    let mut b64_data = Vec::new();
    let mut asset_ids = Vec::new();

    for (index, item) in data.iter().enumerate() {
        if let Some(ref url) = item.url {
            urls.push(url.clone());
        }
        if let Some(ref b64) = item.b64_json {
            b64_data.push(b64.clone());
            let asset = persist_generated_image_asset(
                state,
                project_id,
                generation_id,
                prompt,
                model,
                size,
                revised_prompt,
                cost_credits,
                b64,
                index,
            )
            .await?;
            urls.push(format!("/uploads/{}", local_asset_filename(&asset.url)?));
            asset_ids.push(asset.id);
        }
    }

    if asset_ids.is_empty() && expected_count > 0 {
        return Err(AppError::Internal(
            "图片生成成功但未返回可保存的图片数据".into(),
        ));
    }

    Ok((urls, b64_data, asset_ids))
}

async fn persist_generated_image_asset(
    state: &AppState,
    project_id: &str,
    generation_id: &str,
    prompt: &str,
    model: &str,
    size: &str,
    revised_prompt: Option<&str>,
    cost_credits: f64,
    b64_json: &str,
    index: usize,
) -> Result<asset::model::Asset, AppError> {
    let image_bytes = decode_base64(b64_json.trim())?;
    let assets_root = resolve_assets_root(state).await?;
    let filename = format!("image-generation-{}-{}.png", Uuid::new_v4(), index + 1);
    let file_path = assets_root.join(&filename);
    if !file_path.starts_with(&assets_root) {
        return Err(AppError::Forbidden("非法的资产文件路径".into()));
    }

    fs::write(&file_path, &image_bytes)
        .await
        .map_err(|error| AppError::Internal(format!("写入生成图片失败: {}", error)))?;

    let metadata = serde_json::json!({
        "origin": "image_generation",
        "generationId": generation_id,
        "prompt": prompt,
        "model": model,
        "size": size,
        "revisedPrompt": revised_prompt,
        "costCredits": cost_credits,
        "sizeBytes": image_bytes.len(),
        "generatedAt": chrono::Utc::now().to_rfc3339(),
    })
    .to_string();
    let asset_name = build_asset_name(prompt, index);
    let asset_url = format!("/uploads/{}", filename);

    asset::repo::create_asset(
        &state.db,
        project_id,
        &asset_name,
        "image",
        &asset_url,
        Some(&metadata),
    )
    .await
}

async fn resolve_assets_root(state: &AppState) -> Result<PathBuf, AppError> {
    fs::create_dir_all(&state.config.assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("创建资产目录失败: {}", error)))?;
    fs::canonicalize(&state.config.assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("解析资产目录失败: {}", error)))
}

fn build_asset_name(prompt: &str, index: usize) -> String {
    let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let prefix: String = normalized.chars().take(24).collect();
    let title = if prefix.trim().is_empty() {
        "图片生成".to_string()
    } else {
        prefix
    };
    format!("{}-{}.png", title, index + 1)
}

fn local_asset_filename(asset_url: &str) -> Result<&str, AppError> {
    asset_url
        .strip_prefix("/uploads/")
        .filter(|filename| {
            !filename.is_empty() && !filename.contains('/') && !filename.contains('\\')
        })
        .ok_or_else(|| AppError::Internal("生成资产地址无效".into()))
}

fn decode_base64(input: &str) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = [0u8; 4];
    let mut buffer_len = 0usize;

    for byte in input.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => return Err(AppError::Internal("图片数据不是有效的 base64 编码".into())),
        };

        buffer[buffer_len] = value;
        buffer_len += 1;

        if buffer_len == 4 {
            if buffer[0] == 64 || buffer[1] == 64 {
                return Err(AppError::Internal("图片 base64 填充位置无效".into()));
            }

            if buffer[2] == 64 && buffer[3] != 64 {
                return Err(AppError::Internal("图片 base64 填充位置无效".into()));
            }

            output.push((((buffer[0] as u32) << 2) | ((buffer[1] as u32) >> 4)) as u8);
            if buffer[2] != 64 {
                output.push(((((buffer[1] as u32) & 0x0f) << 4) | ((buffer[2] as u32) >> 2)) as u8);
            }
            if buffer[3] != 64 {
                output.push(((((buffer[2] as u32) & 0x03) << 6) | (buffer[3] as u32)) as u8);
            }

            buffer_len = 0;
        }
    }

    if buffer_len != 0 {
        return Err(AppError::Internal("图片 base64 长度无效".into()));
    }

    Ok(output)
}
