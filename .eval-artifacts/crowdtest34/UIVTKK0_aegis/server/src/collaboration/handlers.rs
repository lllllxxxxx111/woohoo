use axum::{
    extract::{Path, Query, State},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::Stream;
use serde_json::json;
use std::convert::Infallible;

use crate::ai::{
    client::StreamFallbackMode, config::AiChatReq, handlers::enqueue_ai_task_for_request,
    usage::AiUsageOperation,
};
use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::dispatcher::{self, DispatchItem};
use super::loop_detector;
use super::model::*;
use super::readiness;
use super::repo;

/// 校验会话归属当前用户，防止越权访问
async fn verify_session_owner(
    state: &AppState,
    session_id: &str,
    user_id: &UserId,
) -> Result<CollaborationSession, AppError> {
    let session = repo::get_session(&state.db, session_id)
        .await
        .map_err(|e| AppError::NotFound(format!("协同会话不存在: {}", e)))?;

    if session.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权访问此协同会话".to_string()));
    }

    Ok(session)
}

/// 持久化事件到数据库并广播到 SSE channel（异步执行，保证事件携带正确的 rowid 作为 cursor）
fn broadcast_collaboration_event(
    state: &AppState,
    session_id: &str,
    event_type: &str,
    payload: Option<serde_json::Value>,
) {
    let db = state.db.clone();
    let broadcaster = state.collaboration_broadcaster.clone();
    let session_id = session_id.to_string();
    let event_type = event_type.to_string();
    tokio::spawn(async move {
        crate::collaboration::broadcast::persist_and_broadcast(
            &db,
            &broadcaster,
            &session_id,
            &event_type,
            payload,
        )
        .await;
    });
}

