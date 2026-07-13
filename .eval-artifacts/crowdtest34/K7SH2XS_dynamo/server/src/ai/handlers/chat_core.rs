use super::assistant_actions::{
    build_assistant_action_workflow_guard, claim_confirmed_action_source,
    execute_assistant_actions, load_confirmed_action_source, merge_action_results_into_content,
    merge_workflow_guards, preview_assistant_actions,
    reconcile_confirmed_action_source_after_execution, split_assistant_action_block,
};
use super::*;
use crate::ai::catalog_handlers;
use crate::conversation::model::Message;

pub(super) async fn prepare_chat_request(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    execution_stage: &str,
) -> AppResult<PreparedChatRequest> {
    let messages = build_conversation_messages(pool, context, execution_stage).await?;
    let input_chars = message_char_count(&messages);
    Ok(PreparedChatRequest {
        messages,
        input_chars,
    })
}

pub(super) async fn persist_user_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
) -> AppResult<Message> {
    let mut meta_json = serde_json::Map::new();
    if let Some(message_id) = context.confirmed_workflow_guard_message_id.as_ref() {
        meta_json.insert(
            "confirmedWorkflowGuardMessageId".to_string(),
            serde_json::Value::String(message_id.clone()),
        );
    }
    if !context.resource_refs.is_empty() {
        meta_json.insert(
            "resourceRefs".to_string(),
            serde_json::to_value(&context.resource_refs).unwrap_or_else(|_| serde_json::json!([])),
        );
    }
    let meta = if meta_json.is_empty() {
        None
    } else {
        Some(to_json(&serde_json::Value::Object(meta_json)))
    };

    let message = conversation::repo::add_user_message_with_snapshot(
        pool,
        &context.conversation,
        &context.content,
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        None,
        None,
        meta.as_deref(),
    )
    .await?;

    Ok(message)
}

pub(super) async fn save_assistant_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    model: &str,
    content: &str,
    usage: Option<&crate::ai::client::TokenUsage>,
    task_id: Option<&str>,
    action_results: &[AssistantActionResult],
    pending_action_envelope: Option<&AssistantActionEnvelope>,
    project_workflow: Option<&ProjectWorkflowSummary>,
    workflow_guard: Option<&WorkflowGuard>,
) -> AppResult<()> {
    let usage_str = usage
        .as_ref()
        .map(|usage| serde_json::to_string(usage).unwrap_or_default());
    let meta = build_message_meta(
        context,
        Some(model),
        None,
        task_id,
        Some(action_results),
        pending_action_envelope,
        project_workflow,
        workflow_guard,
    );

    let saved_message = conversation::repo::add_message(
        pool,
        &context.conversation.id,
        "assistant",
        content,
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        Some(model),
        usage_str.as_deref(),
        Some(&meta),
    )
    .await?;

    if let Some(envelope) = pending_action_envelope {
        persist_pending_action_audits(pool, context, &saved_message.id, envelope).await?;
    }

    Ok(())
}

pub(super) async fn create_streaming_assistant_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    model: &str,
) -> AppResult<Message> {
    let meta = build_streaming_message_meta(context, model, "running", None);
    conversation::repo::add_message(
        pool,
        &context.conversation.id,
        "assistant",
        "AI 正在思考中...",
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        Some(model),
        None,
        Some(&meta),
    )
    .await
}

pub(super) async fn create_task_streaming_assistant_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    model: &str,
    task_id: &str,
    task_status: &str,
    content: &str,
) -> AppResult<Message> {
    let meta = build_task_streaming_message_meta(context, model, task_id, task_status, None);
    conversation::repo::add_message(
        pool,
        &context.conversation.id,
        "assistant",
        content,
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        Some(model),
        None,
        Some(&meta),
    )
    .await
}

pub(super) async fn update_streaming_assistant_message_content(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    message_id: &str,
    model: &str,
    content: &str,
) -> AppResult<()> {
    let meta = build_streaming_message_meta(context, model, "running", None);
    conversation::repo::update_message_streaming_content(
        pool,
        &context.conversation.id,
        message_id,
        content,
        Some(model),
        Some(&meta),
    )
    .await?;
    Ok(())
}

pub(super) async fn update_task_streaming_assistant_message_content(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    message_id: &str,
    model: &str,
    task_id: &str,
    task_status: &str,
    content: &str,
) -> AppResult<()> {
    let meta = build_task_streaming_message_meta(context, model, task_id, task_status, None);
    conversation::repo::update_message_streaming_content(
        pool,
        &context.conversation.id,
        message_id,
        content,
        Some(model),
        Some(&meta),
    )
    .await?;
    Ok(())
}

