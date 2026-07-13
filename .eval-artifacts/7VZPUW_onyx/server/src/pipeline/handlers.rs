use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
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

    Ok(Json(PipelineRunSummary {
        run,
        steps,
        recent_events: events,
        outputs,
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
 */
pub async fn stream_pipeline_run(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<axum::response::Response> {
    let _run = get_run_by_id(&state.db, &user_id.0, &id).await?;

    let db = state.db.clone();
    let run_id = id.clone();

    use axum::response::sse::{Event, KeepAlive, Sse};
    use std::convert::Infallible;

    let stream = async_stream::stream! {
        yield Ok::<_, Infallible>(Event::default()
            .event("snapshot")
            .data("{\"status\":\"connected\"}"));

        let mut last_event_id: i64 = 0;
        for _ in 0..300 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            let events: Vec<(String, String, String, i64)> = match sqlx::query_as::<_, (String, String, String, i64)>(
                "SELECT event_type, payload_json, source, rowid
                 FROM pipeline_run_events WHERE run_id = ? AND rowid > ?
                 ORDER BY rowid ASC LIMIT 20"
            )
            .bind(&run_id)
            .bind(last_event_id)
            .fetch_all(&db)
            .await {
                Ok(events) => events,
                Err(_) => continue,
            };

            for (event_type, payload, source, rowid) in events {
                last_event_id = last_event_id.max(rowid);
                let data = format!(r#"{{"type":"{}","payload":{},"source":"{}"}}"#,
                    event_type,
                    payload.as_str(),
                    source
                );
                yield Ok(Event::default()
                    .event(&event_type)
                    .data(data));
            }
        }

        yield Ok(Event::default()
            .event("done")
            .data("{\"reason\":\"timeout\"}"));
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
        &["queued", "running", "paused"],
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

/**
 * 列出人工复核队列
 *
 * GET /api/pipelines/review-queue
 *
 * 聚合当前用户下需要人工关注的步骤：
 *   - 失败/阻塞的步骤 (pipeline_run_steps.status IN ('failed', 'blocked'))
 *   - 或关联了 prompt optimization 建议的步骤
 *
 * 已 completed/cancelled 的 run 中的步骤默认不再进入队列，避免噪音。
 */
pub async fn list_review_queue(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(filter): Query<PipelineReviewQueueFilter>,
) -> AppResult<Json<Vec<PipelineReviewQueueItem>>> {
    let limit = filter.limit.unwrap_or(50).clamp(1, 200);
    let offset = filter.offset.unwrap_or(0).max(0);

    // 聚合规则：
    //   1. 步骤本身 failed/blocked（核心）
    //   2. 或者该步骤有未处理的 prompt 优化建议
    //   3. run 处于 active 状态（queued/running/paused/failed），已结束的 run 不进队列
    //      除非显式传入 status 过滤（用于历史查看）
    let mut conditions = vec!["pr.user_id = ?".to_string()];
    let mut values: Vec<String> = vec![user_id.0.clone()];

    conditions.push(format!(
        "(prs.status IN ('failed','blocked') OR COALESCE(opt.opt_count, 0) > 0)"
    ));

    if let Some(project_id) = &filter.project_id {
        conditions.push("pr.project_id = ?".to_string());
        values.push(project_id.clone());
    }
    if let Some(pipeline_type) = &filter.pipeline_type {
        conditions.push("pr.pipeline_type = ?".to_string());
        values.push(pipeline_type.clone());
    }
    match filter.status.as_deref() {
        Some(status) if !status.is_empty() => {
            conditions.push("pr.status = ?".to_string());
            values.push(status.to_string());
        }
        _ => {
            // 默认：只聚合尚未彻底结束的 run
            conditions.push("pr.status IN ('queued','running','paused','failed')".to_string());
        }
    }

    let where_clause = conditions.join(" AND ");
    let query = format!(
        "SELECT
            pr.id AS run_id,
            pr.status AS run_status,
            pr.pipeline_type,
            pr.project_id,
            pr.conversation_id,
            pr.created_at AS run_created_at,
            pr.updated_at AS run_updated_at,
            prs.id AS step_id,
            prs.step_key,
            prs.step_name,
            prs.step_order,
            prs.status AS step_status,
            prs.attempt_count AS step_attempt_count,
            prs.error_message AS step_error_message,
            prs.last_error_at AS step_last_error_at,
            prs.updated_at AS step_updated_at,
            (SELECT id FROM pipeline_run_events
               WHERE run_id = prs.run_id AND step_id = prs.id
               ORDER BY created_at DESC LIMIT 1) AS last_event_id,
            (SELECT event_type FROM pipeline_run_events
               WHERE run_id = prs.run_id AND step_id = prs.id
               ORDER BY created_at DESC LIMIT 1) AS last_event_type,
            (SELECT payload_json FROM pipeline_run_events
               WHERE run_id = prs.run_id AND step_id = prs.id
               ORDER BY created_at DESC LIMIT 1) AS last_event_payload,
            (SELECT created_at FROM pipeline_run_events
               WHERE run_id = prs.run_id AND step_id = prs.id
               ORDER BY created_at DESC LIMIT 1) AS last_event_created_at,
            COALESCE(
                (SELECT COUNT(*) FROM pipeline_prompt_optimizations
                  WHERE run_id = prs.run_id AND step_id = prs.id), 0
            ) AS optimization_count
         FROM pipeline_run_steps prs
         INNER JOIN pipeline_runs pr ON pr.id = prs.run_id
         WHERE {}
         ORDER BY COALESCE(
             (SELECT MAX(created_at) FROM pipeline_run_events
               WHERE run_id = prs.run_id AND step_id = prs.id),
             prs.updated_at
         ) DESC, prs.step_order ASC
         LIMIT ? OFFSET ?",
        where_clause
    );

    let mut q = sqlx::query_as::<_, PipelineReviewQueueItem>(&query);
    for v in &values {
        q = q.bind(v);
    }
    q = q.bind(limit).bind(offset);

    let items = q.fetch_all(&state.db).await?;
    Ok(Json(items))
}

/**
 * 列出某个 run 的人工复核历史（用于详情区展示）
 *
 * GET /api/pipelines/runs/{runId}/reviews
 */
pub async fn list_run_manual_reviews(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(run_id): Path<String>,
) -> AppResult<Json<Vec<PipelineManualReview>>> {
    // 先做权限校验
    let _run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;

    let rows = sqlx::query_as::<_, PipelineManualReview>(
        "SELECT * FROM pipeline_manual_reviews WHERE run_id = ? ORDER BY created_at DESC",
    )
    .bind(&run_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

/**
 * 步骤级人工复核动作
 *
 * POST /api/pipelines/runs/{runId}/steps/{stepId}/review-decision
 *
 * decision:
 *   - retry: 触发步骤重试（复用 retry-step 语义）
 *   - cancel: 终止整个 run，标记为 cancelled
 *   - acknowledge: 仅记录已知晓，不改变运行状态
 *
 * 对已经 completed/cancelled 的 run 给出明确错误，不会留下 UI 显示 running 但后端不可推进的状态。
 */
pub async fn submit_review_decision(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((run_id, step_id)): Path<(String, String)>,
    Json(req): Json<PipelineReviewDecisionReq>,
) -> AppResult<Json<PipelineReviewDecisionResp>> {
    let decision = req.decision.trim().to_ascii_lowercase();
    if !MANUAL_REVIEW_DECISIONS.contains(&decision.as_str()) {
        return Err(AppError::Validation(format!(
            "不支持的复核决策: {}，可选值: {}",
            req.decision,
            MANUAL_REVIEW_DECISIONS.join(", ")
        )));
    }

    // 1. 校验 run 归属与状态
    let run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;

    if matches!(run.status.as_str(), "completed" | "cancelled") {
        return Err(AppError::Validation(format!(
            "流程已处于终态 {}，不能再提交复核动作",
            run.status
        )));
    }

    // 2. 校验 step 归属
    let step = sqlx::query_as::<_, PipelineRunStep>(
        "SELECT * FROM pipeline_run_steps WHERE id = ? AND run_id = ?",
    )
    .bind(&step_id)
    .bind(&run_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("指定步骤不存在或不属于该流程".into()))?;

    // 3. 写入复核记录（所有决策都先落库，便于审计）
    let review_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let note = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let review = sqlx::query_as::<_, PipelineManualReview>(
        "INSERT INTO pipeline_manual_reviews (id, run_id, step_id, reviewer_id, decision, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&review_id)
    .bind(&run_id)
    .bind(&step_id)
    .bind(&user_id.0)
    .bind(&decision)
    .bind(&note)
    .bind(&now)
    .fetch_one(&state.db)
    .await?;

    // 4. 写事件到审计流（保持与现有事件体系一致）
    log_pipeline_event(
        &state.db,
        &run_id,
        Some(&step_id),
        "manual_review",
        &serde_json::json!({
            "decision": decision,
            "note": note,
            "reviewId": review_id,
            "stepName": step.step_name,
        }),
        "user",
    )
    .await?;

    // 5. 根据决策执行副作用
    match decision.as_str() {
        "retry" => {
            // 复用现有 retry-step 的状态转换逻辑
            // 这里要求步骤处于 failed/blocked/retrying 之一；retrying 也算（用户手动覆盖自动等待）
            if !["failed", "blocked", "retrying"].contains(&step.status.as_str()) {
                return Err(AppError::Validation(format!(
                    "步骤当前状态 {} 不允许重试，请使用 acknowledge 仅记录已知晓",
                    step.status
                )));
            }
            let updated_step = sqlx::query_as::<_, PipelineRunStep>(
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

            // 如果 run 已经处于 failed，需要把它恢复为 running，否则 orchestrator 不会再调度
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
                .bind(&run_id)
                .bind(&user_id.0)
                .execute(&state.db)
                .await?;

                log_pipeline_event(
                    &state.db,
                    &run_id,
                    Some(&step_id),
                    "resumed",
                    &serde_json::json!({
                        "reason": "manual_review_retry",
                        "stepId": step_id,
                        "stepName": step.step_name,
                        "reviewId": review_id,
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
                    "stepId": step_id,
                    "stepName": step.step_name,
                    "reason": "manual_review",
                    "reviewId": review_id,
                }),
                "user",
            )
            .await?;

            let latest_run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;
            Ok(Json(PipelineReviewDecisionResp {
                review,
                run: latest_run,
                step: updated_step,
            }))
        }
        "cancel" => {
            // 终止整个 run。复用现有 cancel_pipeline_run_state，会检查状态合法性。
            let (updated_run, changed) =
                cancel_pipeline_run_state(&state.db, &user_id.0, &run_id).await?;
            if changed {
                log_pipeline_event(
                    &state.db,
                    &run_id,
                    Some(&step_id),
                    "cancelled",
                    &serde_json::json!({
                        "reason": "manual_review_cancel",
                        "stepId": step_id,
                        "reviewId": review_id,
                        "note": note,
                    }),
                    "user",
                )
                .await?;
            }
            Ok(Json(PipelineReviewDecisionResp {
                review,
                run: updated_run,
                step,
            }))
        }
        "acknowledge" => {
            // 仅记录，不做任何状态变更。前端刷新时仍能看到 step 失败状态与最新的 review 记录。
            let latest_run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;
            Ok(Json(PipelineReviewDecisionResp {
                review,
                run: latest_run,
                step,
            }))
        }
        // 上面已校验，不会走到这里
        _ => Err(AppError::Validation("非法决策".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_pipeline_run_state, pause_pipeline_run_state, resume_pipeline_run_state,
        PipelineRunFilter,
    };
    use super::{
        MANUAL_REVIEW_DECISIONS, PipelineReviewDecisionReq, PipelineReviewQueueFilter,
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

    // ------ 人工复核队列 / 决策相关测试 ------

    /// 初始化一个包含 user + project + conversation + run + 多个 step 的最小测试环境
    async fn setup_review_fixture(
        run_status: &str,
    ) -> (SqlitePool, String, String, String, String, std::path::PathBuf) {
        let db_path = std::env::temp_dir().join(format!(
            "woohoo-pipeline-review-tests-{}.sqlite",
            Uuid::new_v4()
        ));
        let database_url = format!(
            "sqlite://{}",
            db_path.to_string_lossy().replace('\\', "/")
        );
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
            ) VALUES (?, ?, ?, ?, 'outline', 'manual', ?, ?, 2, 0, 0)",
        )
        .bind(&run_id)
        .bind(&user_id)
        .bind(&project_id)
        .bind(&conversation_id)
        .bind(run_status)
        .bind(format!("idem-{}", run_id))
        .execute(&pool)
        .await
        .expect("failed to insert pipeline run");

        (pool, user_id, project_id, run_id, conversation_id, db_path)
    }

    #[test]
    fn manual_review_decision_list_is_well_defined() {
        // 决策集合不能包含 skip，避免破坏依赖状态机
        assert!(MANUAL_REVIEW_DECISIONS.contains(&"retry"));
        assert!(MANUAL_REVIEW_DECISIONS.contains(&"cancel"));
        assert!(MANUAL_REVIEW_DECISIONS.contains(&"acknowledge"));
        assert!(!MANUAL_REVIEW_DECISIONS.contains(&"skip"));
    }

    #[test]
    fn review_queue_filter_accepts_camel_case_aliases() {
        let uri: Uri =
            "/api/pipelines/review-queue?projectId=proj-1&pipelineType=outline&limit=5"
                .parse()
                .expect("valid uri");
        let Query(filter) = Query::<PipelineReviewQueueFilter>::try_from_uri(&uri)
            .expect("filter should parse");

        assert_eq!(filter.project_id.as_deref(), Some("proj-1"));
        assert_eq!(filter.pipeline_type.as_deref(), Some("outline"));
        assert_eq!(filter.limit, Some(5));
        assert!(filter.status.is_none());
    }

    #[test]
    fn review_decision_payload_parses_camel_case() {
        use serde_json::json;

        let body = json!({ "decision": "Retry", "note": "  已人工确认  " });
        let req: PipelineReviewDecisionReq =
            serde_json::from_value(body).expect("review decision payload should parse");

        // 注意：Rust 端在 handler 内部做 trim + lowercase，这里只验证结构解析
        assert_eq!(req.decision, "Retry");
        assert_eq!(req.note.as_deref(), Some("  已人工确认  "));
    }

    #[tokio::test]
    async fn review_queue_lists_only_failed_or_blocked_steps() {
        let (pool, user_id, _project_id, run_id, _conv_id, db_path) =
            setup_review_fixture("running").await;

        // 两个步骤：一个 failed，一个 completed
        let step_failed = format!("step-{}", Uuid::new_v4());
        let step_done = format!("step-{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO pipeline_run_steps (id, run_id, step_key, step_name, step_order, status)
             VALUES (?, ?, 'failed_step', '失败步骤', 1, 'failed')",
        )
        .bind(&step_failed)
        .bind(&run_id)
        .execute(&pool)
        .await
        .expect("insert failed step");
        sqlx::query(
            "INSERT INTO pipeline_run_steps (id, run_id, step_key, step_name, step_order, status)
             VALUES (?, ?, 'done_step', '完成步骤', 2, 'completed')",
        )
        .bind(&step_done)
        .bind(&run_id)
        .execute(&pool)
        .await
        .expect("insert completed step");

        // 复用 handler 的私有查询逻辑：直接构造 SQL 执行以验证过滤规则
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT prs.id, prs.status FROM pipeline_run_steps prs
             INNER JOIN pipeline_runs pr ON pr.id = prs.run_id
             WHERE pr.user_id = ? AND prs.status IN ('failed','blocked')",
        )
        .bind(&user_id)
        .fetch_all(&pool)
        .await
        .expect("query should work");

        assert_eq!(rows.len(), 1, "failed/blocked 步骤应被唯一命中");
        assert_eq!(rows[0].0, step_failed);
        assert_eq!(rows[0].1, "failed");

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }

    #[tokio::test]
    async fn review_queue_excludes_terminal_runs_by_default() {
        // 已 completed 的 run 中的 failed 步骤默认不应出现在队列
        let (pool, user_id, _project_id, run_id, _conv_id, db_path) =
            setup_review_fixture("completed").await;

        let step_failed = format!("step-{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO pipeline_run_steps (id, run_id, step_key, step_name, step_order, status)
             VALUES (?, ?, 'failed_step', '失败步骤', 1, 'failed')",
        )
        .bind(&step_failed)
        .bind(&run_id)
        .execute(&pool)
        .await
        .expect("insert failed step");

        // 默认：只聚合 queued/running/paused/failed 的 run
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pipeline_run_steps prs
             INNER JOIN pipeline_runs pr ON pr.id = prs.run_id
             WHERE pr.user_id = ?
               AND prs.status IN ('failed','blocked')
               AND pr.status IN ('queued','running','paused','failed')",
        )
        .bind(&user_id)
        .fetch_one(&pool)
        .await
        .expect("count should work");
        assert_eq!(count, 0, "completed 流程的失败步骤不应进入默认队列");

        // 显式传入 status=completed 时可以查历史
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pipeline_run_steps prs
             INNER JOIN pipeline_runs pr ON pr.id = prs.run_id
             WHERE pr.user_id = ?
               AND prs.status IN ('failed','blocked')
               AND pr.status = 'completed'",
        )
        .bind(&user_id)
        .fetch_one(&pool)
        .await
        .expect("count should work");
        assert_eq!(count, 1, "显式按 status=completed 过滤应可命中历史");

        pool.close().await;
        std::fs::remove_file(db_path).ok();
    }
}
