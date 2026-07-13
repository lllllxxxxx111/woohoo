use sqlx::FromRow;
use sqlx::SqlitePool;

use crate::ai::config::{AgentRuntimeState, AiTask, AiTaskStatus};

/**
 * Parse a status string from the database into an AiTaskStatus.
 *
 * The DB stores status as a JSON-serialized string (e.g., '"completed"'),
 * but legacy rows may contain: plain text ('completed'), PascalCase ('"Completed"'),
 * or the SQL DEFAULT ('queued'). This function handles all formats robustly.
 */
fn parse_status_from_db(raw: &str) -> AiTaskStatus {
    // 1. Try standard JSON deserialization (handles '"completed"', '"cancelled"', etc.)
    if let Ok(status) = serde_json::from_str::<AiTaskStatus>(raw) {
        return status;
    }
    // 2. Fall back to case-insensitive plain text matching (legacy rows, SQL DEFAULT)
    let trimmed = raw.trim().trim_matches('"').to_lowercase();
    match trimmed.as_str() {
        "queued" => AiTaskStatus::Queued,
        "running" => AiTaskStatus::Running,
        "completed" => AiTaskStatus::Completed,
        "failed" => AiTaskStatus::Failed,
        "cancelled" => AiTaskStatus::Cancelled,
        _ => AiTaskStatus::Failed,
    }
}

/**
 * 用于从数据库读取任务的中间结构体（包含user_id）
 */
#[derive(FromRow)]
struct TaskRow {
    id: String,
    user_id: String,
    content: String,
    agent_id: Option<String>,
    output_kind: String,
    status: String,
    model: Option<String>,
    error: Option<String>,
    result: Option<String>,
    created_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    attempt_index: i64,
    is_redo: i64,
    previous_failures: i64,
    last_error: Option<String>,
    active_tasks: i64,
    queued_tasks: i64,
    project_id: String,
    conversation_id: String,
}

/**
 * 将任务状态持久化到数据库
 */
pub async fn persist_task(
    db: &SqlitePool,
    task: &AiTask,
    user_id: &str,
) -> Result<(), sqlx::Error> {
    let status_str = serde_json::to_string(&task.status).unwrap_or_default();

    sqlx::query(
        "INSERT OR REPLACE INTO ai_tasks (
            id, user_id, content, agent_id, output_kind, status,
            model, error, result, created_at, started_at, finished_at,
            attempt_index, is_redo, previous_failures, last_error,
            active_tasks, queued_tasks, project_id, conversation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&task.id)
    .bind(user_id)
    .bind(&task.content)
    .bind(&task.agent_id)
    .bind(task.output_kind.as_deref().unwrap_or("text"))
    .bind(&status_str)
    .bind(&task.model)
    .bind(&task.error.as_deref())
    .bind(&task.result.as_deref())
    .bind(task.created_at)
    .bind(task.started_at)
    .bind(task.finished_at)
    .bind(task.attempt_index)
    .bind(if task.is_redo { 1 } else { 0 })
    .bind(task.previous_failures)
    .bind(&task.last_error)
    .bind(task.active_tasks)
    .bind(task.queued_tasks)
    .bind(&task.project_id)
    .bind(&task.conversation_id)
    .execute(db)
    .await?;

    Ok(())
}

/**
 * 从数据库删除任务
 */
pub async fn delete_persisted_task(db: &SqlitePool, task_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM ai_tasks WHERE id = ?")
        .bind(task_id)
        .execute(db)
        .await?;

    Ok(())
}

/**
 * 从数据库恢复任务到内存（返回带user_id的任务元组）
 * 启动时调用，将运行中/排队中的任务标记为失败
 *
 * 返回 (AiTask, user_id) 元组，确保恢复后用户归属不丢失
 */
pub async fn restore_tasks(db: &SqlitePool) -> Result<Vec<(AiTask, String)>, sqlx::Error> {
    let rows = sqlx::query_as::<_, TaskRow>(
        "SELECT id, user_id, content, agent_id, output_kind, status, model, error, result,
                created_at, started_at, finished_at, attempt_index, is_redo,
                previous_failures, last_error, active_tasks, queued_tasks, project_id, conversation_id
         FROM ai_tasks
         ORDER BY created_at DESC
         LIMIT 500"
    )
    .fetch_all(db)
    .await?;

    let now = chrono::Utc::now().timestamp_millis();
    let mut tasks = Vec::new();

    for row in rows {
        /*
         * 先反序列化状态枚举，再判断是否需要标记为失败。
         * Status is stored as a JSON-quoted string (serde_json::to_string),
         * e.g. '"completed"'. Legacy rows may have plain text ('completed') or
         * PascalCase ('"Completed"') from before camelCase rename. Try JSON
         * deserialization first, then fall back to case-insensitive plain-text
         * matching to avoid incorrectly marking valid rows as Failed.
         */
        let original_status: AiTaskStatus = parse_status_from_db(&row.status);

        let (status, final_error, final_finished_at) = match original_status {
            AiTaskStatus::Queued | AiTaskStatus::Running => (
                AiTaskStatus::Failed,
                Some("服务重启，任务已中断".to_string()),
                Some(now),
            ),
            _ => (original_status, row.error.clone(), row.finished_at),
        };

        tasks.push((
            AiTask {
                id: row.id.clone(),
                project_id: row.project_id,
                conversation_id: row.conversation_id,
                user_message_id: None,
                assistant_message_id: None,
                agent_id: row.agent_id,
                content: row.content,
                endpoint_id: None,
                model: row.model,
                output_kind: Some(row.output_kind),
                output_items: None,
                status,
                result: row.result,
                error: final_error,
                attempt_index: row.attempt_index,
                previous_attempts: 0,
                previous_failures: row.previous_failures,
                previous_successes: 0,
                is_redo: row.is_redo > 0,
                last_error: row.last_error,
                agent_status: AgentRuntimeState::Idle,
                active_tasks: row.active_tasks,
                queued_tasks: row.queued_tasks,
                created_at: row.created_at,
                started_at: row.started_at,
                finished_at: final_finished_at,
                seq: None,
            },
            row.user_id,
        ));
    }

    Ok(tasks)
}

/**
 * 清理过期的已完成/失败任务（保留30天）
 */
pub async fn cleanup_old_tasks(db: &SqlitePool) -> Result<u64, sqlx::Error> {
    let thirty_days_ago = chrono::Utc::now().timestamp_millis() - (30 * 24 * 60 * 60 * 1000);

    // Status values are stored as JSON-serialized strings (serde_json::to_string).
    // AiTaskStatus uses rename_all="camelCase", so values are:
    //   "queued", "running", "completed", "failed", "cancelled"
    // The DB column stores these with surrounding quotes: '"completed"', etc.
    let result = sqlx::query(
        "DELETE FROM ai_tasks
         WHERE status IN ('\"completed\"', '\"failed\"', '\"cancelled\"')
           AND finished_at < ?",
    )
    .bind(thirty_days_ago)
    .execute(db)
    .await?;

    Ok(result.rows_affected())
}
