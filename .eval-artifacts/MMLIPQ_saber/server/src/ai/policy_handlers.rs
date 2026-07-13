use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{SecondsFormat, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    pipeline::model::AssistantActionAudit,
    AppState,
};

use super::policy::*;

/**
 * 获取当前用户的助理动作策略配置
 * GET /api/ai/policy
 */
pub async fn get_action_policy(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
) -> AppResult<Json<AssistantActionPolicy>> {
    match sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT policy_json, expires_at FROM user_ai_policies WHERE user_id = ?",
    )
    .bind(&user_id.0)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some((policy_str, expires_at))) => {
            if let Some(exp) = &expires_at {
                if let Ok(exp_time) = chrono::DateTime::parse_from_rfc3339(exp) {
                    if Utc::now() > exp_time {
                        return Ok(Json(AssistantActionPolicy::default()));
                    }
                }
            }

            let policy: AssistantActionPolicy =
                serde_json::from_str(&policy_str).unwrap_or_default();
            Ok(Json(policy))
        }
        Ok(None) => Ok(Json(AssistantActionPolicy::default())),
        Err(e) => {
            tracing::warn!("查询用户策略失败，返回默认策略: {}", e);
            Ok(Json(AssistantActionPolicy::default()))
        }
    }
}

/**
 * 更新助理动作策略配置
 * PUT /api/ai/policy
 */
pub async fn update_action_policy(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<AssistantActionPolicy>,
) -> AppResult<Json<AssistantActionPolicy>> {
    validate_policy(&req)?;

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let policy_str = serde_json::to_string(&req)
        .map_err(|e| AppError::Internal(format!("策略序列化失败: {}", e)))?;

    sqlx::query(
        "INSERT INTO user_ai_policies (user_id, policy_json, expires_at, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           policy_json = excluded.policy_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at",
    )
    .bind(&user_id.0)
    .bind(&policy_str)
    .bind(req.expires_at.as_deref())
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    Ok(Json(req))
}

/**
 * 创建确认令牌（一次性）
 * POST /api/ai/action-audits/{id}/confirm-token
 */
pub async fn create_confirmation_token(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(audit_id): Path<String>,
) -> AppResult<(StatusCode, Json<ConfirmationToken>)> {
    let audit = get_audit_by_id(&state.db, &user_id.0, &audit_id).await?;

    if audit.execution_status != "pending" {
        return Err(AppError::Validation(
            format!("审计记录状态不允许创建令牌: {}", audit.execution_status).into(),
        ));
    }

    if audit.confirmation_token.is_some() {
        let expired = audit
            .confirmation_expires_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| Utc::now() > value.with_timezone(&Utc))
            .unwrap_or(false);
        if !expired {
            return Err(AppError::Validation("该审计记录已存在确认令牌".into()));
        }
    }

    let token = format!("ct-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    let token_hash = sha256_hash(&token);
    let now = Utc::now();
    let expires_at = now + chrono::Duration::minutes(10);

    let confirm_token = ConfirmationToken {
        token: token.clone(),
        user_id: user_id.0.clone(),
        project_id: audit.project_id.clone(),
        conversation_id: audit.conversation_id.clone(),
        message_id: audit.message_id.clone(),
        envelope_hash: audit.envelope_hash.clone(),
        created_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
        expires_at: expires_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        consumed: false,
        consumed_at: None,
        consumed_by: None,
    };

    sqlx::query(
        "UPDATE assistant_action_audits
         SET confirmation_token = ?, confirmation_expires_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ?",
    )
    .bind(&token_hash)
    .bind(confirm_token.expires_at.as_str())
    .bind(confirm_token.created_at.as_str())
    .bind(&audit_id)
    .bind(&user_id.0)
    .execute(&state.db)
    .await?;

    log_audit_event(
        &state.db,
        &audit_id,
        "token_created",
        &json!({ "tokenId": short_hash_prefix(&token_hash) }),
        &user_id.0,
    )
    .await?;

    Ok((StatusCode::CREATED, Json(confirm_token)))
}

