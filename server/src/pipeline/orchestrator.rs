use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde_json::{json, Value};
use sqlx::{FromRow, SqlitePool};
use tokio::time::{interval, MissedTickBehavior};
use uuid::Uuid;

use crate::{
    asset::{self, generated_document::GeneratedMarkdownDocument},
    ai::{
        client::StreamFallbackMode,
        config::{AiChatReq, AiTaskStatus},
        handlers::enqueue_ai_task_for_request,
        usage::AiUsageOperation,
    },
    error::AppError,
    AppState,
};

const ORCHESTRATOR_INTERVAL_SECS: u64 = 3;
const MAX_RUNS_PER_TICK: i64 = 24;
const MISSING_AI_ENDPOINT_REASON: &str = "缺少可用 AI 端点，请先在设置中配置并激活端点后重试";
const DEPENDENCY_FAILED_SKIP_REASON: &str = "依赖步骤失败，当前步骤已跳过";
const RUN_ERROR_WAITING_PREREQUISITE: &str = "WAITING_PREREQUISITE";
const RUN_ERROR_MISSING_ENDPOINT: &str = "MISSING_ENDPOINT";
const RUN_ERROR_DEPENDENCY_UNSATISFIED: &str = "DEPENDENCY_UNSATISFIED";
const RUN_ERROR_RETRY_SCHEDULED: &str = "RETRY_SCHEDULED";
const RUN_ERROR_MANUAL_REVIEW_REQUIRED: &str = "MANUAL_REVIEW_REQUIRED";
const RUN_ERROR_EXECUTION_FAILED: &str = "EXECUTION_FAILED";
const RETRY_BASE_DELAY_SECS: i64 = 4;
const RETRY_REVIEW_BASE_DELAY_SECS: i64 = 3;
const RETRY_NETWORK_BASE_DELAY_SECS: i64 = 6;
const RETRY_MAX_DELAY_SECS: i64 = 90;

mod helpers;
use helpers::*;

#[derive(Debug, Clone, FromRow)]
struct PipelineRunRow {
    id: String,
    user_id: String,
    project_id: String,
    conversation_id: String,
    pipeline_type: String,
    status: String,
}

