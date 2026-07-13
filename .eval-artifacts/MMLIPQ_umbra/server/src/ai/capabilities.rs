use sqlx::FromRow;

use crate::{
    ai::config::{AiEndpoint, AiEndpointCapability},
    error::{AppError, AppResult},
    AppState,
};

#[derive(Debug, Clone)]
pub struct ResolvedAiCapability {
    pub endpoint: AiEndpoint,
    pub capability: Option<AiEndpointCapability>,
    pub model: String,
}

#[derive(Debug, FromRow)]
struct EndpointCapabilityRow {
    endpoint_id: String,
    user_id: String,
    name: String,
    provider: String,
    base_url: String,
    api_key: String,
    default_model: Option<String>,
    is_active: bool,
    endpoint_created_at: String,
    endpoint_updated_at: String,
    capability_id: Option<String>,
    capability: Option<String>,
    capability_model: Option<String>,
    path_override: Option<String>,
    request_adapter: Option<String>,
    response_adapter: Option<String>,
    supports_stream: Option<bool>,
    supports_tools: Option<bool>,
    supports_files: Option<bool>,
    enabled: Option<bool>,
    priority: Option<i64>,
    config_json: Option<String>,
    capability_created_at: Option<String>,
    capability_updated_at: Option<String>,
}

pub async fn resolve_image_generation_capability(
    state: &AppState,
    user_id: &str,
    endpoint_id: Option<&str>,
    requested_model: Option<&str>,
) -> AppResult<ResolvedAiCapability> {
    resolve_capability(
        state,
        user_id,
        "image_generation",
        endpoint_id,
        requested_model,
        Some("gpt-image-1"),
    )
    .await
}

/// 解析视频生成能力，从数据库查找启用了 video_generation 能力的端点
pub async fn resolve_video_generation_capability(
    state: &AppState,
    user_id: &str,
    endpoint_id: Option<&str>,
    requested_model: Option<&str>,
) -> AppResult<ResolvedAiCapability> {
    resolve_capability(
        state,
        user_id,
        "video_generation",
        endpoint_id,
        requested_model,
        Some("wan2.1-t2v-480p"),
    )
    .await
}

async fn resolve_capability(
    state: &AppState,
    user_id: &str,
    capability: &str,
    endpoint_id: Option<&str>,
    requested_model: Option<&str>,
    fallback_model: Option<&str>,
) -> AppResult<ResolvedAiCapability> {
    let row =
        if let Some(endpoint_id) = endpoint_id.map(str::trim).filter(|value| !value.is_empty()) {
            let row = sqlx::query_as::<_, EndpointCapabilityRow>(
                "SELECT
                e.id AS endpoint_id,
                e.user_id,
                e.name,
                e.provider,
                e.base_url,
                e.api_key,
                e.default_model,
                e.is_active,
                e.created_at AS endpoint_created_at,
                e.updated_at AS endpoint_updated_at,
                c.id AS capability_id,
                c.capability,
                c.model AS capability_model,
                c.path_override,
                c.request_adapter,
                c.response_adapter,
                c.supports_stream,
                c.supports_tools,
                c.supports_files,
                c.enabled,
                c.priority,
                c.config_json,
                c.created_at AS capability_created_at,
                c.updated_at AS capability_updated_at
             FROM ai_endpoints e
             JOIN ai_endpoint_capabilities c
                ON c.endpoint_id = e.id
               AND c.capability = ?
               AND c.enabled = 1
             WHERE e.id = ?
               AND e.user_id = ?
               AND e.is_active = 1
             LIMIT 1",
            )
            .bind(capability)
            .bind(endpoint_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("指定的 API 通道不存在或未启用".into()))?;

            row
        } else {
            sqlx::query_as::<_, EndpointCapabilityRow>(
                "SELECT
                e.id AS endpoint_id,
                e.user_id,
                e.name,
                e.provider,
                e.base_url,
                e.api_key,
                e.default_model,
                e.is_active,
                e.created_at AS endpoint_created_at,
                e.updated_at AS endpoint_updated_at,
                c.id AS capability_id,
                c.capability,
                c.model AS capability_model,
                c.path_override,
                c.request_adapter,
                c.response_adapter,
                c.supports_stream,
                c.supports_tools,
                c.supports_files,
                c.enabled,
                c.priority,
                c.config_json,
                c.created_at AS capability_created_at,
                c.updated_at AS capability_updated_at
             FROM ai_endpoint_capabilities c
             JOIN ai_endpoints e ON e.id = c.endpoint_id
             WHERE e.user_id = ?
               AND e.is_active = 1
               AND c.capability = ?
               AND c.enabled = 1
             ORDER BY c.priority ASC, c.created_at ASC
             LIMIT 1",
            )
            .bind(user_id)
            .bind(capability)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| {
                let label = match capability {
                    "image_generation" => "图片生成",
                    "video_generation" => "视频生成",
                    other => other,
                };
                AppError::Validation(format!("请先在设置里为 API 通道启用{}能力", label))
            })?
        };

    let endpoint = AiEndpoint {
        id: row.endpoint_id.clone(),
        user_id: row.user_id,
        name: row.name,
        provider: row.provider,
        base_url: row.base_url,
        api_key: row.api_key,
        default_model: row.default_model,
        is_active: row.is_active,
        created_at: row.endpoint_created_at,
        updated_at: row.endpoint_updated_at,
    };

    let capability_record = row.capability_id.map(|id| AiEndpointCapability {
        id,
        endpoint_id: row.endpoint_id,
        capability: row.capability.unwrap_or_else(|| capability.to_string()),
        model: row.capability_model,
        path_override: row.path_override,
        request_adapter: row
            .request_adapter
            .unwrap_or_else(|| "openai_compatible".to_string()),
        response_adapter: row
            .response_adapter
            .unwrap_or_else(|| "openai_compatible".to_string()),
        supports_stream: row.supports_stream.unwrap_or(false),
        supports_tools: row.supports_tools.unwrap_or(false),
        supports_files: row.supports_files.unwrap_or(false),
        enabled: row.enabled.unwrap_or(true),
        priority: row.priority.unwrap_or(100),
        config_json: row.config_json,
        created_at: row.capability_created_at.unwrap_or_default(),
        updated_at: row.capability_updated_at.unwrap_or_default(),
    });

    let model = select_capability_model(
        capability,
        requested_model,
        capability_record
            .as_ref()
            .and_then(|item| item.model.as_deref()),
        endpoint.default_model.as_deref(),
        fallback_model,
    )
    .ok_or_else(|| {
        let label = match capability {
            "image_generation" => "图片生成",
            "video_generation" => "视频生成",
            other => other,
        };
        AppError::Validation(format!("{}模型未配置", label))
    })?;

    Ok(ResolvedAiCapability {
        endpoint,
        capability: capability_record,
        model,
    })
}

