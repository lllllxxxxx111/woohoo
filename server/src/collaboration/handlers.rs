use axum::{
    extract::{Path, State},
    Json,
};
use serde_json::json;

use crate::error::AppError;
use crate::AppState;

use super::dispatcher::{self, DispatchItem};
use super::loop_detector;
use super::model::*;
use super::repo;

/// 创建协同会话
pub async fn create_session(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<String>,
    Json(req): Json<CreateSessionReq>,
) -> Result<Json<CollaborationSession>, AppError> {
    let session = repo::create_session(
        &state.db,
        &user_id,
        &req.project_id,
        &req.conversation_id,
        req.entry_message_id.as_deref(),
        req.orchestrator_agent_id.as_deref(),
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let _ = repo::create_event(
        &state.db,
        &session.id,
        "collaboration_session_created",
        Some(
            &json!({
                "sessionId": session.id,
                "projectId": session.project_id,
                "state": session.state
            })
            .to_string(),
        ),
    )
    .await;

    Ok(Json(session))
}

/// 查询协同会话详情
pub async fn get_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<SessionSummary>, AppError> {
    let session = repo::get_session(&state.db, &session_id)
        .await
        .map_err(|e| AppError::NotFound(format!("协同会话不存在: {}", e)))?;

    let assignments = repo::list_assignments(&state.db, &session_id)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(SessionSummary {
        session,
        assignments,
    }))
}

/// 编导分派任务
pub async fn dispatch(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<DispatchReq>,
) -> Result<Json<DispatchResponse>, AppError> {
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

    Ok(Json(DispatchResponse {
        dispatched_count: result.dispatched_count as i64,
        assignments: result.assignments,
    }))
}

/// 发送协同消息
pub async fn send_message(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<SendMessageReq>,
) -> Result<Json<CollaborationMessage>, AppError> {
    let _session = repo::get_session(&state.db, &session_id)
        .await
        .map_err(|e| AppError::NotFound(format!("协同会话不存在: {}", e)))?;

    match req.message_kind.as_str() {
        "question" => {
            dispatcher::Dispatcher::handle_question(
                &state.db,
                &session_id,
                req.source_agent_id.as_deref().unwrap_or(""),
                req.target_agent_id.as_deref().unwrap_or(""),
                &req.content,
                req.question_fingerprint.as_deref(),
            )
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

            let messages = repo::list_messages(&state.db, &session_id)
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;
            let last = messages.last().cloned();
            Ok(Json(last.ok_or_else(|| AppError::Internal("消息创建失败".to_string()))?))
        }
        "answer" => {
            dispatcher::Dispatcher::handle_answer(
                &state.db,
                &session_id,
                req.source_agent_id.as_deref().unwrap_or(""),
                req.target_agent_id.as_deref().unwrap_or(""),
                &req.content,
                req.reply_to_message_id.as_deref(),
            )
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

            let messages = repo::list_messages(&state.db, &session_id)
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;
            let last = messages.last().cloned();
            Ok(Json(last.ok_or_else(|| AppError::Internal("消息创建失败".to_string()))?))
        }
        _ => {
            let next_order = repo::get_next_queue_order(&state.db, &session_id)
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;

            let message = repo::create_message(
                &state.db,
                &session_id,
                req.source_agent_id.as_deref(),
                req.target_agent_id.as_deref(),
                &req.message_kind,
                &req.content,
                req.question_fingerprint.as_deref(),
                req.reply_to_message_id.as_deref(),
                next_order,
            )
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

            let _ = repo::increment_round_count(&state.db, &session_id).await;

            Ok(Json(message))
        }
    }
}

/// 循环检测
pub async fn loop_check(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<LoopCheckResponse>, AppError> {
    let session = repo::get_session(&state.db, &session_id)
        .await
        .map_err(|e| AppError::NotFound(format!("协同会话不存在: {}", e)))?;

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
        _ => (
            "unknown".to_string(),
            "未知循环风险等级".to_string(),
        ),
    };

    let signal_strings: Vec<String> = signals.iter().map(|s| s.as_str().to_string()).collect();

    if level >= 4 {
        let _ = repo::update_session_state(&state.db, &session_id, "halted").await;
    }

    let _ = repo::create_event(
        &state.db,
        &session_id,
        "collaboration_loop_warning",
        Some(
            &json!({
                "level": level,
                "signals": signal_strings,
                "action": action
            })
            .to_string(),
        ),
    )
    .await;

    Ok(Json(LoopCheckResponse {
        loop_detected: true,
        signals: signal_strings,
        level,
        action,
        message,
    }))
}

/// 入工作区判定
pub async fn admit(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<AdmitResponse>, AppError> {
    let session = repo::get_session(&state.db, &session_id)
        .await
        .map_err(|e| AppError::NotFound(format!("协同会话不存在: {}", e)))?;

    let current_state = SessionState::try_from(session.state.as_str())
        .map_err(|e| AppError::BadRequest(e))?;

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

    let outline_ready = assignments
        .iter()
        .any(|a| a.task_type == "outline_design" && a.status == "ready");

    if !outline_ready {
        return Ok(Json(AdmitResponse {
            admitted: false,
            pipeline_run_id: None,
            reason: "大纲智能体尚未就绪，无法入场".to_string(),
            blocking_issues: None,
        }));
    }

    let _ = repo::update_session_state(&state.db, &session_id, "workspace_admission")
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let _ = repo::update_admission_decision(
        &state.db,
        &session_id,
        &json!({"admitted": true, "reason": "大纲智能体就绪，关键依赖链无阻塞"}).to_string(),
    )
    .await;

    let _ = repo::create_event(
        &state.db,
        &session_id,
        "collaboration_admission_changed",
        Some(
            &json!({
                "admitted": true,
                "sessionId": session_id
            })
            .to_string(),
        ),
    )
    .await;

    Ok(Json(AdmitResponse {
        admitted: true,
        pipeline_run_id: None,
        reason: "大纲智能体状态为 ready，关键依赖链无阻塞，编导确认入场".to_string(),
        blocking_issues: None,
    }))
}

/// 暂停协同
pub async fn halt(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<HaltReq>,
) -> Result<Json<CollaborationSession>, AppError> {
    let session = repo::get_session(&state.db, &session_id)
        .await
        .map_err(|e| AppError::NotFound(format!("协同会话不存在: {}", e)))?;

    let current_state = SessionState::try_from(session.state.as_str())
        .map_err(|e| AppError::BadRequest(e))?;

    if current_state == SessionState::Completed || current_state == SessionState::Halted {
        return Err(AppError::BadRequest(format!(
            "当前状态 {} 不允许暂停",
            session.state
        )));
    }

    let session = repo::update_session_state(&state.db, &session_id, "halted")
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let _ = repo::create_event(
        &state.db,
        &session_id,
        "collaboration_session_halted",
        Some(
            &json!({
                "reason": req.reason,
                "detail": req.detail
            })
            .to_string(),
        ),
    )
    .await;

    Ok(Json(session))
}