#[derive(Debug, Clone, FromRow)]
struct PipelineStepRow {
    id: String,
    step_key: String,
    step_name: String,
    step_order: i64,
    step_type: Option<String>,
    depends_on_json: Option<String>,
    review_policy_json: Option<String>,
    ai_task_id: Option<String>,
    status: String,
    attempt_count: i64,
    max_retries: i64,
    input_summary: Option<String>,
    error_message: Option<String>,
    last_error_at: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
struct PersistedTaskRow {
    status: String,
    result: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct TaskSnapshot {
    status: String,
    result: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct ReviewDecision {
    decision: &'static str,
    score: Option<f64>,
    issues: Value,
    retry_hints: Value,
    parse_error: Option<String>,
}

pub fn start_orchestrator_worker(state: AppState) {
    tokio::spawn(run_orchestrator_loop(state));
}

async fn run_orchestrator_loop(state: AppState) {
    let mut ticker = interval(Duration::from_secs(ORCHESTRATOR_INTERVAL_SECS));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        if let Err(error) = run_orchestrator_once(&state).await {
            tracing::warn!("pipeline orchestrator tick failed: {}", error);
        }
    }
}

async fn run_orchestrator_once(state: &AppState) -> Result<()> {
    let runs = sqlx::query_as::<_, PipelineRunRow>(
        "SELECT id, user_id, project_id, conversation_id, pipeline_type, status
         FROM pipeline_runs
         WHERE status IN ('queued', 'running')
         ORDER BY created_at ASC
         LIMIT ?",
    )
    .bind(MAX_RUNS_PER_TICK)
    .fetch_all(&state.db)
    .await?;

    for run in runs {
        if let Err(error) = advance_run_once(state, &run).await {
            tracing::warn!(run_id = %run.id, "failed to advance pipeline run: {}", error);
        }
    }

    Ok(())
}

async fn advance_run_once(state: &AppState, run: &PipelineRunRow) -> Result<()> {
    let mut steps = load_run_steps(&state.db, &run.id).await?;
    if steps.is_empty() {
        mark_run_failed(&state.db, run, "pipeline run has no steps").await?;
        return Ok(());
    }

    reconcile_dependency_states(&state.db, run, &mut steps).await?;

    let mut changed = false;
    for step in steps.clone() {
        if step.status != "running" {
            continue;
        }
        if handle_running_step(state, run, &step, &steps).await? {
            changed = true;
        }
    }

    if changed {
        steps = load_run_steps(&state.db, &run.id).await?;
        reconcile_dependency_states(&state.db, run, &mut steps).await?;
    }

    if let Some(step) = pick_next_dispatchable_step(&steps) {
        match dispatch_step_task(state, run, &step, &steps).await {
            Ok(_) => {
                steps = load_run_steps(&state.db, &run.id).await?;
            }
            Err(error) => {
                if is_missing_ai_endpoint_error(&error) {
                    mark_step_blocked_missing_endpoint(&state.db, run, &step).await?;
                    steps = load_run_steps(&state.db, &run.id).await?;
                } else {
                    return Err(error);
                }
            }
        }
    }

    sync_run_state(&state.db, run, &steps).await?;
    Ok(())
}

async fn load_run_steps(pool: &SqlitePool, run_id: &str) -> Result<Vec<PipelineStepRow>> {
    Ok(sqlx::query_as::<_, PipelineStepRow>(
        "SELECT id, step_key, step_name, step_order, step_type,
                depends_on_json, review_policy_json, ai_task_id, status,
                attempt_count, max_retries, input_summary, error_message, last_error_at
         FROM pipeline_run_steps
         WHERE run_id = ?
         ORDER BY step_order ASC, created_at ASC",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?)
}

async fn reconcile_dependency_states(
    pool: &SqlitePool,
    run: &PipelineRunRow,
    steps: &mut [PipelineStepRow],
) -> Result<()> {
    for index in 0..steps.len() {
        if matches!(
            steps[index].status.as_str(),
            "running" | "completed" | "failed"
        ) {
            continue;
        }
        if steps[index].status == "skipped" {
            let recoverable = steps[index]
                .error_message
                .as_deref()
                .map(is_dependency_failed_skip_reason)
                .unwrap_or(false);
            if !recoverable {
                continue;
            }
        }

        let dependencies = parse_depends_on(&steps[index].depends_on_json);
        if dependencies.is_empty() {
            if steps[index].status == "blocked" {
                let should_unblock = match steps[index].error_message.as_deref() {
                    None => true,
                    Some(message) if is_missing_endpoint_block_reason(message) => {
                        has_available_endpoint(pool, &run.user_id).await?
                    }
                    Some(_) => false,
                };
                if !should_unblock {
                    continue;
                }
                let step_id = steps[index].id.clone();
                set_step_status(pool, &run.id, &step_id, "queued", None, false).await?;
                steps[index].status = "queued".to_string();
                steps[index].error_message = None;
            }
            continue;
        }

        let (resolved_dependencies, has_failed_dependency, ready) = {
            let dep_steps = resolve_dependency_steps(&dependencies, &*steps);
            let resolved_count = dep_steps.len();
            let has_failed = dep_steps
                .iter()
                .any(|dependency| is_failed_step_status(&dependency.status));
            let all_ready = dep_steps
                .iter()
                .all(|dependency| is_success_step_status(&dependency.status));
            (resolved_count, has_failed, all_ready)
        };

        if resolved_dependencies != dependencies.len() {
            let step_id = steps[index].id.clone();
            set_step_status(
                pool,
                &run.id,
                &step_id,
                "blocked",
                Some("存在未定义的依赖步骤，等待配置修复"),
                false,
            )
            .await?;
            steps[index].status = "blocked".to_string();
            steps[index].error_message = Some("存在未定义的依赖步骤，等待配置修复".to_string());
            continue;
        }

        if has_failed_dependency {
            let step_id = steps[index].id.clone();
            set_step_status(
                pool,
                &run.id,
                &step_id,
                "skipped",
                Some(DEPENDENCY_FAILED_SKIP_REASON),
                true,
            )
            .await?;
            steps[index].status = "skipped".to_string();
            steps[index].error_message = Some(DEPENDENCY_FAILED_SKIP_REASON.to_string());
            continue;
        }

        let next_status = if ready { "queued" } else { "blocked" };
        if steps[index].status != next_status {
            let step_id = steps[index].id.clone();
            set_step_status(pool, &run.id, &step_id, next_status, None, false).await?;
            steps[index].status = next_status.to_string();
            if next_status == "queued" {
                steps[index].error_message = None;
            }
        }
    }

    Ok(())
}

async fn handle_running_step(
    state: &AppState,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
    steps: &[PipelineStepRow],
) -> Result<bool> {
    let Some(task_id) = step.ai_task_id.as_deref() else {
        mark_step_failed(&state.db, &run.id, &step.id, "步骤 running 但缺少 aiTaskId").await?;
        return Ok(true);
    };

    let Some(task) = load_task_snapshot(state, &run.user_id, task_id).await? else {
        return Ok(false);
    };

    match task.status.as_str() {
        "queued" | "running" => Ok(false),
        "completed" => {
            if normalize_step_type(step) == "review" {
                handle_review_completion(&state.db, run, step, steps, task_id, task.result).await
            } else {
                handle_design_completion(state, run, step, task_id, task.result).await
            }
        }
        "failed" => handle_task_failure(&state.db, run, step, task.error).await,
        _ => Ok(false),
    }
}

async fn load_task_snapshot(
    state: &AppState,
    user_id: &str,
    task_id: &str,
) -> Result<Option<TaskSnapshot>> {
    if let Some(task) = state.ai_runtime.get_task(user_id, task_id).await {
        return Ok(Some(TaskSnapshot {
            status: map_task_status(task.status).to_string(),
            result: task.result,
            error: task.error,
        }));
    }

    let persisted = sqlx::query_as::<_, PersistedTaskRow>(
        "SELECT status, result, error
         FROM ai_tasks
         WHERE id = ? AND user_id = ?",
    )
    .bind(task_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    Ok(persisted.map(|task| TaskSnapshot {
        status: task.status,
        result: task.result,
        error: task.error,
    }))
}

fn map_task_status(status: AiTaskStatus) -> &'static str {
    match status {
        AiTaskStatus::Queued => "queued",
        AiTaskStatus::Running => "running",
        AiTaskStatus::Completed => "completed",
        AiTaskStatus::Failed => "failed",
    }
}

async fn handle_design_completion(
    state: &AppState,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
    task_id: &str,
    result: Option<String>,
) -> Result<bool> {
    let raw_content = result.filter(|value| !value.trim().is_empty());
    let persisted_asset = if let Some(content) = raw_content.as_deref() {
        match persist_pipeline_document_asset(state, run, step, task_id, content).await {
            Ok(asset) => Some(asset),
            Err(error) => {
                tracing::warn!(
                    run_id = %run.id,
                    step_id = %step.id,
                    "failed to persist pipeline document asset: {}",
                    error
                );
                None
            }
        }
    } else {
        None
    };
    let output_json = persisted_asset.as_ref().map(|asset| {
        json!({
            "format": "markdown",
            "assetId": asset.id,
            "assetName": asset.name,
            "assetType": asset.asset_type,
            "assetUrl": asset.url,
            "documentKind": classify_pipeline_document_kind(step),
        })
        .to_string()
    });
    let content_preview = raw_content
        .as_deref()
        .map(build_compact_preview)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "产出已写入步骤输出".to_string());
    let output_id = insert_step_output(
        &state.db,
        &run.id,
        &step.id,
        Some(task_id),
        "design",
        output_json.as_deref(),
        raw_content,
        None,
        None,
        None,
        None,
    )
    .await?;

    if let Some(asset) = persisted_asset.as_ref() {
        append_pipeline_event(
            &state.db,
            &run.id,
            Some(&step.id),
            "pipeline_asset_created",
            json!({
                "outputId": output_id,
                "assetId": asset.id,
                "assetName": asset.name,
                "assetType": asset.asset_type,
                "assetUrl": asset.url,
                "documentKind": classify_pipeline_document_kind(step),
                "stepId": step.id,
                "stepKey": step.step_key,
                "stepName": step.step_name,
            }),
            "system",
        )
        .await?;
    }

    mark_step_completed(&state.db, &run.id, &step.id, Some(&output_id)).await?;
    append_assistant_step_summary(
        &state.db,
        run,
        step,
        format!("设计步骤「{}」已完成：{}", step.step_name, content_preview),
        "等待依赖该步骤的审核/下游阶段自动调度".to_string(),
    )
    .await?;
    Ok(true)
}

async fn persist_pipeline_document_asset(
    state: &AppState,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
    task_id: &str,
    content: &str,
) -> Result<asset::model::Asset> {
    let document_kind = classify_pipeline_document_kind(step);
    let filename_stem = format!(
        "pipeline-{}-{}-{}",
        safe_filename_component(&run.id),
        safe_filename_component(&step.id),
        safe_filename_component(task_id)
    );
    let asset_name = build_pipeline_document_asset_name(step);
    let metadata = json!({
        "origin": "pipeline_output",
        "format": "markdown",
        "pipelineRunId": run.id,
        "pipelineType": run.pipeline_type,
        "conversationId": run.conversation_id,
        "stepId": step.id,
        "stepKey": step.step_key,
        "stepName": step.step_name,
        "stepType": normalize_step_type(step),
        "taskId": task_id,
        "documentKind": document_kind,
        "sizeBytes": content.as_bytes().len(),
        "generatedAt": now_iso(),
    });

    Ok(asset::generated_document::persist_markdown_document(
        state,
        GeneratedMarkdownDocument {
            project_id: &run.project_id,
            name: &asset_name,
            filename_stem: &filename_stem,
            content,
            metadata,
        },
    )
    .await?)
}

fn classify_pipeline_document_kind(step: &PipelineStepRow) -> &'static str {
    let key = step.step_key.to_ascii_lowercase();
    if key.contains("outline") {
        "outline"
    } else if key.contains("script") {
        "script"
    } else if key.contains("storyboard") {
        "storyboard"
    } else if key.contains("chapter") {
        "chapter"
    } else if key.contains("keyframe") {
        "keyframe"
    } else {
        "pipeline_output"
    }
}

fn build_pipeline_document_asset_name(step: &PipelineStepRow) -> String {
    let title = step
        .step_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let fallback = step
        .step_key
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    let base = if title.trim().is_empty() {
        fallback.trim()
    } else {
        title.trim()
    };

    if base.is_empty() {
        "pipeline-output.md".to_string()
    } else if base.ends_with(".md") {
        base.to_string()
    } else {
        format!("{base}.md")
    }
}

fn safe_filename_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        trimmed.to_string()
    }
}

