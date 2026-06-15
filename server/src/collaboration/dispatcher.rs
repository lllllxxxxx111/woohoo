use anyhow::Result;
use serde_json::json;
use sqlx::SqlitePool;

use super::model::{AssignmentStatus, CollaborationMessage, SessionState};
use super::queue::ReplyQueueManager;
use super::repo;

/// 编导分派器：根据用户需求生成任务卡并分派给领域智能体
pub struct Dispatcher;

impl Dispatcher {
    /// 执行分派：创建任务卡，初始化回复队列，推进会话状态
    pub async fn dispatch_assignments(
        pool: &SqlitePool,
        session_id: &str,
        assignments: Vec<DispatchItem>,
    ) -> Result<DispatchResult> {
        let session = repo::get_session(pool, session_id).await?;

        let current_state =
            SessionState::try_from(session.state.as_str()).map_err(|e| anyhow::anyhow!("{}", e))?;
        if current_state != SessionState::Discovery && current_state != SessionState::Delegating {
            return Err(anyhow::anyhow!("当前状态 {} 不允许分派", session.state));
        }

        if current_state == SessionState::Discovery {
            let _ = repo::update_session_state(pool, session_id, SessionState::Delegating.as_str())
                .await?;
        }

        let mut created = Vec::new();
        for item in &assignments {
            let depends_on_json = if item.depends_on.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&item.depends_on)?)
            };
            let input_json = item
                .input
                .as_ref()
                .map(|v| serde_json::to_string(v))
                .transpose()?;

            let assignment = repo::create_assignment(
                pool,
                session_id,
                &item.agent_id,
                &item.task_type,
                &item.goal,
                input_json.as_deref(),
                depends_on_json.as_deref(),
            )
            .await?;

            let _ = repo::create_event(
                pool,
                session_id,
                "collaboration_assignment_updated",
                Some(
                    &json!({
                        "assignmentId": assignment.id,
                        "agentId": assignment.agent_id,
                        "oldStatus": "idle",
                        "newStatus": "assigned"
                    })
                    .to_string(),
                ),
            )
            .await;

            created.push(assignment);
        }

        let _ =
            repo::update_session_state(pool, session_id, SessionState::ResolvingQuestions.as_str())
                .await?;

        ReplyQueueManager::initialize_from_assignments(pool, session_id).await?;

        let _ = repo::create_event(
            pool,
            session_id,
            "collaboration_queue_updated",
            Some(
                &json!({
                    "sessionId": session_id,
                    "action": "initialized"
                })
                .to_string(),
            ),
        )
        .await;

        Ok(DispatchResult {
            dispatched_count: created.len(),
            assignments: created,
        })
    }

    /// 处理智能体提问：将下游 assignment 标记为 questioning/blocked，更新回复队列
    /// 返回创建的消息对象，避免调用方重新查询
    pub async fn handle_question(
        pool: &SqlitePool,
        session_id: &str,
        source_agent_id: &str,
        target_agent_id: &str,
        content: &str,
        fingerprint: Option<&str>,
    ) -> Result<CollaborationMessage> {
        let assignments = repo::list_assignments(pool, session_id).await?;

        if let Some(assignment) = assignments.iter().find(|a| a.agent_id == source_agent_id) {
            let current = AssignmentStatus::try_from(assignment.status.as_str())
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            if current == AssignmentStatus::Assigned || current == AssignmentStatus::Questioning {
                let _ = repo::update_assignment_status(pool, &assignment.id, "questioning").await;
            }
            let _ =
                repo::increment_blocking_question_count(pool, &assignment.id, fingerprint).await;
        }

        let next_order = repo::get_next_queue_order(pool, session_id).await?;

        let message = repo::create_message(
            pool,
            session_id,
            Some(source_agent_id),
            Some(target_agent_id),
            "question",
            content,
            fingerprint,
            None,
            next_order,
        )
        .await?;

        ReplyQueueManager::enqueue(pool, session_id, target_agent_id, "answer").await?;

        let _ = repo::create_event(
            pool,
            session_id,
            "collaboration_question_asked",
            Some(
                &json!({
                    "sourceAgentId": source_agent_id,
                    "targetAgentId": target_agent_id,
                    "questionFingerprint": fingerprint
                })
                .to_string(),
            ),
        )
        .await;

        let _ = repo::increment_round_count(pool, session_id).await;

        Ok(message)
    }

    /// 处理智能体回答：将下游 assignment 从 blocked/questioning → ready，更新回复队列
    /// 返回创建的消息对象，避免调用方重新查询
    pub async fn handle_answer(
        pool: &SqlitePool,
        session_id: &str,
        source_agent_id: &str,
        target_agent_id: &str,
        content: &str,
        reply_to_message_id: Option<&str>,
    ) -> Result<CollaborationMessage> {
        let assignments = repo::list_assignments(pool, session_id).await?;

        if let Some(assignment) = assignments.iter().find(|a| a.agent_id == target_agent_id) {
            let current = AssignmentStatus::try_from(assignment.status.as_str())
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            if current == AssignmentStatus::Blocked || current == AssignmentStatus::Questioning {
                let _ = repo::update_assignment_status(pool, &assignment.id, "ready").await;
            }
        }

        let next_order = repo::get_next_queue_order(pool, session_id).await?;

        let message = repo::create_message(
            pool,
            session_id,
            Some(source_agent_id),
            Some(target_agent_id),
            "answer",
            content,
            None,
            reply_to_message_id,
            next_order,
        )
        .await?;

        ReplyQueueManager::dequeue(pool, session_id).await?;

        let _ = repo::create_event(
            pool,
            session_id,
            "collaboration_question_answered",
            Some(
                &json!({
                    "sourceAgentId": source_agent_id,
                    "targetAgentId": target_agent_id,
                    "replyToMessageId": reply_to_message_id
                })
                .to_string(),
            ),
        )
        .await;

        let _ = repo::increment_round_count(pool, session_id).await;

        Ok(message)
    }
}

/// 分派项
#[derive(Debug, Clone)]
pub struct DispatchItem {
    pub agent_id: String,
    pub task_type: String,
    pub goal: String,
    pub depends_on: Vec<String>,
    pub input: Option<serde_json::Value>,
}

/// 分派结果
#[derive(Debug, Clone)]
pub struct DispatchResult {
    pub dispatched_count: usize,
    pub assignments: Vec<crate::collaboration::model::CollaborationAssignment>,
}
