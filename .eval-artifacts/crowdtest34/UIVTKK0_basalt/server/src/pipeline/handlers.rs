use axum::{
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    AppState,
};

use super::model::*;

/**
 * 查询参数：流程运行列表过滤
 */
#[derive(Debug, Deserialize)]
pub struct PipelineRunFilter {
    #[serde(alias = "projectId")]
    pub project_id: Option<String>,
    #[serde(alias = "conversationId")]
    pub conversation_id: Option<String>,
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/**
 * 创建新的流程运行（一键启动入口）
 * POST /api/pipelines/runs
 */
pub async fn create_pipeline_run(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<CreatePipelineRunReq>,
) -> AppResult<(StatusCode, Json<PipelineRun>)> {
    let (status, run) = create_pipeline_run_for_user(&state.db, &user_id.0, req, true).await?;
    Ok((status, Json(run)))
}

pub(crate) async fn create_pipeline_run_for_user(
    pool: &SqlitePool,
    user_id: &str,
    req: CreatePipelineRunReq,
    enforce_beta_gate: bool,
) -> AppResult<(StatusCode, PipelineRun)> {
    if enforce_beta_gate && !req.beta_enabled {
        return Err(AppError::Validation(
            "该流程为 Beta 功能，请先在设置中开启“多智能体自动编排（Beta）”".into(),
        ));
    }

    let idempotency_key = req
        .idempotency_key
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let existing = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM pipeline_runs WHERE user_id = ? AND idempotency_key = ? AND status IN ('queued', 'running', 'paused')"
    )
    .bind(user_id)
    .bind(&idempotency_key)
    .fetch_optional(pool)
    .await?;

    if let Some((existing_id,)) = existing {
        let run = get_run_by_id(pool, user_id, &existing_id).await?;
        return Ok((StatusCode::CONFLICT, run));
    }

    let run_id = Uuid::new_v4().to_string();
    let total_steps = req.steps.len() as i64;

    let run = sqlx::query_as::<_, PipelineRun>(
        "INSERT INTO pipeline_runs (
            id, user_id, project_id, conversation_id,
            pipeline_type, trigger_source, status,
            idempotency_key, total_steps, completed_steps, failed_steps
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, 0)
        RETURNING *",
    )
    .bind(&run_id)
    .bind(user_id)
    .bind(&req.project_id)
    .bind(&req.conversation_id)
    .bind(&req.pipeline_type)
    .bind(&req.trigger_source)
    .bind(&idempotency_key)
    .bind(total_steps)
    .fetch_one(pool)
    .await?;

    for step_req in &req.steps {
        let step_id = Uuid::new_v4().to_string();
        let step_type = normalize_step_type(&step_req.step_type);
        let depends_on_json =
            serde_json::to_string(&step_req.depends_on).unwrap_or_else(|_| "[]".to_string());
        let review_policy_json = step_req.review_policy.as_ref().map(ToString::to_string);
        let max_retries = step_req.max_retries.unwrap_or(3).clamp(0, 8);
        let input_summary = step_req
            .prompt_template
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        sqlx::query(
            "INSERT INTO pipeline_run_steps (
                id, run_id, step_key, step_name, step_order,
                step_type, depends_on_json, review_policy_json,
                max_retries, run_version, input_summary, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'queued')",
        )
        .bind(&step_id)
        .bind(&run_id)
        .bind(&step_req.step_key)
        .bind(&step_req.step_name)
        .bind(step_req.step_order)
        .bind(step_type)
        .bind(depends_on_json)
        .bind(review_policy_json)
        .bind(max_retries)
        .bind(input_summary)
        .execute(pool)
        .await?;

        log_pipeline_event(
            pool,
            &run_id,
            None,
            "step_queued",
            &serde_json::json!({
                "stepId": step_id,
                "stepKey": step_req.step_key,
                "stepName": step_req.step_name,
            }),
            "system",
        )
        .await?;
    }

    log_pipeline_event(
        pool,
        &run_id,
        None,
        "created",
        &serde_json::json!({
            "pipelineType": req.pipeline_type,
            "triggerSource": req.trigger_source,
            "betaEnabled": req.beta_enabled,
            "totalSteps": total_steps,
        }),
        "system",
    )
    .await?;

    Ok((StatusCode::CREATED, run))
}

/**
 * 获取流程运行详情（状态聚合）
 * GET /api/pipelines/runs/{id}
 */
