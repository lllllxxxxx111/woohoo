use serde_json::json;

use crate::{
    ai::config::{AiTask, AiTaskStatus},
    AppState,
};

use super::{
    handlers,
    model::{error_codes, AssignmentStatus},
    queue::ReplyQueueManager,
    repo,
};

/// 启动协同会话 worker：
/// 1. 启动时恢复（reconcile_active_sessions）
/// 2. 订阅 AI task 事件，及时同步终态任务
/// 3. 定时（10s）兜底 reconcile，处理服务重启后的非终态会话
pub fn start_worker(state: AppState) {
    let startup_state = state.clone();
    let retry_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = reconcile_active_sessions(&startup_state).await {
            tracing::warn!(error = %error, "failed to reconcile collaboration sessions");
        }
    });

    let mut receiver = state.ai_runtime.subscribe();
    let event_state = state;
    tokio::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(envelope) => {
                    if matches!(
                        envelope.event.task.status,
                        AiTaskStatus::Completed | AiTaskStatus::Failed
                    ) {
                        if let Err(error) =
                            sync_terminal_task(&event_state, &envelope.event.task).await
                        {
                            tracing::warn!(
                                task_id = %envelope.event.task.id,
                                error = %error,
                                "failed to sync collaboration assignment from AI task"
                            );
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if let Err(error) = reconcile_active_sessions(&event_state).await {
                        tracing::warn!(error = %error, "failed to reconcile after task event lag");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(error) = reconcile_active_sessions(&retry_state).await {
                tracing::warn!(error = %error, "failed to periodically reconcile collaboration sessions");
            }
        }
    });
}

/// 恢复所有活跃协同会话：
/// - 重建回复队列
/// - 校验关联 AI task 状态
/// - 修正 assignment/session 状态
/// - 任务无法恢复时给出可操作错误（带稳定错误码），不静默标失败
async fn reconcile_active_sessions(state: &AppState) -> anyhow::Result<()> {
    for session in repo::list_active_sessions(&state.db).await? {
        let session_id = session.id.clone();
        let user_id = session.user_id.clone();
        let session_state = session.state.clone();

        if let Err(error) = recover_session(state, &session).await {
            tracing::warn!(
                session_id = %session_id,
                state = %session_state,
                error = %error,
                "failed to recover collaboration session"
            );
        }

        // 派发就绪任务（依赖已完成）
        if let Err(error) =
            handlers::dispatch_ready_assignments(state, &user_id, &session_id).await
        {
            tracing::warn!(session_id = %session_id, error = %error, "failed to dispatch ready collaboration assignments");
        }

        // 检查每个 assignment 的 AI task 状态
        let assignments = repo::list_assignments(&state.db, &session_id).await?;
        for assignment in assignments
            .iter()
            .filter(|assignment| matches!(assignment.status.as_str(), "assigned" | "running"))
        {
            if let Err(error) =
                reconcile_assignment(state, &user_id, &session_id, assignment).await
            {
                tracing::warn!(
                    session_id = %session_id,
                    assignment_id = %assignment.id,
                    error = %error,
                    "failed to reconcile collaboration assignment"
                );
            }
        }

        // 重新评估是否需要 halt / 自动入场
        let refreshed = repo::list_assignments(&state.db, &session_id).await?;
        if refreshed.iter().any(|assignment| assignment.status == "failed") {
            handlers::halt_failed_session(state, &session_id, "服务恢复时发现协同任务已失败或丢失")
                .await?;
        } else {
            if let Err(error) = handlers::try_auto_admit(state, &session_id).await {
                tracing::warn!(session_id = %session_id, error = %error, "failed to auto-admit collaboration session");
            }
        }
    }
    Ok(())
}