pub(super) async fn finalize_streaming_assistant_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    message_id: &str,
    model: &str,
    content: &str,
    usage: Option<&crate::ai::client::TokenUsage>,
    action_results: &[AssistantActionResult],
    pending_action_envelope: Option<&AssistantActionEnvelope>,
    project_workflow: Option<&ProjectWorkflowSummary>,
    workflow_guard: Option<&WorkflowGuard>,
) -> AppResult<()> {
    let usage_str = usage
        .as_ref()
        .map(|usage| serde_json::to_string(usage).unwrap_or_default());
    let meta = build_message_meta(
        context,
        Some(model),
        None,
        None,
        Some(action_results),
        pending_action_envelope,
        project_workflow,
        workflow_guard,
    );

    conversation::repo::replace_message(
        pool,
        &context.conversation.id,
        message_id,
        "assistant",
        content,
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        Some(model),
        usage_str.as_deref(),
        Some(&meta),
    )
    .await?;

    if let Some(envelope) = pending_action_envelope {
        persist_pending_action_audits(pool, context, message_id, envelope).await?;
    }

    Ok(())
}

pub(super) async fn finalize_task_streaming_assistant_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    message_id: &str,
    model: &str,
    content: &str,
    usage: Option<&crate::ai::client::TokenUsage>,
    task_id: &str,
    action_results: &[AssistantActionResult],
    pending_action_envelope: Option<&AssistantActionEnvelope>,
    project_workflow: Option<&ProjectWorkflowSummary>,
    workflow_guard: Option<&WorkflowGuard>,
) -> AppResult<()> {
    let usage_str = usage
        .as_ref()
        .map(|usage| serde_json::to_string(usage).unwrap_or_default());
    let meta = build_message_meta(
        context,
        Some(model),
        None,
        Some(task_id),
        Some(action_results),
        pending_action_envelope,
        project_workflow,
        workflow_guard,
    );

    conversation::repo::replace_message(
        pool,
        &context.conversation.id,
        message_id,
        "assistant",
        content,
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        Some(model),
        usage_str.as_deref(),
        Some(&meta),
    )
    .await?;

    if let Some(envelope) = pending_action_envelope {
        persist_pending_action_audits(pool, context, message_id, envelope).await?;
    }

    Ok(())
}

pub(super) async fn fail_streaming_assistant_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    message_id: &str,
    model: &str,
    error_message: &str,
) -> AppResult<()> {
    let meta = build_streaming_message_meta(context, model, "failed", Some(error_message));
    conversation::repo::replace_message(
        pool,
        &context.conversation.id,
        message_id,
        "system",
        &format!("任务失败：{}", error_message),
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        Some(model),
        None,
        Some(&meta),
    )
    .await?;
    Ok(())
}

pub(super) async fn fail_task_streaming_assistant_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    message_id: &str,
    model: &str,
    task_id: &str,
    error_message: &str,
) -> AppResult<()> {
    let meta =
        build_task_streaming_message_meta(context, model, task_id, "failed", Some(error_message));
    conversation::repo::replace_message(
        pool,
        &context.conversation.id,
        message_id,
        "system",
        &format!("任务失败：{}", error_message),
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        Some(model),
        None,
        Some(&meta),
    )
    .await?;
    Ok(())
}

fn assistant_action_type(action: &AssistantAction) -> &'static str {
    match action {
        AssistantAction::AssignExistingAgent { .. } => "assign_existing_agent",
        AssistantAction::CreateProjectAgent { .. } => "create_project_agent",
        AssistantAction::RemoveProjectAgent { .. } => "remove_project_agent",
        AssistantAction::SearchProjectFiles { .. } => "search_project_files",
        AssistantAction::CreateProjectDirectory { .. } => "create_project_directory",
        AssistantAction::CreateProjectFile { .. } => "create_project_file",
        AssistantAction::DeleteProjectPath { .. } => "delete_project_path",
        AssistantAction::MoveProjectPath { .. } => "move_project_path",
    }
}

fn assistant_action_envelope_hash(envelope: &AssistantActionEnvelope) -> AppResult<String> {
    let payload = serde_json::to_vec(envelope)
        .map_err(|error| AppError::Internal(format!("序列化助理动作失败: {}", error)))?;
    let digest = Sha256::digest(payload);
    Ok(digest.iter().map(|byte| format!("{:02x}", byte)).collect())
}

