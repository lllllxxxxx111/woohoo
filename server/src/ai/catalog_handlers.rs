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
    config::{
        Agent, AgentContact, AiEndpoint, AiEndpointView, AssignProjectAgentReq, CreateAgentReq,
        CreateEndpointReq, CreateProjectAgentReq, ProjectRoleCounts, ProjectWorkflowSummary,
        UpdateAgentReq, UpdateEndpointReq,
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

    Ok(Json(endpoints.into_iter().map(Into::into).collect()))
}

pub async fn create_endpoint(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<CreateEndpointReq>,
) -> AppResult<(StatusCode, Json<AiEndpointView>)> {
    if req.name.trim().is_empty() {
        return Err(AppError::Validation("端点名称不能为空".into()));
    }
    validate_connection_fields(&req.provider, &req.base_url, &req.api_key)?;

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
    .bind(req.api_key.trim())
    .bind(req.default_model.as_deref().map(str::trim))
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(endpoint.into())))
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

    let next_api_key = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| existing.api_key.clone());

    validate_connection_fields(&req.provider, &req.base_url, &next_api_key)?;

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
    .bind(next_api_key)
    .bind(req.default_model.as_deref().map(str::trim))
    .bind(&id)
    .bind(&user_id.0)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("AI 端点不存在".into()))?;

    Ok(Json(endpoint.into()))
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
