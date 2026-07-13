use super::*;

pub(crate) fn compact_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

pub(crate) async fn load_agent_for_request(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    agent_id: Option<&str>,
) -> AppResult<Option<Agent>> {
    match agent_id {
        Some(agent_id) => {
            let agent = sqlx::query_as::<_, Agent>(
                "SELECT a.*
                 FROM agents a
                 INNER JOIN project_agent_assignments pa
                    ON pa.agent_id = a.id
                   AND pa.project_id = ?
                   AND pa.user_id = a.user_id
                   AND pa.is_active = 1
                 WHERE a.id = ? AND a.user_id = ? AND a.is_active = 1",
            )
            .bind(project_id)
            .bind(agent_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| {
                AppError::NotFound("指定的智能体不存在、未加入当前项目或不属于当前用户".into())
            })?;
            Ok(Some(agent))
        }
        None => Ok(None),
    }
}

pub(crate) async fn ensure_project_access(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
) -> AppResult<project::model::Project> {
    let project = project::repo::find_by_id(pool, project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;

    if project.user_id != user_id {
        return Err(AppError::Forbidden("无权访问当前项目".into()));
    }

    Ok(project)
}

pub(crate) async fn ensure_agent_access(
    pool: &SqlitePool,
    user_id: &str,
    agent_id: &str,
) -> AppResult<Agent> {
    sqlx::query_as::<_, Agent>(
        "SELECT * FROM agents WHERE id = ? AND user_id = ? AND is_active = 1",
    )
    .bind(agent_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("指定的智能体不存在或不属于当前用户".into()))
}

pub(crate) async fn upsert_project_agent_assignment(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    agent_id: &str,
    responsibility_kind: Option<&str>,
    responsibility_label: Option<&str>,
    assignment_source: &str,
) -> AppResult<()> {
    let agent = ensure_agent_access(pool, user_id, agent_id).await?;
    let normalized_kind = normalize_responsibility_kind(
        responsibility_kind,
        Some(agent.name.as_str()),
        Some(agent.role.as_str()),
    );
    let normalized_label = normalize_optional(responsibility_label.map(str::to_string))
        .unwrap_or_else(|| role_kind_label(Some(normalized_kind)).to_string());

    sqlx::query(
        "INSERT INTO project_agent_assignments (
             id, user_id, project_id, agent_id, responsibility_kind, responsibility_label,
             assignment_source, is_active
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(project_id, agent_id) DO UPDATE SET
             is_active = 1,
             responsibility_kind = excluded.responsibility_kind,
             responsibility_label = excluded.responsibility_label,
             assignment_source = excluded.assignment_source,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(user_id)
    .bind(project_id)
    .bind(agent_id)
    .bind(normalized_kind)
    .bind(normalized_label)
    .bind(assignment_source)
    .execute(pool)
    .await?;

    Ok(())
}

/**
 * 事务版本的upsert_project_agent_assignment，用于在事务中执行项目智能体绑定操作
 * 接受事务对象而非连接池，确保在同一个事务中完成多个数据库操作
 */
pub(crate) async fn upsert_project_agent_assignment_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: &str,
    project_id: &str,
    agent_id: &str,
    responsibility_kind: Option<&str>,
    responsibility_label: Option<&str>,
    assignment_source: &str,
) -> AppResult<()> {
    let normalized_kind = normalize_responsibility_kind(responsibility_kind, None, None);
    let normalized_label = normalize_optional(responsibility_label.map(str::to_string))
        .unwrap_or_else(|| role_kind_label(Some(normalized_kind)).to_string());

    sqlx::query(
        "INSERT INTO project_agent_assignments (
             id, user_id, project_id, agent_id, responsibility_kind, responsibility_label,
             assignment_source, is_active
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(project_id, agent_id) DO UPDATE SET
             is_active = 1,
             responsibility_kind = excluded.responsibility_kind,
             responsibility_label = excluded.responsibility_label,
             assignment_source = excluded.assignment_source,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(user_id)
    .bind(project_id)
    .bind(agent_id)
    .bind(normalized_kind)
    .bind(normalized_label)
    .bind(assignment_source)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

/**
 * 生成安全的SQL占位符字符串
 * 用于处理动态数量的 IN 子句参数
 *
 * 安全保障：
 * - 仅生成由 '?' 和 ',' 组成的字符串
 * - 不接受任何用户输入作为参数
 * - 通过正则表达式验证输出格式
 */
pub(crate) fn generate_safe_sql_placeholders(count: usize) -> String {
    if count == 0 {
        return String::from("NULL");
    }

    let placeholders: String = (0..count).map(|_| "?").collect::<Vec<_>>().join(", ");

    // 验证生成的占位符只包含合法字符（? 和 , 和 空格）
    if !placeholders
        .chars()
        .all(|c| c == '?' || c == ',' || c == ' ')
    {
        tracing::error!("SQL占位符生成异常: {}", placeholders);
        panic!("SQL占位符包含非法字符");
    }

    placeholders
}

pub(crate) async fn validate_agent_endpoint_access(
    pool: &SqlitePool,
    user_id: &str,
    endpoint_id: Option<&str>,
) -> AppResult<()> {
    let Some(endpoint_id) = endpoint_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };

    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(1) FROM ai_endpoints WHERE id = ? AND user_id = ?",
    )
    .bind(endpoint_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    if exists == 0 {
        return Err(AppError::Validation(
            "绑定的 AI 端点不存在或不属于当前用户".into(),
        ));
    }

    Ok(())
}

pub(crate) async fn ensure_conversation_access(
    state: &AppState,
    user_id: &str,
    conversation_id: &str,
) -> AppResult<Conversation> {
    let conversation = conversation::repo::find_by_id(&state.db, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("对话不存在".into()))?;

    if conversation.user_id != user_id {
        return Err(AppError::Forbidden("无权访问".into()));
    }

    Ok(conversation)
}

pub(crate) async fn get_endpoint_for_request(
    state: &AppState,
    user_id: &str,
    req: &AiChatReq,
    agent: Option<&Agent>,
) -> AppResult<AiEndpoint> {
    if let Some(endpoint_id) = &req.endpoint_id {
        return sqlx::query_as::<_, AiEndpoint>(
            "SELECT * FROM ai_endpoints WHERE id = ? AND user_id = ?",
        )
        .bind(endpoint_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("AI 端点不存在".into()));
    }

    if let Some(agent) = agent {
        if let Some(endpoint_id) = &agent.endpoint_id {
            return sqlx::query_as::<_, AiEndpoint>(
                "SELECT * FROM ai_endpoints WHERE id = ? AND user_id = ?",
            )
            .bind(endpoint_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("Agent 绑定的 AI 端点不存在".into()));
        }
    }

    get_default_endpoint(state, user_id).await
}

pub(crate) async fn get_default_endpoint(state: &AppState, user_id: &str) -> AppResult<AiEndpoint> {
    sqlx::query_as::<_, AiEndpoint>(
        "SELECT * FROM ai_endpoints
         WHERE user_id = ? AND is_active = 1
         ORDER BY created_at ASC
         LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Validation("请先添加 AI 端点配置".into()))
}

pub(crate) fn task_matches_filter(task: &AiTask, filter: &AiTaskFilter) -> bool {
    if let Some(project_id) = filter.project_id.as_deref() {
        if task.project_id != project_id {
            return false;
        }
    }

    if let Some(conversation_id) = filter.conversation_id.as_deref() {
        if task.conversation_id != conversation_id {
            return false;
        }
    }

    true
}

pub(crate) fn is_task_cancel_reason(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered.contains("用户取消")
        || lowered.contains("会话已撤回")
        || lowered.contains("任务已取消")
        || lowered.contains("cancel")
}

pub(crate) async fn should_abort_task_execution(
    state: &AppState,
    user_id: &str,
    task_id: &str,
) -> bool {
    match state.ai_runtime.get_task(user_id, task_id).await {
        None => true,
        Some(task) => {
            matches!(task.status, AiTaskStatus::Failed | AiTaskStatus::Cancelled)
                && task
                    .error
                    .as_deref()
                    .map(is_task_cancel_reason)
                    .unwrap_or(false)
        }
    }
}

pub(crate) fn normalize_resource_refs(value: Option<Vec<ResourceRef>>) -> Vec<ResourceRef> {
    let mut seen = HashSet::new();

    value
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let id = item.id.trim().to_string();
            let name = item.name.trim().to_string();
            let resource_type = item.resource_type.trim().to_string();
            if id.is_empty() || name.is_empty() || resource_type.is_empty() {
                return None;
            }
            if !seen.insert(id.clone()) {
                return None;
            }

            Some(ResourceRef {
                id,
                name,
                resource_type,
                project_id: normalize_optional(item.project_id),
                project_name: normalize_optional(item.project_name),
                version_label: normalize_optional(item.version_label),
            })
        })
        .take(12)
        .collect()
}