async fn handle_review_completion(
    pool: &SqlitePool,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
    steps: &[PipelineStepRow],
    task_id: &str,
    result: Option<String>,
) -> Result<bool> {
    let raw = result.unwrap_or_default();
    let review = parse_review_decision(&raw);
    let review_issues = extract_text_list(&review.issues);
    let retry_hints = extract_text_list(&review.retry_hints);
    let related_design_step = find_retry_design_step(step, steps);

    if should_enable_prompt_optimizer(step) {
        if let Some(optimization_id) = record_prompt_optimization(
            pool,
            run,
            step,
            related_design_step,
            &review,
            &review_issues,
            &retry_hints,
        )
        .await?
        {
            append_pipeline_event(
                pool,
                &run.id,
                Some(&step.id),
                "prompt_optimization_suggested",
                json!({
                    "optimizationId": optimization_id,
                    "stepId": step.id,
                    "stepName": step.step_name,
                    "decision": review.decision,
                    "summary": format!(
                        "已生成 Prompt 优化建议（{}）：{}",
                        step.step_name,
                        summarize_prompt_optimization_hint(&review_issues, &retry_hints, review.parse_error.as_deref()),
                    ),
                }),
                "assistant",
            )
            .await?;
        }
    }

    let output_id = insert_step_output(
        pool,
        &run.id,
        &step.id,
        Some(task_id),
        "review",
        None,
        Some(raw),
        Some(review.decision),
        review.score,
        Some(review.issues.clone()),
        Some(review.retry_hints.clone()),
    )
    .await?;

    if review.decision == "pass" {
        mark_step_completed(pool, &run.id, &step.id, Some(&output_id)).await?;
        append_assistant_step_summary(
            pool,
            run,
            step,
            format!("审核步骤「{}」已通过，可推进后续流程。", step.step_name),
            "继续调度下游设计/审核步骤".to_string(),
        )
        .await?;
        return Ok(true);
    }

    if let Some(design_step) = related_design_step {
        if can_retry_step(step) {
            let retry_prompt = build_retry_prompt(
                design_step.input_summary.as_deref(),
                &review.issues,
                &review.retry_hints,
                review.parse_error.as_deref(),
            );

            mark_step_retrying(
                pool,
                &run.id,
                design_step,
                Some("审核未通过，回流设计步骤重试"),
                Some(&retry_prompt),
            )
            .await?;

            mark_step_blocked_for_retry(
                pool,
                &run.id,
                &step.id,
                Some("等待设计步骤重试后重新审核"),
            )
            .await?;
            append_assistant_step_summary(
                pool,
                run,
                step,
                format!(
                    "审核步骤「{}」未通过，已回流到设计步骤「{}」重试。",
                    step.step_name, design_step.step_name
                ),
                format!("等待「{}」重试完成后再次审核", design_step.step_name),
            )
            .await?;
            return Ok(true);
        }
    }

    mark_step_failed(pool, &run.id, &step.id, &summarize_review_failure(&review)).await?;
    append_assistant_step_summary(
        pool,
        run,
        step,
        format!("审核步骤「{}」未通过且达到重试上限。", step.step_name),
        "需要人工复核后手动触发重试".to_string(),
    )
    .await?;
    Ok(true)
}

