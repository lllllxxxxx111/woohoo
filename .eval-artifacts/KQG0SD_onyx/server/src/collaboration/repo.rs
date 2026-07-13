use anyhow::{anyhow, Result};
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::{
    AssignmentStatus, CollaborationAssignment, CollaborationEvent, CollaborationMessage,
    CollaborationSession, SessionState,
};

/// 创建协同会话
pub async fn create_session(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    conversation_id: &str,
    entry_message_id: Option<&str>,
    orchestrator_agent_id: Option<&str>,
) -> Result<CollaborationSession> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "INSERT INTO collaboration_sessions (
            id, user_id, project_id, conversation_id, entry_message_id,
            state, orchestrator_agent_id, round_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'discovery', ?, 0, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(project_id)
    .bind(conversation_id)
    .bind(entry_message_id)
    .bind(orchestrator_agent_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let session = sqlx::query_as::<_, CollaborationSession>(
        "SELECT * FROM collaboration_sessions WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await?;

    Ok(session)
}

/// 查询协同会话
pub async fn get_session(pool: &SqlitePool, session_id: &str) -> Result<CollaborationSession> {
    let session = sqlx::query_as::<_, CollaborationSession>(
        "SELECT * FROM collaboration_sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;

    Ok(session)
}

/// 更新协同会话状态
pub async fn update_session_state(
    pool: &SqlitePool,
    session_id: &str,
    new_state: &str,
) -> Result<CollaborationSession> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    let session = get_session(pool, session_id).await?;
    let current = SessionState::try_from(session.state.as_str()).map_err(anyhow::Error::msg)?;
    let target = SessionState::try_from(new_state).map_err(anyhow::Error::msg)?;

    if current != target && !current.can_transition_to(&target) {
        return Err(anyhow!(
            "invalid collaboration session transition: {} -> {}",
            session.state,
            new_state
        ));
    }

    sqlx::query("UPDATE collaboration_sessions SET state = ?, updated_at = ? WHERE id = ?")
        .bind(new_state)
        .bind(&now)
        .bind(session_id)
        .execute(pool)
        .await?;

    get_session(pool, session_id).await
}

/// 增加轮次计数
pub async fn increment_round_count(pool: &SqlitePool, session_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "UPDATE collaboration_sessions
         SET round_count = round_count + 1, updated_at = ?
         WHERE id = ?",
    )
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// 更新回复队列
pub async fn update_reply_queue(
    pool: &SqlitePool,
    session_id: &str,
    reply_queue_json: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "UPDATE collaboration_sessions
         SET reply_queue_json = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(reply_queue_json)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// 更新循环检测状态
pub async fn update_loop_status(
    pool: &SqlitePool,
    session_id: &str,
    loop_status_json: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "UPDATE collaboration_sessions
         SET loop_status_json = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(loop_status_json)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// 更新入场决策
pub async fn update_admission_decision(
    pool: &SqlitePool,
    session_id: &str,
    admission_decision_json: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "UPDATE collaboration_sessions
         SET admission_decision_json = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(admission_decision_json)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// 创建任务卡
pub async fn create_assignment(
    pool: &SqlitePool,
    session_id: &str,
    agent_id: &str,
    task_type: &str,
    goal: &str,
    input_json: Option<&str>,
    depends_on_json: Option<&str>,
) -> Result<CollaborationAssignment> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "INSERT INTO collaboration_assignments (
            id, session_id, agent_id, task_type, goal,
            input_json, depends_on_json, status, blocking_question_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', 0, ?, ?)",
    )
    .bind(&id)
    .bind(session_id)
    .bind(agent_id)
    .bind(task_type)
    .bind(goal)
    .bind(input_json)
    .bind(depends_on_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let assignment = sqlx::query_as::<_, CollaborationAssignment>(
        "SELECT * FROM collaboration_assignments WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await?;

    Ok(assignment)
}

/// 查询会话下所有任务卡
pub async fn list_assignments(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<CollaborationAssignment>> {
    let assignments = sqlx::query_as::<_, CollaborationAssignment>(
        "SELECT * FROM collaboration_assignments WHERE session_id = ? ORDER BY created_at ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    Ok(assignments)
}

/// 更新任务卡状态
pub async fn update_assignment_status(
    pool: &SqlitePool,
    assignment_id: &str,
    new_status: &str,
) -> Result<CollaborationAssignment> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    let assignment = sqlx::query_as::<_, CollaborationAssignment>(
        "SELECT * FROM collaboration_assignments WHERE id = ?",
    )
    .bind(assignment_id)
    .fetch_one(pool)
    .await?;
    let current =
        AssignmentStatus::try_from(assignment.status.as_str()).map_err(anyhow::Error::msg)?;
    let target = AssignmentStatus::try_from(new_status).map_err(anyhow::Error::msg)?;

    if current != target && !current.can_transition_to(&target) {
        return Err(anyhow!(
            "invalid collaboration assignment transition: {} -> {}",
            assignment.status,
            new_status
        ));
    }

    sqlx::query("UPDATE collaboration_assignments SET status = ?, updated_at = ? WHERE id = ?")
        .bind(new_status)
        .bind(&now)
        .bind(assignment_id)
        .execute(pool)
        .await?;

    let assignment = sqlx::query_as::<_, CollaborationAssignment>(
        "SELECT * FROM collaboration_assignments WHERE id = ?",
    )
    .bind(assignment_id)
    .fetch_one(pool)
    .await?;

    Ok(assignment)
}

/// 增加任务卡阻塞问题计数
pub async fn increment_blocking_question_count(
    pool: &SqlitePool,
    assignment_id: &str,
    fingerprint: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "UPDATE collaboration_assignments
         SET blocking_question_count = blocking_question_count + 1,
             last_question_fingerprint = ?,
             updated_at = ?
         WHERE id = ?",
    )
    .bind(fingerprint)
    .bind(&now)
    .bind(assignment_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// 创建协同消息
pub async fn create_message(
    pool: &SqlitePool,
    session_id: &str,
    source_agent_id: Option<&str>,
    target_agent_id: Option<&str>,
    message_kind: &str,
    content: &str,
    question_fingerprint: Option<&str>,
    reply_to_message_id: Option<&str>,
    queue_order: i64,
) -> Result<CollaborationMessage> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "INSERT INTO collaboration_messages (
            id, session_id, source_agent_id, target_agent_id,
            message_kind, content, question_fingerprint,
            reply_to_message_id, queue_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(session_id)
    .bind(source_agent_id)
    .bind(target_agent_id)
    .bind(message_kind)
    .bind(content)
    .bind(question_fingerprint)
    .bind(reply_to_message_id)
    .bind(queue_order)
    .bind(&now)
    .execute(pool)
    .await?;

    let message = sqlx::query_as::<_, CollaborationMessage>(
        "SELECT * FROM collaboration_messages WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await?;

    Ok(message)
}

/// 查询会话下所有协同消息
pub async fn list_messages(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<CollaborationMessage>> {
    let messages = sqlx::query_as::<_, CollaborationMessage>(
        "SELECT * FROM collaboration_messages WHERE session_id = ? ORDER BY queue_order ASC, created_at ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    Ok(messages)
}

/// 获取会话最近 N 条消息的指纹
pub async fn get_recent_fingerprints(
    pool: &SqlitePool,
    session_id: &str,
    limit: i64,
) -> Result<Vec<Option<String>>> {
    let rows = sqlx::query_as::<_, (Option<String>,)>(
        "SELECT question_fingerprint FROM collaboration_messages
         WHERE session_id = ? AND question_fingerprint IS NOT NULL
         ORDER BY created_at DESC LIMIT ?",
    )
    .bind(session_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|(fp,)| fp).collect())
}

/// 创建协同事件
pub async fn create_event(
    pool: &SqlitePool,
    session_id: &str,
    event_type: &str,
    payload_json: Option<&str>,
) -> Result<CollaborationEvent> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "INSERT INTO collaboration_events (id, session_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(session_id)
    .bind(event_type)
    .bind(payload_json)
    .bind(&now)
    .execute(pool)
    .await?;

    let event =
        sqlx::query_as::<_, CollaborationEvent>("SELECT * FROM collaboration_events WHERE id = ?")
            .bind(&id)
            .fetch_one(pool)
            .await?;

    Ok(event)
}

/// 获取会话下一个可用的消息队列序号
pub async fn get_next_queue_order(pool: &SqlitePool, session_id: &str) -> Result<i64> {
    let max_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(queue_order), 0) FROM collaboration_messages WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    Ok(max_order + 1)
}

/// 查询项目下活跃的协同会话（非终态）
pub async fn list_active_sessions_for_project(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
) -> Result<Vec<CollaborationSession>> {
    let sessions = sqlx::query_as::<_, CollaborationSession>(
        "SELECT * FROM collaboration_sessions \
         WHERE user_id = ? AND project_id = ? \
         AND state NOT IN ('completed', 'halted') \
         ORDER BY updated_at DESC",
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(sessions)
}