/**
 * 使用确认令牌（执行或拒绝动作）
 * POST /api/ai/action-audits/consume-token
 */
pub async fn consume_confirmation_token(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<ConsumeConfirmationTokenReq>,
) -> AppResult<Json<serde_json::Value>> {
    let token_hash = sha256_hash(&req.token);

    let audit = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT id, execution_status, confirmation_token, envelope_hash, confirmation_expires_at
         FROM assistant_action_audits 
         WHERE confirmation_token = ? AND user_id = ?",
    )
    .bind(&token_hash)
    .bind(&user_id.0)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("确认令牌无效或不存在".into()))?;

    let (audit_id, status, stored_token_hash, _envelope_hash, confirmation_expires_at) = audit;

    if status != "pending" {
        return Err(AppError::Validation(
            format!("审计记录已处理，当前状态: {}", status).into(),
        ));
    }

    let now_dt = Utc::now();
    if let Some(expiry) = confirmation_expires_at.as_deref() {
        if let Ok(expiry_time) = chrono::DateTime::parse_from_rfc3339(expiry) {
            if now_dt > expiry_time.with_timezone(&Utc) {
                let now = now_dt.to_rfc3339_opts(SecondsFormat::Secs, true);
                sqlx::query(
                    "UPDATE assistant_action_audits
                     SET execution_status = 'expired', error_message = '确认令牌已过期',
                         confirmation_token = NULL, confirmation_expires_at = NULL, updated_at = ?
                     WHERE id = ?",
                )
                .bind(&now)
                .bind(&audit_id)
                .execute(&state.db)
                .await?;

                log_audit_event(
                    &state.db,
                    &audit_id,
                    "token_expired",
                    &json!({}),
                    &user_id.0,
                )
                .await?;
                return Err(AppError::Validation(
                    "确认令牌已过期，请重新发起确认".into(),
                ));
            }
        }
    }

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

    if req.approved {
        sqlx::query(
            "UPDATE assistant_action_audits
             SET execution_status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ?,
                 confirmation_token = NULL, confirmation_expires_at = NULL
             WHERE id = ? AND confirmation_token = ?",
        )
        .bind(&user_id.0)
        .bind(&now)
        .bind(&now)
        .bind(&audit_id)
        .bind(&stored_token_hash)
        .execute(&state.db)
        .await?;

        log_audit_event(
            &state.db,
            &audit_id,
            "confirmed",
            &json!({ "reason": req.reason }),
            &user_id.0,
        )
        .await?;
    } else {
        sqlx::query(
            "UPDATE assistant_action_audits
             SET execution_status = 'rejected', confirmed_by = ?, confirmed_at = ?, error_message = ?, updated_at = ?,
                 confirmation_token = NULL, confirmation_expires_at = NULL
             WHERE id = ? AND confirmation_token = ?"
        )
        .bind(&user_id.0)
        .bind(&now)
        .bind(req.reason.clone().unwrap_or_else(|| "用户拒绝".to_string()))
        .bind(&now)
        .bind(&audit_id)
        .bind(&stored_token_hash)
        .execute(&state.db)
        .await?;

        log_audit_event(
            &state.db,
            &audit_id,
            "rejected",
            &json!({ "reason": req.reason }),
            &user_id.0,
        )
        .await?;
    }

    Ok(Json(json!({
        "auditId": audit_id,
        "approved": req.approved,
        "processedAt": now,
    })))
}

/**
 * 查询助理动作审计日志
 * GET /api/ai/action-audits
 */
