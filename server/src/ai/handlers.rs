use std::{
    cmp::min,
    collections::HashSet,
    convert::Infallible,
    path::{Component, Path as StdPath, PathBuf},
    time::{Duration, Instant, SystemTime},
};

mod chat_core;
use chat_core::{
    build_execution_context, build_message_meta_value, create_streaming_assistant_message,
    create_task_streaming_assistant_message, fail_streaming_assistant_message,
    fail_task_streaming_assistant_message, finalize_assistant_response,
    finalize_streaming_assistant_message, finalize_task_streaming_assistant_message,
    persist_user_message, prepare_chat_request, resolve_chat_context, save_assistant_message,
    update_streaming_assistant_message_content, update_task_streaming_assistant_message_content,
};

mod assistant_actions;
use assistant_actions::visible_stream_content;

mod shared;
use shared::*;
pub(super) use shared::{
    default_pass_rate, ensure_agent_access, ensure_project_access, generate_safe_sql_placeholders,
    normalize_optional, phase_progress_percent, resolve_stream_fallback_mode,
    responsibility_kind_for_agent, task_matches_filter, to_json, upsert_project_agent_assignment,
    upsert_project_agent_assignment_tx, validate_agent_endpoint_access, validate_connection_fields,
};

use axum::{
    extract::{Extension, Path, State},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::{stream::Stream, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use tokio::fs;
use uuid::Uuid;

use crate::{
    auth::middleware::UserId,
    conversation::{self, model::Conversation},
    error::{AppError, AppResult},
    project, AppState,
};

use super::{
    client::{ChatMessage, StreamFallbackMode},
    config::{
        Agent, AgentContact, AgentRuntimeState, AiChatReq, AiEndpoint, AiEndpointTestReq, AiTask,
        AiTaskFilter, AiTaskStatus, AiTestReq, ProjectRoleCounts, ProjectWorkflowSummary,
        ResourceRef,
    },
    policy::AssistantActionPolicy,
    runtime::AiTaskRuntime,
    usage::{self, AiUsageOperation, AiUsageStatus, RecordAiUsageInput, UsageNumbers},
};

#[derive(Clone)]
struct ResolvedChatContext {
    conversation: Conversation,
    agent: Option<Agent>,
    endpoint: AiEndpoint,
    /// 解密后的明文 API Key，仅在内存中存在，绝不序列化或写入日志。
    /// 由 `resolve_chat_context` 在加载 endpoint 后立即解密填充，
    /// 所有 AI 调用和 usage 记录都应使用此字段而非 `endpoint.api_key`。
    decrypted_api_key: String,
    content: String,
    resource_refs: Vec<ResourceRef>,
    model: String,
    system_prompt: Option<String>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    frequency_penalty: Option<f64>,
    max_tokens: Option<i64>,
    stream_fallback_mode: StreamFallbackMode,
    output_kind: usage::AiUsageResourceKind,
    output_items: i64,
    operation: AiUsageOperation,
    confirmed_action_source: Option<ConfirmedAssistantActionSource>,
    confirmed_workflow_guard_message_id: Option<String>,
    /**
     * 触发来源：用于区分正常发送、编辑后发送、撤回后重新发送
     */
    trigger_source: Option<String>,
    execution: ExecutionPromptContext,
}

struct PreparedChatRequest {
    messages: Vec<ChatMessage>,
    input_chars: i64,
    /// 与该会话上一次请求的共享前缀占比（cache_probe 在 prepare 时计算并记录）。
    prompt_prefix_hit_ratio: Option<f64>,
}

#[derive(Clone)]
struct ExecutionPromptContext {
    request_fingerprint: String,
    attempt_group_key: String,
    attempt_index: i64,
    previous_attempts: i64,
    previous_failures: i64,
    previous_successes: i64,
    last_error_message: Option<String>,
    agent_runtime_state: AgentRuntimeState,
    agent_active_tasks: i64,
    agent_queued_tasks: i64,
    project_name: String,
    project_status: String,
    project_phase: String,
    project_role_counts: ProjectRoleCounts,
    project_roster: Vec<AgentContact>,
    reusable_agents: Vec<AgentContact>,
    project_workflow: ProjectWorkflowSummary,
    referenced_assets: Vec<ReferencedAssetContext>,
}

#[derive(sqlx::FromRow)]
struct RetrySummaryRow {
    previous_attempts: i64,
    previous_failures: i64,
    previous_successes: i64,
}

#[derive(sqlx::FromRow)]
struct RetryErrorRow {
    error_message: Option<String>,
}

#[derive(Clone)]
struct ProjectExecutionContext {
    project_name: String,
    project_status: String,
    project_phase: String,
    project_role_counts: ProjectRoleCounts,
    project_roster: Vec<AgentContact>,
    reusable_agents: Vec<AgentContact>,
    project_workflow: ProjectWorkflowSummary,
    referenced_assets: Vec<ReferencedAssetContext>,
}

#[derive(Debug, Clone, FromRow)]
struct ReferencedAssetRow {
    id: String,
    project_id: String,
    project_name: String,
    name: String,
    asset_type: String,
    metadata: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone)]
struct ReferencedAssetContext {
    id: String,
    project_name: String,
    name: String,
    asset_type: String,
    version_label: String,
    created_at: String,
    is_current_project: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AssistantActionEnvelope {
    actions: Vec<AssistantAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AssistantAction {
    AssignExistingAgent {
        agent_id: Option<String>,
        agent_name: Option<String>,
        responsibility_kind: Option<String>,
        responsibility_label: Option<String>,
    },
    CreateProjectAgent {
        name: String,
        role: String,
        description: Option<String>,
        system_prompt: Option<String>,
        endpoint_id: Option<String>,
        model: Option<String>,
        temperature: Option<f64>,
        max_tokens: Option<i64>,
        badge: Option<String>,
        responsibility_kind: Option<String>,
        responsibility_label: Option<String>,
    },
    RemoveProjectAgent {
        agent_id: Option<String>,
        agent_name: Option<String>,
    },
    SearchProjectFiles {
        query: Option<String>,
        file_type: Option<String>,
        created_after: Option<String>,
        created_before: Option<String>,
        min_size: Option<i64>,
        max_size: Option<i64>,
        limit: Option<usize>,
    },
    CreateProjectDirectory {
        path: String,
    },
    CreateProjectFile {
        path: String,
        content: String,
        overwrite: Option<bool>,
    },
    DeleteProjectPath {
        path: String,
        recursive: Option<bool>,
    },
    MoveProjectPath {
        from_path: String,
        to_path: String,
        overwrite: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantActionResult {
    action_type: String,
    status: String,
    summary: String,
    agent_id: Option<String>,
    agent_name: Option<String>,
    responsibility_kind: Option<String>,
    responsibility_label: Option<String>,
}

struct FinalizedAssistantResponse {
    content: String,
    action_results: Vec<AssistantActionResult>,
    pending_action_envelope: Option<AssistantActionEnvelope>,
    project_workflow: Option<ProjectWorkflowSummary>,
    workflow_guard: Option<WorkflowGuard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowGuardChecklistItem {
    label: String,
    done: bool,
    required: bool,
    hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowGuard {
    title: String,
    summary: Option<String>,
    confirm_label: Option<String>,
    suggested_reply: Option<String>,
    confirmed_at: Option<String>,
    consumed_at: Option<String>,
    reopened_at: Option<String>,
    items: Vec<WorkflowGuardChecklistItem>,
}

#[derive(Debug, Clone)]
struct ConfirmedAssistantActionSource {
    message_id: String,
    envelope: AssistantActionEnvelope,
    original_meta: String,
}

const CONFIRMED_ACTION_CLAIM_TTL_SECS: i64 = 300;

/**
 * 动作执行安全限制常量
 */
const MAX_ACTIONS_PER_ENVELOPE: usize = 10;
const MAX_FIELD_LENGTH: usize = 256;
const MAX_SYSTEM_PROMPT_LENGTH: usize = 4000;
const MAX_PROJECT_PATH_LENGTH: usize = 512;
const MAX_PROJECT_FILE_CONTENT_LENGTH: usize = 1_000_000;
const MAX_PROJECT_FILE_SEARCH_RESULTS: usize = 200;

/**
 * 允许的动作类型白名单
 */
const ALLOWED_ACTION_TYPES: &[&str] = &[
    "assign_existing_agent",
    "create_project_agent",
    "remove_project_agent",
    "search_project_files",
    "create_project_directory",
    "create_project_file",
    "delete_project_path",
    "move_project_path",
];
const STREAM_FALLBACK_HEADER: &str = "x-force-stream-fallback";
const STREAM_FALLBACK_HEADER_LEGACY: &str = "forcestreamfallback";

/// POST /api/ai/chat
pub async fn ai_chat(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    headers: HeaderMap,
    Json(req): Json<AiChatReq>,
) -> AppResult<Json<serde_json::Value>> {
    let stream_fallback_mode =
        resolve_stream_fallback_mode(req.force_stream_fallback, Some(&headers));
    let context = resolve_chat_context(
        &state,
        &user_id.0,
        req,
        AiUsageOperation::Chat,
        stream_fallback_mode,
    )
    .await?;
    let _ = persist_user_message(&state.db, &context).await?;
    let prepared = match prepare_chat_request(&state, &context, "direct").await {
        Ok(prepared) => prepared,
        Err(error) => {
            if let Err(message_error) =
                save_failure_message(&state.db, &context, &error.to_string(), None).await
            {
                tracing::warn!("Failed to persist sync request error: {}", message_error);
            }
            return Err(error);
        }
    };
    let estimated_cost = crate::billing::budget_enforce::estimate_chat_cost(
        prepared.input_chars,
        context.max_tokens,
    );
    let high_cost_output = matches!(
        context.output_kind,
        usage::AiUsageResourceKind::Image | usage::AiUsageResourceKind::Video
    );
    let task_type = if high_cost_output {
        context.output_kind.as_str()
    } else {
        "chat"
    };
    if let Err(error) = crate::billing::budget_enforce::enforce_budget(
        &state.db,
        &user_id.0,
        estimated_cost,
        task_type,
        high_cost_output,
        Some(&context.model),
        Some(&context.conversation.project_id),
    )
    .await
    {
        if let Err(message_error) =
            save_failure_message(&state.db, &context, &error.to_string(), None).await
        {
            tracing::warn!("Failed to persist sync budget error: {}", message_error);
        }
        return Err(error);
    }
    let started = Instant::now();
    let result = state
        .ai_client
        .chat(
            &context.endpoint.base_url,
            &context.decrypted_api_key,
            &context.model,
            prepared.messages.clone(),
            context.temperature,
            context.top_p,
            context.frequency_penalty,
            context.max_tokens,
            context.stream_fallback_mode,
        )
        .await;
    let latency_ms = started.elapsed().as_millis() as i64;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            if let Err(message_error) =
                save_failure_message(&state.db, &context, &error.to_string(), None).await
            {
                tracing::warn!("Failed to persist sync model error: {}", message_error);
            }
            record_usage_safe(
                &state.db,
                build_usage_record(
                    &user_id.0,
                    &context,
                    UsageRecordCore {
                        operation: AiUsageOperation::Chat,
                        status: AiUsageStatus::Failed,
                        latency_ms,
                        input_chars: prepared.input_chars,
                        output_chars: 0,
                        usage: usage::unavailable_usage(),
                        error_message: Some(error.to_string()),
                        prompt_prefix_hit_ratio: prepared.prompt_prefix_hit_ratio,
                    },
                ),
            )
            .await;
            return Err(error);
        }
    };
    let usage =
        usage::usage_from_response(&prepared.messages, &result.content, result.usage.as_ref());
    let finalized =
        match finalize_assistant_response(&state, &user_id.0, &context, &result.content).await {
            Ok(finalized) => finalized,
            Err(error) => {
                if let Err(message_error) =
                    save_failure_message(&state.db, &context, &error.to_string(), None).await
                {
                    tracing::warn!(
                        "Failed to persist sync post-processing error: {}",
                        message_error
                    );
                }
                record_usage_safe(
                    &state.db,
                    build_usage_record(
                        &user_id.0,
                        &context,
                        UsageRecordCore {
                            operation: AiUsageOperation::Chat,
                            status: AiUsageStatus::Failed,
                            latency_ms,
                            input_chars: prepared.input_chars,
                            output_chars: result.content.chars().count() as i64,
                            usage,
                            error_message: Some(error.to_string()),
                            prompt_prefix_hit_ratio: prepared.prompt_prefix_hit_ratio,
                        },
                    ),
                )
                .await;
                return Err(error);
            }
        };
    if let Err(error) = save_assistant_message(
        &state.db,
        &context,
        &result.model,
        &finalized.content,
        result.usage.as_ref(),
        None,
        &finalized.action_results,
        finalized.pending_action_envelope.as_ref(),
        finalized.project_workflow.as_ref(),
        finalized.workflow_guard.as_ref(),
    )
    .await
    {
        if let Err(message_error) =
            save_failure_message(&state.db, &context, &error.to_string(), None).await
        {
            tracing::warn!("Failed to persist sync save error: {}", message_error);
        }
        record_usage_safe(
            &state.db,
            build_usage_record(
                &user_id.0,
                &context,
                UsageRecordCore {
                    operation: AiUsageOperation::Chat,
                    status: AiUsageStatus::Failed,
                    latency_ms,
                    input_chars: prepared.input_chars,
                    output_chars: finalized.content.chars().count() as i64,
                    usage,
                    error_message: Some(error.to_string()),
                    prompt_prefix_hit_ratio: prepared.prompt_prefix_hit_ratio,
                },
            ),
        )
        .await;
        return Err(error);
    }
    record_usage_and_bill_safe(
        &state.db,
        build_usage_record(
            &user_id.0,
            &context,
            UsageRecordCore {
                operation: AiUsageOperation::Chat,
                status: AiUsageStatus::Success,
                latency_ms,
                input_chars: prepared.input_chars,
                output_chars: finalized.content.chars().count() as i64,
                usage,
                error_message: None,
                prompt_prefix_hit_ratio: prepared.prompt_prefix_hit_ratio,
            },
        ),
    )
    .await;
    let response_meta = build_message_meta_value(
        &context,
        Some(result.model.as_str()),
        None,
        None,
        Some(&finalized.action_results),
        finalized.pending_action_envelope.as_ref(),
        finalized.project_workflow.as_ref(),
        finalized.workflow_guard.as_ref(),
    );

    Ok(Json(serde_json::json!({
        "content": finalized.content,
        "model": result.model,
        "usage": result.usage,
        "meta": response_meta,
    })))
}

/// POST /api/ai/chat/stream
pub async fn ai_chat_stream(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<AiChatReq>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let context = resolve_chat_context(
        &state,
        &user_id.0,
        req,
        AiUsageOperation::Stream,
        StreamFallbackMode::Disable,
    )
    .await?;
    persist_user_message(&state.db, &context).await?;
    let prepared = match prepare_chat_request(&state, &context, "streaming").await {
        Ok(prepared) => prepared,
        Err(error) => {
            if let Err(message_error) =
                save_failure_message(&state.db, &context, &error.to_string(), None).await
            {
                tracing::warn!("Failed to persist stream request error: {}", message_error);
            }
            return Err(error);
        }
    };
    let estimated_cost = crate::billing::budget_enforce::estimate_chat_cost(
        prepared.input_chars,
        context.max_tokens,
    );
    let high_cost_output = matches!(
        context.output_kind,
        usage::AiUsageResourceKind::Image | usage::AiUsageResourceKind::Video
    );
    let task_type = if high_cost_output {
        context.output_kind.as_str()
    } else {
        "chat"
    };
    if let Err(error) = crate::billing::budget_enforce::enforce_budget(
        &state.db,
        &user_id.0,
        estimated_cost,
        task_type,
        high_cost_output,
        Some(&context.model),
        Some(&context.conversation.project_id),
    )
    .await
    {
        if let Err(message_error) =
            save_failure_message(&state.db, &context, &error.to_string(), None).await
        {
            tracing::warn!("Failed to persist stream budget error: {}", message_error);
        }
        return Err(error);
    }
    let prompt_tokens_estimate = usage::estimate_prompt_tokens(&prepared.messages);
    let stream_started = Instant::now();
    let stream_usage_capture = super::client::StreamUsageCapture::new();
    let ai_stream = state
        .ai_client
        .chat_stream(
            &context.endpoint.base_url,
            &context.decrypted_api_key,
            &context.model,
            prepared.messages,
            context.temperature,
            context.top_p,
            context.frequency_penalty,
            context.max_tokens,
            &stream_usage_capture,
        )
        .await;
    let ai_stream = match ai_stream {
        Ok(stream) => stream,
        Err(error) => {
            if let Err(message_error) =
                save_failure_message(&state.db, &context, &error.to_string(), None).await
            {
                tracing::warn!("Failed to persist stream start error: {}", message_error);
            }
            record_usage_safe(
                &state.db,
                build_usage_record(
                    &user_id.0,
                    &context,
                    UsageRecordCore {
                        operation: AiUsageOperation::Stream,
                        status: AiUsageStatus::Failed,
                        latency_ms: stream_started.elapsed().as_millis() as i64,
                        input_chars: prepared.input_chars,
                        output_chars: 0,
                        usage: usage::unavailable_usage(),
                        error_message: Some(error.to_string()),
                        prompt_prefix_hit_ratio: prepared.prompt_prefix_hit_ratio,
                    },
                ),
            )
            .await;
            return Err(error);
        }
    };

    let db = state.db.clone();
    let state_for_finalize = state.clone();
    let request_user_id = user_id.0.clone();
    let conversation_id = context.conversation.id.clone();
    let project_id = context.conversation.project_id.clone();
    let agent_id = context.agent.as_ref().map(|item| item.id.clone());
    let endpoint_id = context.endpoint.id.clone();
    let provider = context.endpoint.provider.clone();
    // 使用已解密的明文 API Key 用于 usage 记录的 fingerprint 计算
    let api_key = context.decrypted_api_key.clone();
    let model_for_save = context.model.clone();
    let output_kind = context.output_kind;
    let output_items = context.output_items;
    let request_content = context.content.clone();
    let input_chars = prepared.input_chars;
    let context_for_finalize = context.clone();
    let persisted_stream_message =
        match create_streaming_assistant_message(&db, &context_for_finalize, &model_for_save).await
        {
            Ok(message) => Some(message),
            Err(error) => {
                tracing::warn!(
                    "Failed to create streaming assistant placeholder message: {}",
                    error
                );
                None
            }
        };

    let sse_stream = async_stream::stream! {
            use futures::StreamExt;

            let mut full_content = String::new();
            let mut visible_content = String::new();
            let mut persisted_visible_content = String::new();
            let mut last_stream_persist_at = Instant::now();
            let mut stream_error: Option<String> = None;
            let mut postprocess_error: Option<String> = None;
            futures::pin_mut!(ai_stream);

            while let Some(result) = ai_stream.next().await {
                match result {
                    Ok(chunk) => {
                        full_content.push_str(&chunk);
                        let next_visible_content = visible_stream_content(&full_content);
                        if let Some(delta) = next_visible_content.strip_prefix(&visible_content) {
                            if !delta.is_empty() {
                                yield Ok(Event::default().data(delta));
                            }
                        } else if next_visible_content != visible_content {
                            tracing::warn!("Visible AI stream content diverged unexpectedly");
                        }
                        visible_content = next_visible_content;

                        if let Some(message) = persisted_stream_message.as_ref() {
                            let should_persist_snapshot =
                                !visible_content.is_empty()
                                && visible_content != persisted_visible_content
                                && (
                                    last_stream_persist_at.elapsed() >= Duration::from_millis(400)
                                    || visible_content
                                        .len()
                                        .saturating_sub(persisted_visible_content.len())
                                        >= 96
                                );

                            if should_persist_snapshot {
                                match update_streaming_assistant_message_content(
                                    &db,
                                    &context_for_finalize,
                                    &message.id,
                                    &model_for_save,
                                    &visible_content,
                                )
                                .await
                                {
                                    Ok(()) => {
                                        persisted_visible_content = visible_content.clone();
                                        last_stream_persist_at = Instant::now();
                                    }
                                    Err(error) => {
                                        tracing::warn!(
                                            message_id = %message.id,
                                            error = %error,
                                            "Failed to persist streaming assistant content snapshot"
                                        );
                                    }
                                }
                            }
                        }
                    }
                    Err(error) => {
                        tracing::error!("AI stream error: {}", error);
                        stream_error = Some(error.to_string());
                        yield Ok(Event::default().event("error").data(error.to_string()));
                        break;
                    }
                }
            }

            if stream_error.is_some() {
                if let Some(error_message) = stream_error.as_ref() {
                    if let Some(message) = persisted_stream_message.as_ref() {
                        if let Err(message_error) = fail_streaming_assistant_message(
                            &db,
                            &context_for_finalize,
                            &message.id,
                            &model_for_save,
                            error_message,
                        )
                        .await
                        {
                            tracing::warn!(
                                "Failed to update stream placeholder into failure message: {}",
                                message_error
                            );
                        }
                    } else if let Err(message_error) =
                        save_failure_message(&db, &context_for_finalize, error_message, None).await
                    {
                        tracing::warn!(
                            "Failed to persist stream failure message: {}",
                            message_error
                        );
                    }
                }
            } else if !full_content.is_empty() {
                match finalize_assistant_response(
                    &state_for_finalize,
                    &request_user_id,
                    &context_for_finalize,
                    &full_content,
                )
                .await
                {
                    Ok(finalized) => {
                        let save_result = if let Some(message) = persisted_stream_message.as_ref() {
                            finalize_streaming_assistant_message(
                                &db,
                                &context_for_finalize,
                                &message.id,
                                &model_for_save,
                                &finalized.content,
                                None,
                                &finalized.action_results,
                                finalized.pending_action_envelope.as_ref(),
                                finalized.project_workflow.as_ref(),
                                finalized.workflow_guard.as_ref(),
                            )
                            .await
                        } else {
                            save_assistant_message(
                                &db,
                                &context_for_finalize,
                                &model_for_save,
                                &finalized.content,
                                None,
                                None,
                                &finalized.action_results,
                                finalized.pending_action_envelope.as_ref(),
                                finalized.project_workflow.as_ref(),
                                finalized.workflow_guard.as_ref(),
                            )
                            .await
                        };

                        if let Err(error) = save_result
                        {
                            let error_message = error.to_string();
                            tracing::error!("Failed to persist AI stream response: {}", error_message);
                            postprocess_error = Some(error_message.clone());
                            if let Some(message) = persisted_stream_message.as_ref() {
                                if let Err(message_error) = fail_streaming_assistant_message(
                                    &db,
                                    &context_for_finalize,
                                    &message.id,
                                    &model_for_save,
                                    &error_message,
                                )
                                .await
                                {
                                    tracing::warn!(
                                        "Failed to update stream placeholder after save error: {}",
                                        message_error
                                    );
                                }
                            } else if let Err(message_error) =
                                save_failure_message(&db, &context_for_finalize, &error_message, None)
                                    .await
                            {
                                tracing::warn!(
                                    "Failed to persist stream save error message: {}",
                                    message_error
                                );
                            }
                        }
                    }
                    Err(error) => {
                        let error_message = error.to_string();
                        tracing::error!("Failed to finalize AI stream response: {}", error_message);
                        postprocess_error = Some(error_message.clone());
                        if let Some(message) = persisted_stream_message.as_ref() {
                            if let Err(message_error) = fail_streaming_assistant_message(
                                &db,
                                &context_for_finalize,
                                &message.id,
                                &model_for_save,
                                &error_message,
                            )
                            .await
                            {
                                tracing::warn!(
                                    "Failed to update stream placeholder after finalize error: {}",
                                    message_error
                                );
                            }
                        } else if let Err(message_error) =
                            save_failure_message(&db, &context_for_finalize, &error_message, None).await
                        {
                            tracing::warn!(
                                "Failed to persist stream post-processing error: {}",
                                message_error
                            );
                        }
                    }
                }
            } else if let Some(message) = persisted_stream_message.as_ref() {
                let error_message = "AI 流式响应为空";
                postprocess_error = Some(error_message.to_string());
                if let Err(message_error) = fail_streaming_assistant_message(
                    &db,
                    &context_for_finalize,
                    &message.id,
                    &model_for_save,
                    error_message,
                )
                .await
                {
                    tracing::warn!(
                        "Failed to update empty stream placeholder into failure message: {}",
                        message_error
                    );
                }
            }

            let latency_ms = stream_started.elapsed().as_millis() as i64;
            let usage = if full_content.is_empty() && stream_error.is_some() {
                usage::unavailable_usage()
            } else if let Some(vendor_usage) = stream_usage_capture.take() {
                // 供应商上报的实际 usage（含缓存命中 tokens），替代估算值。
                usage::UsageNumbers {
                    cached_prompt_tokens: vendor_usage.cached_prompt_tokens,
                    prompt_tokens: vendor_usage.prompt_tokens,
                    completion_tokens: vendor_usage.completion_tokens,
                    total_tokens: vendor_usage.total_tokens,
                    token_source: usage::AiUsageTokenSource::Actual,
                }
            } else {
                let completion_tokens = usage::estimate_tokens(&full_content);
                UsageNumbers {
                    cached_prompt_tokens: None,
                    prompt_tokens: prompt_tokens_estimate,
                    completion_tokens,
                    total_tokens: prompt_tokens_estimate + completion_tokens,
                    token_source: usage::AiUsageTokenSource::Estimated,
                }
            };
            let status = if stream_error.is_some() || postprocess_error.is_some() {
                AiUsageStatus::Failed
            } else {
                AiUsageStatus::Success
            };
            record_usage_and_bill_safe(
                &db,
                build_direct_usage_record(DirectUsageRecordParams {
    user_id: &request_user_id,
    project_id: Some(project_id.clone()),
    conversation_id: Some(conversation_id.clone()),
    agent_id: agent_id.clone(),
    endpoint_id: Some(endpoint_id.clone()),
    provider: &provider,
    api_key: &api_key,
    model: Some(model_for_save.clone()),
    operation: AiUsageOperation::Stream,
    status,
    output_kind,
    output_items: if status == AiUsageStatus::Success { output_items } else { 0 },
    content: &request_content,
    latency_ms,
    input_chars,
    output_chars: full_content.chars().count() as i64,
    usage,
    trigger_source: None,
    error_message: postprocess_error.clone().or(stream_error.clone()),
    prompt_prefix_hit_ratio: prepared.prompt_prefix_hit_ratio,
    }),
            ).await;

            if let Some(error_message) = postprocess_error.as_ref() {
                yield Ok(Event::default().event("error").data(error_message.clone()));
            } else if status == AiUsageStatus::Success {
                yield Ok(Event::default().event("done").data("[DONE]"));
            }
        };

    Ok(Sse::new(sse_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

/// POST /api/ai/test
pub async fn test_endpoint(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    headers: HeaderMap,
    Json(req): Json<AiTestReq>,
) -> AppResult<Json<serde_json::Value>> {
    validate_connection_fields(&req.provider, &req.base_url, &req.api_key).await?;

    if req.model.trim().is_empty() {
        return Err(AppError::Validation("model 不能为空".into()));
    }

    let content = req
        .content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("请只回复“连接成功”。");
    let output_kind = usage::parse_resource_kind(req.output_kind.as_deref())?;
    let output_items = usage::normalize_output_items(req.output_items);

    let mut messages = Vec::new();
    if let Some(system_prompt) = req.system_prompt.as_deref().map(str::trim) {
        if !system_prompt.is_empty() {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
            });
        }
    }
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: content.to_string(),
    });
    let input_chars = message_char_count(&messages);

    let started = Instant::now();
    let stream_fallback_mode =
        resolve_stream_fallback_mode(req.force_stream_fallback, Some(&headers));
    let result = state
        .ai_client
        .chat(
            req.base_url.trim(),
            req.api_key.trim(),
            req.model.trim(),
            messages.clone(),
            req.temperature,
            req.top_p,
            req.frequency_penalty,
            req.max_tokens,
            stream_fallback_mode,
        )
        .await;
    let latency_ms = started.elapsed().as_millis() as i64;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            record_usage_safe(
                &state.db,
                build_direct_usage_record(DirectUsageRecordParams {
                    user_id: &user_id.0,
                    project_id: None,
                    conversation_id: None,
                    agent_id: None,
                    endpoint_id: None,
                    provider: req.provider.trim(),
                    api_key: req.api_key.trim(),
                    model: Some(req.model.trim().to_string()),
                    operation: AiUsageOperation::Test,
                    status: AiUsageStatus::Failed,
                    output_kind,
                    output_items: 0,
                    content: &content,
                    latency_ms,
                    input_chars,
                    output_chars: 0,
                    usage: usage::unavailable_usage(),
                    trigger_source: None,
                    error_message: Some(error.to_string()),
                    prompt_prefix_hit_ratio: None,
                }),
            )
            .await;
            return Err(error);
        }
    };
    let usage = usage::usage_from_response(&messages, &result.content, result.usage.as_ref());
    record_usage_safe(
        &state.db,
        build_direct_usage_record(DirectUsageRecordParams {
            user_id: &user_id.0,
            project_id: None,
            conversation_id: None,
            agent_id: None,
            endpoint_id: None,
            provider: req.provider.trim(),
            api_key: req.api_key.trim(),
            model: Some(result.model.clone()),
            operation: AiUsageOperation::Test,
            status: AiUsageStatus::Success,
            output_kind,
            output_items,
            content: &content,
            latency_ms,
            input_chars,
            output_chars: result.content.chars().count() as i64,
            usage,
            trigger_source: None,
            error_message: None,
            prompt_prefix_hit_ratio: None,
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "content": result.content,
        "model": result.model,
        "usage": result.usage,
    })))
}

/// POST /api/ai/endpoints/:id/test
pub async fn test_endpoint_with_saved_key(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(endpoint_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<AiEndpointTestReq>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id_value = user_id.0.clone();
    let endpoint =
        sqlx::query_as::<_, AiEndpoint>("SELECT * FROM ai_endpoints WHERE id = ? AND user_id = ?")
            .bind(endpoint_id.trim())
            .bind(&user_id_value)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("AI 端点不存在".into()))?;
    // 惰性迁移：若数据库中是旧明文 key，加密后写回
    super::api_key_crypto::migrate_endpoint_if_needed(&state.db, &endpoint).await?;
    // 解密数据库中的密文 API Key 用于本次测试调用
    let decrypted_api_key = super::api_key_crypto::decrypt_endpoint_api_key(&endpoint)?;

    let provider = req
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(endpoint.provider.trim())
        .to_string();
    let base_url = req
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(endpoint.base_url.trim())
        .to_string();
    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(endpoint.default_model.as_deref().map(str::trim))
        .ok_or_else(|| AppError::Validation("model 不能为空".into()))?
        .to_string();

    let test_req = AiTestReq {
        provider,
        base_url,
        // 使用已解密的明文 API Key 传递给 test_endpoint（仅内存中传递，不落盘）
        api_key: decrypted_api_key,
        model,
        force_stream_fallback: req.force_stream_fallback,
        system_prompt: req.system_prompt,
        temperature: req.temperature,
        top_p: req.top_p,
        frequency_penalty: req.frequency_penalty,
        max_tokens: req.max_tokens,
        content: req.content,
        output_kind: req.output_kind,
        output_items: req.output_items,
    };

    test_endpoint(
        State(state),
        Extension(UserId(user_id_value)),
        headers,
        Json(test_req),
    )
    .await
}

pub async fn enqueue_ai_task_for_request(
    state: &AppState,
    user_id: &str,
    req: AiChatReq,
    operation: AiUsageOperation,
    stream_fallback_mode: StreamFallbackMode,
) -> AppResult<AiTask> {
    let context =
        resolve_chat_context(state, user_id, req, operation, stream_fallback_mode).await?;
    let persisted_user_message = persist_user_message(&state.db, &context).await?;
    let task_id = Uuid::new_v4().to_string();

    let persisted_task_message_id = match create_task_streaming_assistant_message(
        &state.db,
        &context,
        &context.model,
        &task_id,
        "queued",
        "任务已提交，排队中...",
    )
    .await
    {
        Ok(message) => Some(message.id),
        Err(error) => {
            tracing::warn!(
                "Failed to create task streaming placeholder message: {}",
                error
            );
            None
        }
    };

    let task = state
        .ai_runtime
        .create_task(
            user_id.to_string(),
            AiTask {
                id: task_id,
                project_id: context.conversation.project_id.clone(),
                conversation_id: context.conversation.id.clone(),
                user_message_id: Some(persisted_user_message.id),
                assistant_message_id: persisted_task_message_id.clone(),
                agent_id: context.agent.as_ref().map(|item| item.id.clone()),
                content: context.content.clone(),
                endpoint_id: Some(context.endpoint.id.clone()),
                model: Some(context.model.clone()),
                output_kind: Some(context.output_kind.as_str().to_string()),
                output_items: Some(context.output_items),
                status: AiTaskStatus::Queued,
                result: None,
                error: None,
                attempt_index: context.execution.attempt_index,
                previous_attempts: context.execution.previous_attempts,
                previous_failures: context.execution.previous_failures,
                previous_successes: context.execution.previous_successes,
                is_redo: context.execution.attempt_index > 1,
                last_error: context.execution.last_error_message.clone(),
                agent_status: context.execution.agent_runtime_state,
                active_tasks: context.execution.agent_active_tasks,
                queued_tasks: context.execution.agent_queued_tasks,
                created_at: 0,
                started_at: None,
                finished_at: None,
            },
        )
        .await;

    tokio::spawn(run_ai_task(
        state.clone(),
        user_id.to_string(),
        task.id.clone(),
        context,
        persisted_task_message_id,
    ));

    Ok(task)
}

async fn run_ai_task(
    state: AppState,
    user_id: String,
    task_id: String,
    mut context: ResolvedChatContext,
    persisted_message_id: Option<String>,
) {
    let _permit = match state.ai_runtime.acquire_slot().await {
        Ok(permit) => permit,
        Err(error) => {
            fail_task_execution(
                &state,
                &user_id,
                &task_id,
                &context,
                0,
                0,
                0,
                usage::unavailable_usage(),
                None,
                format!("任务调度失败: {}", error),
                persisted_message_id.as_deref(),
            )
            .await;
            return;
        }
    };

    if should_abort_task_execution(&state, &user_id, &task_id).await {
        return;
    }

    let running_task = state.ai_runtime.mark_running(&user_id, &task_id).await;
    if !matches!(
        running_task.as_ref().map(|task| task.status),
        Some(AiTaskStatus::Running)
    ) {
        return;
    }

    if let Some(message_id) = persisted_message_id.as_deref() {
        if let Err(error) = update_task_streaming_assistant_message_content(
            &state.db,
            &context,
            message_id,
            &context.model,
            &task_id,
            "running",
            "AI 正在处理中...",
        )
        .await
        {
            tracing::warn!(
                message_id = %message_id,
                error = %error,
                "Failed to mark task placeholder as running"
            );
        }
    }

    if should_abort_task_execution(&state, &user_id, &task_id).await {
        return;
    }

    match build_execution_context(
        &state,
        &user_id,
        &context.conversation,
        context.agent.as_ref(),
        context.operation,
        context.output_kind,
        &context.content,
        &context.resource_refs,
    )
    .await
    {
        Ok(execution) => {
            let _ = state
                .ai_runtime
                .update_task_context(
                    &user_id,
                    &task_id,
                    execution.attempt_index,
                    execution.previous_attempts,
                    execution.previous_failures,
                    execution.previous_successes,
                    execution.attempt_index > 1,
                    execution.last_error_message.clone(),
                    execution.agent_runtime_state,
                    execution.agent_active_tasks,
                    execution.agent_queued_tasks,
                )
                .await;
            context.execution = execution;
            if should_abort_task_execution(&state, &user_id, &task_id).await {
                return;
            }
        }
        Err(error) => {
            fail_task_execution(
                &state,
                &user_id,
                &task_id,
                &context,
                0,
                0,
                0,
                usage::unavailable_usage(),
                None,
                error.to_string(),
                persisted_message_id.as_deref(),
            )
            .await;
            return;
        }
    }

    let prepared = match prepare_chat_request(&state, &context, "running").await {
        Ok(prepared) => prepared,
        Err(error) => {
            fail_task_execution(
                &state,
                &user_id,
                &task_id,
                &context,
                0,
                0,
                0,
                usage::unavailable_usage(),
                None,
                error.to_string(),
                persisted_message_id.as_deref(),
            )
            .await;
            return;
        }
    };

    let estimated_cost = crate::billing::budget_enforce::estimate_chat_cost(
        prepared.input_chars,
        context.max_tokens,
    );
    let high_cost_output = matches!(
        context.output_kind,
        usage::AiUsageResourceKind::Image | usage::AiUsageResourceKind::Video
    );
    let task_type = if high_cost_output {
        context.output_kind.as_str()
    } else {
        "chat"
    };
    if let Err(error) = crate::billing::budget_enforce::enforce_budget(
        &state.db,
        &user_id,
        estimated_cost,
        task_type,
        high_cost_output,
        Some(&context.model),
        Some(&context.conversation.project_id),
    )
    .await
    {
        fail_task_execution(
            &state,
            &user_id,
            &task_id,
            &context,
            0,
            prepared.input_chars,
            0,
            usage::unavailable_usage(),
            prepared.prompt_prefix_hit_ratio,
            error.to_string(),
            persisted_message_id.as_deref(),
        )
        .await;
        return;
    }

    if should_abort_task_execution(&state, &user_id, &task_id).await {
        return;
    }

    let started = Instant::now();
    let task_usage_capture = super::client::StreamUsageCapture::new();
    match state
        .ai_client
        .chat_stream(
            &context.endpoint.base_url,
            &context.decrypted_api_key,
            &context.model,
            prepared.messages.clone(),
            context.temperature,
            context.top_p,
            context.frequency_penalty,
            context.max_tokens,
            &task_usage_capture,
        )
        .await
    {
        Ok(ai_stream) => {
            let mut full_content = String::new();
            let mut visible_content = String::new();
            let mut persisted_visible_content = String::new();
            let mut last_stream_persist_at = Instant::now();
            futures::pin_mut!(ai_stream);

            while let Some(result) = ai_stream.next().await {
                if should_abort_task_execution(&state, &user_id, &task_id).await {
                    return;
                }

                match result {
                    Ok(chunk) => {
                        full_content.push_str(&chunk);
                        let next_visible_content = visible_stream_content(&full_content);

                        if let Some(delta) = next_visible_content.strip_prefix(&visible_content) {
                            if !delta.is_empty() {
                                let _ = state
                                    .ai_runtime
                                    .emit_content_delta(&user_id, &task_id, delta.to_string())
                                    .await;
                            }
                        } else if next_visible_content != visible_content {
                            tracing::warn!("Visible task stream content diverged unexpectedly");
                        }

                        visible_content = next_visible_content;

                        if let Some(message_id) = persisted_message_id.as_deref() {
                            let should_persist_snapshot = !visible_content.is_empty()
                                && visible_content != persisted_visible_content
                                && (last_stream_persist_at.elapsed() >= Duration::from_millis(400)
                                    || visible_content
                                        .len()
                                        .saturating_sub(persisted_visible_content.len())
                                        >= 96);

                            if should_persist_snapshot {
                                match update_task_streaming_assistant_message_content(
                                    &state.db,
                                    &context,
                                    message_id,
                                    &context.model,
                                    &task_id,
                                    "running",
                                    &visible_content,
                                )
                                .await
                                {
                                    Ok(()) => {
                                        persisted_visible_content = visible_content.clone();
                                        last_stream_persist_at = Instant::now();
                                    }
                                    Err(error) => {
                                        tracing::warn!(
                                            message_id = %message_id,
                                            error = %error,
                                            "Failed to persist task streaming content snapshot"
                                        );
                                    }
                                }
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            task_id = %task_id,
                            error = %error,
                            "Task stream failed before completion, falling back to non-stream chat"
                        );
                        run_ai_task_non_stream(
                            &state,
                            &user_id,
                            &task_id,
                            &context,
                            &prepared,
                            started,
                            persisted_message_id.as_deref(),
                        )
                        .await;
                        return;
                    }
                }
            }

            let final_content = if visible_content.trim().is_empty() {
                full_content.trim().to_string()
            } else {
                visible_content.trim().to_string()
            };

            if final_content.is_empty() {
                tracing::warn!(
                    task_id = %task_id,
                    "Task stream finished without visible content, falling back to non-stream chat"
                );
                run_ai_task_non_stream(
                    &state,
                    &user_id,
                    &task_id,
                    &context,
                    &prepared,
                    started,
                    persisted_message_id.as_deref(),
                )
                .await;
                return;
            }

            let latency_ms = started.elapsed().as_millis() as i64;
            finalize_task_success(
                &state,
                &user_id,
                &task_id,
                &context,
                &prepared,
                latency_ms,
                super::client::AiResponse {
                    content: final_content,
                    model: context.model.clone(),
                    // 流式任务路径：供应商上报的实际 usage（含缓存命中），否则回退估算。
                    usage: task_usage_capture.take(),
                },
                persisted_message_id.as_deref(),
            )
            .await;
        }
        Err(error) => {
            tracing::warn!(
                task_id = %task_id,
                error = %error,
                "Failed to start task stream, falling back to non-stream chat"
            );
            run_ai_task_non_stream(
                &state,
                &user_id,
                &task_id,
                &context,
                &prepared,
                started,
                persisted_message_id.as_deref(),
            )
            .await;
        }
    }
}

async fn run_ai_task_non_stream(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    context: &ResolvedChatContext,
    prepared: &PreparedChatRequest,
    started: Instant,
    persisted_message_id: Option<&str>,
) {
    let result = state
        .ai_client
        .chat(
            &context.endpoint.base_url,
            &context.decrypted_api_key,
            &context.model,
            prepared.messages.clone(),
            context.temperature,
            context.top_p,
            context.frequency_penalty,
            context.max_tokens,
            context.stream_fallback_mode,
        )
        .await;
    let latency_ms = started.elapsed().as_millis() as i64;

    if should_abort_task_execution(state, user_id, task_id).await {
        return;
    }

    match result {
        Ok(result) => {
            finalize_task_success(
                state,
                user_id,
                task_id,
                context,
                prepared,
                latency_ms,
                result,
                persisted_message_id,
            )
            .await;
        }
        Err(error) => {
            fail_task_execution(
                state,
                user_id,
                task_id,
                context,
                latency_ms,
                prepared.input_chars,
                0,
                usage::unavailable_usage(),
                prepared.prompt_prefix_hit_ratio,
                error.to_string(),
                persisted_message_id,
            )
            .await;
        }
    }
}

async fn finalize_task_success(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    context: &ResolvedChatContext,
    prepared: &PreparedChatRequest,
    latency_ms: i64,
    result: super::client::AiResponse,
    persisted_message_id: Option<&str>,
) {
    if should_abort_task_execution(state, user_id, task_id).await {
        return;
    }

    let usage =
        usage::usage_from_response(&prepared.messages, &result.content, result.usage.as_ref());
    let finalized =
        match finalize_assistant_response(state, user_id, context, &result.content).await {
            Ok(finalized) => finalized,
            Err(error) => {
                fail_task_execution(
                    state,
                    user_id,
                    task_id,
                    context,
                    latency_ms,
                    prepared.input_chars,
                    result.content.chars().count() as i64,
                    usage,
                    prepared.prompt_prefix_hit_ratio,
                    error.to_string(),
                    persisted_message_id,
                )
                .await;
                return;
            }
        };

    if should_abort_task_execution(state, user_id, task_id).await {
        return;
    }

    let save_result = if let Some(message_id) = persisted_message_id {
        finalize_task_streaming_assistant_message(
            &state.db,
            context,
            message_id,
            &result.model,
            &finalized.content,
            result.usage.as_ref(),
            task_id,
            &finalized.action_results,
            finalized.pending_action_envelope.as_ref(),
            finalized.project_workflow.as_ref(),
            finalized.workflow_guard.as_ref(),
        )
        .await
    } else {
        save_assistant_message(
            &state.db,
            context,
            &result.model,
            &finalized.content,
            result.usage.as_ref(),
            Some(task_id),
            &finalized.action_results,
            finalized.pending_action_envelope.as_ref(),
            finalized.project_workflow.as_ref(),
            finalized.workflow_guard.as_ref(),
        )
        .await
    };

    if let Err(error) = save_result {
        fail_task_execution(
            state,
            user_id,
            task_id,
            context,
            latency_ms,
            prepared.input_chars,
            finalized.content.chars().count() as i64,
            usage,
            prepared.prompt_prefix_hit_ratio,
            error.to_string(),
            persisted_message_id,
        )
        .await;
        return;
    }

    if should_abort_task_execution(state, user_id, task_id).await {
        return;
    }

    record_usage_and_bill_safe(
        &state.db,
        build_usage_record(
            user_id,
            context,
            UsageRecordCore {
                operation: AiUsageOperation::Task,
                status: AiUsageStatus::Success,
                latency_ms,
                input_chars: prepared.input_chars,
                output_chars: finalized.content.chars().count() as i64,
                usage,
                error_message: None,
                prompt_prefix_hit_ratio: prepared.prompt_prefix_hit_ratio,
            },
        ),
    )
    .await;

    let _ = state
        .ai_runtime
        .mark_completed(user_id, task_id, Some(result.model), finalized.content)
        .await;
}

async fn fail_task_execution(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    context: &ResolvedChatContext,
    latency_ms: i64,
    input_chars: i64,
    output_chars: i64,
    usage: UsageNumbers,
    prompt_prefix_hit_ratio: Option<f64>,
    error_message: String,
    persisted_message_id: Option<&str>,
) {
    if let Some(message_id) = persisted_message_id {
        if let Err(message_error) = fail_task_streaming_assistant_message(
            &state.db,
            context,
            message_id,
            &context.model,
            task_id,
            &error_message,
        )
        .await
        {
            tracing::warn!(
                "Failed to persist task streaming failure message: {}",
                message_error
            );
            if let Err(fallback_error) =
                save_failure_message(&state.db, context, &error_message, Some(task_id)).await
            {
                tracing::warn!(
                    "Failed to persist fallback task failure message: {}",
                    fallback_error
                );
            }
        }
    } else if let Err(message_error) =
        save_failure_message(&state.db, context, &error_message, Some(task_id)).await
    {
        tracing::warn!("Failed to persist task failure message: {}", message_error);
    }

    record_usage_safe(
        &state.db,
        build_usage_record(
            user_id,
            context,
            UsageRecordCore {
                operation: AiUsageOperation::Task,
                status: AiUsageStatus::Failed,
                latency_ms,
                input_chars,
                output_chars,
                usage,
                error_message: Some(error_message.clone()),
                prompt_prefix_hit_ratio,
            },
        ),
    )
    .await;

    let _ = state
        .ai_runtime
        .mark_failed(user_id, task_id, error_message)
        .await;
}

async fn save_failure_message(
    pool: &SqlitePool,
    context: &ResolvedChatContext,
    error_message: &str,
    task_id: Option<&str>,
) -> AppResult<()> {
    let meta = build_message_meta(
        context,
        Some(context.model.as_str()),
        Some(error_message),
        task_id,
        None,
        None,
        None,
        None,
    );
    conversation::repo::add_message(
        pool,
        &context.conversation.id,
        "system",
        &format!("任务失败：{}", error_message),
        "text",
        context.agent.as_ref().map(|item| item.id.as_str()),
        Some(context.model.as_str()),
        None,
        Some(&meta),
    )
    .await?;

    Ok(())
}

fn build_message_meta(
    context: &ResolvedChatContext,
    model: Option<&str>,
    error_message: Option<&str>,
    task_id: Option<&str>,
    action_results: Option<&[AssistantActionResult]>,
    pending_action_envelope: Option<&AssistantActionEnvelope>,
    project_workflow: Option<&ProjectWorkflowSummary>,
    workflow_guard: Option<&WorkflowGuard>,
) -> String {
    build_message_meta_value(
        context,
        model,
        error_message,
        task_id,
        action_results,
        pending_action_envelope,
        project_workflow,
        workflow_guard,
    )
    .to_string()
}

fn runtime_state_label(value: AgentRuntimeState) -> &'static str {
    match value {
        AgentRuntimeState::Idle => "idle",
        AgentRuntimeState::Queued => "queued",
        AgentRuntimeState::Busy => "busy",
    }
}