/// 创建协同会话
pub async fn create_session(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<CreateSessionReq>,
) -> Result<Json<CollaborationSession>, AppError> {
    let session = repo::create_session(
        &state.db,
        &user_id.0,
        &req.project_id,
        &req.conversation_id,
        req.entry_message_id.as_deref(),
        req.orchestrator_agent_id.as_deref(),
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let payload = json!({
        "sessionId": session.id,
        "projectId": session.project_id,
        "state": session.state
    });

    broadcast_collaboration_event(
        &state,
        &session.id,
        "collaboration_session_created",
        Some(payload),
    );

    Ok(Json(session))
}

/// 查询协同会话详情
pub async fn get_session(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
) -> Result<Json<SessionSummary>, AppError> {
    let session = verify_session_owner(&state, &session_id, &user_id).await?;

    let assignments = repo::list_assignments(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(SessionSummary {
        session,
        assignments,
    }))
}

/// 查询项目当前活跃协同会话
pub async fn get_active_session(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Query(params): Query<ActiveSessionQuery>,
) -> Result<Json<Option<SessionSummary>>, AppError> {
    let sessions = repo::list_active_sessions_for_project(
        &state.db,
        &user_id.0,
        &params.project_id,
        params.conversation_id.as_deref(),
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let session = match sessions.into_iter().next() {
        Some(s) => s,
        None => return Ok(Json(None)),
    };

    let assignments = repo::list_assignments(&state.db, &session.id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(Some(SessionSummary {
        session,
        assignments,
    })))
}

/// 根据当前对话内容判断是否可以启动协同
pub async fn get_readiness(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Query(params): Query<ReadinessQuery>,
) -> Result<Json<CollaborationReadinessResponse>, AppError> {
    let conversation = crate::conversation::repo::find_by_id(&state.db, &params.conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("对话不存在".to_string()))?;
    if conversation.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权访问该对话".to_string()));
    }

    let messages = crate::conversation::repo::list_messages(&state.db, &params.conversation_id)
        .await?
        .into_iter()
        .map(|message| message.content)
        .collect::<Vec<_>>();
    let result = readiness::evaluate(&messages);
    Ok(Json(CollaborationReadinessResponse {
        ready: result.ready,
        missing: result.missing,
    }))
}

/// 编导分派任务
pub async fn dispatch(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
    Json(req): Json<DispatchReq>,
) -> Result<Json<DispatchResponse>, AppError> {
    verify_session_owner(&state, &session_id, &user_id).await?;

    let items: Vec<DispatchItem> = req
        .assignments
        .into_iter()
        .map(|a| DispatchItem {
            agent_id: a.agent_id,
            task_type: a.task_type,
            goal: a.goal,
            depends_on: a.depends_on,
            input: a.input,
        })
        .collect();

    let result = dispatcher::Dispatcher::dispatch_assignments(&state.db, &session_id, items)
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;

    dispatch_ready_assignments(&state, &user_id.0, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let linked_assignments = repo::list_assignments(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let payload = json!({
        "dispatchedCount": result.dispatched_count,
        "sessionId": session_id,
        "state": SessionState::ResolvingQuestions.as_str()
    });

    broadcast_collaboration_event(
        &state,
        &session_id,
        "collaboration_dispatched",
        Some(payload),
    );

    if linked_assignments
        .iter()
        .any(|assignment| assignment.status == "failed")
    {
        let _ = halt_failed_session(&state, &session_id, "协同任务创建失败").await;
    }

    Ok(Json(DispatchResponse {
        dispatched_count: result.dispatched_count as i64,
        assignments: linked_assignments,
    }))
}

pub(crate) async fn dispatch_ready_assignments(
    state: &AppState,
    user_id: &str,
    session_id: &str,
) -> anyhow::Result<()> {
    let session = repo::get_session(&state.db, session_id).await?;
    let assignments = repo::list_assignments(&state.db, session_id).await?;
    let messages = repo::list_messages(&state.db, session_id).await?;

    for assignment in assignments.iter().filter(|assignment| {
        matches!(assignment.status.as_str(), "assigned" | "ready")
            && assignment.ai_task_id.is_none()
            && dependencies_satisfied(assignment, &assignments)
    }) {
        let Some(claimed) = repo::claim_assignment_for_execution(&state.db, &assignment.id).await?
        else {
            continue;
        };
        broadcast_collaboration_event(
            state,
            session_id,
            "collaboration_assignment_updated",
            Some(json!({
                "assignmentId": claimed.id,
                "agentId": claimed.agent_id,
                "newStatus": claimed.status,
            })),
        );

        let dependency_context = dependency_output_context(&claimed, &messages);
        let input_context = claimed.input_json.as_deref().unwrap_or("无额外输入");
        let task_prompt = format!(
            "你正在参与项目内多智能体协同。\n任务类型：{}\n任务目标：{}\n任务输入：{}{}\n请直接给出可供其他智能体继续工作的明确产出，不要反问用户。",
            claimed.task_type, claimed.goal, input_context, dependency_context
        );
        let req = AiChatReq {
            conversation_id: session.conversation_id.clone(),
            content: task_prompt,
            resource_refs: None,
            agent_id: Some(claimed.agent_id.clone()),
            endpoint_id: None,
            model: None,
            force_stream_fallback: Some(true),
            system_prompt: None,
            temperature: None,
            top_p: None,
            frequency_penalty: None,
            max_tokens: None,
            output_kind: Some("document".to_string()),
            output_items: Some(1),
            allow_assistant_actions: false,
            confirmed_message_id: None,
            confirmed_workflow_guard_message_id: None,
            trigger_source: Some("collaboration".to_string()),
        };

        match enqueue_ai_task_for_request(
            state,
            user_id,
            req,
            AiUsageOperation::Task,
            StreamFallbackMode::Force,
        )
        .await
        {
            Ok(task) => {
                let linked =
                    repo::link_assignment_ai_task(&state.db, &claimed.id, &task.id).await?;
                let next_order = repo::get_next_queue_order(&state.db, session_id).await?;
                let _ = repo::create_message(
                    &state.db,
                    session_id,
                    session.orchestrator_agent_id.as_deref(),
                    Some(&linked.agent_id),
                    MessageKind::Assign.as_str(),
                    &linked.goal,
                    None,
                    None,
                    next_order,
                )
                .await;
                broadcast_collaboration_event(
                    state,
                    session_id,
                    "collaboration_assignment_updated",
                    Some(json!({
                        "assignmentId": linked.id,
                        "agentId": linked.agent_id,
                        "newStatus": linked.status,
                        "aiTaskId": linked.ai_task_id,
                    })),
                );
                if let Some(current_task) = state.ai_runtime.get_task(user_id, &task.id).await {
                    if matches!(
                        current_task.status,
                        crate::ai::config::AiTaskStatus::Completed
                            | crate::ai::config::AiTaskStatus::Failed
                    ) {
                        Box::pin(super::worker::sync_terminal_task(state, &current_task)).await?;
                    }
                }
            }
            Err(error) => {
                let failed = repo::update_assignment_status(
                    &state.db,
                    &claimed.id,
                    AssignmentStatus::Failed.as_str(),
                )
                .await?;
                broadcast_collaboration_event(
                    state,
                    session_id,
                    "collaboration_assignment_updated",
                    Some(json!({
                        "assignmentId": failed.id,
                        "agentId": failed.agent_id,
                        "newStatus": failed.status,
                        "error": error.to_string(),
                    })),
                );
                halt_failed_session(state, session_id, "协同任务创建失败").await?;
                return Err(anyhow::anyhow!(error.to_string()));
            }
        }
    }

    Ok(())
}

fn assignment_dependencies(assignment: &CollaborationAssignment) -> Vec<String> {
    assignment
        .depends_on_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .unwrap_or_default()
}

fn dependencies_satisfied(
    assignment: &CollaborationAssignment,
    assignments: &[CollaborationAssignment],
) -> bool {
    assignment_dependencies(assignment)
        .into_iter()
        .all(|dependency| {
            assignments
                .iter()
                .find(|candidate| candidate.agent_id == dependency)
                .is_some_and(|candidate| candidate.status == "done")
        })
}

fn dependency_output_context(
    assignment: &CollaborationAssignment,
    messages: &[CollaborationMessage],
) -> String {
    let dependencies = assignment_dependencies(assignment);
    let outputs = dependencies
        .iter()
        .filter_map(|agent_id| {
            messages
                .iter()
                .rev()
                .find(|message| {
                    message.source_agent_id.as_deref() == Some(agent_id.as_str())
                        && message.message_kind == MessageKind::Status.as_str()
                })
                .map(|message| format!("\n上游智能体 {} 的产出：\n{}", agent_id, message.content))
        })
        .collect::<String>();
    if outputs.is_empty() {
        String::new()
    } else {
        format!("\n依赖任务产出：{}", outputs)
    }
}

/// 发送协同消息
pub async fn send_message(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
    Json(req): Json<SendMessageReq>,
) -> Result<Json<CollaborationMessage>, AppError> {
    verify_session_owner(&state, &session_id, &user_id).await?;

    let message_kind =
        MessageKind::try_from(req.message_kind.as_str()).map_err(AppError::BadRequest)?;

    let message = match &message_kind {
        MessageKind::Question => dispatcher::Dispatcher::handle_question(
            &state.db,
            &session_id,
            req.source_agent_id.as_deref().unwrap_or(""),
            req.target_agent_id.as_deref().unwrap_or(""),
            &req.content,
            req.question_fingerprint.as_deref(),
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?,
        MessageKind::Answer => dispatcher::Dispatcher::handle_answer(
            &state.db,
            &session_id,
            req.source_agent_id.as_deref().unwrap_or(""),
            req.target_agent_id.as_deref().unwrap_or(""),
            &req.content,
            req.reply_to_message_id.as_deref(),
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?,
        _ => {
            let next_order = repo::get_next_queue_order(&state.db, &session_id)
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;

            let msg = repo::create_message(
                &state.db,
                &session_id,
                req.source_agent_id.as_deref(),
                req.target_agent_id.as_deref(),
                message_kind.as_str(),
                &req.content,
                req.question_fingerprint.as_deref(),
                req.reply_to_message_id.as_deref(),
                next_order,
            )
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

            let _ = repo::increment_round_count(&state.db, &session_id).await;
            msg
        }
    };

    let payload = json!({
        "messageId": message.id,
        "messageKind": message.message_kind,
        "sourceAgentId": message.source_agent_id,
        "targetAgentId": message.target_agent_id,
    });

    broadcast_collaboration_event(
        &state,
        &session_id,
        "collaboration_message_sent",
        Some(payload),
    );

    if let Err(error) = apply_automatic_loop_check(&state, &session_id).await {
        tracing::warn!(session_id = %session_id, error = %error, "自动循环检测失败");
    }

    Ok(Json(message))
}

async fn apply_automatic_loop_check(state: &AppState, session_id: &str) -> anyhow::Result<()> {
    let signals = loop_detector::LoopDetector::detect(&state.db, session_id).await?;
    if signals.is_empty() {
        return Ok(());
    }

    let session = repo::get_session(&state.db, session_id).await?;
    let level = loop_detector::LoopDetector::calculate_level(&signals, session.round_count);
    let signal_strings = signals
        .iter()
        .map(|signal| signal.as_str().to_string())
        .collect::<Vec<_>>();
    let action = if level >= 4 {
        "halt_session"
    } else if level >= 2 {
        "escalate_to_director"
    } else {
        "warn_current_agent"
    };
    let payload = json!({
        "level": level,
        "signals": signal_strings,
        "action": action,
        "message": if level >= 4 { "达到自动讨论轮数上限" } else { "检测到协同循环风险" },
    });
    repo::update_loop_status(&state.db, session_id, &payload.to_string()).await?;
    broadcast_collaboration_event(
        state,
        session_id,
        "collaboration_loop_warning",
        Some(payload),
    );

    if level >= 4 {
        halt_failed_session(state, session_id, "达到自动讨论轮数上限").await?;
    }
    Ok(())
}

/// 获取协同会话消息列表
pub async fn list_messages(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
) -> Result<Json<Vec<CollaborationMessage>>, AppError> {
    verify_session_owner(&state, &session_id, &user_id).await?;

    let messages = repo::list_messages(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(messages))
}

/// 循环检测
pub async fn loop_check(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
) -> Result<Json<LoopCheckResponse>, AppError> {
    verify_session_owner(&state, &session_id, &user_id).await?;

    let signals = loop_detector::LoopDetector::detect(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if signals.is_empty() {
        return Ok(Json(LoopCheckResponse {
            loop_detected: false,
            signals: vec![],
            level: 0,
            action: "none".to_string(),
            message: "未检测到循环风险".to_string(),
        }));
    }

    let session = repo::get_session(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let level = loop_detector::LoopDetector::calculate_level(&signals, session.round_count);

    let (action, message) = match level {
        1 => (
            "warn_current_agent".to_string(),
            "检测到循环风险：要求当前智能体改写为明确问题".to_string(),
        ),
        2 => (
            "escalate_to_director".to_string(),
            "检测到循环风险：已升级给编导重新拆解任务".to_string(),
        ),
        3 => (
            "escalate_to_user".to_string(),
            "检测到严重循环风险：请求用户裁决".to_string(),
        ),
        4 => (
            "halt_session".to_string(),
            "协同会话已暂停：达到自动讨论轮数上限".to_string(),
        ),
        _ => ("unknown".to_string(), "未知循环风险等级".to_string()),
    };

    let signal_strings: Vec<String> = signals.iter().map(|s| s.as_str().to_string()).collect();

    if level >= 4 {
        let _ =
            repo::update_session_state(&state.db, &session_id, SessionState::Halted.as_str()).await;
    }

    let payload = json!({
        "level": level,
        "signals": signal_strings,
        "action": action
    });

    let _ = repo::update_loop_status(&state.db, &session_id, &payload.to_string()).await;

    broadcast_collaboration_event(
        &state,
        &session_id,
        "collaboration_loop_warning",
        Some(payload),
    );

    Ok(Json(LoopCheckResponse {
        loop_detected: true,
        signals: signal_strings,
        level,
        action,
        message,
    }))
}

/// 入工作区判定（含成熟度检查 + 自动创建 pipeline_run）
pub async fn admit(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
) -> Result<Json<AdmitResponse>, AppError> {
    let session = verify_session_owner(&state, &session_id, &user_id).await?;
    Ok(Json(admit_session(&state, session).await?))
}

/// 当所有协同任务成功完成时自动进入工作区。
pub(crate) async fn try_auto_admit(
    state: &AppState,
    session_id: &str,
) -> Result<Option<AdmitResponse>, AppError> {
    let session = repo::get_session(&state.db, session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !matches!(
        session.state.as_str(),
        "resolving_questions" | "workspace_admission"
    ) {
        return Ok(None);
    }

    let assignments = repo::list_assignments(&state.db, session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if assignments.is_empty()
        || !assignments
            .iter()
            .all(|assignment| assignment.status == "done")
    {
        return Ok(None);
    }

    Ok(Some(admit_session(state, session).await?))
}

pub(crate) async fn halt_failed_session(
    state: &AppState,
    session_id: &str,
    reason: &str,
) -> anyhow::Result<()> {
    let session = repo::get_session(&state.db, session_id).await?;
    if matches!(session.state.as_str(), "completed" | "halted") {
        return Ok(());
    }
    let updated =
        repo::update_session_state(&state.db, session_id, SessionState::Halted.as_str()).await?;
    let payload = json!({ "reason": reason, "state": updated.state });
    broadcast_collaboration_event(
        state,
        session_id,
        "collaboration_session_halted",
        Some(payload),
    );
    Ok(())
}

async fn admit_session(
    state: &AppState,
    session: CollaborationSession,
) -> Result<AdmitResponse, AppError> {
    let session_id = session.id.clone();

    let current_state =
        SessionState::try_from(session.state.as_str()).map_err(|e| AppError::BadRequest(e))?;

    if current_state != SessionState::ResolvingQuestions
        && current_state != SessionState::WorkspaceAdmission
    {
        return Err(AppError::BadRequest(format!(
            "当前状态 {} 不允许入工作区判定",
            session.state
        )));
    }

    let assignments = repo::list_assignments(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    // 成熟度检查：阻塞中的智能体
    let blocked: Vec<&CollaborationAssignment> = assignments
        .iter()
        .filter(|a| a.status == "blocked" || a.status == "questioning")
        .collect();

    if !blocked.is_empty() {
        let blocking_issues: Vec<BlockingIssue> = blocked
            .iter()
            .map(|a| BlockingIssue {
                assignment_id: a.id.clone(),
                agent_id: a.agent_id.clone(),
                question: format!("智能体 {} 仍有未解决的阻塞问题", a.agent_id),
                status: a.status.clone(),
            })
            .collect();

        return Ok(AdmitResponse {
            admitted: false,
            pipeline_run_id: None,
            reason: format!("仍有 {} 个阻塞问题未解决，无法入场", blocked.len()),
            blocking_issues: Some(blocking_issues),
        });
    }

    // 成熟度检查：关键角色就绪状态
    let readiness = evaluate_readiness(&assignments);

    if !readiness.can_admit {
        return Ok(AdmitResponse {
            admitted: false,
            pipeline_run_id: None,
            reason: readiness.reason,
            blocking_issues: None,
        });
    }

    repo::update_session_state(
        &state.db,
        &session_id,
        SessionState::WorkspaceAdmission.as_str(),
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    if let Err(e) = repo::update_admission_decision(
        &state.db,
        &session_id,
        &json!({"admitted": true, "reason": &readiness.reason}).to_string(),
    )
    .await
    {
        tracing::warn!(session_id = %session_id, error = %e, "更新入场判定记录失败");
    }

    // 入场成功后自动创建 pipeline_run
    let pipeline_run_id =
        match create_pipeline_from_collaboration(state, &session, &assignments).await {
            Ok(pipeline_run_id) => pipeline_run_id,
            Err(error) => {
                let failure_payload = json!({
                    "admitted": false,
                    "sessionId": session_id,
                    "pipelineRunId": null,
                    "error": error.to_string(),
                });
                let _ = repo::update_admission_decision(
                    &state.db,
                    &session_id,
                    &failure_payload.to_string(),
                )
                .await;
                broadcast_collaboration_event(
                    state,
                    &session_id,
                    "collaboration_admission_changed",
                    Some(failure_payload),
                );
                return Err(error);
            }
        };

    let payload = json!({
        "admitted": true,
        "sessionId": session_id,
        "pipelineRunId": pipeline_run_id
    });

    broadcast_collaboration_event(
        &state,
        &session_id,
        "collaboration_admission_changed",
        Some(payload),
    );

    let workspace_payload = json!({
        "sessionId": session_id,
        "pipelineRunId": pipeline_run_id,
        "state": "workspace_execution"
    });
    broadcast_collaboration_event(
        state,
        &session_id,
        "collaboration_workspace_started",
        Some(workspace_payload),
    );

    Ok(AdmitResponse {
        admitted: true,
        pipeline_run_id: Some(pipeline_run_id),
        reason: readiness.reason,
        blocking_issues: None,
    })
}

/// 暂停协同
pub async fn halt(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
    Json(req): Json<HaltReq>,
) -> Result<Json<CollaborationSession>, AppError> {
    let session = verify_session_owner(&state, &session_id, &user_id).await?;

    let current_state =
        SessionState::try_from(session.state.as_str()).map_err(|e| AppError::BadRequest(e))?;

    if current_state == SessionState::Completed || current_state == SessionState::Halted {
        return Err(AppError::BadRequest(format!(
            "当前状态 {} 不允许暂停",
            session.state
        )));
    }

    let session = repo::update_session_state(&state.db, &session_id, SessionState::Halted.as_str())
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let payload = json!({
        "reason": req.reason,
        "detail": req.detail
    });

    broadcast_collaboration_event(
        &state,
        &session_id,
        "collaboration_session_halted",
        Some(payload),
    );

    Ok(Json(session))
}

/// 协同事件 SSE 流
///
/// Supports Last-Event-ID header for cursor-based replay from collaboration_events table.
/// Events carry an id field (SQLite rowid) for resume after disconnect.
/// When the session reaches a terminal state (completed/halted), the stream closes.
pub async fn stream_collaboration_events(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Query(cursor_query): Query<std::collections::HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.collaboration_broadcaster.subscribe();
    let user_id = user_id.0.clone();
    let db = state.db.clone();

    // Parse cursor from Last-Event-ID header or ?cursor= query param
    let initial_cursor: i64 = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .or_else(|| cursor_query.get("cursor").map(String::as_str))
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

    let stream = async_stream::stream! {
        // Replay events from DB if cursor provided
        let mut last_event_id = initial_cursor;
        if initial_cursor > 0 {
            if let Ok(rows) = sqlx::query_as::<_, (String, String, Option<String>, i64)>(
                "SELECT ce.event_type, ce.session_id, ce.payload_json, ce.rowid
                 FROM collaboration_events ce
                 JOIN collaboration_sessions cs ON ce.session_id = cs.id
                 WHERE cs.user_id = ? AND ce.rowid > ?
                 ORDER BY ce.rowid ASC LIMIT 200"
            )
            .bind(&user_id)
            .bind(initial_cursor)
            .fetch_all(&db)
            .await {
                for (event_type, session_id, payload_json, rowid) in rows {
                    last_event_id = last_event_id.max(rowid);
                    // Use the same envelope type as live broadcasts for consistency
                    // (includes seq field for client-side ordering)
                    let envelope = crate::collaboration::broadcast::CollaborationEventEnvelope {
                        session_id,
                        event_type,
                        payload: payload_json.and_then(|p| serde_json::from_str::<serde_json::Value>(&p).ok()),
                        seq: Some(rowid),
                    };
                    let data = serde_json::to_string(&envelope).unwrap_or_default();
                    yield Ok(Event::default()
                        .id(rowid.to_string())
                        .event("collaboration")
                        .retry(std::time::Duration::from_secs(3))
                        .data(data));
                }
            }
        } else {
            // No cursor — send a snapshot signal so client knows connection is alive
            yield Ok(Event::default()
                .id("0")
                .event("snapshot")
                .retry(std::time::Duration::from_secs(3))
                .data("{\"status\":\"connected\"}"));
        }

        // Periodically poll for terminal session state in case the terminal event
        // was missed (e.g. between connections). Use tokio select! to interleave
        // broadcast events with a polling timer.
        let mut poll_interval = tokio::time::interval(std::time::Duration::from_secs(15));
        poll_interval.tick().await; // consume first immediate tick

        loop {
            tokio::select! {
                _ = poll_interval.tick() => {
                    // Poll DB for any sessions this user owns that have reached
                    // terminal state but whose event we may have missed.
                    let terminal_sessions: Vec<(String, String)> = sqlx::query_as::<_, (String, String)>(
                        "SELECT id, state FROM collaboration_sessions
                         WHERE user_id = ? AND state IN ('completed', 'halted')"
                    )
                    .bind(&user_id)
                    .fetch_all(&db)
                    .await
                    .unwrap_or_default();

                    for (sid, state_str) in terminal_sessions {
                        let reason = if state_str == "completed" { "session_completed" } else { "session_halted" };
                        last_event_id += 1;
                        let terminal_data = serde_json::json!({
                            "sessionId": sid,
                            "state": state_str,
                        }).to_string();
                        yield Ok(Event::default()
                            .id(last_event_id.to_string())
                            .event("collaboration")
                            .retry(std::time::Duration::from_secs(3))
                            .data(terminal_data));
                        last_event_id += 1;
                        yield Ok(Event::default()
                            .id(last_event_id.to_string())
                            .event("done")
                            .data(serde_json::json!({"reason": reason, "sessionId": sid}).to_string()));
                    }
                }
                recv_result = rx.recv() => {
                    match recv_result {
                Ok(envelope) => {
                    // 校验用户是否有权接收此会话的事件
                    let is_owner = sqlx::query_scalar::<_, i64>(
                        "SELECT COUNT(*) FROM collaboration_sessions WHERE id = ? AND user_id = ?"
                    )
                    .bind(&envelope.session_id)
                    .bind(&user_id)
                    .fetch_one(&db)
                    .await
                    .unwrap_or(0);

                    if is_owner == 0 {
                        continue;
                    }

                    // Use the seq from envelope if provided (from persist_and_broadcast),
                    // otherwise look it up from DB (legacy path for in-memory-only broadcasts).
                    let event_rowid = if let Some(seq) = envelope.seq {
                        seq
                    } else {
                        sqlx::query_scalar::<_, i64>(
                            "SELECT rowid FROM collaboration_events
                             WHERE session_id = ? AND event_type = ?
                             ORDER BY rowid DESC LIMIT 1"
                        )
                        .bind(&envelope.session_id)
                        .bind(&envelope.event_type)
                        .fetch_optional(&db)
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or(last_event_id + 1)
                    };

                    last_event_id = last_event_id.max(event_rowid);

                    let data = serde_json::to_string(&envelope).unwrap_or_default();
                    yield Ok(Event::default()
                        .id(last_event_id.to_string())
                        .event("collaboration")
                        .retry(std::time::Duration::from_secs(3))
                        .data(data));

                    // Check if this event type indicates the session reached terminal state.
                    // Covers: workspace completion broadcasts, explicit halt, etc.
                    let et = envelope.event_type.as_str();
                    if et.ends_with("_halted") || et.ends_with("_completed") || et.ends_with("_failed") {
                        last_event_id += 1;
                        yield Ok(Event::default()
                            .id(last_event_id.to_string())
                            .event("done")
                            .retry(std::time::Duration::from_secs(3))
                            .data("{\"reason\":\"session_terminal\"}"));
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    // On lag, do a catch-up query from DB to fill gaps, then signal client
                    let current = last_event_id;
                    if let Ok(rows) = sqlx::query_as::<_, (String, String, Option<String>, i64)>(
                        "SELECT ce.event_type, ce.session_id, ce.payload_json, ce.rowid
                         FROM collaboration_events ce
                         JOIN collaboration_sessions cs ON ce.session_id = cs.id
                         WHERE cs.user_id = ? AND ce.rowid > ?
                         ORDER BY ce.rowid ASC LIMIT 200"
                    )
                    .bind(&user_id)
                    .bind(current)
                    .fetch_all(&db)
                    .await {
                        for (event_type, session_id, payload_json, rowid) in rows {
                            last_event_id = last_event_id.max(rowid);
                            let env = serde_json::json!({
                                "sessionId": session_id,
                                "eventType": event_type,
                                "payload": payload_json.and_then(|p| serde_json::from_str::<serde_json::Value>(&p).ok()),
                            });
                            let data = serde_json::to_string(&env).unwrap_or_default();
                            yield Ok(Event::default()
                                .id(rowid.to_string())
                                .event("collaboration")
                                .retry(std::time::Duration::from_secs(3))
                                .data(data));
                        }
                    }
                    // Signal lag with the last known id so client can reconnect if needed
                    let lagged_data = serde_json::json!({ "skipped": skipped, "lastEventId": last_event_id }).to_string();
                    yield Ok(Event::default()
                        .id(last_event_id.to_string())
                        .event("lagged")
                        .retry(std::time::Duration::from_secs(1))
                        .data(lagged_data));
                }
                Err(_) => {
                    // Broadcast channel closed — emit done and exit
                    last_event_id += 1;
                    yield Ok(Event::default()
                        .id(last_event_id.to_string())
                        .event("done")
                        .retry(std::time::Duration::from_secs(3))
                        .data("{\"reason\":\"server_shutdown\"}"));
                    break;
                }
                    }
                }
            }
        }
    };

    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// 成熟度评估结果
struct ReadinessResult {
    can_admit: bool,
    reason: String,
}

/// 评估协同会话的成熟度，判断是否可以入场
fn evaluate_readiness(assignments: &[CollaborationAssignment]) -> ReadinessResult {
    if assignments.is_empty() {
        return ReadinessResult {
            can_admit: false,
            reason: "尚未分派协同任务，无法入场".to_string(),
        };
    }

    let incomplete = assignments
        .iter()
        .filter(|assignment| !matches!(assignment.status.as_str(), "ready" | "done"))
        .count();
    if incomplete > 0 {
        return ReadinessResult {
            can_admit: false,
            reason: format!("仍有 {} 个协同任务未完成，无法入场", incomplete),
        };
    }

    ReadinessResult {
        can_admit: true,
        reason: "关键依赖链无阻塞，编导确认入场".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        dependencies_satisfied, CollaborationAssignment, COLLABORATION_PIPELINE_TYPE,
        COLLABORATION_TRIGGER_SOURCE,
    };

    fn assignment(agent_id: &str, status: &str, dependencies: &[&str]) -> CollaborationAssignment {
        CollaborationAssignment {
            id: format!("assignment-{agent_id}"),
            session_id: "session-1".to_string(),
            agent_id: agent_id.to_string(),
            task_type: "design".to_string(),
            goal: "test".to_string(),
            input_json: None,
            depends_on_json: (!dependencies.is_empty()).then(|| {
                serde_json::to_string(dependencies).expect("dependencies should serialize")
            }),
            status: status.to_string(),
            blocking_question_count: 0,
            last_question_fingerprint: None,
            ai_task_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn collaboration_pipeline_type_matches_database_constraint() {
        let supported = [
            "one_click",
            "outline",
            "script",
            "storyboard",
            "review",
            "custom",
        ];
        let supported_trigger_sources = ["manual", "automation", "api", "retry"];

        assert!(supported.contains(&COLLABORATION_PIPELINE_TYPE));
        assert!(supported_trigger_sources.contains(&COLLABORATION_TRIGGER_SOURCE));
    }

    #[test]
    fn dependent_assignment_waits_for_upstream_completion() {
        let downstream = assignment("agent-b", "assigned", &["agent-a"]);
        let mut assignments = vec![assignment("agent-a", "running", &[]), downstream.clone()];
        assert!(!dependencies_satisfied(&downstream, &assignments));

        assignments[0].status = "done".to_string();
        assert!(dependencies_satisfied(&downstream, &assignments));
    }
}

/// 协同入场后自动创建 pipeline_run
const COLLABORATION_PIPELINE_TYPE: &str = "custom";
const COLLABORATION_TRIGGER_SOURCE: &str = "automation";

async fn create_pipeline_from_collaboration(
    state: &AppState,
    session: &CollaborationSession,
    assignments: &[CollaborationAssignment],
) -> Result<String, AppError> {
    let ready_assignments: Vec<&CollaborationAssignment> = assignments
        .iter()
        .filter(|a| a.status == "ready" || a.status == "done")
        .collect();

    if ready_assignments.is_empty() {
        return Err(AppError::BadRequest(
            "没有可创建工作区流程的协同任务".to_string(),
        ));
    }

    let step_keys = ready_assignments
        .iter()
        .map(|assignment| {
            (
                assignment.agent_id.clone(),
                format!("collab-{}", assignment.id),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let steps: Vec<crate::pipeline::model::CreatePipelineStepReq> = ready_assignments
        .iter()
        .enumerate()
        .map(|(i, a)| crate::pipeline::model::CreatePipelineStepReq {
            step_key: step_keys
                .get(&a.agent_id)
                .cloned()
                .unwrap_or_else(|| format!("collab-{}", a.id)),
            step_name: a.goal.clone(),
            step_order: i as i64,
            step_type: a.task_type.clone(),
            depends_on: a
                .depends_on_json
                .as_ref()
                .and_then(|v| serde_json::from_str::<Vec<String>>(v).ok())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|agent_id| step_keys.get(&agent_id).cloned())
                .collect(),
            review_policy: None,
            max_retries: Some(3),
            prompt_template: Some(a.goal.clone()),
        })
        .collect();

    let req = crate::pipeline::model::CreatePipelineRunReq {
        project_id: session.project_id.clone(),
        conversation_id: session.conversation_id.clone(),
        pipeline_type: COLLABORATION_PIPELINE_TYPE.to_string(),
        trigger_source: COLLABORATION_TRIGGER_SOURCE.to_string(),
        beta_enabled: true,
        idempotency_key: Some(format!("collab-{}", session.id)),
        steps,
    };

    let (_, run) = crate::pipeline::handlers::create_pipeline_run_for_user(
        &state.db,
        &session.user_id,
        req,
        false,
    )
    .await?;
    let run_id = run.id;
    repo::update_session_pipeline_run_id(&state.db, &session.id, &run_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    repo::update_session_state(
        &state.db,
        &session.id,
        SessionState::WorkspaceExecution.as_str(),
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    tracing::info!(
        session_id = %session.id,
        pipeline_run_id = %run_id,
        "协同入场后自动创建 pipeline_run 成功"
    );
    let payload = json!({
        "sessionId": session.id,
        "pipelineRunId": run_id,
        "state": SessionState::WorkspaceExecution.as_str(),
    });
    broadcast_collaboration_event(
        &state,
        &session.id,
        "collaboration_workspace_started",
        Some(payload),
    );
    Ok(run_id)
}
