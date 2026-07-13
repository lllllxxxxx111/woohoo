use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{SecondsFormat, Utc};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    AppState,
};

use super::{
    dispatcher,
    model::{
        CreateNotificationChannelReq, InspectionFinding, InspectionFindingRow, NotificationChannel,
        NotificationChannelRow, NotificationEvent, NotificationEventRow,
        NotificationSupportSummary, OpsListQuery, OpsOverview, RuntimeHeartbeat,
        RuntimeHeartbeatRow, TestNotificationReq, TestNotificationResult,
        UpdateNotificationChannelReq,
    },
    monitor,
};

#[derive(Debug, FromRow)]
struct NotificationSummaryRow {
    configured_channels: i64,
    enabled_channels: i64,
    queued_events: i64,
    failed_events: i64,
}

pub async fn overview(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
) -> AppResult<Json<OpsOverview>> {
    let heartbeats = load_heartbeats(&state.db, 20).await?;
    let active_findings = load_findings(&state.db, &user_id.0, false, 50).await?;
    let task_snapshot = state.ai_runtime.global_snapshot().await;
    let recent_failures =
        monitor::load_failure_window(&state.db, state.config.ops_failure_window_minutes).await?;
    let notification_summary = load_notification_summary(&state.db, &user_id.0).await?;

    Ok(Json(OpsOverview {
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        heartbeats,
        active_findings,
        task_snapshot,
        recent_failures,
        notification_summary,
    }))
}

pub async fn list_heartbeats(
    State(state): State<AppState>,
    Query(query): Query<OpsListQuery>,
) -> AppResult<Json<Vec<RuntimeHeartbeat>>> {
    let items = load_heartbeats(&state.db, query.limit.unwrap_or(20).clamp(1, 100) as i64).await?;
    Ok(Json(items))
}

pub async fn list_findings(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<OpsListQuery>,
) -> AppResult<Json<Vec<InspectionFinding>>> {
    let items = load_findings(
        &state.db,
        &user_id.0,
        query.include_resolved.unwrap_or(false),
        query.limit.unwrap_or(50).clamp(1, 200) as i64,
    )
    .await?;
    Ok(Json(items))
}

pub async fn list_notification_channels(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
) -> AppResult<Json<Vec<NotificationChannel>>> {
    let rows = sqlx::query_as::<_, NotificationChannelRow>(
        "SELECT id, user_id, name, channel_type, target, config_json, is_enabled, created_at, updated_at
         FROM notification_channels
         WHERE user_id = ?
         ORDER BY updated_at DESC, created_at DESC",
    )
    .bind(&user_id.0)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

pub async fn list_notification_events(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<OpsListQuery>,
) -> AppResult<Json<Vec<NotificationEvent>>> {
    let rows = sqlx::query_as::<_, NotificationEventRow>(
        "SELECT
             id, user_id, channel_id, finding_id, event_type, status, dedupe_key, attempt_count,
             last_error, next_attempt_at, payload_json, response_body, created_at, updated_at, sent_at
         FROM notification_events
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?",
    )
    .bind(&user_id.0)
    .bind(query.limit.unwrap_or(50).clamp(1, 200) as i64)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

pub async fn test_notification_channel(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<TestNotificationReq>,
) -> AppResult<Json<TestNotificationResult>> {
    validate_notification_channel("test-channel", &req.channel_type, &req.target)?;
    let channel_type = normalize_channel_type(&req.channel_type)?.to_string();
    let title = req
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Woohoo 巡检测试通知");
    let message = req
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("这是一条测试通知，说明当前通知链路已经打通。");
    let event = dispatcher::send_test_notification(
        &state,
        &user_id.0,
        &channel_type,
        req.target.trim(),
        req.config,
        title,
        message,
    )
    .await?;

    Ok(Json(TestNotificationResult {
        status: event.status.clone(),
        channel_type,
        response_body: event.response_body.clone(),
        event,
    }))
}

pub async fn create_notification_channel(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<CreateNotificationChannelReq>,
) -> AppResult<(StatusCode, Json<NotificationChannel>)> {
    validate_notification_channel(&req.name, &req.channel_type, &req.target)?;

    let channel = sqlx::query_as::<_, NotificationChannelRow>(
        "INSERT INTO notification_channels (
             id, user_id, name, channel_type, target, config_json, is_enabled
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, user_id, name, channel_type, target, config_json, is_enabled, created_at, updated_at",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&user_id.0)
    .bind(req.name.trim())
    .bind(normalize_channel_type(&req.channel_type)?)
    .bind(req.target.trim())
    .bind(req.config.as_ref().map(|value| value.to_string()))
    .bind(req.is_enabled.unwrap_or(true))
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(channel.into())))
}

pub async fn update_notification_channel(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<UpdateNotificationChannelReq>,
) -> AppResult<Json<NotificationChannel>> {
    validate_notification_channel(&req.name, &req.channel_type, &req.target)?;

    let channel = sqlx::query_as::<_, NotificationChannelRow>(
        "UPDATE notification_channels
         SET name = ?, channel_type = ?, target = ?, config_json = ?, is_enabled = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND user_id = ?
         RETURNING id, user_id, name, channel_type, target, config_json, is_enabled, created_at, updated_at",
    )
    .bind(req.name.trim())
    .bind(normalize_channel_type(&req.channel_type)?)
    .bind(req.target.trim())
    .bind(req.config.as_ref().map(|value| value.to_string()))
    .bind(req.is_enabled)
    .bind(&id)
    .bind(&user_id.0)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("通知通道不存在".into()))?;

    Ok(Json(channel.into()))
}

