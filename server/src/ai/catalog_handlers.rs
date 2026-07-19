use std::collections::HashMap;

use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    AppState,
};

use super::{
    api_key_crypto,
    config::{
        Agent, AgentContact, AiEndpoint, AiEndpointCapability, AiEndpointCapabilityView,
        AiEndpointModelsReq, AiEndpointModelsResp, AiEndpointView, AssignProjectAgentReq,
        CreateAgentReq, CreateEndpointReq, CreateProjectAgentReq, ProjectRoleCounts,
        ProjectWorkflowSummary, UpdateAgentReq, UpdateEndpointReq, UpsertEndpointCapabilityReq,
    },
    handlers::{
        default_pass_rate, ensure_agent_access, ensure_project_access,
        generate_safe_sql_placeholders, normalize_optional, phase_progress_percent,
        responsibility_kind_for_agent, upsert_project_agent_assignment,
        upsert_project_agent_assignment_tx, validate_agent_endpoint_access,
        validate_connection_fields,
    },
    runtime::{AiTaskRuntime, RuntimeProjectTaskCounts},
};

#[derive(Debug, FromRow)]
struct AgentWithUsage {
    id: String,
    name: String,
    role: String,
    system_prompt: String,
    pub badge: String,
    pub description: String,
    pub endpoint_id: Option<String>,
    pub model: Option<String>,
    pub temperature: f64,
    pub max_tokens: i64,
    pub work_count: i64,
}

#[derive(Debug, FromRow)]
struct ProjectAgentWithUsage {
    assignment_id: String,
    project_id: String,
    responsibility_kind: String,
    responsibility_label: String,
    assignment_source: String,
    id: String,
    name: String,
    role: String,
    system_prompt: String,
    badge: String,
    description: String,
    endpoint_id: Option<String>,
    model: Option<String>,
    temperature: f64,
    max_tokens: i64,
    work_count: i64,
}

pub async fn list_endpoints(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
) -> AppResult<Json<Vec<AiEndpointView>>> {
    let endpoints = sqlx::query_as::<_, AiEndpoint>(
        "SELECT * FROM ai_endpoints WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(&user_id.0)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(build_endpoint_views(&state.db, endpoints).await?))
}

pub async fn create_endpoint(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<CreateEndpointReq>,
) -> AppResult<(StatusCode, Json<AiEndpointView>)> {
    if req.name.trim().is_empty() {
        return Err(AppError::Validation("端点名称不能为空".into()));
    }
    validate_connection_fields(&req.provider, &req.base_url, &req.api_key).await?;

    // 加密 API Key 后再写入数据库，避免明文落盘
    let encrypted_api_key = api_key_crypto::encrypt(req.api_key.trim())?;

    let id = Uuid::new_v4().to_string();
    let endpoint = sqlx::query_as::<_, AiEndpoint>(
        "INSERT INTO ai_endpoints (id, user_id, name, provider, base_url, api_key, default_model)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&id)
    .bind(&user_id.0)
    .bind(req.name.trim())
    .bind(req.provider.trim())
    .bind(req.base_url.trim())
    .bind(&encrypted_api_key)
    .bind(req.default_model.as_deref().map(str::trim))
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(build_endpoint_view(&state.db, endpoint).await?),
    ))
}