pub async fn list_action_audits(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(filter): Query<AuditLogFilter>,
) -> AppResult<Json<Vec<AssistantActionAudit>>> {
    let limit = filter.limit.unwrap_or(50).clamp(1, 200);
    let offset = filter.offset.unwrap_or(0);

    let mut conditions = vec!["user_id = ?".to_string()];
    let mut values: Vec<String> = vec![user_id.0.clone()];

    if let Some(project_id) = &filter.project_id {
        conditions.push("project_id = ?".to_string());
        values.push(project_id.clone());
    }
    if let Some(action_type) = &filter.action_type {
        conditions.push("action_type = ?".to_string());
        values.push(action_type.clone());
    }
    if let Some(status) = &filter.execution_status {
        conditions.push("execution_status = ?".to_string());
        values.push(status.clone());
    }
    if let Some(since) = &filter.since {
        conditions.push("created_at >= ?".to_string());
        values.push(since.clone());
    }
    if let Some(until) = &filter.until {
        conditions.push("created_at <= ?".to_string());
        values.push(until.clone());
    }

    let where_clause = conditions.join(" AND ");
    let query = format!(
        "SELECT * FROM assistant_action_audits WHERE {} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        where_clause
    );

    let mut q = sqlx::query_as::<_, AssistantActionAudit>(&query);
    for v in &values {
        q = q.bind(v);
    }
    q = q.bind(limit).bind(offset);

    let audits = q.fetch_all(&state.db).await?;

    Ok(Json(audits))
}

/**
 * 校验策略配置的合法性
 */
fn validate_policy(policy: &AssistantActionPolicy) -> AppResult<()> {
    if policy.max_actions_per_response == 0 {
        return Err(AppError::Validation(
            "maxActionsPerResponse 必须大于 0".into(),
        ));
    }
    if policy.max_actions_per_response > 20 {
        return Err(AppError::Validation(
            "maxActionsPerResponse 不能超过 20".into(),
        ));
    }

    let valid_types = [
        "assign_existing_agent",
        "create_project_agent",
        "remove_project_agent",
        "search_project_files",
        "create_project_directory",
        "create_project_file",
        "delete_project_path",
        "move_project_path",
    ];

    for action_type in &policy.allowed_action_types {
        if !valid_types.contains(&action_type.as_str()) {
            return Err(AppError::Validation(
                format!("不支持的动作类型: {}", action_type).into(),
            ));
        }
    }

    for action_type in &policy.require_confirmation_for {
        if !valid_types.contains(&action_type.as_str()) {
            return Err(AppError::Validation(
                format!("不支持的确认要求类型: {}", action_type).into(),
            ));
        }
    }

    if let Some(ref exp) = policy.expires_at {
        let parsed = chrono::DateTime::parse_from_rfc3339(exp);
        if parsed.is_err() {
            return Err(AppError::Validation(
                "expiresAt 格式无效，请使用 ISO 8601 格式".into(),
            ));
        }
        if let Ok(exp_time) = parsed {
            if Utc::now() > exp_time {
                return Err(AppError::Validation("策略过期时间不能是过去的时间".into()));
            }
        }
    }

    Ok(())
}

/**
 * 获取审计记录并验证用户权限
 */
async fn get_audit_by_id(
    pool: &sqlx::SqlitePool,
    user_id: &str,
    audit_id: &str,
) -> AppResult<AssistantActionAudit> {
    let result: Option<AssistantActionAudit> = sqlx::query_as::<_, AssistantActionAudit>(
        "SELECT * FROM assistant_action_audits WHERE id = ? AND user_id = ?",
    )
    .bind(audit_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    result.ok_or_else(|| AppError::NotFound("审计记录不存在或无权访问".into()))
}

/**
 * 记录审计事件
 */
async fn log_audit_event(
    pool: &sqlx::SqlitePool,
    audit_id: &str,
    event: &str,
    payload: &serde_json::Value,
    _user_id: &str,
) -> AppResult<()> {
    let event_id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO assistant_action_audit_events (id, audit_id, event_type, payload_json, source)
         VALUES (?, ?, ?, ?, 'user')",
    )
    .bind(&event_id)
    .bind(audit_id)
    .bind(event)
    .bind(&payload.to_string())
    .execute(pool)
    .await?;

    Ok(())
}

/**
 * 简单的 SHA-256 哈希（用于令牌存储）
 */
fn sha256_hash(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn short_hash_prefix(value: &str) -> String {
    value.chars().take(16).collect()
}
