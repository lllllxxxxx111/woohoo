use serde_json::json;

use crate::{
    ai::config::{AiTask, AiTaskStatus},
    AppState,
};

use super::{handlers, model::AssignmentStatus, repo};

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

async fn reconcile_active_sessions(state: &AppState) -> anyhow::Result<()> {
    for session in repo::list_active_sessions(&state.db).await? {
        if let Err(error) =
            handlers::dispatch_ready_assignments(state, &session.user_id, &session.id).await
        {
            tracing::warn!(session_id = %session.id, error = %error, "failed to dispatch ready collaboration assignments");
        }
        let assignments = repo::list_assignments(&state.db, &session.id).await?;
        for assignment in assignments
            .iter()
            .filter(|assignment| matches!(assignment.status.as_str(), "assigned" | "running"))
        {
            let Some(task_id) = assignment.ai_task_id.as_deref() else {
                let updated = repo::update_assignment_status(
                    &state.db,
                    &assignment.id,
                    AssignmentStatus::Failed.as_str(),
                )
                .await?;
                broadcast_assignment_update(state, &updated, None);
                continue;
            };

            match state.ai_runtime.get_task(&session.user_id, task_id).await {
                Some(task)
                    if matches!(task.status, AiTaskStatus::Completed | AiTaskStatus::Failed) =>
                {
                    sync_terminal_task(state, &task).await?;
                }
                Some(_) => {}
                None => {
                    let updated = repo::update_assignment_status(
                        &state.db,
                        &assignment.id,
                        AssignmentStatus::Failed.as_str(),
                    )
                    .await?;
                    broadcast_assignment_update(state, &updated, Some(task_id));
                }
            }
        }

        let refreshed = repo::list_assignments(&state.db, &session.id).await?;
        if refreshed
            .iter()
            .any(|assignment| assignment.status == "failed")
        {
            handlers::halt_failed_session(state, &session.id, "服务恢复时发现协同任务已失败或丢失")
                .await?;
        } else {
            if let Err(error) = handlers::try_auto_admit(state, &session.id).await {
                tracing::warn!(session_id = %session.id, error = %error, "failed to auto-admit collaboration session");
            }
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
    crate::collaboration::broadcast::persist_and_broadcast(
        &state.db,
        &state.collaboration_broadcaster,
        &assignment.session_id,
        "collaboration_message_sent",
        Some(message_payload),
    )
    .await;

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
    });
    let db = state.db.clone();
    let broadcaster = state.collaboration_broadcaster.clone();
    let session_id = assignment.session_id.clone();
    tokio::spawn(async move {
        crate::collaboration::broadcast::persist_and_broadcast(
            &db,
            &broadcaster,
            &session_id,
            "collaboration_assignment_updated",
            Some(payload),
        )
        .await;
    });
}