pub async fn update_endpoint(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<UpdateEndpointReq>,
) -> AppResult<Json<AiEndpointView>> {
    if req.name.trim().is_empty() {
        return Err(AppError::Validation("端点名称不能为空".into()));
    }

    let existing =
        sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ? AND user_id = ?")
            .bind(&id)
            .bind(&user_id.0)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("AI 端点不存在".into()))?;

    // 计算下一个 api_key 值：
    // - 用户未提供新 key（None 或空字符串）→ 保留原值（可能是密文或旧明文）
    // - 用户提供新 key → 加密后写入
    //
    // 注意：保留原值时直接使用 existing.api_key（已是密文或明文），
    // 不做解密+重新加密，避免无谓的解密失败或密钥轮换。
    let next_api_key_stored: String = match req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(new_plain_key) => {
            // 用户提交新明文 key：加密后写入
            api_key_crypto::encrypt(new_plain_key)?
        }
        None => existing.api_key.clone(),
    };

    // 校验连接字段：validate_connection_fields 接受明文，需要解密（若已是密文）
    let next_api_key_for_validation =
        api_key_crypto::maybe_decrypt(&next_api_key_stored)?;
    validate_connection_fields(&req.provider, &req.base_url, &next_api_key_for_validation).await?;

    let endpoint = sqlx::query_as::<_, AiEndpoint>(
        "UPDATE ai_endpoints
         SET name = ?, provider = ?, base_url = ?, api_key = ?, default_model = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND user_id = ?
         RETURNING *",
    )
    .bind(req.name.trim())
    .bind(req.provider.trim())
    .bind(req.base_url.trim())
    .bind(&next_api_key_stored)
    .bind(req.default_model.as_deref().map(str::trim))
    .bind(&id)
    .bind(&user_id.0)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("AI 端点不存在".into()))?;

    Ok(Json(build_endpoint_view(&state.db, endpoint).await?))
}

pub async fn delete_endpoint(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM ai_endpoints WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user_id.0)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn upsert_endpoint_capability(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<UpsertEndpointCapabilityReq>,
) -> AppResult<Json<AiEndpointCapabilityView>> {
    let capability = normalize_capability(&req.capability)?;
    ensure_endpoint_owner(&state.db, &id, &user_id.0).await?;

    let existing = sqlx::query_as::<_, AiEndpointCapability>(
        "SELECT * FROM ai_endpoint_capabilities
         WHERE endpoint_id = ? AND capability = ?
         LIMIT 1",
    )
    .bind(&id)
    .bind(&capability)
    .fetch_optional(&state.db)
    .await?;

    let next_model = match req.model {
        Some(value) => normalize_optional(Some(value)),
        None => existing.as_ref().and_then(|item| item.model.clone()),
    };
    let next_path_override = match req.path_override {
        Some(value) => normalize_optional(Some(value)),
        None => existing
            .as_ref()
            .and_then(|item| item.path_override.clone()),
    };
    let next_request_adapter = match req.request_adapter {
        Some(value) => {
            normalize_optional(Some(value)).unwrap_or_else(|| "openai_compatible".to_string())
        }
        None => existing
            .as_ref()
            .map(|item| item.request_adapter.clone())
            .unwrap_or_else(|| "openai_compatible".to_string()),
    };
    let next_response_adapter = match req.response_adapter {
        Some(value) => {
            normalize_optional(Some(value)).unwrap_or_else(|| "openai_compatible".to_string())
        }
        None => existing
            .as_ref()
            .map(|item| item.response_adapter.clone())
            .unwrap_or_else(|| "openai_compatible".to_string()),
    };
    let next_supports_stream = req
        .supports_stream
        .or_else(|| existing.as_ref().map(|item| item.supports_stream))
        .unwrap_or(false);
    let next_supports_tools = req
        .supports_tools
        .or_else(|| existing.as_ref().map(|item| item.supports_tools))
        .unwrap_or(false);
    let next_supports_files = req
        .supports_files
        .or_else(|| existing.as_ref().map(|item| item.supports_files))
        .unwrap_or(false);
    let next_enabled = req
        .enabled
        .or_else(|| existing.as_ref().map(|item| item.enabled))
        .unwrap_or(true);
    let next_priority = req
        .priority
        .or_else(|| existing.as_ref().map(|item| item.priority))
        .unwrap_or(100);
    let next_config_json = match req.config_json {
        Some(value) => normalize_optional(Some(value)),
        None => existing.as_ref().and_then(|item| item.config_json.clone()),
    };

    // SSRF 防护：path_override 若为绝对 URL，必须独立校验
    // 防止攻击者用绝对 URL 绕过已校验的 base_url，直连内网/云元数据
    if let Some(path_override) = next_path_override.as_deref() {
        super::ssrf_guard::validate_path_override(path_override).await?;
    }

    let capability_id = Uuid::new_v4().to_string();
    let record = sqlx::query_as::<_, AiEndpointCapability>(
        "INSERT INTO ai_endpoint_capabilities (
             id, endpoint_id, capability, model, path_override, request_adapter, response_adapter,
             supports_stream, supports_tools, supports_files, enabled, priority, config_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint_id, capability) DO UPDATE SET
             model = excluded.model,
             path_override = excluded.path_override,
             request_adapter = excluded.request_adapter,
             response_adapter = excluded.response_adapter,
             supports_stream = excluded.supports_stream,
             supports_tools = excluded.supports_tools,
             supports_files = excluded.supports_files,
             enabled = excluded.enabled,
             priority = excluded.priority,
             config_json = excluded.config_json,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         RETURNING *",
    )
    .bind(&capability_id)
    .bind(&id)
    .bind(&capability)
    .bind(next_model.as_deref())
    .bind(next_path_override.as_deref())
    .bind(&next_request_adapter)
    .bind(&next_response_adapter)
    .bind(next_supports_stream)
    .bind(next_supports_tools)
    .bind(next_supports_files)
    .bind(next_enabled)
    .bind(next_priority)
    .bind(next_config_json.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok(Json(record.into()))
}

