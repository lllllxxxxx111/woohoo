use super::*;

pub(super) fn parse_depends_on(raw: &Option<String>) -> Vec<String> {
    let Some(raw) = raw.as_ref() else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    value
        .as_array()
        .into_iter()
        .flat_map(|items| items.iter())
        .filter_map(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

pub(super) fn resolve_dependency_steps<'a>(
    dependencies: &[String],
    steps: &'a [PipelineStepRow],
) -> Vec<&'a PipelineStepRow> {
    dependencies
        .iter()
        .filter_map(|dep| {
            steps
                .iter()
                .find(|candidate| candidate.id == *dep || candidate.step_key == *dep)
        })
        .collect()
}

pub(super) fn normalize_step_type(step: &PipelineStepRow) -> &'static str {
    match step
        .step_type
        .as_deref()
        .unwrap_or("design")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "review" => "review",
        "system" => "system",
        _ => "design",
    }
}

pub(super) fn is_success_step_status(status: &str) -> bool {
    status == "completed"
}

pub(super) fn is_failed_step_status(status: &str) -> bool {
    matches!(status, "failed" | "skipped")
}

pub(super) fn is_missing_ai_endpoint_error(error: &anyhow::Error) -> bool {
    if let Some(app_error) = error.downcast_ref::<AppError>() {
        return matches!(app_error, AppError::Validation(message) if message.contains("请先添加 AI 端点配置"));
    }

    error.to_string().contains("请先添加 AI 端点配置")
}

pub(super) fn is_missing_endpoint_block_reason(message: &str) -> bool {
    message.contains("缺少可用 AI 端点") || message.contains("请先添加 AI 端点配置")
}

pub(super) fn is_dependency_failed_skip_reason(message: &str) -> bool {
    message.contains(DEPENDENCY_FAILED_SKIP_REASON)
}

pub(super) fn is_dependency_unsatisfied_reason(message: &str) -> bool {
    message.contains("依赖")
        || message.contains("前置")
        || message.contains("未定义的依赖步骤")
        || message.contains("等待配置修复")
}

pub(super) fn find_retry_design_step<'a>(
    review_step: &PipelineStepRow,
    steps: &'a [PipelineStepRow],
) -> Option<&'a PipelineStepRow> {
    let dependencies = parse_depends_on(&review_step.depends_on_json);
    for dep in dependencies {
        if let Some(step) = steps
            .iter()
            .find(|candidate| candidate.id == dep || candidate.step_key == dep)
        {
            if normalize_step_type(step) == "design" {
                return Some(step);
            }
        }
    }

    steps
        .iter()
        .filter(|candidate| candidate.step_order < review_step.step_order)
        .rev()
        .find(|candidate| normalize_step_type(candidate) == "design")
}

pub(super) fn parse_review_decision(raw: &str) -> ReviewDecision {
    let Some(payload) = parse_json_payload(raw) else {
        let fallback_issue = compact_review_text(raw)
            .unwrap_or_else(|| "审核输出无法解析为 JSON，请按约定格式返回。".to_string());
        return ReviewDecision {
            decision: "fail",
            score: None,
            issues: json!([fallback_issue]),
            retry_hints: json!(["请根据上述评语修订大纲，并确保审核输出包含 decision、score、issues、retryHints。"]),
            parse_error: Some("review_parse_error".to_string()),
        };
    };

    let decision = payload
        .get("decision")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "fail".to_string());

    ReviewDecision {
        decision: if decision == "pass" { "pass" } else { "fail" },
        score: payload.get("score").and_then(Value::as_f64),
        issues: normalize_json_array(payload.get("issues")),
        retry_hints: normalize_json_array(
            payload
                .get("retryHints")
                .or_else(|| payload.get("retry_hints")),
        ),
        parse_error: None,
    }
}