pub(crate) fn asset_version_label(metadata: Option<&str>) -> Option<String> {
    let metadata = metadata?;
    let parsed = serde_json::from_str::<serde_json::Value>(metadata).ok()?;

    if let Some(label) = parsed
        .get("versionLabel")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(label.to_string());
    }

    match parsed
        .get("reviewStatus")
        .and_then(|value| value.as_str())
        .map(str::trim)
    {
        Some("approved") => return Some("已审核".to_string()),
        Some("rejected") => return Some("待修订".to_string()),
        _ => {}
    }

    match parsed
        .get("derivationType")
        .and_then(|value| value.as_str())
        .map(str::trim)
    {
        Some("optimized") => return Some("优化版".to_string()),
        Some("remake") => return Some("重制版".to_string()),
        Some("variant") => return Some("变体版".to_string()),
        _ => {}
    }

    if parsed.get("parentAssetId").is_some() || parsed.get("sourceAssetId").is_some() {
        return Some("派生版".to_string());
    }

    Some("当前版".to_string())
}

pub(crate) fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub(crate) fn is_stale_confirmed_action_claim(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .and_then(|timestamp| {
            let age =
                chrono::Utc::now().signed_duration_since(timestamp.with_timezone(&chrono::Utc));
            Some(age.num_seconds() >= CONFIRMED_ACTION_CLAIM_TTL_SECS)
        })
        .unwrap_or(true)
}