pub async fn get_pipeline_run(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<PipelineRunSummary>> {
    let run = get_run_by_id(&state.db, &user_id.0, &id).await?;

    let steps = sqlx::query_as::<_, PipelineRunStep>(
        "SELECT * FROM pipeline_run_steps WHERE run_id = ? ORDER BY step_order",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;

    let events = sqlx::query_as::<_, PipelineRunEvent>(
        "SELECT * FROM pipeline_run_events WHERE run_id = ? ORDER BY created_at DESC LIMIT 20",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;

    let outputs = sqlx::query_as::<_, PipelineStepOutput>(
        "SELECT * FROM pipeline_step_outputs WHERE run_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;

    let reviews = sqlx::query_as::<_, PipelineManualReview>(
        "SELECT * FROM pipeline_manual_reviews WHERE run_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(PipelineRunSummary {
        run,
        steps,
        recent_events: events,
        outputs,
        reviews,
    }))
}

/**
 * 获取流程的 Prompt 优化建议（Beta）
 * GET /api/pipelines/runs/{id}/optimizations
 */
pub async fn list_pipeline_optimizations(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<PipelinePromptOptimization>>> {
    let _run = get_run_by_id(&state.db, &user_id.0, &id).await?;

    let rows = sqlx::query_as::<_, PipelinePromptOptimization>(
        "SELECT *
         FROM pipeline_prompt_optimizations
         WHERE run_id = ?
         ORDER BY created_at DESC
         LIMIT 50",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

/**
 * 获取用户的流程运行列表
 * GET /api/pipelines/runs
 */
pub async fn list_pipeline_runs(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(filter): Query<PipelineRunFilter>,
) -> AppResult<Json<Vec<PipelineRun>>> {
    let limit = filter.limit.unwrap_or(20).clamp(1, 100);
    let offset = filter.offset.unwrap_or(0);

    let mut conditions = vec!["user_id = ?".to_string()];
    let mut values: Vec<String> = vec![user_id.0.clone()];

    if let Some(project_id) = &filter.project_id {
        conditions.push("project_id = ?".to_string());
        values.push(project_id.clone());
    }
    if let Some(conversation_id) = &filter.conversation_id {
        conditions.push("conversation_id = ?".to_string());
        values.push(conversation_id.clone());
    }
    if let Some(status) = &filter.status {
        conditions.push("status = ?".to_string());
        values.push(status.clone());
    }

    let where_clause = conditions.join(" AND ");
    let query = format!(
        "SELECT * FROM pipeline_runs WHERE {} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
        where_clause
    );

    let mut q = sqlx::query_as::<_, PipelineRun>(&query);
    for v in &values {
        q = q.bind(v);
    }
    q = q.bind(limit).bind(offset);

    let runs = q.fetch_all(&state.db).await?;

    Ok(Json(runs))
}

/**
 * 暂停流程运行
 * POST /api/pipelines/runs/{id}/pause
 */
pub async fn pause_pipeline_run(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    req: Option<Json<PipelineControlReq>>,
) -> AppResult<Json<PipelineRun>> {
    let (updated, changed) = pause_pipeline_run_state(&state.db, &user_id.0, &id).await?;

    if changed {
        let reason = req.as_ref().and_then(|r| r.reason.as_deref()).unwrap_or("");
        log_pipeline_event(
            &state.db,
            &id,
            None,
            "paused",
            &serde_json::json!({ "reason": reason }),
            "user",
        )
        .await?;
    }

    Ok(Json(updated))
}

/**
 * 恢复流程运行
 * POST /api/pipelines/runs/{id}/resume
 */
pub async fn resume_pipeline_run(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<PipelineRun>> {
    let (updated, changed) = resume_pipeline_run_state(&state.db, &user_id.0, &id).await?;

    if changed {
        log_pipeline_event(
            &state.db,
            &id,
            None,
            "resumed",
            &serde_json::json!({}),
            "user",
        )
        .await?;
    }

    Ok(Json(updated))
}

/**
 * 取消流程运行
 * POST /api/pipelines/runs/{id}/cancel
 */
pub async fn cancel_pipeline_run(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    req: Option<Json<PipelineControlReq>>,
) -> AppResult<Json<PipelineRun>> {
    let (updated, changed) = cancel_pipeline_run_state(&state.db, &user_id.0, &id).await?;

    if changed {
        let reason = req.as_ref().and_then(|r| r.reason.as_deref()).unwrap_or("");
        log_pipeline_event(
            &state.db,
            &id,
            None,
            "cancelled",
            &serde_json::json!({ "reason": reason }),
            "user",
        )
        .await?;
    }

    Ok(Json(updated))
}

/**
 * 重试指定步骤
 * POST /api/pipelines/runs/{id}/retry-step
 */
pub async fn retry_pipeline_step(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<PipelineControlReq>,
) -> AppResult<Json<PipelineRunStep>> {
    let run = get_run_by_id(&state.db, &user_id.0, &id).await?;
    let retry_reason = req
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if !["running", "paused", "failed"].contains(&run.status.as_str()) {
        return Err(AppError::Validation(
            format!("当前状态不允许重试步骤: {}", run.status).into(),
        ));
    }

    let step_id = req
        .step_id
        .ok_or_else(|| AppError::Validation("必须指定要重试的步骤ID (stepId)".into()))?;

    let step = sqlx::query_as::<_, PipelineRunStep>(
        "SELECT * FROM pipeline_run_steps WHERE id = ? AND run_id = ?",
    )
    .bind(&step_id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("指定步骤不存在".into()))?;

    if !["failed", "blocked"].contains(&step.status.as_str()) {
        return Err(AppError::Validation(
            format!("步骤当前状态不允许重试: {}", step.status).into(),
        ));
    }

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let updated = sqlx::query_as::<_, PipelineRunStep>(
        "UPDATE pipeline_run_steps
         SET status = 'retrying',
             ai_task_id = NULL,
             completed_at = NULL,
             output_ref = NULL,
             error_message = NULL,
             last_error_at = NULL,
             run_version = COALESCE(run_version, 1) + 1,
             updated_at = ?
         WHERE id = ? AND run_id = ? RETURNING *",
    )
    .bind(&now)
    .bind(&step_id)
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

    if run.status == "failed" {
        sqlx::query(
            "UPDATE pipeline_runs
             SET status = 'running',
                 error_message = NULL,
                 error_code = NULL,
                 finished_at = NULL,
                 updated_at = ?
             WHERE id = ? AND user_id = ?",
        )
        .bind(&now)
        .bind(&id)
        .bind(&user_id.0)
        .execute(&state.db)
        .await?;

        log_pipeline_event(
            &state.db,
            &id,
            Some(&step_id),
            "resumed",
            &serde_json::json!({
                "reason": "manual_retry_step",
                "stepId": step_id,
                "stepName": step.step_name,
                "manualReviewNote": retry_reason.clone(),
            }),
            "user",
        )
        .await?;
    }

    log_pipeline_event(
        &state.db,
        &id,
        Some(&step_id),
        "step_retry",
        &serde_json::json!({
            "stepId": step_id,
            "stepName": step.step_name,
            "attemptCount": updated.attempt_count,
            "reason": retry_reason.clone(),
        }),
        "user",
    )
    .await?;

    Ok(Json(updated))
}

/**
 * 获取流程运行的SSE事件流
 * GET /api/pipelines/runs/{id}/stream
 * Supports Last-Event-ID header for resuming from a specific event (rowid).
 * Event IDs use format "pipe-{rowid}".
 */
pub async fn stream_pipeline_run(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<axum::response::Response> {
    let _run = get_run_by_id(&state.db, &user_id.0, &id).await?;

    let db = state.db.clone();
    let run_id = id.clone();

    // Parse Last-Event-ID to determine starting position
    let start_rowid: i64 = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("pipe-"))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);

    use axum::response::sse::{Event, KeepAlive, Sse};
    use std::convert::Infallible;

    let stream = async_stream::stream! {
        // Fetch existing events from after start_rowid immediately so fresh
        // subscribers don't wait 2 seconds for the first poll. This also
        // validates the cursor: if start_rowid is greater than the max rowid
        // for this run, we emit a resync_required + done and let the client
        // re-bootstrap via HTTP.
        let initial_events: Vec<(String, Option<String>, String, i64)> = match sqlx::query_as::<_, (String, Option<String>, String, i64)>(
            "SELECT event_type, payload_json, source, rowid
             FROM pipeline_run_events WHERE run_id = ? AND rowid > ?
             ORDER BY rowid ASC LIMIT 50"
        )
        .bind(&run_id)
        .bind(start_rowid)
        .fetch_all(&db)
        .await {
            Ok(events) => events,
            Err(e) => {
                tracing::debug!(error = %e, "pipeline stream initial poll error");
                Vec::new()
            }
        };

        // Detect future cursor: start_rowid > 0 but no events exist past it
        // AND max_rowid for the run is less than start_rowid.
        let max_rowid: Option<i64> = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(rowid), 0) FROM pipeline_run_events WHERE run_id = ?"
        )
        .bind(&run_id)
        .fetch_optional(&db)
        .await
        .ok()
        .flatten();

        let cursor_ahead = start_rowid > 0 && max_rowid.unwrap_or(0) < start_rowid;

        if cursor_ahead {
            yield Ok::<_, Infallible>(Event::default()
                .event("resync_required")
                .id(format!("pipe-{}", start_rowid))
                .data(serde_json::json!({
                    "reason": "cursor_ahead",
                    "message": "事件游标超前于当前数据，请重新拉取运行状态"
                }).to_string()));
            // Close the stream; client reconnects after HTTP resync which will
            // establish a fresh run snapshot.
            yield Ok(Event::default()
                .event("done")
                .id(format!("pipe-{}", max_rowid.unwrap_or(0)))
                .data(serde_json::json!({"reason": "resync"}).to_string()));
            return;
        }

        // Send connected snapshot; id uses GREATEST(start_rowid, max_rowid) so
        // reconnects after seeing all events don't re-deliver them.
        let snapshot_cursor = max_rowid.unwrap_or(start_rowid).max(start_rowid);
        yield Ok::<_, Infallible>(Event::default()
            .event("snapshot")
            .id(format!("pipe-{}", snapshot_cursor))
            .data(serde_json::json!({
                "status": "connected",
                "cursor": snapshot_cursor
            }).to_string()));

        // Flush initial events (if any) before entering the poll loop
        let mut last_event_id: i64 = snapshot_cursor;
        for (event_type, payload, source, rowid) in &initial_events {
            last_event_id = last_event_id.max(*rowid);
            let payload_str = payload.clone().unwrap_or_else(|| "{}".to_string());
            let data = serde_json::json!({
                "type": event_type,
                "payload": serde_json::from_str::<serde_json::Value>(&payload_str).unwrap_or(serde_json::Value::Null),
                "source": source,
                "rowid": rowid
            }).to_string();
            yield Ok(Event::default()
                .event(event_type)
                .id(format!("pipe-{}", rowid))
                .data(data));
        }

        let mut poll_count = 0i32;
        let max_polls: i32 = 300; // ~10 minutes at 2s interval

        while poll_count < max_polls {
            poll_count += 1;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            let events: Vec<(String, Option<String>, String, i64)> = match sqlx::query_as::<_, (String, Option<String>, String, i64)>(
                "SELECT event_type, payload_json, source, rowid
                 FROM pipeline_run_events WHERE run_id = ? AND rowid > ?
                 ORDER BY rowid ASC LIMIT 50"
            )
            .bind(&run_id)
            .bind(last_event_id)
            .fetch_all(&db)
            .await {
                Ok(events) => events,
                Err(e) => {
                    tracing::debug!(error = %e, "pipeline stream poll error");
                    continue;
                }
            };

            for (event_type, payload, source, rowid) in events {
                last_event_id = last_event_id.max(rowid);
                let payload_str = payload.unwrap_or_else(|| "{}".to_string());
                let data = serde_json::json!({
                    "type": event_type,
                    "payload": serde_json::from_str::<serde_json::Value>(&payload_str).unwrap_or(serde_json::Value::Null),
                    "source": source,
                    "rowid": rowid
                }).to_string();
                yield Ok(Event::default()
                    .event(&event_type)
                    .id(format!("pipe-{}", rowid))
                    .data(data));
            }

            // Check if run has reached terminal state
            if let Ok(Some((status,))) = sqlx::query_as::<_, (String,)>(
                "SELECT status FROM pipeline_runs WHERE id = ?"
            )
            .bind(&run_id)
            .fetch_optional(&db)
            .await {
                if matches!(status.as_str(), "completed" | "failed" | "cancelled" | "blocked") {
                    // Give a brief moment for any final events to flush
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                    // Final poll for any remaining events
                    if let Ok(events) = sqlx::query_as::<_, (String, Option<String>, String, i64)>(
                        "SELECT event_type, payload_json, source, rowid
                         FROM pipeline_run_events WHERE run_id = ? AND rowid > ?
                         ORDER BY rowid ASC LIMIT 50"
                    )
                    .bind(&run_id)
                    .bind(last_event_id)
                    .fetch_all(&db)
                    .await {
                        for (event_type, payload, source, rowid) in events {
                            last_event_id = last_event_id.max(rowid);
                            let payload_str = payload.unwrap_or_else(|| "{}".to_string());
                            let data = serde_json::json!({
                                "type": event_type,
                                "payload": serde_json::from_str::<serde_json::Value>(&payload_str).unwrap_or(serde_json::Value::Null),
                                "source": source,
                                "rowid": rowid
                            }).to_string();
                            yield Ok(Event::default()
                                .event(&event_type)
                                .id(format!("pipe-{}", rowid))
                                .data(data));
                        }
                    }

                    yield Ok(Event::default()
                        .event("done")
                        .id(format!("pipe-{}", last_event_id))
                        .data(serde_json::json!({
                            "reason": "terminal",
                            "status": status
                        }).to_string()));
                    break;
                }
            }
        }

        if poll_count >= max_polls {
            yield Ok(Event::default()
                .event("done")
                .id(format!("pipe-{}", last_event_id))
                .data(serde_json::json!({"reason": "timeout"}).to_string()));
        }
    };

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(30)))
        .into_response())
}