fn compact_review_text(raw: &str) -> Option<String> {
    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim();
    if trimmed.is_empty() {
        return None;
    }

    let preview = if trimmed.chars().count() > 180 {
        format!("{}...", trimmed.chars().take(180).collect::<String>())
    } else {
        trimmed.to_string()
    };
    Some(format!("审核评语：{}", preview))
}

pub(super) fn parse_json_payload(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }

    for block in trimmed.split("```").skip(1).step_by(2) {
        let candidate = block
            .trim()
            .strip_prefix("json")
            .map(str::trim)
            .unwrap_or_else(|| block.trim());
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            return Some(value);
        }
    }

    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[start..=end]).ok()
}

pub(super) fn normalize_json_array(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        Some(Value::String(text)) if !text.trim().is_empty() => json!([text.trim()]),
        Some(Value::Null) | None => json!([]),
        Some(other) => json!([other]),
    }
}

pub(super) fn summarize_review_failure(review: &ReviewDecision) -> String {
    if let Some(code) = review.parse_error.as_deref() {
        return format!("审核失败：{}", code);
    }
    let issues = review
        .issues
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    if issues.is_empty() {
        "审核未通过，请根据反馈重试".to_string()
    } else {
        format!("审核未通过：{}", issues.join("；"))
    }
}

pub(super) fn derive_running_state_error(
    steps: &[PipelineStepRow],
) -> (Option<String>, Option<String>) {
    let has_dispatchable = steps.iter().any(|step| {
        if matches!(step.status.as_str(), "queued" | "running") {
            return true;
        }
        step.status == "retrying" && is_step_dispatch_ready(step)
    });
    if has_dispatchable {
        return (None, None);
    }

    let mut retry_due_list: Vec<String> = steps
        .iter()
        .filter(|step| step.status == "retrying")
        .filter_map(retry_not_due_until)
        .collect();
    retry_due_list.sort();
    if let Some(next_due_at) = retry_due_list.first() {
        return (
            Some(RUN_ERROR_RETRY_SCHEDULED.to_string()),
            Some(format!(
                "步骤处于自动重试退避中，预计于 {} 重试",
                next_due_at
            )),
        );
    }

    let blocked_steps: Vec<&PipelineStepRow> = steps
        .iter()
        .filter(|step| step.status == "blocked")
        .collect();
    if blocked_steps.is_empty() {
        return (None, None);
    }

    let mut reasons: Vec<String> = blocked_steps
        .iter()
        .filter_map(|step| step.error_message.as_deref())
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .collect();
    reasons.sort();
    reasons.dedup();

    if reasons.is_empty() {
        return (
            Some(RUN_ERROR_DEPENDENCY_UNSATISFIED.to_string()),
            Some("存在未满足前置条件，流程等待继续执行".to_string()),
        );
    }

    if let Some(reason) = reasons
        .iter()
        .find(|reason| is_missing_endpoint_block_reason(reason))
        .cloned()
    {
        return (Some(RUN_ERROR_MISSING_ENDPOINT.to_string()), Some(reason));
    }

    if let Some(reason) = reasons
        .iter()
        .find(|reason| is_dependency_unsatisfied_reason(reason))
        .cloned()
    {
        return (
            Some(RUN_ERROR_DEPENDENCY_UNSATISFIED.to_string()),
            Some(reason),
        );
    }

    (
        Some(RUN_ERROR_WAITING_PREREQUISITE.to_string()),
        Some(reasons[0].clone()),
    )
}

pub(super) fn derive_failed_run_error(steps: &[PipelineStepRow]) -> (String, String) {
    let failed_steps: Vec<&PipelineStepRow> = steps
        .iter()
        .filter(|step| step.status == "failed")
        .collect();
    if failed_steps.is_empty() {
        return (
            RUN_ERROR_EXECUTION_FAILED.to_string(),
            "流程执行失败".to_string(),
        );
    }

    let first_reason = failed_steps
        .iter()
        .filter_map(|step| step.error_message.as_deref())
        .map(str::trim)
        .find(|message| !message.is_empty())
        .unwrap_or("流程执行失败")
        .to_string();

    let requires_manual_review = failed_steps.iter().any(|step| {
        normalize_step_type(step) == "review"
            || step
                .error_message
                .as_deref()
                .map(|message| message.contains("审核"))
                .unwrap_or(false)
    });

    if requires_manual_review {
        (RUN_ERROR_MANUAL_REVIEW_REQUIRED.to_string(), first_reason)
    } else {
        (RUN_ERROR_EXECUTION_FAILED.to_string(), first_reason)
    }
}

