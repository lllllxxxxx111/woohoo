use axum::{
    extract::{Path, Query, State},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use chrono::{SecondsFormat, Utc};
use futures::stream::Stream;
use serde_json::json;
use std::convert::Infallible;
use uuid::Uuid;

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

/// 广播协同事件到 SSE channel
fn broadcast_collaboration_event(
    state: &AppState,
    session_id: &str,
    event_type: &str,
    payload: Option<serde_json::Value>,
) {
    state
        .collaboration_broadcaster
        .broadcast(session_id.to_string(), event_type, payload);
}

/// 创建协同会话
pub async fn create_session(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<CreateSessionReq>,
) -> Result<Json<CollaborationSession>, AppError> {
    let project_exists =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM projects WHERE id = ? AND user_id = ?")
            .bind(&req.project_id)
            .bind(&user_id.0)
            .fetch_one(&state.db)
            .await?
            > 0;
    if !project_exists {
        return Err(AppError::NotFound("项目不存在或无权访问".to_string()));
    }

    let conversation_exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM conversations WHERE id = ? AND project_id = ? AND user_id = ?",
    )
    .bind(&req.conversation_id)
    .bind(&req.project_id)
    .bind(&user_id.0)
    .fetch_one(&state.db)
    .await?
        > 0;
    if !conversation_exists {
        return Err(AppError::NotFound("对话不存在或不属于当前项目".to_string()));
    }

    if let Some(orchestrator_agent_id) = req.orchestrator_agent_id.as_deref() {
        let orchestrator_exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM agents WHERE id = ? AND user_id = ? AND is_active = 1",
        )
        .bind(orchestrator_agent_id)
        .bind(&user_id.0)
        .fetch_one(&state.db)
        .await?
            > 0;
        if !orchestrator_exists {
            return Err(AppError::BadRequest(
                "主编智能体不存在、已停用或不属于当前用户".to_string(),
            ));
        }
    }

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

    let _ = repo::create_event(
        &state.db,
        &session.id,
        "collaboration_session_created",
        Some(&payload.to_string()),
    )
    .await;

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

    for assignment in &req.assignments {
        let agent_exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM agents WHERE id = ? AND user_id = ? AND is_active = 1",
        )
        .bind(&assignment.agent_id)
        .bind(&user_id.0)
        .fetch_one(&state.db)
        .await?
            > 0;
        if !agent_exists {
            return Err(AppError::BadRequest(format!(
                "智能体 {} 不存在、已停用或不属于当前用户",
                assignment.agent_id
            )));
        }
    }

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
        let role_instruction = match claimed.task_type.as_str() {
            "review" => {
                "你处于审核阶段。必须逐项核对上游成果，指出冲突、缺漏和风险，并给出明确修改建议。"
            }
            "synthesis" => {
                "你是最终主编。必须吸收上游成果与审核意见，做出取舍并输出一份完整、统一、可直接交付的最终内容，不能只写摘要。"
            }
            _ => "你是领域专家。请输出具体、结构化、可供审核和汇总直接复用的专业成果。",
        };
        let task_prompt = format!(
            "你正在参与项目内多智能体协同。\n任务类型：{}\n任务目标：{}\n任务输入：{}{}\n{}\n请直接给出明确产出，不要反问用户。",
            claimed.task_type,
            claimed.goal,
            input_context,
            dependency_context,
            role_instruction
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
    let _ = repo::create_event(
        &state.db,
        session_id,
        "collaboration_loop_warning",
        Some(&payload.to_string()),
    )
    .await;
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

    let _ = repo::create_event(
        &state.db,
        &session_id,
        "collaboration_loop_warning",
        Some(&payload.to_string()),
    )
    .await;

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
    let updated = repo::halt_session_with_audit(&state.db, session_id, reason, "system").await?;
    let payload = json!({ "reason": reason, "state": updated.state, "haltedBy": "system" });
    let _ = repo::create_event(
        &state.db,
        session_id,
        "collaboration_session_halted",
        Some(&payload.to_string()),
    )
    .await;
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
                let _ = repo::create_event(
                    &state.db,
                    &session_id,
                    "collaboration_admission_changed",
                    Some(&failure_payload.to_string()),
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

    if let Err(e) = repo::create_event(
        &state.db,
        &session_id,
        "collaboration_admission_changed",
        Some(&payload.to_string()),
    )
    .await
    {
        tracing::warn!(session_id = %session_id, error = %e, "创建入场事件记录失败");
    }

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

    let session = repo::halt_session_with_audit(&state.db, &session_id, &req.reason, &user_id.0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let payload = json!({
        "reason": req.reason,
        "detail": req.detail,
        "haltedBy": user_id.0,
    });

    if let Err(e) = repo::create_event(
        &state.db,
        &session_id,
        "collaboration_session_halted",
        Some(&payload.to_string()),
    )
    .await
    {
        tracing::warn!(session_id = %session_id, error = %e, "创建暂停事件记录失败");
    }

    broadcast_collaboration_event(
        &state,
        &session_id,
        "collaboration_session_halted",
        Some(payload),
    );

    Ok(Json(session))
}

/// 恢复已暂停的协同会话（人工恢复流程）
/// POST /api/collaboration/sessions/{id}/resume
pub async fn resume(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
    Json(req): Json<ResumeReq>,
) -> Result<Json<CollaborationSession>, AppError> {
    let session = verify_session_owner(&state, &session_id, &user_id).await?;

    if session.state != "halted" {
        return Err(AppError::BadRequest(format!(
            "当前状态 {} 不允许恢复，仅 halted 状态可恢复",
            session.state
        )));
    }

    let session = repo::resume_session(
        &state.db,
        &session_id,
        &req.action,
        &user_id.0,
        req.note.as_deref(),
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let payload = json!({
        "action": req.action,
        "operatorUserId": user_id.0,
        "note": req.note,
        "newState": session.state,
    });

    let _ = repo::create_event(
        &state.db,
        &session_id,
        "collaboration_session_resumed",
        Some(&payload.to_string()),
    )
    .await;

    broadcast_collaboration_event(
        &state,
        &session_id,
        "collaboration_session_resumed",
        Some(payload),
    );

    // 恢复后尝试重新分派就绪任务
    if let Err(e) = dispatch_ready_assignments(&state, &user_id.0, &session_id).await {
        tracing::warn!(session_id = %session_id, error = %e, "恢复后重新分派失败");
    }

    Ok(Json(session))
}

/// 获取队列可视化（当前发言者/待发言/已完成/阻塞）
/// GET /api/collaboration/sessions/{id}/queue
pub async fn get_queue(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Path(session_id): Path<String>,
) -> Result<Json<QueueVisualization>, AppError> {
    let session = verify_session_owner(&state, &session_id, &user_id).await?;
    let assignments = repo::list_assignments(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    // 从持久化的 reply_queue_json 加载队列
    let queue = super::queue::ReplyQueueManager::load_queue(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let current_speaker = queue.first().map(|entry| QueueSpeaker {
        agent_id: entry.agent_id.clone(),
        intent: entry.intent.clone(),
    });

    let pending_queue: Vec<QueueSpeaker> = queue
        .iter()
        .skip(1)
        .map(|entry| QueueSpeaker {
            agent_id: entry.agent_id.clone(),
            intent: entry.intent.clone(),
        })
        .collect();

    let completed_members: Vec<CompletedMember> = assignments
        .iter()
        .filter(|a| a.status == "done")
        .map(|a| CompletedMember {
            agent_id: a.agent_id.clone(),
            goal: a.goal.clone(),
            completed_at: a.updated_at.clone(),
        })
        .collect();

    let blocked_members: Vec<BlockedMember> = assignments
        .iter()
        .filter(|a| a.status == "blocked" || a.status == "questioning")
        .map(|a| BlockedMember {
            agent_id: a.agent_id.clone(),
            goal: a.goal.clone(),
            blocking_reason: a.failure_reason.clone().unwrap_or_else(|| {
                format!(
                    "智能体 {} 有 {} 个未解决问题",
                    a.agent_id, a.blocking_question_count
                )
            }),
            blocking_question_count: a.blocking_question_count,
        })
        .collect();

    Ok(Json(QueueVisualization {
        session_id: session.id,
        current_speaker,
        pending_queue,
        completed_members,
        blocked_members,
    }))
}

/// 协同事件 SSE 流
pub async fn stream_collaboration_events(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.collaboration_broadcaster.subscribe();
    let user_id = user_id.0.clone();
    let db = state.db.clone();

    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
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

                    let data = serde_json::to_string(&envelope).unwrap_or_default();
                    yield Ok(Event::default().event("collaboration").data(data));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(_) => break,
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
        .filter(|assignment| assignment.status != "done")
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
            failure_reason: None,
            semantic_fingerprint: None,
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
    let completed_assignments: Vec<&CollaborationAssignment> = assignments
        .iter()
        .filter(|assignment| assignment.status == "done")
        .collect();

    if completed_assignments.is_empty() {
        return Err(AppError::BadRequest(
            "没有可创建工作区流程的协同任务".to_string(),
        ));
    }

    let delivery_assignments: Vec<&CollaborationAssignment> = session
        .orchestrator_agent_id
        .as_deref()
        .and_then(|orchestrator_id| {
            completed_assignments
                .iter()
                .copied()
                .find(|assignment| assignment.agent_id == orchestrator_id)
        })
        .map(|assignment| vec![assignment])
        .unwrap_or(completed_assignments);

    let messages = repo::list_messages(&state.db, &session.id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let deliverables = delivery_assignments
        .into_iter()
        .map(|assignment| {
            let content = messages
                .iter()
                .rev()
                .find(|message| {
                    message.source_agent_id.as_deref() == Some(assignment.agent_id.as_str())
                        && message.message_kind == MessageKind::Status.as_str()
                })
                .map(|message| message.content.trim().to_string())
                .filter(|content| !content.is_empty())
                .ok_or_else(|| {
                    AppError::Internal(format!("协同任务 {} 已完成但缺少可交付输出", assignment.id))
                })?;
            Ok((assignment, content))
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    let idempotency_key = format!("collab-{}", session.id);
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    if let Some((existing_run_id,)) = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM pipeline_runs WHERE user_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&session.user_id)
    .bind(&idempotency_key)
    .fetch_optional(&mut *tx)
    .await?
    {
        sqlx::query(
            "UPDATE collaboration_sessions
             SET pipeline_run_id = ?, state = 'workspace_execution', updated_at = ?
             WHERE id = ?",
        )
        .bind(&existing_run_id)
        .bind(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true))
        .bind(&session.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(existing_run_id);
    }

    let run_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let total_steps = deliverables.len() as i64;
    sqlx::query(
        "INSERT INTO pipeline_runs (
            id, user_id, project_id, conversation_id,
            pipeline_type, trigger_source, status, idempotency_key,
            total_steps, completed_steps, failed_steps,
            started_at, finished_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, 0, ?, ?, ?, ?)",
    )
    .bind(&run_id)
    .bind(&session.user_id)
    .bind(&session.project_id)
    .bind(&session.conversation_id)
    .bind(COLLABORATION_PIPELINE_TYPE)
    .bind(COLLABORATION_TRIGGER_SOURCE)
    .bind(&idempotency_key)
    .bind(total_steps)
    .bind(total_steps)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    for (index, (assignment, content)) in deliverables.iter().enumerate() {
        let step_id = Uuid::new_v4().to_string();
        let output_id = Uuid::new_v4().to_string();
        let step_key = format!("collab-{}", assignment.id);
        let step_name = if assignment.task_type == "synthesis" {
            "主编汇总交付"
        } else {
            assignment.goal.as_str()
        };
        let output_json = json!({
            "format": "collaboration",
            "source": "collaboration",
            "sessionId": session.id,
            "assignmentId": assignment.id,
            "agentId": assignment.agent_id,
            "taskType": assignment.task_type,
            "content": content,
        })
        .to_string();

        sqlx::query(
            "INSERT INTO pipeline_run_steps (
                id, run_id, step_key, step_name, step_order,
                step_type, depends_on_json, max_retries, run_version,
                input_summary, output_ref, status, duration_ms,
                started_at, completed_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, '[]', 0, 1, ?, ?, 'completed', 0, ?, ?, ?, ?)",
        )
        .bind(&step_id)
        .bind(&run_id)
        .bind(&step_key)
        .bind(step_name)
        .bind(index as i64)
        .bind(&assignment.task_type)
        .bind(&assignment.goal)
        .bind(&output_id)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO pipeline_step_outputs (
                id, run_id, step_id, task_id, output_type,
                output_json, raw_content, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'document', ?, ?, ?, ?)",
        )
        .bind(&output_id)
        .bind(&run_id)
        .bind(&step_id)
        .bind(assignment.ai_task_id.as_deref())
        .bind(&output_json)
        .bind(content)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO pipeline_run_events (
                id, run_id, step_id, event_type, payload_json, source, created_at
             ) VALUES (?, ?, ?, 'step_completed', ?, 'system', ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&run_id)
        .bind(&step_id)
        .bind(
            json!({
                "source": "collaboration",
                "sessionId": session.id,
                "assignmentId": assignment.id,
                "outputId": output_id,
            })
            .to_string(),
        )
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    for (event_type, payload) in [
        (
            "created",
            json!({
                "pipelineType": COLLABORATION_PIPELINE_TYPE,
                "triggerSource": COLLABORATION_TRIGGER_SOURCE,
                "totalSteps": total_steps,
                "sourceSessionId": session.id,
            }),
        ),
        (
            "completed",
            json!({
                "totalSteps": total_steps,
                "completedSteps": total_steps,
                "failedSteps": 0,
                "sourceSessionId": session.id,
            }),
        ),
    ] {
        sqlx::query(
            "INSERT INTO pipeline_run_events (
                id, run_id, step_id, event_type, payload_json, source, created_at
             ) VALUES (?, ?, NULL, ?, ?, 'system', ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&run_id)
        .bind(event_type)
        .bind(payload.to_string())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "UPDATE collaboration_sessions
         SET pipeline_run_id = ?, state = 'workspace_execution', updated_at = ?
         WHERE id = ?",
    )
    .bind(&run_id)
    .bind(&now)
    .bind(&session.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    tracing::info!(
        session_id = %session.id,
        pipeline_run_id = %run_id,
        "协同成果已作为已完成工作区产物写入 pipeline_run"
    );
    let payload = json!({
        "sessionId": session.id,
        "pipelineRunId": run_id,
        "state": SessionState::WorkspaceExecution.as_str(),
    });
    let _ = repo::create_event(
        &state.db,
        &session.id,
        "collaboration_workspace_started",
        Some(&payload.to_string()),
    )
    .await;
    Ok(run_id)
}