async fn handle_task_failure(
    pool: &SqlitePool,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
    error: Option<String>,
) -> Result<bool> {
    let reason = error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("AI 任务执行失败")
        .to_string();

    if can_retry_step(step) {
        mark_step_retrying(pool, &run.id, step, Some(&reason), None).await?;
        append_assistant_step_summary(
            pool,
            run,
            step,
            format!("步骤「{}」执行失败，已进入自动重试队列。", step.step_name),
            "等待退避计时结束后自动重试".to_string(),
        )
        .await?;
    } else {
        mark_step_failed(pool, &run.id, &step.id, &reason).await?;
        append_assistant_step_summary(
            pool,
            run,
            step,
            format!("步骤「{}」执行失败且超出最大重试次数。", step.step_name),
            "建议人工检查错误并手动重试失败步骤".to_string(),
        )
        .await?;
    }

    Ok(true)
}

fn can_retry_step(step: &PipelineStepRow) -> bool {
    step.attempt_count <= step.max_retries
}

fn pick_next_dispatchable_step(steps: &[PipelineStepRow]) -> Option<PipelineStepRow> {
    steps
        .iter()
        .find(|step| {
            matches!(step.status.as_str(), "queued" | "retrying")
                && step.ai_task_id.is_none()
                && is_step_dispatch_ready(step)
        })
        .cloned()
}

