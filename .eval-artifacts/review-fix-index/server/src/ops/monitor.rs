use std::{process, time::Duration};

use chrono::{SecondsFormat, Utc};
use serde_json::json;
use sqlx::{FromRow, SqlitePool};
use tokio::time::{interval, MissedTickBehavior};
use uuid::Uuid;

use crate::{ai::runtime::RuntimeTaskSnapshot, AppState};

use super::{dispatcher, model::FailureWindowSnapshot};

const MIN_FAILURE_SAMPLE: i64 = 5;
const WARNING_FAILURE_RATIO: f64 = 0.35;
const CRITICAL_FAILURE_RATIO: f64 = 0.60;
const SQLITE_ON_CONFLICT_MISSING_UNIQUE: &str =
    "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint";

#[derive(Debug, FromRow)]
struct FailureWindowRow {
    request_count: i64,
    failure_count: i64,
}

#[derive(Debug, Clone, Copy)]
enum FindingChangeAction {
    Opened,
    Escalated,
    Resolved,
}

#[derive(Debug, Clone, FromRow)]
struct ExistingFindingRow {
    id: String,
    severity: String,
    status: String,
    occurrence_count: i64,
}

#[derive(Debug, Clone)]
struct FindingSyncResult {
    finding_id: String,
    finding_key: String,
    category: String,
    severity: Option<String>,
    status: String,
    scope_type: String,
    scope_id: Option<String>,
    summary: String,
    details: serde_json::Value,
    occurrence_count: i64,
    action: FindingChangeAction,
}

pub fn start_background_workers(state: AppState) {
    tokio::spawn(run_heartbeat_loop(state.clone()));
    tokio::spawn(run_inspection_loop(state));
}

pub async fn load_failure_window(
    pool: &SqlitePool,
    window_minutes: i64,
) -> Result<FailureWindowSnapshot, sqlx::Error> {
    let from_ts = (Utc::now() - chrono::Duration::minutes(window_minutes.max(1)))
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let row = sqlx::query_as::<_, FailureWindowRow>(
        "SELECT
             COUNT(*) AS request_count,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count
         FROM ai_usage_events
         WHERE created_at >= ?",
    )
    .bind(from_ts)
    .fetch_one(pool)
    .await?;

    let failure_rate = if row.request_count <= 0 {
        0.0
    } else {
        row.failure_count as f64 / row.request_count as f64
    };

    Ok(FailureWindowSnapshot {
        window_minutes: window_minutes.max(1),
        request_count: row.request_count,
        failure_count: row.failure_count,
        failure_rate,
    })
}

async fn run_heartbeat_loop(state: AppState) {
    let mut ticker = interval(Duration::from_secs(
        state.config.ops_heartbeat_interval_secs.max(5),
    ));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        if let Err(error) = record_heartbeats(&state).await {
            tracing::warn!("Failed to record runtime heartbeat: {}", error);
        }
    }
}

async fn run_inspection_loop(state: AppState) {
    let mut ticker = interval(Duration::from_secs(
        state.config.ops_inspection_interval_secs.max(10),
    ));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        if let Err(error) = run_inspection_once(&state).await {
            tracing::warn!("Failed to run inspection loop: {}", error);
        }
    }
}

async fn record_heartbeats(state: &AppState) -> Result<(), sqlx::Error> {
    let snapshot = state.ai_runtime.global_snapshot().await;
    let uptime_ms = Utc::now()
        .timestamp_millis()
        .saturating_sub(state.started_at);

    upsert_runtime_heartbeat(
        &state.db,
        "server",
        "service",
        "healthy",
        &format!(
            "服务正常运行，监听 {}:{}，运行 {} 秒。",
            state.config.host,
            state.config.port,
            uptime_ms / 1000
        ),
        json!({
            "pid": process::id(),
            "host": state.config.host,
            "port": state.config.port,
            "startedAt": state.started_at,
            "uptimeMs": uptime_ms,
            "maxConcurrentTasks": state.config.ai_max_concurrent_tasks,
        }),
    )
    .await?;

    let runtime_status = derive_runtime_status(&snapshot, state.config.ops_stale_task_after_secs);
    upsert_runtime_heartbeat(
        &state.db,
        "ai-runtime",
        "runtime",
        runtime_status,
        &format!(
            "任务池状态：运行中 {}，排队 {}，累计完成 {}，累计失败 {}。",
            snapshot.running_tasks,
            snapshot.queued_tasks,
            snapshot.completed_tasks,
            snapshot.failed_tasks
        ),
        serde_json::to_value(&snapshot).unwrap_or_else(|_| json!({})),
    )
    .await?;

    Ok(())
}