pub(super) fn build_retry_prompt(
    original_prompt: Option<&str>,
    issues: &Value,
    retry_hints: &Value,
    parse_error: Option<&str>,
) -> String {
    let mut sections = vec![
        original_prompt
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("请根据审核反馈重做当前步骤。")
            .to_string(),
        "[审核反馈]".to_string(),
        format!("issues: {}", issues),
        format!("retryHints: {}", retry_hints),
    ];
    if let Some(code) = parse_error {
        sections.push(format!("parseError: {}", code));
    }
    sections.push("请修复后输出新的设计结果。".to_string());
    sections.join("\n")
}

pub(super) fn build_compact_preview(raw: &str) -> String {
    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 96 {
        compact
    } else {
        format!("{}...", compact.chars().take(96).collect::<String>())
    }
}

pub(super) fn extract_text_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flat_map(|items| items.iter())
        .map(|item| match item {
            Value::String(text) => text.trim().to_string(),
            other => other.to_string(),
        })
        .filter(|text| !text.is_empty() && text != "\"\"")
        .collect()
}

pub(super) fn should_enable_prompt_optimizer(step: &PipelineStepRow) -> bool {
    let Some(raw_policy) = step
        .review_policy_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };

    let Ok(value) = serde_json::from_str::<Value>(raw_policy) else {
        return false;
    };

    value
        .get("promptOptimizerBetaEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(super) fn summarize_prompt_optimization_hint(
    review_issues: &[String],
    retry_hints: &[String],
    parse_error: Option<&str>,
) -> String {
    if let Some(code) = parse_error {
        return format!("审核输出格式异常（{}），已补充格式约束建议。", code);
    }
    if let Some(issue) = review_issues.first() {
        return format!("优先修复：{}", issue);
    }
    if let Some(hint) = retry_hints.first() {
        return format!("优先执行：{}", hint);
    }
    "建议保持当前策略并持续收敛审核标准。".to_string()
}