fn is_step_dispatch_ready(step: &PipelineStepRow) -> bool {
    if step.status != "retrying" {
        return true;
    }

    retry_not_due_until(step).is_none()
}

fn retry_not_due_until(step: &PipelineStepRow) -> Option<String> {
    let last_error_at = step.last_error_at.as_deref()?.trim();
    if last_error_at.is_empty() {
        return None;
    }

    let parsed = DateTime::parse_from_rfc3339(last_error_at).ok()?;
    let next_due_at =
        parsed.with_timezone(&Utc) + ChronoDuration::seconds(compute_retry_delay_seconds(step));
    if Utc::now() < next_due_at {
        Some(next_due_at.to_rfc3339_opts(SecondsFormat::Secs, true))
    } else {
        None
    }
}

fn calculate_next_retry_at(step: &PipelineStepRow, error_at_iso: &str) -> Option<String> {
    let parsed = DateTime::parse_from_rfc3339(error_at_iso).ok()?;
    let next_due_at =
        parsed.with_timezone(&Utc) + ChronoDuration::seconds(compute_retry_delay_seconds(step));
    Some(next_due_at.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn compute_retry_delay_seconds(step: &PipelineStepRow) -> i64 {
    let (policy_base, policy_max) = parse_retry_backoff_policy(step);

    let reason = step
        .error_message
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let base_default = if reason.contains("timeout")
        || reason.contains("network")
        || reason.contains("failed to fetch")
        || reason.contains("连接")
        || reason.contains("超时")
    {
        RETRY_NETWORK_BASE_DELAY_SECS
    } else if normalize_step_type(step) == "review" {
        RETRY_REVIEW_BASE_DELAY_SECS
    } else {
        RETRY_BASE_DELAY_SECS
    };

    let base = policy_base.unwrap_or(base_default).clamp(1, 300);
    let max_delay = policy_max.unwrap_or(RETRY_MAX_DELAY_SECS).clamp(base, 900);

    let exponent = (step.attempt_count.saturating_sub(1)).clamp(0, 8) as u32;
    let multiplier = 1_i64.checked_shl(exponent).unwrap_or(256).clamp(1, 256);
    let delay = base.saturating_mul(multiplier);
    delay.clamp(base, max_delay)
}

fn parse_retry_backoff_policy(step: &PipelineStepRow) -> (Option<i64>, Option<i64>) {
    let Some(raw) = step
        .review_policy_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (None, None);
    };

    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (None, None);
    };

    let base = value
        .get("retryBackoffSec")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0);
    let max = value
        .get("retryMaxBackoffSec")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0);
    (base, max)
}

async fn dispatch_step_task(
    state: &AppState,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
    steps: &[PipelineStepRow],
) -> Result<()> {
    let agent_id = resolve_step_agent_id(&state.db, &run.user_id, &run.project_id, step).await?;
    let content = build_step_prompt(&state.db, run, step, steps).await?;

    let req = AiChatReq {
        conversation_id: run.conversation_id.clone(),
        content,
        resource_refs: None,
        agent_id,
        endpoint_id: None,
        model: None,
        force_stream_fallback: Some(true),
        system_prompt: None,
        temperature: None,
        top_p: None,
        frequency_penalty: None,
        max_tokens: None,
        output_kind: Some("text".to_string()),
        output_items: Some(1),
        allow_assistant_actions: false,
        confirmed_message_id: None,
        confirmed_workflow_guard_message_id: None,
        trigger_source: Some("pipeline".to_string()),
    };

    let task = enqueue_ai_task_for_request(
        state,
        &run.user_id,
        req,
        AiUsageOperation::Task,
        StreamFallbackMode::Force,
    )
    .await?;

    mark_step_running(&state.db, &run.id, &step.id, &task.id).await?;
    Ok(())
}