pub(crate) fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

pub(crate) fn resource_type_label(value: &str) -> &str {
    match value {
        "image" => "图片",
        "video" => "视频",
        "audio" => "音频",
        "document" => "文档",
        _ => "其他",
    }
}

pub(crate) fn default_pass_rate(badge: &str) -> f64 {
    match badge {
        "审核" => 0.99,
        "资深" => 0.92,
        "主编" => 0.9,
        "管理" => 0.94,
        "视觉" => 0.88,
        "设定" => 0.65,
        _ => 0.85,
    }
}

pub(crate) fn normalize_responsibility_kind(
    value: Option<&str>,
    name: Option<&str>,
    role: Option<&str>,
) -> &'static str {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        match value {
            "design" | "设计" => return "design",
            "review" | "审核" => return "review",
            "editor" | "主编" | "编辑" => return "editor",
            "manager" | "管理" => return "manager",
            _ => {}
        }
    }

    let lowered = format!("{} {}", name.unwrap_or(""), role.unwrap_or("")).to_ascii_lowercase();
    if lowered.contains("审核")
        || lowered.contains("review")
        || lowered.contains("风控")
        || lowered.contains("合规")
    {
        "review"
    } else if lowered.contains("主编")
        || lowered.contains("编辑")
        || lowered.contains("大纲")
        || lowered.contains("writer")
        || lowered.contains("editor")
    {
        "editor"
    } else if lowered.contains("管理")
        || lowered.contains("经理")
        || lowered.contains("统筹")
        || lowered.contains("manager")
        || lowered.contains("pm")
    {
        "manager"
    } else if lowered.contains("设计")
        || lowered.contains("视觉")
        || lowered.contains("分镜")
        || lowered.contains("人物")
        || lowered.contains("render")
        || lowered.contains("design")
    {
        "design"
    } else {
        "custom"
    }
}