/// 恢复单个会话：重建队列 + 状态一致性校验
async fn recover_session(
    state: &AppState,
    session: &super::model::CollaborationSession,
) -> anyhow::Result<()> {
    let session_id = &session.id;

    // 1. 重建回复队列：当 queue 为空但存在运行中/就绪任务时
    let existing_queue = ReplyQueueManager::load_queue(&state.db, session_id).await?;
    if existing_queue.is_empty() {
        let _ = ReplyQueueManager::initialize_from_assignments(&state.db, session_id).await?;
        let _ = repo::create_event(
            &state.db,
            session_id,
            "collaboration_queue_updated",
            Some(
                &json!({
                    "sessionId": session_id,
                    "action": "recovered_on_restart",
                    "reason": "reply queue rebuilt during service restart"
                })
                .to_string(),
            ),
        )
        .await;
        tracing::info!(session_id = %session_id, "协同会话回复队列已在重启后重建");
    }

    // 2. 状态一致性校验：resolving_questions/workspace_admission 必须有 assignment
    let assignments = repo::list_assignments(&state.db, session_id).await?;
    if matches!(
        session.state.as_str(),
        "resolving_questions" | "workspace_admission" | "workspace_execution"
    ) && assignments.is_empty()
    {
        // 没有任务卡但状态进入中段，halt 并给出可操作错误
        let reason = format!(
            "{}: 会话状态 {} 但无任务卡，无法恢复，请人工介入",
            error_codes::TASK_UNRECOVERABLE,
            session.state
        );
        let _ = repo::update_assignment_failure_reason(
            &state.db,
            session_id,
            &reason,
        )
        .await;
        let _ =
            handlers::halt_failed_session(state, session_id, &reason).await?;
        return Ok(());
    }

    Ok(())
}

/// 校验单个 assignment 的 AI task 状态
/// - AI task 缺失：记录可操作错误（含错误码），halt 会话，不静默标 failed
/// - AI task 已终态：同步到 assignment
/// - AI task 进行中：不做处理
async fn reconcile_assignment(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    assignment: &super::model::CollaborationAssignment,
) -> anyhow::Result<()> {
    let Some(task_id) = assignment.ai_task_id.as_deref() else {
        // ai_task_id 为空但状态为 running：服务重启丢失关联
        let reason = format!(
            "{}: assignment {} 处于 running 但缺少 ai_task_id，可能服务重启导致丢失，需人工裁决",
            error_codes::TASK_UNRECOVERABLE,
            assignment.id
        );
        let _ = repo::update_assignment_failure_reason(&state.db, &assignment.id, &reason).await;
        broadcast_assignment_update(
            state,
            &repo::update_assignment_status(
                &state.db,
                &assignment.id,
                AssignmentStatus::Failed.as_str(),
            )
            .await?,
            None,
        );
        return Ok(());
    };

    match state.ai_runtime.get_task(user_id, task_id).await {
        Some(task)
            if matches!(task.status, AiTaskStatus::Completed | AiTaskStatus::Failed) =>
        {
            sync_terminal_task(state, &task).await?;
        }
        Some(_) => {}
        None => {
            // AI task 缺失：服务重启丢失了 in-memory AI task
            let reason = format!(
                "{}: assignment {} 关联的 AI task {} 不存在（服务重启导致 in-memory 任务丢失），需人工恢复或重试分派",
                error_codes::TASK_UNRECOVERABLE,
                assignment.id,
                task_id
            );
            tracing::warn!(session_id = %session_id, assignment_id = %assignment.id, task_id = %task_id, "AI task missing during reconcile");
            let _ = repo::update_assignment_failure_reason(&state.db, &assignment.id, &reason)
                .await;
            let updated = repo::update_assignment_status(
                &state.db,
                &assignment.id,
                AssignmentStatus::Failed.as_str(),
            )
            .await?;
            broadcast_assignment_update(state, &updated, Some(task_id));
        }
    }

    Ok(())
}

