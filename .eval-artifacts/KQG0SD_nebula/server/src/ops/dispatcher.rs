use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use reqwest::Client;
use serde_json::{json, Value};
use sqlx::sqlite::SqliteQueryResult;
use sqlx::{FromRow, SqlitePool};
use tokio::time::{interval, MissedTickBehavior};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    AppState,
};

use super::model::{NotificationEvent, NotificationEventRow};

const MAX_BATCH_SIZE: i64 = 20;
const SQLITE_ON_CONFLICT_MISSING_UNIQUE: &str =
    "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint";

#[derive(Debug, FromRow)]
struct PendingNotificationRow {
    id: String,
    attempt_count: i64,
    payload_json: Option<String>,
    channel_type: Option<String>,
    target: Option<String>,
    config_json: Option<String>,
    is_enabled: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct FindingNotificationEvent {
    pub finding_id: String,
    pub finding_key: String,
    pub event_type: &'static str,
    pub severity: Option<String>,
    pub payload: Value,
}

#[derive(Debug)]
enum DeliveryErrorKind {
    Retryable,
    Permanent,
}

#[derive(Debug)]
struct DeliveryError {
    kind: DeliveryErrorKind,
    message: String,
}

impl DeliveryError {
    fn retryable(message: impl Into<String>) -> Self {
        Self {
            kind: DeliveryErrorKind::Retryable,
            message: message.into(),
        }
    }

