use anyhow::{anyhow, Result};
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::{
    error_codes, AssignmentStatus, CollaborationAssignment, CollaborationEvent,
    CollaborationMessage, CollaborationSession, SessionState,
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

/// 更新协同会话状态（单一入口，强校验状态迁移合法性）
/// 非法迁移返回包含稳定错误码的 anyhow::Error
pub async fn update_session_state(
    pool: &SqlitePool,
    session_id: &str,
    new_state: &str,
) -> Result<CollaborationSession> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    let session = get_session(pool, session_id).await?;
    let current = SessionState::try_from(session.state.as_str())
        .map_err(|e| anyhow!("{}: {}", error_codes::UNKNOWN_STATE, e))?;
    let target = SessionState::try_from(new_state)
        .map_err(|e| anyhow!("{}: {}", error_codes::UNKNOWN_STATE, e))?;

    if current != target && !current.can_transition_to(&target) {
        return Err(anyhow!(
            "{}: invalid session transition {} -> {}",
            error_codes::INVALID_TRANSITION,
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

/// 更新任务卡状态（单一入口，强校验状态迁移合法性）
/// 非法迁移返回包含稳定错误码的 anyhow::Error
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
    let current = AssignmentStatus::try_from(assignment.status.as_str())
        .map_err(|e| anyhow!("{}: {}", error_codes::UNKNOWN_STATE, e))?;
    let target = AssignmentStatus::try_from(new_status)
        .map_err(|e| anyhow!("{}: {}", error_codes::UNKNOWN_STATE, e))?;

    if current != target && !current.can_transition_to(&target) {
        return Err(anyhow!(
            "{}: invalid assignment transition {} -> {}",
            error_codes::INVALID_TRANSITION,
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

/// 将任务卡关联到真实 AI 任务，并进入运行态
pub async fn claim_assignment_for_execution(
    pool: &SqlitePool,
    assignment_id: &str,
) -> Result<Option<CollaborationAssignment>> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    Ok(sqlx::query_as::<_, CollaborationAssignment>(
        "UPDATE collaboration_assignments
         SET status = 'running', updated_at = ?
         WHERE id = ? AND status IN ('assigned', 'ready') AND ai_task_id IS NULL
         RETURNING *",
    )
    .bind(&now)
    .bind(assignment_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn link_assignment_ai_task(
    pool: &SqlitePool,
    assignment_id: &str,
    ai_task_id: &str,
) -> Result<CollaborationAssignment> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    sqlx::query(
        "UPDATE collaboration_assignments
         SET ai_task_id = ?, updated_at = ?
         WHERE id = ? AND status = 'running'",
    )
    .bind(ai_task_id)
    .bind(&now)
    .bind(assignment_id)
    .execute(pool)
    .await?;

    Ok(sqlx::query_as::<_, CollaborationAssignment>(
        "SELECT * FROM collaboration_assignments WHERE id = ?",
    )
    .bind(assignment_id)
    .fetch_one(pool)
    .await?)
}

pub async fn find_assignment_by_ai_task_id(
    pool: &SqlitePool,
    ai_task_id: &str,
) -> Result<Option<CollaborationAssignment>> {
    Ok(sqlx::query_as::<_, CollaborationAssignment>(
        "SELECT * FROM collaboration_assignments WHERE ai_task_id = ? LIMIT 1",
    )
    .bind(ai_task_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn update_session_pipeline_run_id(
    pool: &SqlitePool,
    session_id: &str,
    pipeline_run_id: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    sqlx::query(
        "UPDATE collaboration_sessions
         SET pipeline_run_id = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(pipeline_run_id)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
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
    conversation_id: Option<&str>,
) -> Result<Vec<CollaborationSession>> {
    let sessions = if let Some(conversation_id) = conversation_id {
        sqlx::query_as::<_, CollaborationSession>(
            "SELECT * FROM collaboration_sessions
             WHERE user_id = ? AND project_id = ? AND conversation_id = ?
               AND state NOT IN ('completed', 'halted')
             ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .bind(project_id)
        .bind(conversation_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, CollaborationSession>(
            "SELECT * FROM collaboration_sessions
             WHERE user_id = ? AND project_id = ?
               AND state NOT IN ('completed', 'halted')
             ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .bind(project_id)
        .fetch_all(pool)
        .await?
    };

    Ok(sessions)
}

pub async fn list_active_sessions(pool: &SqlitePool) -> Result<Vec<CollaborationSession>> {
    Ok(sqlx::query_as::<_, CollaborationSession>(
        "SELECT * FROM collaboration_sessions
         WHERE state NOT IN ('completed', 'halted')
         ORDER BY updated_at ASC",
    )
    .fetch_all(pool)
    .await?)
}

/// 暂停协同会话并记录审计信息（halt_reason / halted_by / halted_at）
pub async fn halt_session_with_audit(
    pool: &SqlitePool,
    session_id: &str,
    reason: &str,
    halted_by: &str,
) -> Result<CollaborationSession> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    let session = get_session(pool, session_id).await?;
    let current = SessionState::try_from(session.state.as_str())
        .map_err(|e| anyhow!("{}: {}", error_codes::UNKNOWN_STATE, e))?;

    if matches!(current, SessionState::Completed | SessionState::Halted) {
        return Ok(session);
    }
    if !current.can_transition_to(&SessionState::Halted) {
        return Err(anyhow!(
            "{}: cannot halt from state {}",
            error_codes::INVALID_TRANSITION,
            session.state
        ));
    }

    sqlx::query(
        "UPDATE collaboration_sessions
         SET state = 'halted', halt_reason = ?, halted_by = ?, halted_at = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(reason)
    .bind(halted_by)
    .bind(&now)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;

    get_session(pool, session_id).await
}

/// 恢复已暂停的协同会话，记录恢复审计信息
/// action: "restart"（回到 discovery）/ "resume"（尝试继续当前阶段）
pub async fn resume_session(
    pool: &SqlitePool,
    session_id: &str,
    action: &str,
    operator_user_id: &str,
    note: Option<&str>,
) -> Result<CollaborationSession> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    let session = get_session(pool, session_id).await?;

    if session.state != "halted" {
        return Err(anyhow!(
            "{}: cannot resume from state {} (only halted sessions can be resumed)",
            error_codes::INVALID_TRANSITION,
            session.state
        ));
    }

    let target_state = match action {
        "restart" => SessionState::Discovery,
        "resume" => SessionState::ResolvingQuestions,
        other => {
            return Err(anyhow!(
                "{}: unknown recovery action {}",
                error_codes::UNKNOWN_STATE,
                other
            ));
        }
    };

    if !SessionState::Halted.can_transition_to(&target_state) {
        return Err(anyhow!(
            "{}: cannot resume to {} from halted",
            error_codes::INVALID_TRANSITION,
            target_state.as_str()
        ));
    }

    sqlx::query(
        "UPDATE collaboration_sessions
         SET state = ?, recovery_audited = 1, recovery_action = ?,
             recovery_operator_user_id = ?, recovery_note = ?,
             halt_reason = NULL, halted_by = NULL, halted_at = NULL,
             updated_at = ?
         WHERE id = ?",
    )
    .bind(target_state.as_str())
    .bind(action)
    .bind(operator_user_id)
    .bind(note)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;

    get_session(pool, session_id).await
}

/// 记录任务卡失败原因
pub async fn update_assignment_failure_reason(
    pool: &SqlitePool,
    assignment_id: &str,
    failure_reason: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    sqlx::query(
        "UPDATE collaboration_assignments
         SET failure_reason = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(failure_reason)
    .bind(&now)
    .bind(assignment_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 获取会话最近 N 条问题消息的内容（用于语义近似检测）
pub async fn get_recent_question_contents(
    pool: &SqlitePool,
    session_id: &str,
    limit: i64,
) -> Result<Vec<String>> {
    let rows = sqlx::query_as::<_, (String,)>(
        "SELECT content FROM collaboration_messages
         WHERE session_id = ? AND message_kind = 'question'
         ORDER BY created_at DESC, queue_order DESC LIMIT ?",
    )
    .bind(session_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// 更新会话的可配置轮次上限
pub async fn update_max_round_limit(
    pool: &SqlitePool,
    session_id: &str,
    max_round_limit: i64,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    sqlx::query(
        "UPDATE collaboration_sessions
         SET max_round_limit = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(max_round_limit)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use uuid::Uuid;

    /// 创建测试用 SQLite 内存池，并应用协同相关 schema（含 027 治理字段）
    async fn create_collab_test_pool() -> SqlitePool {
        let db_path = std::env::temp_dir().join(format!("woohoo-collab-{}.sqlite", Uuid::new_v4()));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));

        // 测试中关闭 FK 检查，避免依赖 users/projects/conversations/agents 父表
        let options = SqliteConnectOptions::from_str(&database_url)
            .expect("invalid sqlite url for test")
            .create_if_missing(true)
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("failed to connect test sqlite");

        // 创建 schema_migrations 表（避免 run_schema_migrations 重复执行）
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version    TEXT PRIMARY KEY NOT NULL,
                kind       TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create schema_migrations");

        // 应用协同 schema（012）
        sqlx::query(include_str!("../../migrations/012_collaboration.sql"))
            .execute(&pool)
            .await
            .expect("failed to apply 012_collaboration");
        // 应用 pipeline_run_id 列（016）
        sqlx::query("ALTER TABLE collaboration_sessions ADD COLUMN pipeline_run_id TEXT")
            .execute(&pool)
            .await
            .ok();
        // 应用治理字段（027）
        sqlx::query(include_str!("../../migrations/027_collaboration_governance.sql"))
            .execute(&pool)
            .await
            .expect("failed to apply 027_collaboration_governance");

        // 记录迁移版本
        for version in ["012_collaboration", "027_collaboration_governance"] {
            sqlx::query("INSERT INTO schema_migrations (version, kind) VALUES (?, 'sql')")
                .bind(version)
                .execute(&pool)
                .await
                .expect("failed to record migration");
        }

        pool
    }

    /// 插入测试用 session（FK 关闭，user_id/project_id 可任意）
    async fn seed_session(pool: &SqlitePool, user_id: &str) -> CollaborationSession {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
        sqlx::query(
            "INSERT INTO collaboration_sessions (
                id, user_id, project_id, conversation_id, state, round_count, created_at, updated_at
            ) VALUES (?, ?, 'proj-1', 'conv-1', 'discovery', 0, ?, ?)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .expect("failed to seed session");
        get_session(pool, &id).await.expect("session should exist")
    }

    /// 合法迁移：discovery -> delegating -> resolving_questions -> halted -> discovery
    #[tokio::test]
    async fn valid_session_transitions_succeed() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        let s = update_session_state(&pool, &session.id, SessionState::Delegating.as_str())
            .await
            .expect("discovery -> delegating should succeed");
        assert_eq!(s.state, "delegating");

        let s = update_session_state(&pool, &session.id, SessionState::ResolvingQuestions.as_str())
            .await
            .expect("delegating -> resolving_questions should succeed");
        assert_eq!(s.state, "resolving_questions");

        let s = update_session_state(&pool, &session.id, SessionState::Halted.as_str())
            .await
            .expect("resolving_questions -> halted should succeed");
        assert_eq!(s.state, "halted");

        let s = update_session_state(&pool, &session.id, SessionState::Discovery.as_str())
            .await
            .expect("halted -> discovery should succeed");
        assert_eq!(s.state, "discovery");

        pool.close().await;
    }

    /// 非法迁移：discovery -> completed 应返回包含 INVALID_TRANSITION 错误码的错误
    #[tokio::test]
    async fn invalid_session_transition_returns_stable_error_code() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        let err = update_session_state(&pool, &session.id, SessionState::Completed.as_str())
            .await
            .expect_err("discovery -> completed should fail");
        let msg = format!("{}", err);
        assert!(
            msg.contains(error_codes::INVALID_TRANSITION),
            "error should contain {}: got {}",
            error_codes::INVALID_TRANSITION,
            msg
        );

        pool.close().await;
    }

    /// halt_session_with_audit 应记录 halt_reason/halted_by/halted_at
    #[tokio::test]
    async fn halt_session_with_audit_records_audit_fields() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        // 先迁到 resolving_questions 才能 halt
        update_session_state(&pool, &session.id, SessionState::Delegating.as_str())
            .await
            .unwrap();
        update_session_state(&pool, &session.id, SessionState::ResolvingQuestions.as_str())
            .await
            .unwrap();

        let halted = halt_session_with_audit(&pool, &session.id, "测试暂停原因", "user-1")
            .await
            .expect("halt should succeed");
        assert_eq!(halted.state, "halted");
        assert_eq!(halted.halt_reason.as_deref(), Some("测试暂停原因"));
        assert_eq!(halted.halted_by.as_deref(), Some("user-1"));
        assert!(halted.halted_at.is_some());

        pool.close().await;
    }

    /// resume_session 应清除 halt 字段并记录恢复审计
    #[tokio::test]
    async fn resume_session_records_recovery_audit() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        // discovery -> delegating -> resolving_questions -> halted
        update_session_state(&pool, &session.id, SessionState::Delegating.as_str())
            .await
            .unwrap();
        update_session_state(&pool, &session.id, SessionState::ResolvingQuestions.as_str())
            .await
            .unwrap();
        halt_session_with_audit(&pool, &session.id, "需人工介入", "system")
            .await
            .unwrap();

        // resume: action=resume, 应回到 resolving_questions
        let resumed = resume_session(
            &pool,
            &session.id,
            "resume",
            "user-1",
            Some("人工确认后恢复"),
        )
        .await
        .expect("resume should succeed");
        assert_eq!(resumed.state, "resolving_questions");
        assert_eq!(resumed.recovery_audited, 1);
        assert_eq!(resumed.recovery_action.as_deref(), Some("resume"));
        assert_eq!(resumed.recovery_operator_user_id.as_deref(), Some("user-1"));
        assert_eq!(resumed.recovery_note.as_deref(), Some("人工确认后恢复"));
        assert!(resumed.halt_reason.is_none());
        assert!(resumed.halted_by.is_none());
        assert!(resumed.halted_at.is_none());

        pool.close().await;
    }

    /// resume_session 对非 halted 状态应返回错误
    #[tokio::test]
    async fn resume_session_rejects_non_halted_state() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        let err = resume_session(&pool, &session.id, "resume", "user-1", None)
            .await
            .expect_err("resume on discovery should fail");
        let msg = format!("{}", err);
        assert!(msg.contains(error_codes::INVALID_TRANSITION));

        pool.close().await;
    }

    /// resume_session 对未知 action 应返回 UNKNOWN_STATE 错误码
    #[tokio::test]
    async fn resume_session_rejects_unknown_action() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        update_session_state(&pool, &session.id, SessionState::Delegating.as_str())
            .await
            .unwrap();
        update_session_state(&pool, &session.id, SessionState::ResolvingQuestions.as_str())
            .await
            .unwrap();
        halt_session_with_audit(&pool, &session.id, "测试", "system")
            .await
            .unwrap();

        let err = resume_session(&pool, &session.id, "unknown_action", "user-1", None)
            .await
            .expect_err("unknown action should fail");
        let msg = format!("{}", err);
        assert!(msg.contains(error_codes::UNKNOWN_STATE));

        pool.close().await;
    }

    /// update_assignment_failure_reason 应正确持久化失败原因（模拟缺失任务降级）
    #[tokio::test]
    async fn update_assignment_failure_reason_persists() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        let assignment = create_assignment(
            &pool,
            &session.id,
            "agent-1",
            "design",
            "设计大纲",
            None,
            None,
        )
        .await
        .expect("create_assignment should succeed");

        update_assignment_failure_reason(&pool, &assignment.id, "AI task 缺失，无法恢复")
            .await
            .expect("update failure_reason should succeed");

        let assignments = list_assignments(&pool, &session.id).await.unwrap();
        let found = assignments
            .iter()
            .find(|a| a.id == assignment.id)
            .expect("assignment should exist");
        assert_eq!(
            found.failure_reason.as_deref(),
            Some("AI task 缺失，无法恢复")
        );

        pool.close().await;
    }

    /// 非法 assignment 状态迁移应返回稳定错误码
    #[tokio::test]
    async fn invalid_assignment_transition_returns_stable_error_code() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        let assignment = create_assignment(
            &pool,
            &session.id,
            "agent-1",
            "design",
            "设计大纲",
            None,
            None,
        )
        .await
        .unwrap();
        // 当前 status=assigned，直接迁到 done 非法（必须先 running）
        let err = update_assignment_status(&pool, &assignment.id, AssignmentStatus::Done.as_str())
            .await
            .expect_err("assigned -> done should fail");
        let msg = format!("{}", err);
        assert!(msg.contains(error_codes::INVALID_TRANSITION));

        pool.close().await;
    }

    /// get_recent_question_contents 应返回最近问题内容（用于语义检测）
    #[tokio::test]
    async fn get_recent_question_contents_returns_latest() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        // 创建 3 条问题消息
        for content in ["如何设计大纲", "请问大纲怎么写", "大纲结构是什么"] {
            let order = get_next_queue_order(&pool, &session.id).await.unwrap();
            create_message(
                &pool,
                &session.id,
                Some("agent-1"),
                None,
                "question",
                content,
                None,
                None,
                order,
            )
            .await
            .unwrap();
        }

        let contents = get_recent_question_contents(&pool, &session.id, 8)
            .await
            .expect("should fetch question contents");
        assert_eq!(contents.len(), 3);
        // DESC 排序，最新在前
        assert_eq!(contents[0], "大纲结构是什么");

        pool.close().await;
    }

    /// update_max_round_limit 应正确更新可配置轮次上限
    #[tokio::test]
    async fn update_max_round_limit_persists() {
        let pool = create_collab_test_pool().await;
        let session = seed_session(&pool, "user-1").await;

        update_max_round_limit(&pool, &session.id, 30)
            .await
            .expect("update_max_round_limit should succeed");

        let s = get_session(&pool, &session.id).await.unwrap();
        assert_eq!(s.max_round_limit, 30);

        pool.close().await;
    }

    /// 跨用户访问：不同 user_id 应查询不到对方的会话
    /// 模拟 verify_session_owner 的越权访问场景
    #[tokio::test]
    async fn cross_user_access_is_isolated() {
        let pool = create_collab_test_pool().await;
        let user_a_session = seed_session(&pool, "user-a").await;
        let user_b_session = seed_session(&pool, "user-b").await;

        // user-a 的会话不应归属 user-b
        assert_ne!(user_a_session.user_id, user_b_session.user_id);
        assert_eq!(user_a_session.user_id, "user-a");
        assert_eq!(user_b_session.user_id, "user-b");

        // 模拟 verify_session_owner: 查询会话后比对 user_id
        let fetched = get_session(&pool, &user_a_session.id).await.unwrap();
        assert_eq!(
            fetched.user_id, "user-a",
            "user-b 不应能访问 user-a 的会话"
        );

        // list_active_sessions_for_project 应按 user_id 隔离
        let user_a_active = list_active_sessions_for_project(&pool, "user-a", "proj-1", None)
            .await
            .unwrap();
        assert_eq!(user_a_active.len(), 1);
        assert_eq!(user_a_active[0].user_id, "user-a");

        let user_b_active = list_active_sessions_for_project(&pool, "user-b", "proj-1", None)
            .await
            .unwrap();
        assert_eq!(user_b_active.len(), 1);
        assert_eq!(user_b_active[0].user_id, "user-b");

        pool.close().await;
    }
}