/**
 * 根据ID获取流程运行记录并验证用户权限
 */
async fn get_run_by_id(pool: &SqlitePool, user_id: &str, run_id: &str) -> AppResult<PipelineRun> {
    sqlx::query_as::<_, PipelineRun>("SELECT * FROM pipeline_runs WHERE id = ? AND user_id = ?")
        .bind(run_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("流程运行不存在或无权访问".into()))
}

async fn pause_pipeline_run_state(
    pool: &SqlitePool,
    user_id: &str,
    run_id: &str,
) -> AppResult<(PipelineRun, bool)> {
    transition_pipeline_run_status(
        pool,
        user_id,
        run_id,
        "paused",
        "暂停",
        &["queued", "running"],
        None,
    )
    .await
}

async fn resume_pipeline_run_state(
    pool: &SqlitePool,
    user_id: &str,
    run_id: &str,
) -> AppResult<(PipelineRun, bool)> {
    transition_pipeline_run_status(pool, user_id, run_id, "running", "恢复", &["paused"], None)
        .await
}

async fn cancel_pipeline_run_state(
    pool: &SqlitePool,
    user_id: &str,
    run_id: &str,
) -> AppResult<(PipelineRun, bool)> {
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    transition_pipeline_run_status(
        pool,
        user_id,
        run_id,
        "cancelled",
        "取消",
        &["queued", "running", "paused", "failed"],
        Some(now),
    )
    .await
}