    fn permanent(message: impl Into<String>) -> Self {
        Self {
            kind: DeliveryErrorKind::Permanent,
            message: message.into(),
        }
    }
}

pub fn start_dispatcher_worker(state: AppState) {
    tokio::spawn(run_dispatcher_loop(state));
}

pub async fn enqueue_finding_notifications(
    pool: &SqlitePool,
    finding: &FindingNotificationEvent,
) -> Result<i64, sqlx::Error> {
    let channels = sqlx::query_as::<_, EnabledChannelRow>(
        "SELECT id, user_id FROM notification_channels WHERE is_enabled = 1",
    )
    .fetch_all(pool)
    .await?;

    let mut created = 0_i64;
    for channel in channels {
        let dedupe_key = build_finding_dedupe_key(
            &channel.id,
            &finding.finding_key,
            finding.event_type,
            finding.severity.as_deref(),
        );

        let result = match insert_finding_notification_event(
            pool,
            &channel.user_id,
            &channel.id,
            &finding.finding_id,
            finding.event_type,
            &dedupe_key,
            finding.payload.to_string(),
        )
        .await
        {
            Ok(result) => result,
            Err(error) if is_on_conflict_missing_unique_constraint(&error) => {
                tracing::warn!(
                    "notification_events 缺少 dedupe conflict 目标索引，尝试自动修复后重试: {}",
                    error
                );
                repair_notification_event_dedupe_conflict_target(pool).await?;
                insert_finding_notification_event(
                    pool,
                    &channel.user_id,
                    &channel.id,
                    &finding.finding_id,
                    finding.event_type,
                    &dedupe_key,
                    finding.payload.to_string(),
                )
                .await?
            }
            Err(error) => return Err(error),
        };

        created += result.rows_affected() as i64;
    }

    Ok(created)
}

async fn insert_finding_notification_event(
    pool: &SqlitePool,
    user_id: &str,
    channel_id: &str,
    finding_id: &str,
    event_type: &str,
    dedupe_key: &str,
    payload_json: String,
) -> Result<SqliteQueryResult, sqlx::Error> {
    sqlx::query(
        "INSERT INTO notification_events (
             id, user_id, channel_id, finding_id, event_type, status, dedupe_key,
             attempt_count, payload_json, next_attempt_at, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, NULL,
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(dedupe_key) WHERE dedupe_key != '' DO NOTHING",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(user_id)
    .bind(channel_id)
    .bind(finding_id)
    .bind(event_type)
    .bind(dedupe_key)
    .bind(payload_json)
    .execute(pool)
    .await
}

fn is_on_conflict_missing_unique_constraint(error: &sqlx::Error) -> bool {
    error
        .to_string()
        .contains(SQLITE_ON_CONFLICT_MISSING_UNIQUE)
}

async fn repair_notification_event_dedupe_conflict_target(
    pool: &SqlitePool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM notification_events
         WHERE dedupe_key != ''
           AND rowid NOT IN (
             SELECT MAX(rowid)
             FROM notification_events
             WHERE dedupe_key != ''
             GROUP BY dedupe_key
           )",
    )
    .execute(pool)
    .await?;

    sqlx::query("DROP INDEX IF EXISTS idx_notification_events_dedupe")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedupe
         ON notification_events(dedupe_key) WHERE dedupe_key != ''",
    )
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn send_test_notification(
    state: &AppState,
    user_id: &str,
    channel_type: &str,
    target: &str,
    config: Option<Value>,
    title: &str,
    message: &str,
) -> AppResult<NotificationEvent> {
    let now = now_iso();
    let payload = json!({
        "title": title,
        "text": message,
        "sentAt": now,
    });
    let event_id = Uuid::new_v4().to_string();
    let client = build_http_client(state.config.ops_notification_timeout_secs)?;
    let response =
        deliver_notification(&client, channel_type, target, config.as_ref(), &payload).await;

    let (status, response_body, last_error, sent_at, attempt_count) = match response {
        Ok(body) => ("sent", Some(body), None, Some(now.clone()), 1_i64),
        Err(error) => ("failed", None, Some(error.message), None, 1_i64),
    };

    let row = sqlx::query_as::<_, NotificationEventRow>(
        "INSERT INTO notification_events (
             id, user_id, channel_id, finding_id, event_type, status, dedupe_key,
             attempt_count, last_error, payload_json, response_body, created_at, updated_at, sent_at
         )
         VALUES (?, ?, NULL, NULL, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING
             id, user_id, channel_id, finding_id, event_type, status, dedupe_key, attempt_count,
             last_error, next_attempt_at, payload_json, response_body, created_at, updated_at, sent_at",
    )
    .bind(&event_id)
    .bind(user_id)
    .bind(status)
    .bind(format!("test:{}:{}", channel_type.trim().to_ascii_lowercase(), event_id))
    .bind(attempt_count)
    .bind(last_error)
    .bind(payload.to_string())
    .bind(response_body)
    .bind(&now)
    .bind(&now)
    .bind(sent_at)
    .fetch_one(&state.db)
    .await?;

    Ok(row.into())
}

async fn run_dispatcher_loop(state: AppState) {
    let mut ticker = interval(Duration::from_secs(
        state.config.ops_notification_interval_secs.max(5),
    ));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let client = match build_http_client(state.config.ops_notification_timeout_secs) {
        Ok(client) => client,
        Err(error) => {
            tracing::error!("Failed to build notification HTTP client: {}", error);
            return;
        }
    };

    loop {
        ticker.tick().await;
        match dispatch_pending_once(&state, &client).await {
            Ok(processed) => {
                if let Err(error) = record_notifier_heartbeat(&state, processed).await {
                    tracing::warn!("Failed to record notifier heartbeat: {}", error);
                }
            }
            Err(error) => {
                tracing::warn!("Failed to dispatch notification batch: {}", error);
                if let Err(heartbeat_error) =
                    record_notifier_failure_heartbeat(&state, &error.to_string()).await
                {
                    tracing::warn!(
                        "Failed to record notifier failure heartbeat: {}",
                        heartbeat_error
                    );
                }
            }
        }
    }
}

async fn dispatch_pending_once(state: &AppState, client: &Client) -> anyhow::Result<usize> {
    let now = now_iso();
    let events = sqlx::query_as::<_, PendingNotificationRow>(
        "SELECT
             e.id, e.attempt_count, e.payload_json,
             c.channel_type, c.target, c.config_json, c.is_enabled
         FROM notification_events e
         LEFT JOIN notification_channels c ON c.id = e.channel_id
         WHERE e.status = 'queued'
           AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ?)
         ORDER BY e.created_at ASC
         LIMIT ?",
    )
    .bind(&now)
    .bind(MAX_BATCH_SIZE)
    .fetch_all(&state.db)
    .await?;