async fn persist_pending_action_audits(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    message_id: &str,
    envelope: &AssistantActionEnvelope,
) -> AppResult<()> {
    if envelope.actions.is_empty() {
        return Ok(());
    }

    let envelope_hash = assistant_action_envelope_hash(envelope)?;
    let now = chrono::Utc::now().to_rfc3339();

    for action in &envelope.actions {
        let action_payload = serde_json::to_string(action)
            .map_err(|error| AppError::Internal(format!("序列化助理动作失败: {}", error)))?;
        let action_type = assistant_action_type(action);
        let audit_id = Uuid::new_v4().to_string();

        sqlx::query(
            "INSERT INTO assistant_action_audits (
                id, run_id, user_id, project_id, conversation_id,
                message_id, action_type, action_payload,
                execution_status, envelope_hash, created_at, updated_at
             ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        )
        .bind(&audit_id)
        .bind(&context.conversation.user_id)
        .bind(&context.conversation.project_id)
        .bind(&context.conversation.id)
        .bind(message_id)
        .bind(action_type)
        .bind(&action_payload)
        .bind(&envelope_hash)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    Ok(())
}

pub(super) fn build_message_meta_value(
    context: &ResolvedChatContext,
    model: Option<&str>,
    error_message: Option<&str>,
    task_id: Option<&str>,
    action_results: Option<&[AssistantActionResult]>,
    pending_action_envelope: Option<&AssistantActionEnvelope>,
    project_workflow: Option<&ProjectWorkflowSummary>,
    workflow_guard: Option<&WorkflowGuard>,
) -> serde_json::Value {
    serde_json::json!({
        "provider": context.endpoint.provider.as_str(),
        "taskId": task_id,
        "model": model,
        "operation": context.operation.as_str(),
        "resourceRefs": &context.resource_refs,
        "outputKind": context.output_kind.as_str(),
        "outputItems": context.output_items,
        "attemptIndex": context.execution.attempt_index,
        "previousAttempts": context.execution.previous_attempts,
        "previousFailures": context.execution.previous_failures,
        "previousSuccesses": context.execution.previous_successes,
        "isRedo": context.execution.attempt_index > 1,
        "agentStatus": format!("{:?}", context.execution.agent_runtime_state).to_ascii_lowercase(),
        "activeTasks": context.execution.agent_active_tasks,
        "queuedTasks": context.execution.agent_queued_tasks,
        "lastError": error_message.or(context.execution.last_error_message.as_deref()),
        "assistantActions": action_results,
        "pendingAssistantActions": pending_action_envelope,
        "projectWorkflow": project_workflow,
        "workflowGuard": workflow_guard,
    })
}

fn build_streaming_message_meta(
    context: &ResolvedChatContext,
    model: &str,
    task_status: &str,
    error_message: Option<&str>,
) -> String {
    let mut meta = build_message_meta_value(
        context,
        Some(model),
        error_message,
        None,
        None,
        None,
        None,
        None,
    );
    if let Some(meta_obj) = meta.as_object_mut() {
        meta_obj.insert(
            "taskStatus".to_string(),
            serde_json::Value::String(task_status.to_string()),
        );
        meta_obj.insert(
            "operation".to_string(),
            serde_json::Value::String("stream".to_string()),
        );
    }
    meta.to_string()
}

fn build_task_streaming_message_meta(
    context: &ResolvedChatContext,
    model: &str,
    task_id: &str,
    task_status: &str,
    error_message: Option<&str>,
) -> String {
    let mut meta = build_message_meta_value(
        context,
        Some(model),
        error_message,
        Some(task_id),
        None,
        None,
        None,
        None,
    );
    if let Some(meta_obj) = meta.as_object_mut() {
        meta_obj.insert(
            "taskStatus".to_string(),
            serde_json::Value::String(task_status.to_string()),
        );
        meta_obj.insert(
            "operation".to_string(),
            serde_json::Value::String("task".to_string()),
        );
    }
    meta.to_string()
}

async fn build_conversation_messages(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    execution_stage: &str,
) -> AppResult<Vec<ChatMessage>> {
    let history = conversation::repo::list_message_history(pool, &context.conversation.id).await?;
    let mut messages = Vec::new();
    let runtime_prompt = build_execution_prompt(context, history.len(), execution_stage);

    let system_prompt = [
        context.system_prompt.as_deref().map(str::trim),
        context.agent.as_ref().map(|item| item.system_prompt.trim()),
        Some(runtime_prompt.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");

    if !system_prompt.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
        });
    }

    for message in history {
        messages.push(ChatMessage {
            role: if message.role == "assistant" {
                "assistant".to_string()
            } else {
                message.role
            },
            content: message.content,
        });
    }

    Ok(messages)
}