pub(crate) fn responsibility_kind_for_agent(agent: &AgentContact) -> &'static str {
    normalize_responsibility_kind(
        agent.responsibility_kind.as_deref(),
        Some(agent.name.as_str()),
        Some(agent.role.as_str()),
    )
}

pub(crate) fn role_kind_label(value: Option<&str>) -> &'static str {
    match value {
        Some("design") | Some("设计") => "设计",
        Some("review") | Some("审核") => "审核",
        Some("editor") | Some("主编") | Some("编辑") => "主编",
        Some("manager") | Some("管理") => "管理",
        _ => "其他",
    }
}

pub(crate) fn phase_progress_percent(phase: &str) -> i64 {
    match phase {
        "ideation" => 10,
        "script" => 35,
        "storyboard" => 60,
        "shooting" => 75,
        "post" => 90,
        "publish" => 100,
        _ => 0,
    }
}

pub(crate) fn resolve_stream_fallback_mode(
    request_flag: Option<bool>,
    headers: Option<&HeaderMap>,
) -> StreamFallbackMode {
    let header_value = headers
        .and_then(|items| items.get(STREAM_FALLBACK_HEADER))
        .or_else(|| headers.and_then(|items| items.get(STREAM_FALLBACK_HEADER_LEGACY)))
        .and_then(|value| value.to_str().ok())
        .and_then(parse_bool_flag);

    match header_value.or(request_flag) {
        Some(true) => StreamFallbackMode::Force,
        Some(false) => StreamFallbackMode::Disable,
        None => StreamFallbackMode::Auto,
    }
}

pub(crate) fn parse_bool_flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub(crate) fn validate_connection_fields(
    provider: &str,
    base_url: &str,
    api_key: &str,
) -> AppResult<()> {
    if provider.trim().is_empty() {
        return Err(AppError::Validation("provider 不能为空".into()));
    }

    if base_url.trim().is_empty() {
        return Err(AppError::Validation("baseUrl 不能为空".into()));
    }

    if provider_requires_api_key(provider) && api_key.trim().is_empty() {
        return Err(AppError::Validation("apiKey 不能为空".into()));
    }

    Ok(())
}

pub(crate) fn provider_requires_api_key(provider: &str) -> bool {
    !matches!(
        provider.trim().to_ascii_lowercase().as_str(),
        "mock" | "ollama"
    )
}

pub(crate) fn build_usage_record(
    user_id: &str,
    context: &ResolvedChatContext,
    operation: AiUsageOperation,
    status: AiUsageStatus,
    latency_ms: i64,
    input_chars: i64,
    output_chars: i64,
    usage: UsageNumbers,
    error_message: Option<String>,
) -> RecordAiUsageInput {
    build_direct_usage_record(
        user_id,
        Some(context.conversation.project_id.clone()),
        Some(context.conversation.id.clone()),
        context.agent.as_ref().map(|item| item.id.clone()),
        Some(context.endpoint.id.clone()),
        &context.endpoint.provider,
        &context.endpoint.api_key,
        Some(context.model.clone()),
        operation,
        status,
        context.output_kind,
        if status == AiUsageStatus::Success {
            context.output_items
        } else {
            0
        },
        &context.content,
        latency_ms,
        input_chars,
        output_chars,
        usage,
        context.trigger_source.clone(),
        error_message,
    )
}