async fn mark_step_blocked_missing_endpoint(
    pool: &SqlitePool,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
) -> Result<()> {
    set_step_status(
        pool,
        &run.id,
        &step.id,
        "blocked",
        Some(MISSING_AI_ENDPOINT_REASON),
        false,
    )
    .await
}

async fn has_available_endpoint(pool: &SqlitePool, user_id: &str) -> Result<bool> {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(1) FROM ai_endpoints WHERE user_id = ? AND is_active = 1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

async fn resolve_step_agent_id(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    step: &PipelineStepRow,
) -> Result<Option<String>> {
    let roles = if normalize_step_type(step) == "review" {
        vec!["review", "editor", "manager", "design", "custom"]
    } else {
        vec!["design", "editor", "manager", "custom", "review"]
    };

    for role in roles {
        let row = sqlx::query_as::<_, (String,)>(
            "SELECT a.id
             FROM project_agent_assignments pa
             INNER JOIN agents a ON a.id = pa.agent_id
             WHERE pa.user_id = ?
               AND pa.project_id = ?
               AND pa.is_active = 1
               AND a.is_active = 1
               AND pa.responsibility_kind = ?
             ORDER BY pa.updated_at DESC, pa.created_at DESC
             LIMIT 1",
        )
        .bind(user_id)
        .bind(project_id)
        .bind(role)
        .fetch_optional(pool)
        .await?;

        if let Some((agent_id,)) = row {
            return Ok(Some(agent_id));
        }
    }

    let fallback = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM agents WHERE user_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(fallback.map(|(id,)| id))
}

async fn build_step_prompt(
    pool: &SqlitePool,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
    steps: &[PipelineStepRow],
) -> Result<String> {
    let dependencies = parse_depends_on(&step.depends_on_json);
    let dep_steps = resolve_dependency_steps(&dependencies, steps);
    let mut dep_outputs = Vec::new();
    for dep in dep_steps {
        let output = sqlx::query_as::<_, (Option<String>, Option<String>)>(
            "SELECT raw_content, output_json
             FROM pipeline_step_outputs
             WHERE run_id = ? AND step_id = ?
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&run.id)
        .bind(&dep.id)
        .fetch_optional(pool)
        .await?;
        if let Some((raw, output_json)) = output {
            let text = raw
                .or(output_json)
                .unwrap_or_else(|| "(上游步骤无输出)".to_string());
            dep_outputs.push(format!("[上游步骤 {} 输出]\n{}", dep.step_key, text));
        }
    }

    let mut sections = vec![
        format!("流程类型：{}", run.pipeline_type),
        format!("步骤：{} ({})", step.step_name, step.step_key),
        format!("步骤类型：{}", normalize_step_type(step)),
        format!(
            "任务要求：{}",
            step.input_summary
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("请按步骤要求输出可执行内容。")
        ),
    ];

    if let Some(policy) = step
        .review_policy_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("审核策略：{}", policy));
    }

    if !dep_outputs.is_empty() {
        sections.push(dep_outputs.join("\n\n"));
    }

    if normalize_step_type(step) == "review" {
        sections.push(
            "请严格只输出 JSON：{\"decision\":\"pass|fail\",\"score\":0.0,\"issues\":[],\"retryHints\":[],\"riskLevel\":\"low|medium|high\"}".to_string(),
        );
    }

    Ok(sections.join("\n\n"))
}