pub async fn list_endpoint_capabilities(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<AiEndpointCapabilityView>>> {
    ensure_endpoint_owner(&state.db, &id, &user_id.0).await?;

    let capabilities = load_capabilities_for_endpoint(&state.db, &id).await?;
    Ok(Json(capabilities.into_iter().map(Into::into).collect()))
}

pub async fn list_endpoint_models(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<AiEndpointModelsReq>,
) -> AppResult<Json<AiEndpointModelsResp>> {
    let endpoint = if let Some(endpoint_id) = req
        .endpoint_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let endpoint =
            sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ? AND user_id = ?")
                .bind(endpoint_id)
                .bind(&user_id.0)
                .fetch_optional(&state.db)
                .await?
                .ok_or_else(|| AppError::NotFound("AI 通道不存在".into()))?;
        // 惰性迁移：若数据库中是旧明文 key，加密后写回
        api_key_crypto::migrate_endpoint_if_needed(&state.db, &endpoint).await?;
        // 重新读取（迁移后值已变化）
        if api_key_crypto::is_encrypted(&endpoint.api_key) || endpoint.api_key.trim().is_empty() {
            endpoint
        } else {
            sqlx::query_as::<_, AiEndpoint>(
                "SELECT * FROM ai_endpoints WHERE id = ? AND user_id = ?",
            )
            .bind(endpoint_id)
            .bind(&user_id.0)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("AI 通道不存在".into()))?
        }
    } else {
        AiEndpoint {
            id: String::new(),
            user_id: user_id.0.clone(),
            name: "draft".to_string(),
            provider: normalize_optional(req.provider.clone()).unwrap_or_default(),
            base_url: normalize_optional(req.base_url.clone()).unwrap_or_default(),
            api_key: String::new(),
            default_model: None,
            is_active: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    };

    let provider = normalize_optional(req.provider).unwrap_or(endpoint.provider);
    let base_url = normalize_optional(req.base_url).unwrap_or(endpoint.base_url);
    // 数据库中可能是密文，需要在调用前解密
    let stored_api_key = normalize_optional(req.api_key).unwrap_or(endpoint.api_key);
    let api_key = api_key_crypto::maybe_decrypt(&stored_api_key)?;

    validate_connection_fields(&provider, &base_url, &api_key).await?;

    let models = state.ai_client.list_models(&base_url, &api_key).await?;

    Ok(Json(AiEndpointModelsResp { models }))
}

async fn ensure_endpoint_owner(
    pool: &SqlitePool,
    endpoint_id: &str,
    user_id: &str,
) -> AppResult<()> {
    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(1) FROM ai_endpoints WHERE id = ? AND user_id = ?",
    )
    .bind(endpoint_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    if exists == 0 {
        return Err(AppError::NotFound("AI 端点不存在".into()));
    }

    Ok(())
}