pub(crate) fn build_direct_usage_record(
    user_id: &str,
    project_id: Option<String>,
    conversation_id: Option<String>,
    agent_id: Option<String>,
    endpoint_id: Option<String>,
    provider: &str,
    api_key: &str,
    model: Option<String>,
    operation: AiUsageOperation,
    status: AiUsageStatus,
    output_kind: usage::AiUsageResourceKind,
    output_items: i64,
    content: &str,
    latency_ms: i64,
    input_chars: i64,
    output_chars: i64,
    usage: UsageNumbers,
    trigger_source: Option<String>,
    error_message: Option<String>,
) -> RecordAiUsageInput {
    let request_fingerprint = usage::fingerprint_request(content);
    let attempt_group_key = usage::build_attempt_group_key(
        user_id,
        project_id.as_deref(),
        conversation_id.as_deref(),
        agent_id.as_deref(),
        output_kind,
        operation,
        content,
    );

    RecordAiUsageInput {
        user_id: user_id.to_string(),
        project_id,
        conversation_id,
        agent_id,
        endpoint_id,
        api_key_fingerprint: usage::fingerprint_api_key(api_key),
        provider: provider.to_string(),
        model,
        operation,
        status,
        resource_kind: output_kind,
        output_items: output_items.max(0),
        latency_ms,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        token_source: usage.token_source,
        input_chars,
        output_chars,
        request_fingerprint,
        attempt_group_key,
        trigger_source,
        error_message,
    }
}

pub(crate) async fn record_usage_safe(pool: &SqlitePool, record: RecordAiUsageInput) {
    match usage::record(pool, record).await {
        Ok(()) => {}
        Err(error) => {
            tracing::warn!("Failed to record AI usage: {}", error);
        }
    }
}

pub(crate) fn ai_usage_credit_cost(record: &RecordAiUsageInput) -> f64 {
    if record.status != AiUsageStatus::Success || record.operation == AiUsageOperation::Test {
        return 0.0;
    }

    let total_tokens = record.total_tokens.max(0);
    if total_tokens == 0 {
        return 0.0;
    }

    (total_tokens as f64 / 1000.0).max(0.01)
}

pub(crate) async fn record_usage_and_bill_safe(pool: &SqlitePool, record: RecordAiUsageInput) {
    let credit_cost = ai_usage_credit_cost(&record);
    let should_bill = credit_cost > 0.0;
    let user_id = record.user_id.clone();
    let reason = format!("ai_usage_{}", record.operation.as_str());
    let ref_id = record.request_fingerprint.clone();

    match usage::record(pool, record).await {
        Ok(()) => {}
        Err(error) => {
            tracing::warn!("Failed to record AI usage: {}", error);
            return;
        }
    }

    if !should_bill {
        return;
    }

    if let Err(error) = crate::billing::repo::check_and_deduct(
        pool,
        &user_id,
        credit_cost,
        &reason,
        Some("ai_usage"),
        Some(&ref_id),
    )
    .await
    {
        tracing::warn!(
            user_id = %user_id,
            credit_cost,
            error = %error,
            "Failed to record AI usage billing transaction"
        );
    }
}