pub(super) async fn resolve_chat_context(
    state: &AppState,
    user_id: &str,
    req: AiChatReq,
    operation: AiUsageOperation,
    stream_fallback_mode: StreamFallbackMode,
) -> AppResult<ResolvedChatContext> {
    let content = req.content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::Validation("content 不能为空".into()));
    }

    let conversation = ensure_conversation_access(state, user_id, &req.conversation_id).await?;
    let resource_refs = normalize_resource_refs(req.resource_refs.clone());
    let agent = load_agent_for_request(
        &state.db,
        user_id,
        &conversation.project_id,
        req.agent_id.as_deref(),
    )
    .await?;
    let endpoint = get_endpoint_for_request(state, user_id, &req, agent.as_ref()).await?;
    let model = req
        .model
        .as_deref()
        .or(agent.as_ref().and_then(|item| item.model.as_deref()))
        .or(endpoint.default_model.as_deref())
        .unwrap_or("gpt-4o-mini")
        .to_string();
    let temperature = agent
        .as_ref()
        .map(|item| item.temperature)
        .or(req.temperature);
    let top_p = req.top_p;
    let frequency_penalty = req.frequency_penalty;
    let max_tokens = agent
        .as_ref()
        .map(|item| item.max_tokens)
        .or(req.max_tokens);
    let output_kind = usage::parse_resource_kind(req.output_kind.as_deref())?;
    let output_items = usage::normalize_output_items(req.output_items);
    let confirmed_action_source = if req.allow_assistant_actions {
        load_confirmed_action_source(
            &state.db,
            user_id,
            &conversation.id,
            req.confirmed_message_id.as_deref(),
        )
        .await?
    } else {
        None
    };
    let execution = build_execution_context(
        state,
        user_id,
        &conversation,
        agent.as_ref(),
        operation,
        output_kind,
        &content,
        &resource_refs,
    )
    .await?;

    Ok(ResolvedChatContext {
        conversation,
        agent,
        endpoint,
        content,
        resource_refs,
        model,
        system_prompt: normalize_optional(req.system_prompt),
        temperature,
        top_p,
        frequency_penalty,
        max_tokens,
        stream_fallback_mode,
        output_kind,
        output_items,
        operation,
        confirmed_action_source,
        confirmed_workflow_guard_message_id: normalize_optional(
            req.confirmed_workflow_guard_message_id,
        ),
        trigger_source: req.trigger_source.clone(),
        explicit_endpoint_id: req.endpoint_id.clone(),
        allow_assistant_actions: req.allow_assistant_actions,
        execution,
    })
}

pub(super) async fn build_execution_context(
    state: &AppState,
    user_id: &str,
    conversation: &Conversation,
    agent: Option<&Agent>,
    operation: AiUsageOperation,
    output_kind: usage::AiUsageResourceKind,
    content: &str,
    resource_refs: &[ResourceRef],
) -> AppResult<ExecutionPromptContext> {
    let request_fingerprint = usage::fingerprint_request(content);
    let attempt_group_key = usage::build_attempt_group_key(
        user_id,
        Some(conversation.project_id.as_str()),
        Some(conversation.id.as_str()),
        agent.map(|item| item.id.as_str()),
        output_kind,
        operation,
        content,
    );

    let summary = sqlx::query_as::<_, RetrySummaryRow>(
        "SELECT
             COUNT(*) AS previous_attempts,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS previous_failures,
             COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS previous_successes
         FROM ai_usage_events
         WHERE user_id = ? AND attempt_group_key = ?",
    )
    .bind(user_id)
    .bind(&attempt_group_key)
    .fetch_one(&state.db)
    .await?;

    let last_error = sqlx::query_as::<_, RetryErrorRow>(
        "SELECT error_message
         FROM ai_usage_events
         WHERE user_id = ? AND attempt_group_key = ? AND status = 'failed'
         ORDER BY created_at DESC
         LIMIT 1",
    )
    .bind(user_id)
    .bind(&attempt_group_key)
    .fetch_optional(&state.db)
    .await?;

    let runtime_stats_map = state.ai_runtime.agent_runtime_stats(user_id).await;
    let runtime_stats = agent
        .and_then(|item| runtime_stats_map.get(&item.id).cloned())
        .unwrap_or_default();
    let project_context =
        load_project_execution_context(state, user_id, &conversation.project_id, resource_refs)
            .await?;

    Ok(ExecutionPromptContext {
        request_fingerprint,
        attempt_group_key,
        attempt_index: summary.previous_attempts + 1,
        previous_attempts: summary.previous_attempts,
        previous_failures: summary.previous_failures,
        previous_successes: summary.previous_successes,
        last_error_message: last_error.and_then(|row| normalize_optional(row.error_message)),
        agent_runtime_state: AiTaskRuntime::derive_state(&runtime_stats),
        agent_active_tasks: runtime_stats.active_tasks,
        agent_queued_tasks: runtime_stats.queued_tasks,
        project_name: project_context.project_name,
        project_status: project_context.project_status,
        project_phase: project_context.project_phase,
        project_role_counts: project_context.project_role_counts,
        project_roster: project_context.project_roster,
        reusable_agents: project_context.reusable_agents,
        project_workflow: project_context.project_workflow,
        referenced_assets: project_context.referenced_assets,
    })
}