    for event in &events {
        process_event(state, client, event).await?;
    }

    Ok(events.len())
}

async fn process_event(
    state: &AppState,
    client: &Client,
    event: &PendingNotificationRow,
) -> anyhow::Result<()> {
    let Some(channel_type) = event.channel_type.as_deref() else {
        mark_event_terminal(&state.db, &event.id, "failed", "通知通道不存在", None).await?;
        return Ok(());
    };
    let Some(target) = event.target.as_deref() else {
        mark_event_terminal(&state.db, &event.id, "failed", "通知目标不存在", None).await?;
        return Ok(());
    };
    if event.is_enabled == Some(false) {
        mark_event_terminal(&state.db, &event.id, "skipped", "通知通道已禁用", None).await?;
        return Ok(());
    }

    let payload = event
        .payload_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| json!({ "text": "系统通知" }));
    let config = event
        .config_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());

    match deliver_notification(client, channel_type, target, config.as_ref(), &payload).await {
        Ok(response_body) => {
            sqlx::query(
                "UPDATE notification_events
                 SET status = 'sent',
                     attempt_count = attempt_count + 1,
                     last_error = NULL,
                     response_body = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                     sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                     next_attempt_at = NULL
                 WHERE id = ?",
            )
            .bind(response_body)
            .bind(&event.id)
            .execute(&state.db)
            .await?;
        }
        Err(error) => {
            let next_attempt_count = event.attempt_count + 1;
            let reached_limit = next_attempt_count
                >= state.config.ops_notification_max_retries as i64
                || matches!(error.kind, DeliveryErrorKind::Permanent);
            if reached_limit {
                mark_event_terminal(&state.db, &event.id, "failed", &error.message, None).await?;
            } else {
                let delay_seconds = retry_delay_secs(next_attempt_count);
                let next_attempt_at = (Utc::now() + chrono::Duration::seconds(delay_seconds))
                    .to_rfc3339_opts(SecondsFormat::Secs, true);
                sqlx::query(
                    "UPDATE notification_events
                     SET attempt_count = ?,
                         last_error = ?,
                         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                         next_attempt_at = ?,
                         response_body = NULL
                     WHERE id = ?",
                )
                .bind(next_attempt_count)
                .bind(&error.message)
                .bind(next_attempt_at)
                .bind(&event.id)
                .execute(&state.db)
                .await?;
            }
        }
    }

    Ok(())
}

async fn mark_event_terminal(
    pool: &SqlitePool,
    event_id: &str,
    status: &str,
    last_error: &str,
    response_body: Option<String>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE notification_events
         SET status = ?,
             attempt_count = attempt_count + 1,
             last_error = ?,
             response_body = ?,
             next_attempt_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(status)
    .bind(last_error)
    .bind(response_body)
    .bind(event_id)
    .execute(pool)
    .await?;

    Ok(())
}

async fn record_notifier_heartbeat(state: &AppState, processed: usize) -> Result<(), sqlx::Error> {
    let (queued, failed) = load_notification_queue_counts(&state.db).await?;
    let status = if failed > 0 { "warning" } else { "healthy" };
    let summary = format!(
        "通知派发器运行正常：本轮处理 {} 条，待发送 {} 条，失败 {} 条。",
        processed, queued, failed
    );
    upsert_heartbeat(
        &state.db,
        "notifier",
        "dispatcher",
        status,
        &summary,
        json!({
            "processed": processed,
            "queuedEvents": queued,
            "failedEvents": failed,
        }),
    )
    .await
}

async fn record_notifier_failure_heartbeat(
    state: &AppState,
    error: &str,
) -> Result<(), sqlx::Error> {
    upsert_heartbeat(
        &state.db,
        "notifier",
        "dispatcher",
        "critical",
        "通知派发器执行失败，请检查网络连通性或通道配置。",
        json!({
            "lastError": error,
        }),
    )
    .await
}