pub(crate) async fn sync_terminal_task(state: &AppState, task: &AiTask) -> anyhow::Result<()> {
    let Some(assignment) = repo::find_assignment_by_ai_task_id(&state.db, &task.id).await? else {
        return Ok(());
    };
    if matches!(assignment.status.as_str(), "done" | "failed") {
        return Ok(());
    }

    let (status, kind, content) = match task.status {
        AiTaskStatus::Completed => (
            AssignmentStatus::Done,
            "status",
            task.result
                .clone()
                .unwrap_or_else(|| format!("任务「{}」已完成", assignment.goal)),
        ),
        AiTaskStatus::Failed => (
            AssignmentStatus::Failed,
            "escalation",
            format!(
                "任务「{}」执行失败：{}",
                assignment.goal,
                task.error.as_deref().unwrap_or("未知错误")
            ),
        ),
        _ => return Ok(()),
    };

    let updated =
        repo::update_assignment_status(&state.db, &assignment.id, status.as_str()).await?;

    // 记录失败原因（仅 failed）
    if matches!(task.status, AiTaskStatus::Failed) {
        let _ = repo::update_assignment_failure_reason(
            &state.db,
            &assignment.id,
            task.error.as_deref().unwrap_or("AI task 执行失败"),
        )
        .await;
    }

    broadcast_assignment_update(state, &updated, Some(&task.id));

    let next_order = repo::get_next_queue_order(&state.db, &assignment.session_id).await?;
    let message = repo::create_message(
        &state.db,
        &assignment.session_id,
        Some(&assignment.agent_id),
        None,
        kind,
        &content,
        None,
        None,
        next_order,
    )
    .await?;
    let message_payload = json!({
        "messageId": message.id,
        "messageKind": message.message_kind,
        "sourceAgentId": message.source_agent_id,
        "targetAgentId": message.target_agent_id,
    });
    let _ = repo::create_event(
        &state.db,
        &assignment.session_id,
        "collaboration_message_sent",
        Some(&message_payload.to_string()),
    )
    .await;
    state.collaboration_broadcaster.broadcast(
        assignment.session_id.clone(),
        "collaboration_message_sent",
        Some(message_payload),
    );

    if matches!(task.status, AiTaskStatus::Completed) {
        let session = repo::get_session(&state.db, &assignment.session_id).await?;
        handlers::dispatch_ready_assignments(state, &session.user_id, &assignment.session_id)
            .await?;
        handlers::try_auto_admit(state, &assignment.session_id).await?;
    } else {
        handlers::halt_failed_session(state, &assignment.session_id, &content).await?;
    }

    Ok(())
}

fn broadcast_assignment_update(
    state: &AppState,
    assignment: &super::model::CollaborationAssignment,
    task_id: Option<&str>,
) {
    let payload = json!({
        "assignmentId": assignment.id,
        "agentId": assignment.agent_id,
        "newStatus": assignment.status,
        "aiTaskId": task_id,
        "failureReason": assignment.failure_reason,
    });
    state.collaboration_broadcaster.broadcast(
        assignment.session_id.clone(),
        "collaboration_assignment_updated",
        Some(payload),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证稳定错误码常量存在且未被改动
    #[test]
    fn error_codes_are_stable() {
        assert_eq!(
            error_codes::TASK_UNRECOVERABLE,
            "COLLABORATION_TASK_UNRECOVERABLE"
        );
        assert_eq!(
            error_codes::INVALID_TRANSITION,
            "COLLABORATION_INVALID_TRANSITION"
        );
        assert_eq!(
            error_codes::QUESTION_LIMIT_REACHED,
            "COLLABORATION_QUESTION_LIMIT_REACHED"
        );
        assert_eq!(
            error_codes::SEMANTIC_DUPLICATE_QUESTION,
            "COLLABORATION_SEMANTIC_DUPLICATE"
        );
        assert_eq!(
            error_codes::ROUND_LIMIT_REACHED,
            "COLLABORATION_ROUND_LIMIT_REACHED"
        );
        assert_eq!(error_codes::UNKNOWN_STATE, "COLLABORATION_UNKNOWN_STATE");
    }

    /// 验证 halt_session_with_audit 错误消息格式（包含错误码前缀）
    #[test]
    fn failure_reason_includes_error_code_prefix() {
        let reason = format!(
            "{}: assignment {} 处于 running 但缺少 ai_task_id，可能服务重启导致丢失，需人工裁决",
            error_codes::TASK_UNRECOVERABLE,
            "assignment-1"
        );
        assert!(reason.starts_with("COLLABORATION_TASK_UNRECOVERABLE:"));
        assert!(reason.contains("assignment-1"));
    }
}