fn normalize_capability(value: &str) -> AppResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "chat" | "agent_plan" | "image_generation" | "video_generation" | "tts" | "stt"
        | "embedding" | "moderation" => Ok(normalized),
        _ => Err(AppError::Validation("不支持的 API 能力类型".into())),
    }
}

async fn build_endpoint_view(pool: &SqlitePool, endpoint: AiEndpoint) -> AppResult<AiEndpointView> {
    let capabilities = load_capabilities_for_endpoint(pool, &endpoint.id)
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    let mut view = AiEndpointView::from(endpoint);
    view.capabilities = capabilities;
    Ok(view)
}

async fn build_endpoint_views(
    pool: &SqlitePool,
    endpoints: Vec<AiEndpoint>,
) -> AppResult<Vec<AiEndpointView>> {
    let endpoint_ids: Vec<String> = endpoints
        .iter()
        .map(|endpoint| endpoint.id.clone())
        .collect();
    let mut grouped: HashMap<String, Vec<AiEndpointCapabilityView>> = HashMap::new();

    if !endpoint_ids.is_empty() {
        let placeholders = generate_safe_sql_placeholders(endpoint_ids.len());
        let sql = format!(
            "SELECT * FROM ai_endpoint_capabilities
             WHERE endpoint_id IN ({})
             ORDER BY capability ASC, priority ASC, created_at DESC",
            placeholders
        );
        let mut query = sqlx::query_as::<_, AiEndpointCapability>(&sql);
        for endpoint_id in &endpoint_ids {
            query = query.bind(endpoint_id);
        }
        let capabilities = query.fetch_all(pool).await?;
        for capability in capabilities {
            grouped
                .entry(capability.endpoint_id.clone())
                .or_default()
                .push(capability.into());
        }
    }

    Ok(endpoints
        .into_iter()
        .map(|endpoint| {
            let capabilities = grouped.remove(&endpoint.id).unwrap_or_default();
            let mut view = AiEndpointView::from(endpoint);
            view.capabilities = capabilities;
            view
        })
        .collect())
}

async fn load_capabilities_for_endpoint(
    pool: &SqlitePool,
    endpoint_id: &str,
) -> AppResult<Vec<AiEndpointCapability>> {
    Ok(sqlx::query_as::<_, AiEndpointCapability>(
        "SELECT * FROM ai_endpoint_capabilities
         WHERE endpoint_id = ?
         ORDER BY capability ASC, priority ASC, created_at DESC",
    )
    .bind(endpoint_id)
    .fetch_all(pool)
    .await?)
}

pub async fn list_agents(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
) -> AppResult<Json<Vec<AgentContact>>> {
    let agents = load_agent_contacts(&state.db, &state.ai_runtime, &user_id.0).await?;
    Ok(Json(agents))
}