fn normalize_model_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn select_capability_model(
    capability: &str,
    requested_model: Option<&str>,
    capability_model: Option<&str>,
    endpoint_default_model: Option<&str>,
    fallback_model: Option<&str>,
) -> Option<String> {
    let requested_model = normalize_model_name(requested_model);
    let capability_model = normalize_model_name(capability_model);
    let endpoint_default_model = normalize_model_name(endpoint_default_model);
    let fallback_model = normalize_model_name(fallback_model);

    let requested_is_endpoint_default = requested_model
        .as_deref()
        .zip(endpoint_default_model.as_deref())
        .map(|(requested, default_model)| requested.eq_ignore_ascii_case(default_model))
        .unwrap_or(false);
    let should_prefer_capability_model =
        matches!(capability, "image_generation" | "video_generation")
            && capability_model.is_some()
            && (requested_model.is_none() || requested_is_endpoint_default);

    if should_prefer_capability_model {
        capability_model
            .or(requested_model)
            .or(endpoint_default_model)
            .or(fallback_model)
    } else {
        requested_model
            .or(capability_model)
            .or(endpoint_default_model)
            .or(fallback_model)
    }
}

#[cfg(test)]
mod tests {
    use super::select_capability_model;

    #[test]
    fn image_generation_prefers_capability_model_over_endpoint_default_request() {
        let selected = select_capability_model(
            "image_generation",
            Some("gpt-5.5"),
            Some("gpt-image-2"),
            Some("gpt-5.5"),
            Some("gpt-image-1"),
        );

        assert_eq!(selected.as_deref(), Some("gpt-image-2"));
    }

    #[test]
    fn image_generation_respects_explicit_non_default_model() {
        let selected = select_capability_model(
            "image_generation",
            Some("dall-e-3"),
            Some("gpt-image-2"),
            Some("gpt-5.5"),
            Some("gpt-image-1"),
        );

        assert_eq!(selected.as_deref(), Some("dall-e-3"));
    }

    #[test]
    fn chat_keeps_requested_model_first() {
        let selected = select_capability_model(
            "chat",
            Some("gpt-5.5"),
            Some("gpt-4.1"),
            Some("gpt-5.5"),
            None,
        );

        assert_eq!(selected.as_deref(), Some("gpt-5.5"));
    }
}
