use axum::{
    extract::{Path, Query, State},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::Stream;
use serde_json::json;
use std::convert::Infallible;

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::dispatcher::{self, DispatchItem};
use super::loop_detector;
use super::model::*;
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
    let sessions =
        repo::list_active_sessions_for_project(&state.db, &user_id.0, &params.project_id)
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

    let payload = json!({
        "dispatchedCount": result.dispatched_count,
        "sessionId": session_id
    });

    broadcast_collaboration_event(
        &state,
        &session_id,
        "collaboration_dispatched",
        Some(payload),
    );

    Ok(Json(DispatchResponse {
        dispatched_count: result.dispatched_count as i64,
        assignments: result.assignments,
    }))
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

    Ok(Json(message))
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

        return Ok(Json(AdmitResponse {
            admitted: false,
            pipeline_run_id: None,
            reason: format!("仍有 {} 个阻塞问题未解决，无法入场", blocked.len()),
            blocking_issues: Some(blocking_issues),
        }));
    }

    // 成熟度检查：关键角色就绪状态
    let readiness = evaluate_readiness(&assignments);

    if !readiness.can_admit {
        return Ok(Json(AdmitResponse {
            admitted: false,
            pipeline_run_id: None,
            reason: readiness.reason,
            blocking_issues: None,
        }));
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
    let pipeline_run_id = create_pipeline_from_collaboration(&state, &session, &assignments).await;

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

    if pipeline_run_id.is_some() {
        let workspace_payload = json!({
            "sessionId": session_id,
            "pipelineRunId": pipeline_run_id,
            "state": "workspace_execution"
        });
        broadcast_collaboration_event(
            &state,
            &session_id,
            "collaboration_workspace_started",
            Some(workspace_payload),
        );
    }

    Ok(Json(AdmitResponse {
        admitted: true,
        pipeline_run_id,
        reason: readiness.reason,
        blocking_issues: None,
    }))
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
    let critical_roles = ["outline_design", "character_design", "storyboard_render"];

    for role in &critical_roles {
        let has_ready = assignments
            .iter()
            .any(|a| a.task_type == *role && (a.status == "ready" || a.status == "done"));

        if !has_ready {
            let display_name = match *role {
                "outline_design" => "大纲架构",
                "character_design" => "人设设计",
                "storyboard_render" => "分镜渲染",
                _ => role,
            };
            return ReadinessResult {
                can_admit: false,
                reason: format!("关键角色「{}」尚未就绪，无法入场", display_name),
            };
        }
    }

    ReadinessResult {
        can_admit: true,
        reason: "关键依赖链无阻塞，编导确认入场".to_string(),
    }
}

/// 协同入场后自动创建 pipeline_run
async fn create_pipeline_from_collaboration(
    state: &AppState,
    session: &CollaborationSession,
    assignments: &[CollaborationAssignment],
) -> Option<String> {
    let ready_assignments: Vec<&CollaborationAssignment> = assignments
        .iter()
        .filter(|a| a.status == "ready" || a.status == "done")
        .collect();

    if ready_assignments.is_empty() {
        tracing::warn!(session_id = %session.id, "无就绪任务，跳过 pipeline_run 创建");
        return None;
    }

    let steps: Vec<crate::pipeline::model::CreatePipelineStepReq> = ready_assignments
        .iter()
        .enumerate()
        .map(|(i, a)| crate::pipeline::model::CreatePipelineStepReq {
            step_key: format!("step-{}", a.id),
            step_name: a.goal.clone(),
            step_order: i as i64,
            step_type: a.task_type.clone(),
            depends_on: a
                .depends_on_json
                .as_ref()
                .and_then(|v| serde_json::from_str(v).ok())
                .unwrap_or_default(),
            review_policy: None,
            max_retries: Some(3),
            prompt_template: Some(a.goal.clone()),
        })
        .collect();

    let req = crate::pipeline::model::CreatePipelineRunReq {
        project_id: session.project_id.clone(),
        conversation_id: session.conversation_id.clone(),
        pipeline_type: "collaboration".to_string(),
        trigger_source: "collaboration_admit".to_string(),
        beta_enabled: true,
        idempotency_key: Some(format!("collab-{}", session.id)),
        steps,
    };

    match crate::pipeline::handlers::create_pipeline_run_for_user(
        &state.db,
        &session.user_id,
        req,
        false,
    )
    .await
    {
        Ok((_, run)) => {
            tracing::info!(
                session_id = %session.id,
                pipeline_run_id = %run.id,
                "协同入场后自动创建 pipeline_run 成功"
            );
            Some(run.id)
        }
        Err(e) => {
            tracing::error!(
                session_id = %session.id,
                error = %e,
                "协同入场后创建 pipeline_run 失败"
            );
            None
        }
    }
}