async fn transition_pipeline_run_status(
    pool: &SqlitePool,
    user_id: &str,
    run_id: &str,
    next_status: &str,
    action_label: &str,
    allowed_current_statuses: &[&str],
    finished_at: Option<String>,
) -> AppResult<(PipelineRun, bool)> {
    let current = get_run_by_id(pool, user_id, run_id).await?;
    if current.status == next_status {
        return Ok((current, false));
    }

    if !allowed_current_statuses.contains(&current.status.as_str()) {
        return Err(AppError::Validation(
            format!("当前状态不允许{}: {}", action_label, current.status).into(),
        ));
    }

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let status_placeholders = vec!["?"; allowed_current_statuses.len()].join(", ");
    let query = format!(
        "UPDATE pipeline_runs
         SET status = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND status IN ({})
         RETURNING *",
        status_placeholders
    );

    let mut builder = sqlx::query_as::<_, PipelineRun>(&query)
        .bind(next_status)
        .bind(finished_at)
        .bind(&now)
        .bind(run_id)
        .bind(user_id);

    for status in allowed_current_statuses {
        builder = builder.bind(status);
    }

    if let Some(updated) = builder.fetch_optional(pool).await? {
        return Ok((updated, true));
    }

    let latest = get_run_by_id(pool, user_id, run_id).await?;
    if latest.status == next_status {
        return Ok((latest, false));
    }

    Err(AppError::Validation(
        format!("当前状态不允许{}: {}", action_label, latest.status).into(),
    ))
}