pub async fn list_project_agents(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Vec<AgentContact>>> {
    ensure_project_access(&state.db, &user_id.0, &project_id).await?;
    let roster = load_project_agent_contacts(
        &state.db,
        &state.ai_runtime,
        &user_id.0,
        std::slice::from_ref(&project_id),
    )
    .await?;

    Ok(Json(roster.get(&project_id).cloned().unwrap_or_default()))
}

pub async fn create_agent(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<CreateAgentReq>,
) -> AppResult<(StatusCode, Json<Agent>)> {
    if req.name.trim().is_empty() {
        return Err(AppError::Validation("Agent name cannot be empty".into()));
    }
    validate_agent_endpoint_access(&state.db, &user_id.0, req.endpoint_id.as_deref()).await?;

    let id = Uuid::new_v4().to_string();
    let agent = match sqlx::query_as::<_, Agent>(
        "INSERT INTO agents (
             id, user_id, name, role, description, system_prompt, endpoint_id, model,
             temperature, max_tokens, badge
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&id)
    .bind(&user_id.0)
    .bind(req.name.trim())
    .bind(req.role.trim())
    .bind(req.description.as_deref().unwrap_or("").trim())
    .bind(req.system_prompt.trim())
    .bind(req.endpoint_id.as_deref().map(str::trim))
    .bind(req.model.as_deref().map(str::trim))
    .bind(req.temperature.unwrap_or(0.7))
    .bind(req.max_tokens.unwrap_or(4096))
    .bind(req.badge.as_deref().unwrap_or("").trim())
    .fetch_one(&state.db)
    .await
    {
        Ok(agent) => agent,
        Err(sqlx::Error::Database(db_error)) if db_error.is_unique_violation() => {
            return Err(AppError::Conflict("智能体名称已存在".into()));
        }
        Err(error) => return Err(error.into()),
    };

    Ok((StatusCode::CREATED, Json(agent)))
}

pub async fn create_project_agent(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateProjectAgentReq>,
) -> AppResult<(StatusCode, Json<AgentContact>)> {
    ensure_project_access(&state.db, &user_id.0, &project_id).await?;
    if req.name.trim().is_empty() {
        return Err(AppError::Validation("Agent name cannot be empty".into()));
    }
    validate_agent_endpoint_access(&state.db, &user_id.0, req.endpoint_id.as_deref()).await?;

    let id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    let agent = match sqlx::query_as::<_, Agent>(
        "INSERT INTO agents (
             id, user_id, name, role, description, system_prompt, endpoint_id, model,
             temperature, max_tokens, badge
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&id)
    .bind(&user_id.0)
    .bind(req.name.trim())
    .bind(req.role.trim())
    .bind(req.description.as_deref().unwrap_or("").trim())
    .bind(req.system_prompt.trim())
    .bind(req.endpoint_id.as_deref().map(str::trim))
    .bind(req.model.as_deref().map(str::trim))
    .bind(req.temperature.unwrap_or(0.7))
    .bind(req.max_tokens.unwrap_or(4096))
    .bind(req.badge.as_deref().unwrap_or("").trim())
    .fetch_one(&mut *tx)
    .await
    {
        Ok(agent) => agent,
        Err(sqlx::Error::Database(db_error)) if db_error.is_unique_violation() => {
            return Err(AppError::Conflict("智能体名称已存在".into()));
        }
        Err(error) => return Err(error.into()),
    };

    upsert_project_agent_assignment_tx(
        &mut tx,
        &user_id.0,
        &project_id,
        &agent.id,
        req.responsibility_kind.as_deref(),
        req.responsibility_label.as_deref(),
        "created",
    )
    .await?;

    tx.commit().await?;

    let roster = load_project_agent_contacts(
        &state.db,
        &state.ai_runtime,
        &user_id.0,
        std::slice::from_ref(&project_id),
    )
    .await?;
    let created = roster
        .get(&project_id)
        .and_then(|items| items.iter().find(|item| item.id == agent.id).cloned())
        .ok_or_else(|| AppError::Internal("项目智能体创建后未能回读".into()))?;

    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn assign_project_agent(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<AssignProjectAgentReq>,
) -> AppResult<Json<Vec<AgentContact>>> {
    ensure_project_access(&state.db, &user_id.0, &project_id).await?;
    ensure_agent_access(&state.db, &user_id.0, &req.agent_id).await?;

    upsert_project_agent_assignment(
        &state.db,
        &user_id.0,
        &project_id,
        &req.agent_id,
        req.responsibility_kind.as_deref(),
        req.responsibility_label.as_deref(),
        "existing",
    )
    .await?;

    let roster = load_project_agent_contacts(
        &state.db,
        &state.ai_runtime,
        &user_id.0,
        std::slice::from_ref(&project_id),
    )
    .await?;

    Ok(Json(roster.get(&project_id).cloned().unwrap_or_default()))
}

pub async fn update_agent(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAgentReq>,
) -> AppResult<Json<Agent>> {
    if req.name.trim().is_empty() {
        return Err(AppError::Validation("Agent name cannot be empty".into()));
    }
    validate_agent_endpoint_access(&state.db, &user_id.0, req.endpoint_id.as_deref()).await?;

    let agent = match sqlx::query_as::<_, Agent>(
        "UPDATE agents
         SET name = ?, role = ?, description = ?, system_prompt = ?, endpoint_id = ?, model = ?, temperature = ?, max_tokens = ?, badge = ?
         WHERE id = ? AND user_id = ? AND is_active = 1
         RETURNING *",
    )
    .bind(req.name.trim())
    .bind(req.role.trim())
    .bind(req.description.as_deref().unwrap_or("").trim())
    .bind(req.system_prompt.trim())
    .bind(req.endpoint_id.as_deref().map(str::trim))
    .bind(req.model.as_deref().map(str::trim))
    .bind(req.temperature.unwrap_or(0.7))
    .bind(req.max_tokens.unwrap_or(4096))
    .bind(req.badge.as_deref().unwrap_or("").trim())
    .bind(&id)
    .bind(&user_id.0)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(agent)) => agent,
        Ok(None) => return Err(AppError::NotFound("Agent not found".into())),
        Err(sqlx::Error::Database(db_error)) if db_error.is_unique_violation() => {
            return Err(AppError::Conflict("智能体名称已存在".into()));
        }
        Err(error) => return Err(error.into()),
    };

    Ok(Json(agent))
}