async fn load_project_execution_context(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    resource_refs: &[ResourceRef],
) -> AppResult<ProjectExecutionContext> {
    let project = ensure_project_access(&state.db, user_id, project_id).await?;
    let roster_map = catalog_handlers::load_project_agent_contacts(
        &state.db,
        &state.ai_runtime,
        user_id,
        std::slice::from_ref(&project.id),
    )
    .await?;
    let project_roster = roster_map.get(&project.id).cloned().unwrap_or_default();
    let project_role_counts = catalog_handlers::build_project_role_counts(&project_roster);
    let all_agents =
        catalog_handlers::load_agent_contacts(&state.db, &state.ai_runtime, user_id).await?;
    let assigned_agent_ids = project_roster
        .iter()
        .map(|agent| agent.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let reusable_agents = all_agents
        .into_iter()
        .filter(|agent| !assigned_agent_ids.contains(&agent.id))
        .collect::<Vec<_>>();

    let asset_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM assets WHERE project_id = ?")
            .bind(&project.id)
            .fetch_one(&state.db)
            .await?;
    let script_ready = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM scripts WHERE project_id = ? AND TRIM(content) != ''",
    )
    .bind(&project.id)
    .fetch_one(&state.db)
    .await?
        > 0;
    let storyboard_line_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)
         FROM storyboard_lines sl
         INNER JOIN storyboards s ON s.id = sl.storyboard_id
         WHERE s.project_id = ?",
    )
    .bind(&project.id)
    .fetch_one(&state.db)
    .await?;
    let conversation_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM conversations WHERE project_id = ? AND user_id = ?",
    )
    .bind(&project.id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    let message_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)
         FROM messages m
         INNER JOIN conversations c ON c.id = m.conversation_id
         WHERE c.project_id = ? AND c.user_id = ?",
    )
    .bind(&project.id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    let task_counts = state.ai_runtime.project_task_counts(user_id).await;
    let referenced_assets =
        load_referenced_asset_contexts(&state.db, user_id, &project.id, resource_refs).await?;
    let project_workflow = catalog_handlers::build_project_workflow_summary(
        &project.status,
        &project.phase,
        asset_count,
        script_ready,
        storyboard_line_count,
        conversation_count,
        message_count,
        project_roster.len() as i64,
        task_counts.get(&project.id).copied().unwrap_or_default(),
        project_role_counts.clone(),
    );

    Ok(ProjectExecutionContext {
        project_name: project.name,
        project_status: project.status,
        project_phase: project.phase,
        project_role_counts,
        project_roster,
        reusable_agents,
        project_workflow,
        referenced_assets,
    })
}

async fn load_referenced_asset_contexts(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    resource_refs: &[ResourceRef],
) -> AppResult<Vec<ReferencedAssetContext>> {
    let mut assets = Vec::new();

    for resource_ref in resource_refs {
        let asset = sqlx::query_as::<_, ReferencedAssetRow>(
            "SELECT a.id, a.project_id, p.name AS project_name, a.name, a.asset_type, a.metadata, a.created_at
             FROM assets a
             INNER JOIN projects p ON p.id = a.project_id
             WHERE a.id = ? AND p.user_id = ?",
        )
        .bind(&resource_ref.id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Validation(format!(
            "引用的资源不存在或无权访问: {}",
            resource_ref.name
        )))?;
        assets.push(ReferencedAssetContext {
            id: asset.id,
            project_name: asset.project_name,
            name: asset.name,
            asset_type: asset.asset_type,
            version_label: asset_version_label(asset.metadata.as_deref())
                .or_else(|| resource_ref.version_label.clone())
                .unwrap_or_else(|| "当前版".to_string()),
            created_at: asset.created_at,
            is_current_project: asset.project_id == project_id,
        });
    }

    Ok(assets)
}