pub async fn delete_notification_channel(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM notification_channels WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user_id.0)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn load_heartbeats(
    pool: &SqlitePool,
    limit: i64,
) -> Result<Vec<RuntimeHeartbeat>, sqlx::Error> {
    let rows = sqlx::query_as::<_, RuntimeHeartbeatRow>(
        "SELECT component_key, component_type, status, summary, metrics_json, last_seen_at, updated_at
         FROM runtime_heartbeats
         ORDER BY
           CASE status
             WHEN 'critical' THEN 0
             WHEN 'warning' THEN 1
             ELSE 2
           END,
           last_seen_at DESC
         LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(Into::into).collect())
}

async fn load_findings(
    pool: &SqlitePool,
    user_id: &str,
    include_resolved: bool,
    limit: i64,
) -> Result<Vec<InspectionFinding>, sqlx::Error> {
    let rows = sqlx::query_as::<_, InspectionFindingRow>(
        "SELECT
             id, finding_key, user_id, category, severity, status, scope_type, scope_id,
             summary, details_json, occurrence_count, first_seen_at, last_seen_at, resolved_at
         FROM inspection_findings
         WHERE (user_id IS NULL OR user_id = ?)
           AND (? = 1 OR status != 'resolved')
         ORDER BY
           CASE severity
             WHEN 'critical' THEN 0
             WHEN 'warning' THEN 1
             ELSE 2
           END,
           CASE status
             WHEN 'open' THEN 0
             ELSE 1
           END,
           last_seen_at DESC
         LIMIT ?",
    )
    .bind(user_id)
    .bind(if include_resolved { 1 } else { 0 })
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(Into::into).collect())
}

async fn load_notification_summary(
    pool: &SqlitePool,
    user_id: &str,
) -> Result<NotificationSupportSummary, sqlx::Error> {
    let row = sqlx::query_as::<_, NotificationSummaryRow>(
        "SELECT
             (SELECT COUNT(*) FROM notification_channels WHERE user_id = ?) AS configured_channels,
             (SELECT COUNT(*) FROM notification_channels WHERE user_id = ? AND is_enabled = 1) AS enabled_channels,
             (SELECT COUNT(*) FROM notification_events WHERE user_id = ? AND status = 'queued') AS queued_events,
             (SELECT COUNT(*) FROM notification_events WHERE user_id = ? AND status = 'failed') AS failed_events",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(user_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok(NotificationSupportSummary {
        configured_channels: row.configured_channels,
        enabled_channels: row.enabled_channels,
        queued_events: row.queued_events,
        failed_events: row.failed_events,
    })
}

fn validate_notification_channel(name: &str, channel_type: &str, target: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::Validation("通知通道名称不能为空".into()));
    }
    if target.trim().is_empty() {
        return Err(AppError::Validation("通知目标不能为空".into()));
    }
    let _ = normalize_channel_type(channel_type)?;
    Ok(())
}

fn normalize_channel_type(value: &str) -> AppResult<&str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "email" => Ok("email"),
        "webhook" => Ok("webhook"),
        "feishu" => Ok("feishu"),
        "dingtalk" => Ok("dingtalk"),
        "wecom" => Ok("wecom"),
        "slack" => Ok("slack"),
        "telegram" => Ok("telegram"),
        "other" => Ok("other"),
        other => Err(AppError::Validation(format!(
            "不支持的通知通道类型: {}",
            other
        ))),
    }
}