pub(super) async fn record_prompt_optimization(
    pool: &SqlitePool,
    run: &PipelineRunRow,
    review_step: &PipelineStepRow,
    design_step: Option<&PipelineStepRow>,
    review: &ReviewDecision,
    review_issues: &[String],
    retry_hints: &[String],
) -> Result<Option<String>> {
    let has_signal =
        !review_issues.is_empty() || !retry_hints.is_empty() || review.parse_error.is_some();
    if !has_signal {
        return Ok(None);
    }

    let base_design_summary = design_step
        .and_then(|step| step.input_summary.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("请保持当前设计结构，但优先解决审核反馈问题。");

    let issue_lines = if review_issues.is_empty() {
        "- 本轮未提取到明确 issues，请补充审核依据。".to_string()
    } else {
        review_issues
            .iter()
            .map(|item| format!("- {}", item))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let hint_lines = if retry_hints.is_empty() {
        "- 按审核标准补充可执行细节并自检后再提交。".to_string()
    } else {
        retry_hints
            .iter()
            .map(|item| format!("- {}", item))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let design_prompt_patch = [
        "[流程自动优化建议 - 设计侧]",
        &format!("基线任务：{}", base_design_summary),
        "请在下一轮设计中优先修复以下问题：",
        &issue_lines,
        "建议补充动作：",
        &hint_lines,
        "要求：仅输出可执行方案，不要复述问题。",
    ]
    .join("\n");

    let review_prompt_patch = [
        "[流程自动优化建议 - 审核侧]",
        "请优先检查以下风险点：",
        &issue_lines,
        "并确认以下修复动作是否真实落地：",
        &hint_lines,
        "输出必须包含 decision/score/issues/retryHints/riskLevel 五个字段。",
    ]
    .join("\n");

    let rationale = json!({
        "decision": review.decision,
        "score": review.score,
        "issues": review_issues,
        "retryHints": retry_hints,
        "parseError": review.parse_error,
        "reviewStepKey": review_step.step_key,
        "relatedDesignStepKey": design_step.map(|step| step.step_key.clone()),
    });

    let optimization_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO pipeline_prompt_optimizations (
            id, run_id, step_id, project_id, conversation_id,
            decision, design_prompt_patch, review_prompt_patch, rationale_json, source,
            created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
    )
    .bind(&optimization_id)
    .bind(&run.id)
    .bind(&review_step.id)
    .bind(&run.project_id)
    .bind(&run.conversation_id)
    .bind("suggested")
    .bind(design_prompt_patch)
    .bind(review_prompt_patch)
    .bind(rationale.to_string())
    .bind("assistant")
    .execute(pool)
    .await?;

    Ok(Some(optimization_id))
}

pub(super) async fn append_assistant_step_summary(
    pool: &SqlitePool,
    run: &PipelineRunRow,
    step: &PipelineStepRow,
    summary: String,
    next_action: String,
) -> Result<()> {
    append_pipeline_event(
        pool,
        &run.id,
        Some(&step.id),
        "assistant_step_summary",
        json!({
            "stepId": step.id,
            "stepKey": step.step_key,
            "stepName": step.step_name,
            "stepType": normalize_step_type(step),
            "summary": summary,
            "nextAction": next_action,
        }),
        "assistant",
    )
    .await
}

pub(super) fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(super) async fn append_pipeline_event(
    pool: &SqlitePool,
    run_id: &str,
    step_id: Option<&str>,
    event_type: &str,
    payload: Value,
    source: &str,
) -> Result<()> {
    let event_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO pipeline_run_events (id, run_id, step_id, event_type, payload_json, source)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&event_id)
    .bind(run_id)
    .bind(step_id)
    .bind(event_type)
    .bind(payload.to_string())
    .bind(source)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        compute_retry_delay_seconds, derive_failed_run_error, derive_running_state_error,
        extract_text_list, normalize_json_array, parse_json_payload, parse_review_decision,
        pick_next_dispatchable_step, PipelineStepRow, RUN_ERROR_DEPENDENCY_UNSATISFIED,
        RUN_ERROR_EXECUTION_FAILED, RUN_ERROR_MANUAL_REVIEW_REQUIRED, RUN_ERROR_MISSING_ENDPOINT,
        RUN_ERROR_RETRY_SCHEDULED,
    };
    use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
    use serde_json::json;

    #[test]
    fn parse_json_from_codeblock() {
        let raw = "```json\n{\"decision\":\"pass\",\"issues\":[],\"retryHints\":[]}\n```";
        let value = parse_json_payload(raw).expect("json should parse");
        assert_eq!(value.get("decision").and_then(|v| v.as_str()), Some("pass"));
    }

    #[test]
    fn review_parse_error_to_fail() {
        let review = parse_review_decision("not-json");
        assert_eq!(review.decision, "fail");
        assert!(review.parse_error.is_some());
    }

    #[test]
    fn review_parse_error_preserves_plain_text_feedback() {
        let review = parse_review_decision("结构还可以，但缺少结尾反转和角色动机说明。");
        let issues = extract_text_list(&review.issues);
        let hints = extract_text_list(&review.retry_hints);

        assert_eq!(review.decision, "fail");
        assert!(issues
            .first()
            .is_some_and(|item| item.contains("缺少结尾反转")));
        assert!(hints
            .first()
            .is_some_and(|item| item.contains("decision")));
    }

    #[test]
    fn normalize_array_from_string() {
        assert_eq!(normalize_json_array(Some(&json!("x"))), json!(["x"]));
    }

    fn build_step(
        step_type: Option<&str>,
        status: &str,
        error_message: Option<&str>,
    ) -> PipelineStepRow {
        PipelineStepRow {
            id: "s1".to_string(),
            step_key: "step".to_string(),
            step_name: "Step".to_string(),
            step_order: 1,
            step_type: step_type.map(str::to_string),
            depends_on_json: Some("[]".to_string()),
            review_policy_json: None,
            ai_task_id: None,
            status: status.to_string(),
            attempt_count: 1,
            max_retries: 2,
            input_summary: None,
            error_message: error_message.map(str::to_string),
            last_error_at: None,
        }
    }

    #[test]
    fn running_state_error_marks_missing_endpoint_when_blocked_by_endpoint() {
        let steps = vec![build_step(
            Some("design"),
            "blocked",
            Some("缺少可用 AI 端点，请先在设置中配置并激活端点后重试"),
        )];

        let (code, message) = derive_running_state_error(&steps);
        assert_eq!(code.as_deref(), Some(RUN_ERROR_MISSING_ENDPOINT));
        assert!(message.unwrap_or_default().contains("缺少可用 AI 端点"));
    }

    #[test]
    fn running_state_error_marks_dependency_unsatisfied_for_dependency_block() {
        let steps = vec![build_step(
            Some("design"),
            "blocked",
            Some("存在未定义的依赖步骤，等待配置修复"),
        )];

        let (code, message) = derive_running_state_error(&steps);
        assert_eq!(code.as_deref(), Some(RUN_ERROR_DEPENDENCY_UNSATISFIED));
        assert!(message.unwrap_or_default().contains("依赖"));
    }

    #[test]
    fn failed_error_marks_manual_review_required_for_review_step() {
        let steps = vec![build_step(
            Some("review"),
            "failed",
            Some("审核未通过：缺少关键字段"),
        )];
        let (code, message) = derive_failed_run_error(&steps);
        assert_eq!(code, RUN_ERROR_MANUAL_REVIEW_REQUIRED);
        assert!(message.contains("审核未通过"));
    }

    #[test]
    fn failed_error_marks_execution_failed_for_non_review_step() {
        let steps = vec![build_step(Some("design"), "failed", Some("生成阶段超时"))];
        let (code, message) = derive_failed_run_error(&steps);
        assert_eq!(code, RUN_ERROR_EXECUTION_FAILED);
        assert!(message.contains("超时"));
    }

    #[test]
    fn retry_delay_uses_network_backoff_and_exponential() {
        let mut step = build_step(Some("design"), "retrying", Some("network timeout"));
        step.attempt_count = 3;
        let delay = compute_retry_delay_seconds(&step);
        assert!(delay >= 24);
    }

    #[test]
    fn retrying_step_not_dispatchable_before_due_time() {
        let mut step = build_step(Some("design"), "retrying", Some("暂时失败"));
        step.attempt_count = 1;
        step.last_error_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
        let selected = pick_next_dispatchable_step(&[step]);
        assert!(selected.is_none());
    }

    #[test]
    fn retrying_step_dispatchable_after_due_time() {
        let mut step = build_step(Some("design"), "retrying", Some("暂时失败"));
        step.attempt_count = 1;
        step.last_error_at = Some(
            (Utc::now() - ChronoDuration::seconds(120)).to_rfc3339_opts(SecondsFormat::Secs, true),
        );
        let selected = pick_next_dispatchable_step(&[step]);
        assert!(selected.is_some());
    }

    #[test]
    fn running_state_error_marks_retry_scheduled_when_retry_waiting() {
        let mut step = build_step(Some("design"), "retrying", Some("network timeout"));
        step.attempt_count = 1;
        step.last_error_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));

        let (code, message) = derive_running_state_error(&[step]);
        assert_eq!(code.as_deref(), Some(RUN_ERROR_RETRY_SCHEDULED));
        assert!(message.unwrap_or_default().contains("自动重试退避中"));
    }
}