async fn run_inspection_once(state: &AppState) -> Result<(), sqlx::Error> {
    let snapshot = state.ai_runtime.global_snapshot().await;
    let failure_window =
        load_failure_window(&state.db, state.config.ops_failure_window_minutes).await?;

    let warning_backlog = (state.config.ai_max_concurrent_tasks as i64 * 2).max(10);
    let critical_backlog = (state.config.ai_max_concurrent_tasks as i64 * 4).max(20);
    let stale_ms = (state.config.ops_stale_task_after_secs.max(60) * 1000) as i64;
    let stale_queue_ms = (stale_ms / 2).max(60_000);

    let queue_severity = if snapshot.queued_tasks >= critical_backlog {
        Some("critical")
    } else if snapshot.queued_tasks >= warning_backlog {
        Some("warning")
    } else {
        None
    };
    if let Some(change) = sync_finding(
        &state.db,
        "runtime.queue_backlog",
        queue_severity,
        "runtime",
        "service",
        None,
        &format!(
            "任务排队堆积：当前排队 {}，建议检查 worker 吞吐或上游模型可用性。",
            snapshot.queued_tasks
        ),
        json!({
            "queuedTasks": snapshot.queued_tasks,
            "warningThreshold": warning_backlog,
            "criticalThreshold": critical_backlog,
            "maxConcurrentTasks": state.config.ai_max_concurrent_tasks,
        }),
    )
    .await?
    {
        emit_finding_notifications(&state.db, change).await?;
    }

    let stale_running_severity = match snapshot.oldest_running_age_ms {
        Some(age) if age >= stale_ms * 2 => Some("critical"),
        Some(age) if age >= stale_ms => Some("warning"),
        _ => None,
    };
    if let Some(change) = sync_finding(
        &state.db,
        "runtime.stale_running",
        stale_running_severity,
        "runtime",
        "service",
        None,
        &format!(
            "存在运行超时任务：最老运行任务已持续 {} 秒。",
            snapshot.oldest_running_age_ms.unwrap_or_default() / 1000
        ),
        json!({
            "oldestRunningAgeMs": snapshot.oldest_running_age_ms,
            "runningTasks": snapshot.running_tasks,
            "staleAfterMs": stale_ms,
        }),
    )
    .await?
    {
        emit_finding_notifications(&state.db, change).await?;
    }

    let stale_queue_severity = match snapshot.oldest_queued_age_ms {
        Some(age) if age >= stale_ms => Some("critical"),
        Some(age) if age >= stale_queue_ms => Some("warning"),
        _ => None,
    };
    if let Some(change) = sync_finding(
        &state.db,
        "runtime.stale_queue",
        stale_queue_severity,
        "runtime",
        "service",
        None,
        &format!(
            "存在长时间未开跑任务：最老排队任务已等待 {} 秒。",
            snapshot.oldest_queued_age_ms.unwrap_or_default() / 1000
        ),
        json!({
            "oldestQueuedAgeMs": snapshot.oldest_queued_age_ms,
            "queuedTasks": snapshot.queued_tasks,
            "warningAfterMs": stale_queue_ms,
            "criticalAfterMs": stale_ms,
        }),
    )
    .await?
    {
        emit_finding_notifications(&state.db, change).await?;
    }

    let failure_severity = if failure_window.request_count >= MIN_FAILURE_SAMPLE
        && failure_window.failure_rate >= CRITICAL_FAILURE_RATIO
    {
        Some("critical")
    } else if failure_window.request_count >= MIN_FAILURE_SAMPLE
        && failure_window.failure_rate >= WARNING_FAILURE_RATIO
    {
        Some("warning")
    } else {
        None
    };
    if let Some(change) = sync_finding(
        &state.db,
        "usage.high_failure_rate",
        failure_severity,
        "usage",
        "service",
        None,
        &format!(
            "最近 {} 分钟失败率偏高：{} / {}。",
            failure_window.window_minutes,
            failure_window.failure_count,
            failure_window.request_count
        ),
        json!({
            "windowMinutes": failure_window.window_minutes,
            "requestCount": failure_window.request_count,
            "failureCount": failure_window.failure_count,
            "failureRate": failure_window.failure_rate,
            "warningRatio": WARNING_FAILURE_RATIO,
            "criticalRatio": CRITICAL_FAILURE_RATIO,
        }),
    )
    .await?
    {
        emit_finding_notifications(&state.db, change).await?;
    }

    let inspector_status = derive_inspector_status(
        queue_severity,
        stale_running_severity,
        stale_queue_severity,
        failure_severity,
    );
    upsert_runtime_heartbeat(
        &state.db,
        "inspector",
        "inspector",
        inspector_status,
        &format!(
            "巡检完成：运行中 {}，排队 {}，最近 {} 分钟失败率 {:.0}%。",
            snapshot.running_tasks,
            snapshot.queued_tasks,
            failure_window.window_minutes,
            failure_window.failure_rate * 100.0
        ),
        json!({
            "taskSnapshot": snapshot,
            "recentFailures": failure_window,
        }),
    )
    .await?;

    Ok(())
}