async fn load_notification_queue_counts(pool: &SqlitePool) -> Result<(i64, i64), sqlx::Error> {
    let row = sqlx::query_as::<_, NotificationQueueCountRow>(
        "SELECT
             COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued_count,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count
         FROM notification_events",
    )
    .fetch_one(pool)
    .await?;
    Ok((row.queued_count, row.failed_count))
}

async fn upsert_heartbeat(
    pool: &SqlitePool,
    component_key: &str,
    component_type: &str,
    status: &str,
    summary: &str,
    metrics: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO runtime_heartbeats (
             component_key, component_type, status, summary, metrics_json, last_seen_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(component_key) DO UPDATE SET
             component_type = excluded.component_type,
             status = excluded.status,
             summary = excluded.summary,
             metrics_json = excluded.metrics_json,
             last_seen_at = excluded.last_seen_at,
             updated_at = excluded.updated_at",
    )
    .bind(component_key)
    .bind(component_type)
    .bind(status)
    .bind(summary)
    .bind(metrics.to_string())
    .execute(pool)
    .await?;

    Ok(())
}

async fn deliver_notification(
    client: &Client,
    channel_type: &str,
    target: &str,
    _config: Option<&Value>,
    payload: &Value,
) -> Result<String, DeliveryError> {
    let normalized = channel_type.trim().to_ascii_lowercase();
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| render_fallback_text(payload));

    let body = match normalized.as_str() {
        "feishu" => json!({
            "msg_type": "text",
            "content": {
                "text": text,
            }
        }),
        "dingtalk" => json!({
            "msgtype": "text",
            "text": {
                "content": text,
            }
        }),
        "wecom" => json!({
            "msgtype": "text",
            "text": {
                "content": text,
            }
        }),
        "slack" => json!({
            "text": text,
        }),
        "webhook" | "other" => payload.clone(),
        "email" => {
            return Err(DeliveryError::permanent(
                "email 通道尚未接入 SMTP/邮件服务派发器",
            ))
        }
        "telegram" => {
            return Err(DeliveryError::permanent(
                "telegram 通道需要专用 bot/sendMessage 配置，当前后端尚未接入",
            ))
        }
        other => {
            return Err(DeliveryError::permanent(format!(
                "不支持的通知通道类型: {}",
                other
            )))
        }
    };

    let response = client
        .post(target)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| DeliveryError::retryable(format!("通知请求失败: {}", error)))?;
    let status = response.status();
    let response_body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(DeliveryError::retryable(format!(
            "通知通道返回错误 {}: {}",
            status, response_body
        )));
    }

    Ok(response_body)
}

fn render_fallback_text(payload: &Value) -> String {
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("系统通知");
    let summary = payload
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("通知事件已触发");
    format!("{}\n{}", title, summary)
}

fn build_finding_dedupe_key(
    channel_id: &str,
    finding_key: &str,
    event_type: &str,
    severity: Option<&str>,
) -> String {
    match severity {
        Some(level) if !level.trim().is_empty() => {
            format!(
                "finding:{}:{}:{}:{}",
                finding_key, event_type, level, channel_id
            )
        }
        _ => format!("finding:{}:{}:{}", finding_key, event_type, channel_id),
    }
}

fn build_http_client(timeout_secs: u64) -> AppResult<Client> {
    Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(timeout_secs.max(5)))
        .build()
        .map_err(|error| AppError::Internal(format!("创建通知 HTTP 客户端失败: {}", error)))
}

fn retry_delay_secs(attempt_count: i64) -> i64 {
    match attempt_count {
        i if i <= 1 => 15,
        2 => 30,
        3 => 60,
        _ => 120,
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[derive(Debug, FromRow)]
struct EnabledChannelRow {
    id: String,
    user_id: String,
}

#[derive(Debug, FromRow)]
struct NotificationQueueCountRow {
    queued_count: i64,
    failed_count: i64,
}