pub(super) fn build_execution_prompt(
    context: &ResolvedChatContext,
    history_len: usize,
    execution_stage: &str,
) -> String {
    let mut lines = vec![
        "[执行上下文]".to_string(),
        format!("当前执行通道: {}", context.operation.as_str()),
        format!("当前执行阶段: {}", execution_stage),
        format!(
            "当前项目: {}，项目状态: {}，当前阶段: {}，阶段进度: {}%",
            context.execution.project_name,
            context.execution.project_status,
            context.execution.project_phase,
            context.execution.project_workflow.progress_percent
        ),
        format!("当前对话历史消息数: {}", history_len),
        format!(
            "当前任务产出类型: {}，目标产出数量: {}",
            context.output_kind.as_str(),
            context.output_items
        ),
        format!(
            "当前任务组: {}，请求指纹: {}",
            compact_text(&context.execution.attempt_group_key),
            compact_text(&context.execution.request_fingerprint)
        ),
        format!(
            "当前请求是否携带已确认的项目成员调整授权: {}",
            if context.confirmed_action_source.is_some() { "是" } else { "否" }
        ),
        format!(
            "本次是该任务组的第 {} 次尝试；之前已尝试 {} 次，失败 {} 次，成功 {} 次。",
            context.execution.attempt_index,
            context.execution.previous_attempts,
            context.execution.previous_failures,
            context.execution.previous_successes
        ),
        format!(
            "当前项目角色计数: 设计 {}，审核 {}，主编 {}，管理 {}，其他 {}。",
            context.execution.project_role_counts.design,
            context.execution.project_role_counts.review,
            context.execution.project_role_counts.editor,
            context.execution.project_role_counts.manager,
            context.execution.project_role_counts.custom
        ),
        format!(
            "当前项目流程概览: 资产 {}，剧本 {}，分镜镜头 {}，对话 {}，消息 {}，成员 {}，任务队列 {}/{}/{}/{}(排队/执行中/完成/失败)。",
            context.execution.project_workflow.asset_count,
            if context.execution.project_workflow.script_ready { "已完成" } else { "未完成" },
            context.execution.project_workflow.storyboard_line_count,
            context.execution.project_workflow.conversation_count,
            context.execution.project_workflow.message_count,
            context.execution.project_workflow.assigned_agent_count,
            context.execution.project_workflow.queued_task_count,
            context.execution.project_workflow.running_task_count,
            context.execution.project_workflow.completed_task_count,
            context.execution.project_workflow.failed_task_count,
        ),
    ];

    if context.execution.project_roster.is_empty() {
        lines.push("当前项目还没有绑定任何智能体成员。".to_string());
    } else {
        lines.push("当前项目负责成员:".to_string());
        for agent in &context.execution.project_roster {
            lines.push(format!(
                "- {} | 职责分类 {} | 角色 {} | 当前状态 {} | 执行中 {} | 排队 {}",
                agent.name,
                role_kind_label(agent.responsibility_kind.as_deref()),
                agent
                    .responsibility_label
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(agent.role.as_str()),
                runtime_state_label(agent.status),
                agent.active_tasks,
                agent.queued_tasks
            ));
        }
    }

    if context.execution.reusable_agents.is_empty() {
        lines.push("当前用户没有可复用但未加入本项目的智能体。".to_string());
    } else {
        lines.push("可复用但尚未加入当前项目的智能体:".to_string());
        for agent in context.execution.reusable_agents.iter().take(8) {
            lines.push(format!(
                "- {} | 分类 {} | 角色 {}",
                agent.name,
                role_kind_label(Some(responsibility_kind_for_agent(agent))),
                agent.role
            ));
        }
    }

    if context.execution.referenced_assets.is_empty() {
        lines.push("本次请求未显式引用资源。".to_string());
    } else {
        lines.push("本次请求显式引用的资源:".to_string());
        for asset in context.execution.referenced_assets.iter().take(8) {
            lines.push(format!(
                "- {} : {} : {} : {} | id {} | {} | 创建于 {}",
                asset.project_name,
                resource_type_label(&asset.asset_type),
                asset.name,
                asset.version_label,
                compact_text(&asset.id),
                if asset.is_current_project {
                    "当前项目资源"
                } else {
                    "跨项目参考资源"
                },
                asset.created_at
            ));
        }
    }

    if let Some(agent) = context.agent.as_ref() {
        lines.push(format!("你当前扮演的智能体: {}", agent.name));
        lines.push(format!("你的工作职责: {}", agent.role.trim()));
        if !agent.description.trim().is_empty() {
            lines.push(format!("职责说明: {}", agent.description.trim()));
        }
        lines.push(format!(
            "当前工作进度/负载: 状态 {}，执行中 {} 个，排队 {} 个。",
            runtime_state_label(context.execution.agent_runtime_state),
            context.execution.agent_active_tasks,
            context.execution.agent_queued_tasks
        ));
    }

    if let Some(error_message) = context.execution.last_error_message.as_deref() {
        lines.push(format!("最近一次失败原因: {}", compact_text(error_message)));
    }

    if context.execution.attempt_index > 1 {
        lines.push(
            "这是一次重做任务。你必须先输出“优化方案”小节，再输出“执行结果”小节。".to_string(),
        );
        lines.push("优化方案至少覆盖：问题复盘、本轮调整、风险兜底。".to_string());
        for hint in build_retry_optimization_hints(
            context.output_kind,
            context.execution.previous_failures,
            context.execution.last_error_message.as_deref(),
        ) {
            lines.push(format!("优化提示: {}", hint));
        }
    } else {
        lines.push("优先直接完成任务，不要复述系统规则。".to_string());
    }

    lines.push("默认仍以当前项目做判断、分工和进度汇报；如果用户显式引用了其他项目资源，只能把它们当参考资料，不能误记为当前项目资产。".to_string());
    lines.push("如果当前项目缺角色，优先从“可复用”名单里选择合适智能体；确实没有合适候选时，再建议创建新的项目智能体。".to_string());
    lines.push(
        "如果用户要求删除某个智能体，默认理解为“从当前项目移出”，不要推断为全局删除。".to_string(),
    );
    lines.push("如果用户想直接开始某个流程，但关键信息不足，不要直接开工。先输出可读说明，再在末尾追加 ```woohoo-confirm JSON 代码块。".to_string());
    lines.push("woohoo-confirm 需要包含: title, summary, confirmLabel, suggestedReply, items[]. items 字段里用 done 表示是否已具备，用 required 表示是否必需，用 hint 说明缺什么。".to_string());
    lines.push("只有在关键信息充分，或者用户明确确认“按当前条件继续”时，才真正进入流程执行；确认后如果仍有缺项，必须显式说明你采用了哪些假设。".to_string());
    lines.push("示例: ```woohoo-confirm {\"title\":\"进入分镜流程前确认\",\"summary\":\"当前项目还缺少分镜生成的关键输入。\",\"confirmLabel\":\"按当前条件启动\",\"suggestedReply\":\"我确认按当前条件进入分镜流程，请把缺失项按最小假设补齐并标注。\",\"items\":[{\"label\":\"目标风格\",\"done\":false,\"required\":true,\"hint\":\"需要写实/国风/赛博等方向\"},{\"label\":\"主角设定\",\"done\":true,\"required\":true,\"hint\":null}]} ```".to_string());
    lines.push(
        "涉及项目成员调整时，默认先给方案并请求确认；不要把当前回复里的成员变更直接落库。"
            .to_string(),
    );
    lines.push("可用动作: assign_existing_agent, create_project_agent, remove_project_agent, search_project_files, create_project_directory, create_project_file, delete_project_path, move_project_path。".to_string());
    lines.push("项目文件动作只允许在当前项目目录内执行，禁止越权访问其他目录。".to_string());
    lines.push("删除/移动属于危险动作，必须先征得用户确认后再执行。".to_string());
    lines.push("示例1: ```woohoo-actions {\"actions\":[{\"type\":\"assign_existing_agent\",\"agent_name\":\"分镜渲染师\",\"responsibility_kind\":\"design\",\"responsibility_label\":\"视觉设计\"}]} ```".to_string());
    lines.push("示例2: ```woohoo-actions {\"actions\":[{\"type\":\"search_project_files\",\"query\":\"分镜\",\"file_type\":\"md\",\"limit\":20}]} ```".to_string());
    lines.push("示例3: ```woohoo-actions {\"actions\":[{\"type\":\"create_project_file\",\"path\":\"notes/shot-plan.md\",\"content\":\"# 分镜计划\\n\",\"overwrite\":true}]} ```".to_string());
    lines.push("示例4(危险): ```woohoo-actions {\"actions\":[{\"type\":\"move_project_path\",\"from_path\":\"drafts/old.md\",\"to_path\":\"archive/old.md\",\"overwrite\":false}]} ```".to_string());
    lines.push("如果你提出了成员调整，请输出 woohoo-actions，再由系统生成确认卡片；用户确认后，系统会按已确认动作执行。".to_string());
    lines.push("如果不需要变更项目成员，就不要输出 woohoo-actions 代码块。".to_string());

    lines.join("\n")
}

