use anyhow::Result;
use serde_json::json;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet, VecDeque};

use super::model::{AssignmentStatus, CollaborationMessage, MessageKind, SessionState};
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
        validate_assignment_dependencies(&assignments)?;

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

        let mut dispatched_count = 0usize;
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
                        "oldStatus": AssignmentStatus::Idle.as_str(),
                        "newStatus": AssignmentStatus::Assigned.as_str()
                    })
                    .to_string(),
                ),
            )
            .await;

            dispatched_count += 1;
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

        Ok(DispatchResult { dispatched_count })
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
                let _ = repo::update_assignment_status(
                    pool,
                    &assignment.id,
                    AssignmentStatus::Questioning.as_str(),
                )
                .await;
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
            MessageKind::Question.as_str(),
            content,
            fingerprint,
            None,
            next_order,
        )
        .await?;

        ReplyQueueManager::enqueue(
            pool,
            session_id,
            target_agent_id,
            MessageKind::Answer.as_str(),
        )
        .await?;

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
                let _ = repo::update_assignment_status(
                    pool,
                    &assignment.id,
                    AssignmentStatus::Ready.as_str(),
                )
                .await;
            }
        }

        let next_order = repo::get_next_queue_order(pool, session_id).await?;

        let message = repo::create_message(
            pool,
            session_id,
            Some(source_agent_id),
            Some(target_agent_id),
            MessageKind::Answer.as_str(),
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

fn validate_assignment_dependencies(assignments: &[DispatchItem]) -> Result<()> {
    let agent_ids = assignments
        .iter()
        .map(|assignment| assignment.agent_id.as_str())
        .collect::<HashSet<_>>();
    if agent_ids.len() != assignments.len() {
        return Err(anyhow::anyhow!(
            "each collaboration agent may only receive one assignment"
        ));
    }

    let mut indegree = assignments
        .iter()
        .map(|assignment| (assignment.agent_id.as_str(), 0usize))
        .collect::<HashMap<_, _>>();
    let mut downstream = HashMap::<&str, Vec<&str>>::new();

    for assignment in assignments {
        let mut unique_dependencies = HashSet::new();
        for dependency in &assignment.depends_on {
            let dependency = dependency.trim();
            if dependency.is_empty() || !unique_dependencies.insert(dependency) {
                continue;
            }
            if dependency == assignment.agent_id {
                return Err(anyhow::anyhow!(
                    "collaboration assignment cannot depend on itself"
                ));
            }
            if !agent_ids.contains(dependency) {
                return Err(anyhow::anyhow!(
                    "collaboration dependency references an unknown agent: {}",
                    dependency
                ));
            }
            *indegree
                .get_mut(assignment.agent_id.as_str())
                .expect("assignment agent should exist") += 1;
            downstream
                .entry(dependency)
                .or_default()
                .push(assignment.agent_id.as_str());
        }
    }

    let mut queue = indegree
        .iter()
        .filter_map(|(agent_id, count)| (*count == 0).then_some(*agent_id))
        .collect::<VecDeque<_>>();
    let mut visited = 0usize;
    while let Some(agent_id) = queue.pop_front() {
        visited += 1;
        for dependent in downstream.get(agent_id).into_iter().flatten() {
            let count = indegree
                .get_mut(dependent)
                .expect("dependent agent should exist");
            *count -= 1;
            if *count == 0 {
                queue.push_back(dependent);
            }
        }
    }

    if visited != assignments.len() {
        return Err(anyhow::anyhow!(
            "collaboration assignment dependencies contain a cycle"
        ));
    }
    Ok(())
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(agent_id: &str, depends_on: &[&str]) -> DispatchItem {
        DispatchItem {
            agent_id: agent_id.to_string(),
            task_type: "design".to_string(),
            goal: format!("task for {agent_id}"),
            depends_on: depends_on.iter().map(|value| value.to_string()).collect(),
            input: None,
        }
    }

    #[test]
    fn accepts_acyclic_assignment_dependencies() {
        let assignments = vec![item("agent-a", &[]), item("agent-b", &["agent-a"])];
        assert!(validate_assignment_dependencies(&assignments).is_ok());
    }

    #[test]
    fn rejects_unknown_or_cyclic_dependencies() {
        assert!(validate_assignment_dependencies(&[item("agent-a", &["missing"])]).is_err());
        assert!(validate_assignment_dependencies(&[
            item("agent-a", &["agent-b"]),
            item("agent-b", &["agent-a"]),
        ])
        .is_err());
    }

    #[test]
    fn rejects_duplicate_agent_assignments() {
        assert!(
            validate_assignment_dependencies(&[item("agent-a", &[]), item("agent-a", &[]),])
                .is_err()
        );
    }
}