/**
 * 记录流程事件到审计日志
 */
async fn log_pipeline_event(
    pool: &SqlitePool,
    run_id: &str,
    step_id: Option<&str>,
    event_type: &str,
    payload: &serde_json::Value,
    source: &str,
) -> AppResult<()> {
    let event_id = Uuid::new_v4().to_string();
    let payload_str = payload.to_string();

    sqlx::query(
        "INSERT INTO pipeline_run_events (id, run_id, step_id, event_type, payload_json, source) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(&event_id)
    .bind(run_id)
    .bind(step_id)
    .bind(event_type)
    .bind(&payload_str)
    .bind(source)
    .execute(pool)
    .await?;

    Ok(())
}

fn normalize_step_type(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "design" => "design",
        "review" => "review",
        "system" => "system",
        _ => "design",
    }
}

pub async fn list_review_queue(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(filter): Query<ReviewQueueFilter>,
) -> AppResult<Json<ReviewQueueResponse>> {
    let limit = filter.limit.unwrap_or(20).clamp(1, 100);
    let offset = filter.offset.unwrap_or(0).max(0);

    let mut conditions = vec![
        "r.user_id = ?".to_string(),
        "(s.status IN ('failed', 'blocked') OR r.error_code = 'MANUAL_REVIEW_REQUIRED')"
            .to_string(),
    ];
    let mut values = vec![user_id.0.clone()];

    if let Some(project_id) = filter.project_id.as_deref().map(str::trim) {
        if !project_id.is_empty() {
            conditions.push("r.project_id = ?".to_string());
            values.push(project_id.to_string());
        }
    }

    if let Some(pipeline_type) = filter.pipeline_type.as_deref().map(str::trim) {
        if !pipeline_type.is_empty() {
            conditions.push("r.pipeline_type = ?".to_string());
            values.push(pipeline_type.to_string());
        }
    }

    if let Some(status) = filter.status.as_deref().map(str::trim) {
        if !status.is_empty() {
            conditions.push("s.status = ?".to_string());
            values.push(status.to_string());
        }
    }

    let where_clause = conditions.join(" AND ");
    let count_sql = format!(
        "SELECT COUNT(*)
         FROM pipeline_runs r
         INNER JOIN pipeline_run_steps s ON s.run_id = r.id
         WHERE {}",
        where_clause
    );
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for value in &values {
        count_query = count_query.bind(value);
    }
    let total = count_query.fetch_one(&state.db).await?;

    let steps_sql = format!(
        "SELECT s.id, s.run_id
         FROM pipeline_runs r
         INNER JOIN pipeline_run_steps s ON s.run_id = r.id
         WHERE {}
         ORDER BY s.updated_at DESC, r.created_at DESC
         LIMIT ? OFFSET ?",
        where_clause
    );
    let mut steps_query = sqlx::query_as::<_, (String, String)>(&steps_sql);
    for value in &values {
        steps_query = steps_query.bind(value);
    }
    let step_pairs = steps_query
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;

    let mut items = Vec::new();
    for (step_id, run_id) in step_pairs {
        let run = match get_run_by_id(&state.db, &user_id.0, &run_id).await {
            Ok(run) => run,
            Err(_) => continue,
        };

        let step = match sqlx::query_as::<_, PipelineRunStep>(
            "SELECT * FROM pipeline_run_steps WHERE id = ? AND run_id = ?",
        )
        .bind(&step_id)
        .bind(&run_id)
        .fetch_optional(&state.db)
        .await?
        {
            Some(step) => step,
            None => continue,
        };

        let project_name =
            sqlx::query_scalar::<_, String>("SELECT name FROM projects WHERE id = ?")
                .bind(&run.project_id)
                .fetch_optional(&state.db)
                .await?;

        let conversation_title =
            sqlx::query_scalar::<_, String>("SELECT title FROM conversations WHERE id = ?")
                .bind(&run.conversation_id)
                .fetch_optional(&state.db)
                .await?;

        let latest_event = sqlx::query_as::<_, PipelineRunEvent>(
            "SELECT *
             FROM pipeline_run_events
             WHERE run_id = ? AND step_id = ?
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(&run_id)
        .bind(&step_id)
        .fetch_optional(&state.db)
        .await?;

        let latest_error_event = sqlx::query_as::<_, PipelineRunEvent>(
            "SELECT *
             FROM pipeline_run_events
             WHERE run_id = ?
               AND step_id = ?
               AND event_type IN ('step_failed', 'failed')
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(&run_id)
        .bind(&step_id)
        .fetch_optional(&state.db)
        .await?;

        let optimization_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM pipeline_prompt_optimizations
             WHERE run_id = ? AND step_id = ?",
        )
        .bind(&run_id)
        .bind(&step_id)
        .fetch_one(&state.db)
        .await?;

        let review_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM pipeline_manual_reviews
             WHERE run_id = ? AND step_id = ?",
        )
        .bind(&run_id)
        .bind(&step_id)
        .fetch_one(&state.db)
        .await?;

        let latest_review = sqlx::query_as::<_, PipelineManualReview>(
            "SELECT *
             FROM pipeline_manual_reviews
             WHERE run_id = ? AND step_id = ?
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(&run_id)
        .bind(&step_id)
        .fetch_optional(&state.db)
        .await?;

        items.push(ReviewQueueItem {
            run,
            step,
            latest_event,
            latest_error_event,
            optimization_count,
            review_count,
            latest_review,
            project_name,
            conversation_title,
        });
    }

    Ok(Json(ReviewQueueResponse {
        items,
        total,
        limit,
        offset,
    }))
}

pub async fn submit_review_decision(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((run_id, step_id)): Path<(String, String)>,
    Json(req): Json<PipelineReviewDecisionReq>,
) -> AppResult<Json<serde_json::Value>> {
    let decision = req.decision.trim().to_ascii_lowercase();
    if !matches!(decision.as_str(), "retry" | "cancel" | "acknowledge") {
        return Err(AppError::Validation(
            "Unsupported review decision. Use retry, cancel, or acknowledge.".into(),
        ));
    }

    let note = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;
    let step = sqlx::query_as::<_, PipelineRunStep>(
        "SELECT * FROM pipeline_run_steps WHERE id = ? AND run_id = ?",
    )
    .bind(&step_id)
    .bind(&run_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Pipeline step not found".into()))?;

    match decision.as_str() {
        "retry" => {
            if !["failed", "blocked"].contains(&step.status.as_str()) {
                return Err(AppError::Validation(
                    format!("Step status '{}' cannot be retried.", step.status).into(),
                ));
            }
            if !["running", "paused", "failed"].contains(&run.status.as_str()) {
                return Err(AppError::Validation(
                    format!("Run status '{}' cannot retry a step.", run.status).into(),
                ));
            }
        }
        "cancel" => {
            if ["completed", "cancelled"].contains(&run.status.as_str()) {
                return Err(AppError::Validation(
                    format!("Run status '{}' cannot be cancelled.", run.status).into(),
                ));
            }
        }
        "acknowledge" => {}
        _ => unreachable!(),
    }

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let review_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO pipeline_manual_reviews (id, user_id, run_id, step_id, decision, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&review_id)
    .bind(&user_id.0)
    .bind(&run_id)
    .bind(&step_id)
    .bind(&decision)
    .bind(&note)
    .bind(&now)
    .execute(&state.db)
    .await?;

    let mut updated_run: Option<PipelineRun> = None;
    let mut updated_step: Option<PipelineRunStep> = None;

    match decision.as_str() {
        "retry" => {
            let step_update = sqlx::query_as::<_, PipelineRunStep>(
                "UPDATE pipeline_run_steps
                 SET status = 'retrying',
                     ai_task_id = NULL,
                     completed_at = NULL,
                     output_ref = NULL,
                     error_message = NULL,
                     last_error_at = NULL,
                     run_version = COALESCE(run_version, 1) + 1,
                     updated_at = ?
                 WHERE id = ? AND run_id = ?
                 RETURNING *",
            )
            .bind(&now)
            .bind(&step_id)
            .bind(&run_id)
            .fetch_one(&state.db)
            .await?;
            updated_step = Some(step_update);

            if run.status == "failed" {
                updated_run = sqlx::query_as::<_, PipelineRun>(
                    "UPDATE pipeline_runs
                     SET status = 'running',
                         error_message = NULL,
                         error_code = NULL,
                         finished_at = NULL,
                         updated_at = ?
                     WHERE id = ? AND user_id = ?
                     RETURNING *",
                )
                .bind(&now)
                .bind(&run_id)
                .bind(&user_id.0)
                .fetch_optional(&state.db)
                .await?;

                log_pipeline_event(
                    &state.db,
                    &run_id,
                    Some(&step_id),
                    "resumed",
                    &serde_json::json!({
                        "reason": "manual_review_retry",
                        "reviewId": review_id,
                        "note": note,
                    }),
                    "user",
                )
                .await?;
            }

            log_pipeline_event(
                &state.db,
                &run_id,
                Some(&step_id),
                "step_retry",
                &serde_json::json!({
                    "reviewId": review_id,
                    "stepId": step_id,
                    "stepName": step.step_name,
                    "reason": "manual_review_retry",
                    "note": note,
                }),
                "user",
            )
            .await?;
        }
        "cancel" => {
            let (run_update, changed) =
                cancel_pipeline_run_state(&state.db, &user_id.0, &run_id).await?;
            updated_run = Some(run_update);

            if changed {
                log_pipeline_event(
                    &state.db,
                    &run_id,
                    Some(&step_id),
                    "cancelled",
                    &serde_json::json!({
                        "reason": "manual_review_cancel",
                        "reviewId": review_id,
                        "stepId": step_id,
                        "stepName": step.step_name,
                        "note": note,
                    }),
                    "user",
                )
                .await?;
            }
        }
        "acknowledge" => {}
        _ => unreachable!(),
    }

    Ok(Json(serde_json::json!({
        "success": true,
        "reviewId": review_id,
        "decision": decision,
        "run": updated_run,
        "step": updated_step,
    })))
}

pub async fn list_step_reviews(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((run_id, step_id)): Path<(String, String)>,
) -> AppResult<Json<Vec<PipelineManualReview>>> {
    let _run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;

    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pipeline_run_steps WHERE id = ? AND run_id = ?",
    )
    .bind(&step_id)
    .bind(&run_id)
    .fetch_one(&state.db)
    .await?;

    if exists == 0 {
        return Err(AppError::NotFound("Pipeline step not found".into()));
    }

    let reviews = sqlx::query_as::<_, PipelineManualReview>(
        "SELECT *
         FROM pipeline_manual_reviews
         WHERE run_id = ? AND step_id = ?
         ORDER BY created_at DESC
         LIMIT 50",
    )
    .bind(&run_id)
    .bind(&step_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(reviews))
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_pipeline_run_state, pause_pipeline_run_state, resume_pipeline_run_state,
        PipelineRunFilter,
    };
    use crate::db::init_db;
    use crate::error::AppError;
    use axum::{extract::Query, http::Uri};
    use sqlx::SqlitePool;
    use uuid::Uuid;

    #[test]
    fn pipeline_run_filter_accepts_snake_case_project_id() {
        let uri: Uri = "/api/pipelines/runs?project_id=proj-1&status=running"
            .parse()
            .expect("valid test uri");
        let Query(filter) =
            Query::<PipelineRunFilter>::try_from_uri(&uri).expect("query should parse");

        assert_eq!(filter.project_id.as_deref(), Some("proj-1"));
        assert_eq!(filter.status.as_deref(), Some("running"));
    }

    #[test]
    fn pipeline_run_filter_accepts_camel_case_project_id_alias() {
        let uri: Uri = "/api/pipelines/runs?projectId=proj-2&limit=10"
            .parse()
            .expect("valid test uri");
        let Query(filter) =
            Query::<PipelineRunFilter>::try_from_uri(&uri).expect("query should parse");

        assert_eq!(filter.project_id.as_deref(), Some("proj-2"));
        assert_eq!(filter.limit, Some(10));
    }

    async fn setup_test_run(status: &str) -> (SqlitePool, String, String, std::path::PathBuf) {
        let db_path = std::env::temp_dir().join(format!(
            "woohoo-pipeline-handler-tests-{}.sqlite",
            Uuid::new_v4()
        ));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
        let pool = init_db(&database_url, 1).await;

        let user_id = format!("user-{}", Uuid::new_v4());
        let project_id = format!("proj-{}", Uuid::new_v4());
        let conversation_id = format!("conv-{}", Uuid::new_v4());
        let run_id = format!("run-{}", Uuid::new_v4());

        sqlx::query("INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)")
            .bind(&user_id)
            .bind(format!("tester-{}", &user_id))
            .bind(format!("{}@example.com", &user_id))
            .bind("hashed-password")
            .execute(&pool)
            .await
            .expect("failed to insert user");

        sqlx::query("INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)")
            .bind(&project_id)
            .bind(&user_id)
            .bind("测试项目")
            .execute(&pool)
            .await
            .expect("failed to insert project");

        sqlx::query(
            "INSERT INTO conversations (id, project_id, user_id, title) VALUES (?, ?, ?, ?)",
        )
        .bind(&conversation_id)
        .bind(&project_id)
        .bind(&user_id)
        .bind("测试会话")
        .execute(&pool)
        .await
        .expect("failed to insert conversation");

        sqlx::query(
            "INSERT INTO pipeline_runs (
                id, user_id, project_id, conversation_id,
                pipeline_type, trigger_source, status,
                idempotency_key, total_steps, completed_steps, failed_steps
            ) VALUES (?, ?, ?, ?, 'outline', 'manual', ?, ?, 1, 0, 0)",
        )
        .bind(&run_id)
        .bind(&user_id)
        .bind(&project_id)
        .bind(&conversation_id)
        .bind(status)
        .bind(format!("idem-{}", run_id))
        .execute(&pool)
        .await
        .expect("failed to insert pipeline run");

        (pool, user_id, run_id, db_path)
    }

    #[tokio::test]
    async fn pause_transition_is_idempotent_after_first_success() {
        let (pool, user_id, run_id, db_path) = setup_test_run("running").await;

        let (first, first_changed) = pause_pipeline_run_state(&pool, &user_id, &run_id)
            .await
            .expect("first pause should succeed");
        assert!(first_changed);
        assert_eq!(first.status, "paused");

        let (second, second_changed) = pause_pipeline_run_state(&pool, &user_id, &run_id)
            .await
            .expect("second pause should be a no-op");
        assert!(!second_changed);
        assert_eq!(second.status, "paused");

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }

    #[tokio::test]
    async fn pause_transition_is_idempotent_under_concurrent_requests() {
        let (pool, user_id, run_id, db_path) = setup_test_run("running").await;
        let pool_a = pool.clone();
        let pool_b = pool.clone();
        let user_id_a = user_id.clone();
        let user_id_b = user_id.clone();
        let run_id_a = run_id.clone();
        let run_id_b = run_id.clone();

        let (left, right) = tokio::join!(
            pause_pipeline_run_state(&pool_a, &user_id_a, &run_id_a),
            pause_pipeline_run_state(&pool_b, &user_id_b, &run_id_b),
        );

        let left = left.expect("left pause should resolve");
        let right = right.expect("right pause should resolve");

        assert_eq!(left.0.status, "paused");
        assert_eq!(right.0.status, "paused");
        assert_ne!(left.1, right.1);

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }

    #[tokio::test]
    async fn resume_transition_is_idempotent_after_first_success() {
        let (pool, user_id, run_id, db_path) = setup_test_run("paused").await;

        let (first, first_changed) = resume_pipeline_run_state(&pool, &user_id, &run_id)
            .await
            .expect("first resume should succeed");
        assert!(first_changed);
        assert_eq!(first.status, "running");

        let (second, second_changed) = resume_pipeline_run_state(&pool, &user_id, &run_id)
            .await
            .expect("second resume should be a no-op");
        assert!(!second_changed);
        assert_eq!(second.status, "running");

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }

    #[tokio::test]
    async fn resume_transition_is_idempotent_under_concurrent_requests() {
        let (pool, user_id, run_id, db_path) = setup_test_run("paused").await;
        let pool_a = pool.clone();
        let pool_b = pool.clone();
        let user_id_a = user_id.clone();
        let user_id_b = user_id.clone();
        let run_id_a = run_id.clone();
        let run_id_b = run_id.clone();

        let (left, right) = tokio::join!(
            resume_pipeline_run_state(&pool_a, &user_id_a, &run_id_a),
            resume_pipeline_run_state(&pool_b, &user_id_b, &run_id_b),
        );

        let left = left.expect("left resume should resolve");
        let right = right.expect("right resume should resolve");

        assert_eq!(left.0.status, "running");
        assert_eq!(right.0.status, "running");
        assert_ne!(left.1, right.1);

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }

    #[tokio::test]
    async fn cancel_transition_is_idempotent_after_first_success() {
        let (pool, user_id, run_id, db_path) = setup_test_run("running").await;

        let (first, first_changed) = cancel_pipeline_run_state(&pool, &user_id, &run_id)
            .await
            .expect("first cancel should succeed");
        assert!(first_changed);
        assert_eq!(first.status, "cancelled");
        assert!(first.finished_at.is_some());

        let (second, second_changed) = cancel_pipeline_run_state(&pool, &user_id, &run_id)
            .await
            .expect("second cancel should be a no-op");
        assert!(!second_changed);
        assert_eq!(second.status, "cancelled");

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }

    #[tokio::test]
    async fn cancel_transition_is_idempotent_under_concurrent_requests() {
        let (pool, user_id, run_id, db_path) = setup_test_run("running").await;
        let pool_a = pool.clone();
        let pool_b = pool.clone();
        let user_id_a = user_id.clone();
        let user_id_b = user_id.clone();
        let run_id_a = run_id.clone();
        let run_id_b = run_id.clone();

        let (left, right) = tokio::join!(
            cancel_pipeline_run_state(&pool_a, &user_id_a, &run_id_a),
            cancel_pipeline_run_state(&pool_b, &user_id_b, &run_id_b),
        );

        let left = left.expect("left cancel should resolve");
        let right = right.expect("right cancel should resolve");

        assert_eq!(left.0.status, "cancelled");
        assert_eq!(right.0.status, "cancelled");
        assert_ne!(left.1, right.1);
        assert!(left.0.finished_at.is_some());
        assert!(right.0.finished_at.is_some());

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }

    #[tokio::test]
    async fn invalid_transition_still_returns_validation_error() {
        let (pool, user_id, run_id, db_path) = setup_test_run("completed").await;

        let error = pause_pipeline_run_state(&pool, &user_id, &run_id)
            .await
            .expect_err("pause from completed should fail");

        match error {
            AppError::Validation(message) => {
                assert!(message.contains("当前状态不允许暂停"));
                assert!(message.contains("completed"));
            }
            other => panic!("unexpected error type: {other:?}"),
        }

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }
}