fn build_retry_optimization_hints(
    output_kind: usage::AiUsageResourceKind,
    previous_failures: i64,
    last_error_message: Option<&str>,
) -> Vec<String> {
    let mut hints = vec![
        "先判断上一轮失败点，再明确这次具体调整，不要原样重复输出。".to_string(),
        "如果信息不充分，先补全关键假设，再给结果。".to_string(),
    ];

    match output_kind {
        usage::AiUsageResourceKind::Image | usage::AiUsageResourceKind::Video => {
            hints.push("先收紧镜头/主体/风格/时长等约束，再给生成方案。".to_string());
        }
        usage::AiUsageResourceKind::Document => {
            hints.push("先给结构大纲，再补全文档正文，避免直接堆砌内容。".to_string());
        }
        _ => {
            hints.push("先给步骤化方案，再输出最终正文，避免一次性大段无结构回答。".to_string());
        }
    }

    if previous_failures >= 2 {
        hints.push("连续失败较多，本轮优先缩小范围、减少冗余、降低一次性输出风险。".to_string());
    }

    if let Some(error_message) = last_error_message.map(compact_text) {
        let lowered = error_message.to_ascii_lowercase();
        if lowered.contains("timeout") || lowered.contains("timed out") {
            hints.push("上一轮疑似超时，本轮请更紧凑，优先输出最关键内容。".to_string());
        }
        if lowered.contains("token") || lowered.contains("context") || lowered.contains("length") {
            hints.push("上一轮疑似上下文过长，本轮先压缩上下文和输出长度。".to_string());
        }
        if lowered.contains("429") || lowered.contains("rate limit") {
            hints.push("上一轮疑似限流，本轮避免无效冗长推理，尽量一次命中。".to_string());
        }
        if lowered.contains("审核") || lowered.contains("安全") || lowered.contains("policy") {
            hints.push("上一轮涉及审核/安全问题，本轮先给合规替代方案，再给结果。".to_string());
        }
    }

    hints
}