pub(crate) fn message_char_count(messages: &[ChatMessage]) -> i64 {
    messages
        .iter()
        .map(|message| message.content.chars().count() as i64)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::usage::{
        AiUsageOperation, AiUsageResourceKind, AiUsageStatus, AiUsageTokenSource,
        RecordAiUsageInput,
    };
    use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

    fn usage_record(
        operation: AiUsageOperation,
        status: AiUsageStatus,
        total_tokens: i64,
    ) -> RecordAiUsageInput {
        RecordAiUsageInput {
            user_id: "test-user".to_string(),
            project_id: None,
            conversation_id: None,
            agent_id: None,
            endpoint_id: None,
            api_key_fingerprint: "test-key".to_string(),
            provider: "mock".to_string(),
            model: Some("mock-model".to_string()),
            operation,
            status,
            resource_kind: AiUsageResourceKind::Text,
            output_items: 1,
            latency_ms: 1,
            prompt_tokens: total_tokens,
            completion_tokens: 0,
            total_tokens,
            token_source: AiUsageTokenSource::Estimated,
            input_chars: 0,
            output_chars: 0,
            request_fingerprint: "request".to_string(),
            attempt_group_key: "attempt".to_string(),
            trigger_source: None,
            error_message: None,
        }
    }

    #[test]
    fn ai_usage_credit_cost_only_bills_successful_runtime_usage() {
        let chat = usage_record(AiUsageOperation::Chat, AiUsageStatus::Success, 1_500);
        assert_eq!(ai_usage_credit_cost(&chat), 1.5);

        let tiny_chat = usage_record(AiUsageOperation::Chat, AiUsageStatus::Success, 1);
        assert_eq!(ai_usage_credit_cost(&tiny_chat), 0.01);

        let failed_chat = usage_record(AiUsageOperation::Chat, AiUsageStatus::Failed, 1_500);
        assert_eq!(ai_usage_credit_cost(&failed_chat), 0.0);

        let test_request = usage_record(AiUsageOperation::Test, AiUsageStatus::Success, 1_500);
        assert_eq!(ai_usage_credit_cost(&test_request), 0.0);
    }

    async fn setup_usage_billing_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("failed to create in-memory sqlite pool");

        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("failed to enable foreign keys");

        sqlx::query(
            "CREATE TABLE users (
                id TEXT PRIMARY KEY NOT NULL,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL
             )",
        )
        .execute(&pool)
        .await
        .expect("failed to create users table");

        sqlx::query(
            "CREATE TABLE user_credits (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                balance REAL NOT NULL DEFAULT 100,
                total_earned REAL NOT NULL DEFAULT 0,
                total_spent REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
             )",
        )
        .execute(&pool)
        .await
        .expect("failed to create user_credits table");

        sqlx::query(
            "CREATE TABLE credit_transactions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                amount REAL NOT NULL,
                balance_after REAL NOT NULL,
                kind TEXT NOT NULL,
                reason TEXT,
                ref_type TEXT,
                ref_id TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
             )",
        )
        .execute(&pool)
        .await
        .expect("failed to create credit_transactions table");

        sqlx::query(
            "CREATE TABLE ai_usage_events (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id TEXT,
                conversation_id TEXT,
                agent_id TEXT,
                endpoint_id TEXT,
                api_key_fingerprint TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL,
                model TEXT,
                operation TEXT NOT NULL,
                status TEXT NOT NULL,
                resource_kind TEXT NOT NULL DEFAULT 'text',
                output_items INTEGER NOT NULL DEFAULT 0,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                token_source TEXT NOT NULL DEFAULT 'unavailable',
                input_chars INTEGER NOT NULL DEFAULT 0,
                output_chars INTEGER NOT NULL DEFAULT 0,
                request_fingerprint TEXT NOT NULL DEFAULT '',
                attempt_group_key TEXT NOT NULL DEFAULT '',
                attempt_index INTEGER NOT NULL DEFAULT 1,
                is_redo INTEGER NOT NULL DEFAULT 0,
                trigger_source TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
             )",
        )
        .execute(&pool)
        .await
        .expect("failed to create ai_usage_events table");

        sqlx::query(
            "INSERT INTO users (id, username, email, password_hash)
             VALUES ('test-user', 'test-user', 'test-user@example.test', 'test')",
        )
        .execute(&pool)
        .await
        .expect("failed to insert test user");

        pool
    }

    #[tokio::test]
    async fn record_usage_and_bill_safe_writes_spent_transaction_for_success() {
        let pool = setup_usage_billing_pool().await;

        let success = usage_record(AiUsageOperation::Chat, AiUsageStatus::Success, 1_500);
        record_usage_and_bill_safe(&pool, success).await;

        let spent = sqlx::query_scalar::<_, f64>(
            "SELECT COALESCE(SUM(amount), 0)
             FROM credit_transactions
             WHERE user_id = 'test-user' AND kind = 'spent' AND ref_type = 'ai_usage'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to query spent transactions");
        assert_eq!(spent, 1.5);

        let balance = sqlx::query_scalar::<_, f64>(
            "SELECT balance FROM user_credits WHERE user_id = 'test-user'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to query credit balance");
        assert_eq!(balance, 98.5);

        let failed = usage_record(AiUsageOperation::Chat, AiUsageStatus::Failed, 1_500);
        record_usage_and_bill_safe(&pool, failed).await;

        let spent_after_failed = sqlx::query_scalar::<_, f64>(
            "SELECT COALESCE(SUM(amount), 0)
             FROM credit_transactions
             WHERE user_id = 'test-user' AND kind = 'spent' AND ref_type = 'ai_usage'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to query spent transactions after failed usage");
        assert_eq!(spent_after_failed, 1.5);
    }
}