fn derive_runtime_status(snapshot: &RuntimeTaskSnapshot, stale_after_secs: u64) -> &'static str {
    let stale_ms = (stale_after_secs.max(60) * 1000) as i64;
    match snapshot.oldest_running_age_ms {
        Some(age) if age >= stale_ms => "warning",
        _ => "healthy",
    }
}

fn derive_inspector_status(
    queue_severity: Option<&str>,
    stale_running_severity: Option<&str>,
    stale_queue_severity: Option<&str>,
    failure_severity: Option<&str>,
) -> &'static str {
    let severities = [
        queue_severity,
        stale_running_severity,
        stale_queue_severity,
        failure_severity,
    ];

    if severities
        .into_iter()
        .flatten()
        .any(|value| value == "critical")
    {
        "critical"
    } else if severities
        .into_iter()
        .flatten()
        .any(|value| value == "warning")
    {
        "warning"
    } else {
        "healthy"
    }
}

async fn upsert_runtime_heartbeat(
    pool: &SqlitePool,
    component_key: &str,
    component_type: &str,
    status: &str,
    summary: &str,
    metrics: serde_json::Value,
) -> Result<(), sqlx::Error> {
    let execute_upsert = || {
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
    };

    if let Err(error) = execute_upsert().await {
        if !is_on_conflict_missing_unique_constraint(&error) {
            return Err(error);
        }

        tracing::warn!(
            "runtime_heartbeats 缺少 conflict 目标索引，尝试自动修复后重试: {}",
            error
        );
        repair_runtime_heartbeat_conflict_target(pool).await?;
        execute_upsert().await?;
    }

    Ok(())
}

fn is_on_conflict_missing_unique_constraint(error: &sqlx::Error) -> bool {
    error
        .to_string()
        .contains(SQLITE_ON_CONFLICT_MISSING_UNIQUE)
}