pub(super) async fn finalize_assistant_response(
    state: &AppState,
    user_id: &str,
    context: &ResolvedChatContext,
    raw_content: &str,
) -> AppResult<FinalizedAssistantResponse> {
    let (content_without_guard, parsed_guard) = split_workflow_guard_block(raw_content);
    let (visible_content, action_envelope) = split_assistant_action_block(&content_without_guard);
    let mut action_results = Vec::new();
    let mut pending_action_envelope = None;
    let mut project_workflow = None;
    let mut workflow_guard = parsed_guard;

    if let Some(source) = context.confirmed_action_source.as_ref() {
        if claim_confirmed_action_source(&state.db, user_id, &context.conversation.id, source)
            .await?
        {
            let confirmed_results =
                execute_assistant_actions(state, user_id, context, source.envelope.clone()).await;
            reconcile_confirmed_action_source_after_execution(
                &state.db,
                user_id,
                &context.conversation.id,
                source,
                &confirmed_results,
            )
            .await?;
            action_results.extend(confirmed_results);
            if let Ok(project_context) = load_project_execution_context(
                state,
                user_id,
                &context.conversation.project_id,
                &context.resource_refs,
            )
            .await
            {
                project_workflow = Some(project_context.project_workflow);
            }
        }
    }

    if let Some(envelope) = action_envelope {
        let preview_results = preview_assistant_actions(&envelope);
        let action_workflow_guard = build_assistant_action_workflow_guard(&preview_results);
        workflow_guard = Some(match workflow_guard.take() {
            Some(existing_guard) => merge_workflow_guards(existing_guard, action_workflow_guard),
            None => action_workflow_guard,
        });
        pending_action_envelope = Some(envelope);
        action_results.extend(preview_results);
    }

    let content = merge_action_results_into_content(&visible_content, &action_results);
    Ok(FinalizedAssistantResponse {
        content,
        action_results,
        pending_action_envelope,
        project_workflow,
        workflow_guard,
    })
}

fn split_workflow_guard_block(content: &str) -> (String, Option<WorkflowGuard>) {
    let marker = "```woohoo-confirm";
    let Some(start) = content.find(marker) else {
        return (content.trim().to_string(), None);
    };
    let after_marker = &content[start + marker.len()..];
    let Some(end_offset) = after_marker.find("```") else {
        return (content.trim().to_string(), None);
    };
    let json_block = after_marker[..end_offset].trim();
    let Some(parsed) = serde_json::from_str::<WorkflowGuard>(json_block).ok() else {
        return (content.trim().to_string(), None);
    };
    let visible = format!(
        "{}\n{}",
        content[..start].trim(),
        after_marker[end_offset + 3..].trim()
    )
    .trim()
    .to_string();

    (visible, Some(parsed))
}