pub async fn delete_agent(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    sqlx::query("UPDATE agents SET is_active = 0 WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user_id.0)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_project_agent(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, agent_id)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    ensure_project_access(&state.db, &user_id.0, &project_id).await?;

    sqlx::query(
        "UPDATE project_agent_assignments
         SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE user_id = ? AND project_id = ? AND agent_id = ?",
    )
    .bind(&user_id.0)
    .bind(&project_id)
    .bind(&agent_id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn load_agent_contacts(
    pool: &SqlitePool,
    runtime: &AiTaskRuntime,
    user_id: &str,
) -> AppResult<Vec<AgentContact>> {
    crate::db::ensure_default_agents_for_user(pool, user_id).await?;
    let rows = sqlx::query_as::<_, AgentWithUsage>(
        "SELECT
             a.id, a.name, a.role, a.system_prompt, a.badge,
             a.description, a.endpoint_id, a.model, a.temperature, a.max_tokens,
             COALESCE(m.work_count, 0) AS work_count
         FROM agents a
         LEFT JOIN (
             SELECT m.agent_id, COUNT(*) AS work_count
             FROM messages m
             INNER JOIN conversations c ON c.id = m.conversation_id
             WHERE m.agent_id IS NOT NULL AND c.user_id = ?
             GROUP BY m.agent_id
         ) m ON m.agent_id = a.id
         WHERE a.user_id = ? AND a.is_active = 1
         ORDER BY a.name",
    )
    .bind(user_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let runtime_stats = runtime.agent_runtime_stats(user_id).await;

    Ok(rows
        .into_iter()
        .map(|row| {
            let stats = runtime_stats.get(&row.id).cloned().unwrap_or_default();
            AgentContact {
                id: row.id,
                name: row.name,
                role: row.role,
                work_count: row.work_count,
                pass_rate: default_pass_rate(&row.badge),
                badge: row.badge,
                system_prompt: row.system_prompt,
                description: row.description,
                endpoint_id: row.endpoint_id,
                model: row.model,
                temperature: row.temperature,
                max_tokens: row.max_tokens,
                status: AiTaskRuntime::derive_state(&stats),
                active_tasks: stats.active_tasks,
                queued_tasks: stats.queued_tasks,
                project_id: None,
                assignment_id: None,
                responsibility_kind: None,
                responsibility_label: None,
                assignment_source: None,
            }
        })
        .collect())
}

pub async fn load_project_agent_contacts(
    pool: &SqlitePool,
    runtime: &AiTaskRuntime,
    user_id: &str,
    project_ids: &[String],
) -> AppResult<HashMap<String, Vec<AgentContact>>> {
    if project_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = generate_safe_sql_placeholders(project_ids.len());
    let sql = format!(
        "SELECT
             pa.id AS assignment_id,
             pa.project_id,
             pa.responsibility_kind,
             pa.responsibility_label,
             pa.assignment_source,
             a.id, a.name, a.role, a.system_prompt, a.badge,
             a.description, a.endpoint_id, a.model, a.temperature, a.max_tokens,
             COALESCE(m.work_count, 0) AS work_count
         FROM project_agent_assignments pa
         INNER JOIN agents a
             ON a.id = pa.agent_id
            AND a.user_id = pa.user_id
            AND a.is_active = 1
         LEFT JOIN (
             SELECT m.agent_id, COUNT(*) AS work_count
             FROM messages m
             INNER JOIN conversations c ON c.id = m.conversation_id
             WHERE m.agent_id IS NOT NULL AND c.user_id = ?
             GROUP BY m.agent_id
         ) m ON m.agent_id = a.id
         WHERE pa.user_id = ?
           AND pa.is_active = 1
           AND pa.project_id IN ({})
         ORDER BY pa.project_id ASC, pa.created_at ASC, a.name ASC",
        placeholders
    );

    let mut query = sqlx::query_as::<_, ProjectAgentWithUsage>(&sql)
        .bind(user_id)
        .bind(user_id);
    for project_id in project_ids {
        query = query.bind(project_id);
    }

    let rows = query.fetch_all(pool).await?;
    let runtime_stats = runtime.agent_runtime_stats(user_id).await;
    let mut rosters = HashMap::<String, Vec<AgentContact>>::new();

    for row in rows {
        let stats = runtime_stats.get(&row.id).cloned().unwrap_or_default();
        rosters
            .entry(row.project_id.clone())
            .or_default()
            .push(AgentContact {
                id: row.id,
                name: row.name,
                role: row.role,
                work_count: row.work_count,
                pass_rate: default_pass_rate(&row.badge),
                badge: row.badge,
                system_prompt: row.system_prompt,
                description: row.description,
                endpoint_id: row.endpoint_id,
                model: row.model,
                temperature: row.temperature,
                max_tokens: row.max_tokens,
                status: AiTaskRuntime::derive_state(&stats),
                active_tasks: stats.active_tasks,
                queued_tasks: stats.queued_tasks,
                project_id: Some(row.project_id),
                assignment_id: Some(row.assignment_id),
                responsibility_kind: Some(row.responsibility_kind),
                responsibility_label: normalize_optional(Some(row.responsibility_label)),
                assignment_source: Some(row.assignment_source),
            });
    }

    Ok(rosters)
}

pub fn build_project_role_counts(roster: &[AgentContact]) -> ProjectRoleCounts {
    let mut counts = ProjectRoleCounts::default();

    for agent in roster {
        match responsibility_kind_for_agent(agent) {
            "design" => counts.design += 1,
            "review" => counts.review += 1,
            "editor" => counts.editor += 1,
            "manager" => counts.manager += 1,
            _ => counts.custom += 1,
        }
    }

    counts
}

pub fn build_project_workflow_summary(
    status: &str,
    phase: &str,
    asset_count: i64,
    script_ready: bool,
    storyboard_line_count: i64,
    conversation_count: i64,
    message_count: i64,
    assigned_agent_count: i64,
    task_counts: RuntimeProjectTaskCounts,
    role_counts: ProjectRoleCounts,
) -> ProjectWorkflowSummary {
    ProjectWorkflowSummary {
        status: status.to_string(),
        phase: phase.to_string(),
        progress_percent: phase_progress_percent(phase),
        asset_count,
        script_ready,
        storyboard_ready: storyboard_line_count > 0,
        storyboard_line_count,
        conversation_count,
        message_count,
        assigned_agent_count,
        queued_task_count: task_counts.queued,
        running_task_count: task_counts.running,
        completed_task_count: task_counts.completed,
        failed_task_count: task_counts.failed,
        role_counts,
    }
}