async fn repair_runtime_heartbeat_conflict_target(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM runtime_heartbeats
         WHERE rowid NOT IN (
            SELECT MAX(rowid)
            FROM runtime_heartbeats
            GROUP BY component_key
         )",
    )
    .execute(pool)
    .await?;

    sqlx::query("DROP INDEX IF EXISTS idx_runtime_heartbeats_component_key")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_heartbeats_component_key
         ON runtime_heartbeats(component_key)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn sync_finding(
    pool: &SqlitePool,
    finding_key: &str,
    severity: Option<&str>,
    category: &str,
    scope_type: &str,
    scope_id: Option<&str>,
    summary: &str,
    details: serde_json::Value,
) -> Result<Option<FindingSyncResult>, sqlx::Error> {
    let existing = sqlx::query_as::<_, ExistingFindingRow>(
        "SELECT id, severity, status, occurrence_count
         FROM inspection_findings
         WHERE finding_key = ?",
    )
    .bind(finding_key)
    .fetch_optional(pool)
    .await?;

    match (severity, existing) {
        (Some(level), Some(current)) => {
            let next_occurrence = current.occurrence_count + 1;
            sqlx::query(
                "UPDATE inspection_findings
                 SET category = ?,
                     severity = ?,
                     status = 'open',
                     scope_type = ?,
                     scope_id = ?,
                     summary = ?,
                     details_json = ?,
                     occurrence_count = ?,
                     last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                     resolved_at = NULL
                 WHERE id = ?",
            )
            .bind(category)
            .bind(level)
            .bind(scope_type)
            .bind(scope_id)
            .bind(summary)
            .bind(details.to_string())
            .bind(next_occurrence)
            .bind(&current.id)
            .execute(pool)
            .await?;

            let action = if current.status != "open" {
                Some(FindingChangeAction::Opened)
            } else if current.severity != level {
                Some(FindingChangeAction::Escalated)
            } else {
                None
            };

            Ok(action.map(|action| FindingSyncResult {
                finding_id: current.id,
                finding_key: finding_key.to_string(),
                category: category.to_string(),
                severity: Some(level.to_string()),
                status: "open".into(),
                scope_type: scope_type.to_string(),
                scope_id: scope_id.map(str::to_string),
                summary: summary.to_string(),
                details,
                occurrence_count: next_occurrence,
                action,
            }))
        }
        (Some(level), None) => {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO inspection_findings (
                     id, finding_key, user_id, category, severity, status, scope_type, scope_id,
                     summary, details_json, occurrence_count, first_seen_at, last_seen_at, resolved_at
                 )
                 VALUES (?, ?, NULL, ?, ?, 'open', ?, ?, ?, ?, 1,
                         strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                         strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                         NULL)",
            )
            .bind(&id)
            .bind(finding_key)
            .bind(category)
            .bind(level)
            .bind(scope_type)
            .bind(scope_id)
            .bind(summary)
            .bind(details.to_string())
            .execute(pool)
            .await?;

            Ok(Some(FindingSyncResult {
                finding_id: id,
                finding_key: finding_key.to_string(),
                category: category.to_string(),
                severity: Some(level.to_string()),
                status: "open".into(),
                scope_type: scope_type.to_string(),
                scope_id: scope_id.map(str::to_string),
                summary: summary.to_string(),
                details,
                occurrence_count: 1,
                action: FindingChangeAction::Opened,
            }))
        }
        (None, Some(current)) if current.status != "resolved" => {
            sqlx::query(
                "UPDATE inspection_findings
                 SET status = 'resolved',
                     last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                     resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                 WHERE id = ?",
            )
            .bind(&current.id)
            .execute(pool)
            .await?;

            Ok(Some(FindingSyncResult {
                finding_id: current.id,
                finding_key: finding_key.to_string(),
                category: category.to_string(),
                severity: Some(current.severity),
                status: "resolved".into(),
                scope_type: scope_type.to_string(),
                scope_id: scope_id.map(str::to_string),
                summary: summary.to_string(),
                details,
                occurrence_count: current.occurrence_count,
                action: FindingChangeAction::Resolved,
            }))
        }
        _ => Ok(None),
    }
}

async fn emit_finding_notifications(
    pool: &SqlitePool,
    change: FindingSyncResult,
) -> Result<(), sqlx::Error> {
    let (event_type, title) = match change.action {
        FindingChangeAction::Opened => ("finding_opened", "巡检告警"),
        FindingChangeAction::Escalated => ("finding_escalated", "巡检升级告警"),
        FindingChangeAction::Resolved => ("finding_resolved", "巡检恢复通知"),
    };
    let severity = change.severity.clone().unwrap_or_else(|| "info".into());
    let text = format!(
        "{}\n级别: {}\n状态: {}\n检查项: {}\n摘要: {}\n次数: {}",
        title, severity, change.status, change.finding_key, change.summary, change.occurrence_count
    );

    let payload = json!({
        "title": title,
        "text": text,
        "summary": change.summary,
        "severity": change.severity,
        "status": change.status,
        "findingKey": change.finding_key,
        "category": change.category,
        "scopeType": change.scope_type,
        "scopeId": change.scope_id,
        "details": change.details,
        "occurrenceCount": change.occurrence_count,
        "generatedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
    });

    dispatcher::enqueue_finding_notifications(
        pool,
        &dispatcher::FindingNotificationEvent {
            finding_id: change.finding_id,
            finding_key: payload["findingKey"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            event_type,
            severity: payload["severity"].as_str().map(str::to_string),
            payload,
        },
    )
    .await?;

    Ok(())
}
