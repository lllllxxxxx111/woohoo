use sqlx::FromRow;
use sqlx::SqlitePool;

use crate::ai::config::{AgentRuntimeState, AiTask, AiTaskStatus};

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
    result: Option<String>,
    error: Option<String>,
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
            model, result, error, created_at, started_at, finished_at,
            attempt_index, is_redo, previous_failures, last_error,
            active_tasks, queued_tasks, project_id, conversation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&task.id)
    .bind(user_id)
    .bind(&task.content)
    .bind(&task.agent_id)
    .bind(&task.output_kind.as_deref().unwrap_or("text"))
    .bind(&status_str)
    .bind(&task.model)
    .bind(&task.result)
    .bind(&task.error.as_deref())
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
 * 从数据库恢复任务到内存（返回带user_id的任务元组）。
 *
 * AI 请求的供应商上下文只存在于发起请求的进程内，服务重启后无法安全续接。
 * 因此 queued/running 任务统一收敛为可见的失败终态，并将恢复原因写回数据库，
 * 让用户可以从任务列表重新提交，而不是留下永远 running 的孤儿记录。
 *
 * 返回 (AiTask, user_id) 元组，确保恢复后用户归属不丢失
 */
pub async fn restore_tasks(db: &SqlitePool) -> Result<Vec<(AiTask, String)>, sqlx::Error> {
    let rows = sqlx::query_as::<_, TaskRow>(
        "SELECT id, user_id, content, agent_id, output_kind, status, model, result, error,
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
         * 先反序列化状态枚举，再判断是否需要标记为失败
         * 避免字符串 contains 匹配的大小写/格式问题
         */
        let (original_status, invalid_status) = classify_persisted_status(&row.status);

        let (status, final_error, final_finished_at, recovery_error) = match original_status {
            AiTaskStatus::Queued => (
                AiTaskStatus::Failed,
                Some("服务重启中断了排队任务，请重新提交；如仍失败请联系运营处理".to_string()),
                Some(now),
                Some("ai_task_recovered_queued"),
            ),
            AiTaskStatus::Running => (
                AiTaskStatus::Failed,
                Some("服务重启中断了执行中的任务，无法安全续接供应商请求，请重试；外部费用将由对账流程处理".to_string()),
                Some(now),
                Some("ai_task_recovered_running"),
            ),
            _ if invalid_status => (
                AiTaskStatus::Failed,
                Some(format!(
                    "服务重启发现无法识别的历史任务状态 `{}`，已停止自动恢复，请人工核查后重试",
                    row.status
                )),
                Some(row.finished_at.unwrap_or(now)),
                Some("ai_task_recovered_invalid_status"),
            ),
            _ => (original_status, row.error.clone(), row.finished_at, None),
        };

        // 只有仍处于中断状态的记录才会被更新，重复启动不会重复生成恢复副作用。
        if let Some(recovery_error) = recovery_error {
            let status_value =
                serde_json::to_string(&status).unwrap_or_else(|_| "\"failed\"".to_string());
            let query = if invalid_status {
                "UPDATE ai_tasks
                 SET status = ?, error = ?, last_error = ?, finished_at = ?
                 WHERE id = ? AND status = ?"
            } else {
                "UPDATE ai_tasks
                 SET status = ?, error = ?, last_error = ?, finished_at = ?
                 WHERE id = ? AND lower(trim(status, ' \"')) IN ('queued', 'running')"
            };
            let mut statement = sqlx::query(query)
                .bind(status_value)
                .bind(final_error.as_deref())
                .bind(recovery_error)
                .bind(final_finished_at)
                .bind(&row.id);
            if invalid_status {
                statement = statement.bind(&row.status);
            }
            statement.execute(db).await?;
        }

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
                last_error: recovery_error.map(str::to_string).or(row.last_error),
                agent_status: AgentRuntimeState::Idle,
                active_tasks: row.active_tasks,
                queued_tasks: row.queued_tasks,
                created_at: row.created_at,
                started_at: row.started_at,
                finished_at: final_finished_at,
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

    let result = sqlx::query(
        "DELETE FROM ai_tasks
         WHERE status IN ('\"completed\"', '\"failed\"', '\"cancelled\"',
                          '\"Completed\"', '\"Failed\"', '\"Cancelled\"',
                          'completed', 'failed', 'cancelled')
           AND finished_at < ?",
    )
    .bind(thirty_days_ago)
    .execute(db)
    .await?;

    Ok(result.rows_affected())
}

fn parse_persisted_status(raw: &str) -> AiTaskStatus {
    classify_persisted_status(raw).0
}

fn classify_persisted_status(raw: &str) -> (AiTaskStatus, bool) {
    if let Ok(status) = serde_json::from_str::<AiTaskStatus>(raw) {
        return (status, false);
    }

    let normalized = raw.trim().trim_matches('\"').to_ascii_lowercase();
    match normalized.as_str() {
        "queued" => (AiTaskStatus::Queued, false),
        "running" => (AiTaskStatus::Running, false),
        "completed" => (AiTaskStatus::Completed, false),
        "failed" | "cancelled" => (AiTaskStatus::Failed, false),
        _ => (AiTaskStatus::Failed, true),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_persisted_status, restore_tasks};
    use crate::ai::config::AiTaskStatus;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite test pool");
        sqlx::query(
            "CREATE TABLE ai_tasks (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                agent_id TEXT,
                output_kind TEXT,
                status TEXT NOT NULL,
                model TEXT,
                result TEXT,
                error TEXT,
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                finished_at INTEGER,
                attempt_index INTEGER NOT NULL DEFAULT 0,
                is_redo INTEGER NOT NULL DEFAULT 0,
                previous_failures INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                active_tasks INTEGER NOT NULL DEFAULT 0,
                queued_tasks INTEGER NOT NULL DEFAULT 0,
                project_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create ai_tasks fixture");
        pool
    }

    async fn insert_task(pool: &sqlx::SqlitePool, id: &str, status: &str) {
        sqlx::query(
            "INSERT INTO ai_tasks (id, user_id, content, output_kind, status, created_at, project_id, conversation_id)
             VALUES (?, 'user-1', 'content', 'text', ?, 1, 'project-1', 'conversation-1')",
        )
        .bind(id)
        .bind(status)
        .execute(pool)
        .await
        .expect("insert ai task fixture");
    }

    #[test]
    fn parses_json_and_legacy_task_statuses() {
        assert_eq!(parse_persisted_status("\"queued\""), AiTaskStatus::Queued);
        assert_eq!(parse_persisted_status("running"), AiTaskStatus::Running);
        assert_eq!(parse_persisted_status("Completed"), AiTaskStatus::Completed);
        assert_eq!(parse_persisted_status("cancelled"), AiTaskStatus::Failed);
    }

    #[tokio::test]
    async fn restores_case_variants_and_invalid_statuses_idempotently() {
        let pool = test_pool().await;
        insert_task(&pool, "queued-json", "\"queued\"").await;
        insert_task(&pool, "queued-title", "Queued").await;
        insert_task(&pool, "running-title", "Running").await;
        insert_task(&pool, "completed", "completed").await;
        insert_task(&pool, "failed", "\"failed\"").await;
        insert_task(&pool, "cancelled", "Cancelled").await;
        insert_task(&pool, "invalid", "stuck").await;

        let first = restore_tasks(&pool).await.expect("first restore");
        assert_eq!(first.len(), 7);

        let recovered: (i64, i64) = sqlx::query_as(
            "SELECT
                (SELECT COUNT(*) FROM ai_tasks WHERE lower(trim(status, ' \"')) IN ('queued', 'running')),
                (SELECT COUNT(*) FROM ai_tasks WHERE status = '\"failed\"' AND last_error IS NOT NULL)",
        )
        .fetch_one(&pool)
        .await
        .expect("query restored states");
        assert_eq!(recovered.0, 0);
        assert_eq!(recovered.1, 4);

        let invalid_error: (String, String) =
            sqlx::query_as("SELECT error, last_error FROM ai_tasks WHERE id = 'invalid'")
                .fetch_one(&pool)
                .await
                .expect("query invalid status");
        assert!(invalid_error.0.contains("stuck"));
        assert_eq!(invalid_error.1, "ai_task_recovered_invalid_status");

        let snapshot: Vec<(String, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT id, error, last_error FROM ai_tasks ORDER BY id")
                .fetch_all(&pool)
                .await
                .expect("snapshot restored tasks");
        restore_tasks(&pool).await.expect("second restore");
        let snapshot_again: Vec<(String, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT id, error, last_error FROM ai_tasks ORDER BY id")
                .fetch_all(&pool)
                .await
                .expect("snapshot after second restore");
        assert_eq!(snapshot, snapshot_again);
    }
}