async fn sync_run_state(
    pool: &SqlitePool,
    run: &PipelineRunRow,
    steps: &[PipelineStepRow],
) -> Result<()> {
    let total = steps.len() as i64;
    let done = steps
        .iter()
        .filter(|step| matches!(step.status.as_str(), "completed" | "skipped"))
        .count() as i64;
    let failed = steps.iter().filter(|step| step.status == "failed").count() as i64;
    let active = steps.iter().any(|step| {
        matches!(
            step.status.as_str(),
            "queued" | "running" | "blocked" | "retrying"
        )
    });

    let (running_error_code, running_error_message) = derive_running_state_error(steps);
    let (failed_error_code, failed_error_message) = derive_failed_run_error(steps);

    let next_status = if failed > 0 && !active {
        "failed"
    } else if total > 0 && done >= total && failed == 0 {
        "completed"
    } else {
        "running"
    };

    let now = now_iso();
    if matches!(next_status, "failed" | "completed") {
        let affected = sqlx::query(
            "UPDATE pipeline_runs
             SET status = ?,
                 total_steps = ?,
                 completed_steps = ?,
                 failed_steps = ?,
                 started_at = COALESCE(started_at, ?),
                 finished_at = COALESCE(finished_at, ?),
                 error_code = ?,
                 error_message = ?,
                 updated_at = ?
             WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(next_status)
        .bind(total)
        .bind(done)
        .bind(failed)
        .bind(&now)
        .bind(&now)
        .bind(if next_status == "failed" {
            Some(failed_error_code.as_str())
        } else {
            None
        })
        .bind(if next_status == "failed" {
            Some(failed_error_message.as_str())
        } else {
            None
        })
        .bind(&now)
        .bind(&run.id)
        .execute(pool)
        .await?
        .rows_affected();

        if affected > 0 {
            append_pipeline_event(
                pool,
                &run.id,
                None,
                next_status,
                json!({
                    "totalSteps": total,
                    "completedSteps": done,
                    "failedSteps": failed,
                    "errorCode": if next_status == "failed" { Some(failed_error_code.as_str()) } else { None::<&str> },
                    "errorMessage": if next_status == "failed" { Some(failed_error_message.as_str()) } else { None::<&str> },
                }),
                "system",
            )
            .await?;
        }
    } else {
        let affected = sqlx::query(
            "UPDATE pipeline_runs
             SET status = 'running',
                 total_steps = ?,
                 completed_steps = ?,
                 failed_steps = ?,
                 started_at = COALESCE(started_at, ?),
                 error_code = ?,
                 error_message = ?,
                 updated_at = ?
             WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(total)
        .bind(done)
        .bind(failed)
        .bind(&now)
        .bind(running_error_code.as_deref())
        .bind(running_error_message.as_deref())
        .bind(&now)
        .bind(&run.id)
        .execute(pool)
        .await?
        .rows_affected();

        if affected > 0 && run.status == "queued" {
            append_pipeline_event(
                pool,
                &run.id,
                None,
                "started",
                json!({
                    "totalSteps": total,
                }),
                "system",
            )
            .await?;
        }
    }

    Ok(())
}

async fn mark_run_failed(pool: &SqlitePool, run: &PipelineRunRow, reason: &str) -> Result<()> {
    let now = now_iso();
    let affected = sqlx::query(
        "UPDATE pipeline_runs
         SET status = 'failed',
             error_code = ?,
             error_message = ?,
             failed_steps = 1,
             finished_at = COALESCE(finished_at, ?),
             updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')",
    )
    .bind(RUN_ERROR_EXECUTION_FAILED)
    .bind(reason)
    .bind(&now)
    .bind(&now)
    .bind(&run.id)
    .execute(pool)
    .await?
    .rows_affected();

    if affected > 0 {
        append_pipeline_event(
            pool,
            &run.id,
            None,
            "failed",
            json!({
                "errorCode": RUN_ERROR_EXECUTION_FAILED,
                "reason": reason,
            }),
            "system",
        )
        .await?;
    }
    Ok(())
}

async fn mark_step_running(
    pool: &SqlitePool,
    run_id: &str,
    step_id: &str,
    task_id: &str,
) -> Result<()> {
    let now = now_iso();
    let affected = sqlx::query(
        "UPDATE pipeline_run_steps
         SET status = 'running',
             ai_task_id = ?,
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, ?),
             error_message = NULL,
             last_error_at = NULL,
             run_version = COALESCE(run_version, 1) + 1,
             updated_at = ?
         WHERE id = ? AND run_id = ?",
    )
    .bind(task_id)
    .bind(&now)
    .bind(&now)
    .bind(step_id)
    .bind(run_id)
    .execute(pool)
    .await?
    .rows_affected();

    if affected > 0 {
        append_pipeline_event(
            pool,
            run_id,
            Some(step_id),
            "step_started",
            json!({
                "stepId": step_id,
                "taskId": task_id,
            }),
            "system",
        )
        .await?;
    }
    Ok(())
}

async fn mark_step_completed(
    pool: &SqlitePool,
    run_id: &str,
    step_id: &str,
    output_ref: Option<&str>,
) -> Result<()> {
    let now = now_iso();
    let affected = sqlx::query(
        "UPDATE pipeline_run_steps
         SET status = 'completed',
             completed_at = COALESCE(completed_at, ?),
             output_ref = ?,
             error_message = NULL,
             last_error_at = NULL,
             run_version = COALESCE(run_version, 1) + 1,
             updated_at = ?
         WHERE id = ? AND run_id = ?",
    )
    .bind(&now)
    .bind(output_ref)
    .bind(&now)
    .bind(step_id)
    .bind(run_id)
    .execute(pool)
    .await?
    .rows_affected();

    if affected > 0 {
        append_pipeline_event(
            pool,
            run_id,
            Some(step_id),
            "step_completed",
            json!({
                "stepId": step_id,
                "outputRef": output_ref,
            }),
            "system",
        )
        .await?;
    }
    Ok(())
}

async fn mark_step_retrying(
    pool: &SqlitePool,
    run_id: &str,
    step: &PipelineStepRow,
    reason: Option<&str>,
    next_input_summary: Option<&str>,
) -> Result<()> {
    let now = now_iso();
    let step_id = step.id.as_str();
    let next_retry_at = calculate_next_retry_at(step, &now);
    let affected = sqlx::query(
        "UPDATE pipeline_run_steps
         SET status = 'retrying',
             ai_task_id = NULL,
             completed_at = NULL,
             output_ref = NULL,
             error_message = ?,
             last_error_at = ?,
             input_summary = COALESCE(?, input_summary),
             run_version = COALESCE(run_version, 1) + 1,
             updated_at = ?
         WHERE id = ? AND run_id = ?",
    )
    .bind(reason)
    .bind(&now)
    .bind(next_input_summary)
    .bind(&now)
    .bind(step_id)
    .bind(run_id)
    .execute(pool)
    .await?
    .rows_affected();

    if affected > 0 {
        append_pipeline_event(
            pool,
            run_id,
            Some(step_id),
            "step_retry",
            json!({
                "stepId": step_id,
                "reason": reason,
                "nextInputSummarySet": next_input_summary.is_some(),
                "nextRetryAt": next_retry_at,
            }),
            "system",
        )
        .await?;
    }
    Ok(())
}

async fn mark_step_blocked_for_retry(
    pool: &SqlitePool,
    run_id: &str,
    step_id: &str,
    reason: Option<&str>,
) -> Result<()> {
    let now = now_iso();
    sqlx::query(
        "UPDATE pipeline_run_steps
         SET status = 'blocked',
             ai_task_id = NULL,
             completed_at = NULL,
             error_message = ?,
             last_error_at = ?,
             run_version = COALESCE(run_version, 1) + 1,
             updated_at = ?
         WHERE id = ? AND run_id = ?",
    )
    .bind(reason)
    .bind(&now)
    .bind(&now)
    .bind(step_id)
    .bind(run_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_step_failed(
    pool: &SqlitePool,
    run_id: &str,
    step_id: &str,
    reason: &str,
) -> Result<()> {
    let now = now_iso();
    let affected = sqlx::query(
        "UPDATE pipeline_run_steps
         SET status = 'failed',
             error_message = ?,
             last_error_at = ?,
             completed_at = COALESCE(completed_at, ?),
             run_version = COALESCE(run_version, 1) + 1,
             updated_at = ?
         WHERE id = ? AND run_id = ?",
    )
    .bind(reason)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .bind(step_id)
    .bind(run_id)
    .execute(pool)
    .await?
    .rows_affected();

    if affected > 0 {
        append_pipeline_event(
            pool,
            run_id,
            Some(step_id),
            "step_failed",
            json!({
                "stepId": step_id,
                "reason": reason,
            }),
            "system",
        )
        .await?;
    }
    Ok(())
}

async fn set_step_status(
    pool: &SqlitePool,
    run_id: &str,
    step_id: &str,
    status: &str,
    error_message: Option<&str>,
    clear_task: bool,
) -> Result<()> {
    let now = now_iso();
    if clear_task {
        sqlx::query(
            "UPDATE pipeline_run_steps
             SET status = ?,
                 ai_task_id = NULL,
                 error_message = ?,
                 run_version = COALESCE(run_version, 1) + 1,
                 updated_at = ?
             WHERE id = ? AND run_id = ?",
        )
        .bind(status)
        .bind(error_message)
        .bind(&now)
        .bind(step_id)
        .bind(run_id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            "UPDATE pipeline_run_steps
             SET status = ?,
                 error_message = ?,
                 run_version = COALESCE(run_version, 1) + 1,
                 updated_at = ?
             WHERE id = ? AND run_id = ?",
        )
        .bind(status)
        .bind(error_message)
        .bind(&now)
        .bind(step_id)
        .bind(run_id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn insert_step_output(
    pool: &SqlitePool,
    run_id: &str,
    step_id: &str,
    task_id: Option<&str>,
    output_type: &str,
    output_json: Option<&str>,
    raw_content: Option<String>,
    review_decision: Option<&str>,
    review_score: Option<f64>,
    review_issues: Option<Value>,
    retry_hints: Option<Value>,
) -> Result<String> {
    let output_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO pipeline_step_outputs (
            id, run_id, step_id, task_id, output_type,
            output_json, raw_content,
            review_decision, review_score, review_issues_json, retry_hints_json,
            created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
    )
    .bind(&output_id)
    .bind(run_id)
    .bind(step_id)
    .bind(task_id)
    .bind(output_type)
    .bind(output_json)
    .bind(raw_content)
    .bind(review_decision)
    .bind(review_score)
    .bind(review_issues.map(|v| v.to_string()))
    .bind(retry_hints.map(|v| v.to_string()))
    .execute(pool)
    .await?;

    Ok(output_id)
}
