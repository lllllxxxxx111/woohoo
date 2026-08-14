use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::error::AppResult;

use super::model::Script;

pub async fn find_by_project(pool: &SqlitePool, project_id: &str) -> AppResult<Option<Script>> {
    sqlx::query_as::<_, Script>("SELECT * FROM scripts WHERE project_id = ?")
        .bind(project_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

pub async fn list_by_user(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Script>> {
    sqlx::query_as::<_, Script>(
        "SELECT s.*
         FROM scripts s
         INNER JOIN projects p ON p.id = s.project_id
         WHERE p.user_id = ?
         ORDER BY s.updated_at DESC, s.id DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/**
 * 在给定事务内写入“当前剧本”（scripts 表）。
 *
 * 抽离为事务版本，便于与版本历史写入（content_versions）合并到同一事务，
 * 保证“当前内容 + 版本快照”原子一致。
 */
pub async fn write_current_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    title: &str,
    content: &str,
) -> AppResult<Script> {
    let id = Uuid::new_v4().to_string();
    let script = sqlx::query_as::<_, Script>(
        "INSERT INTO scripts (id, project_id, title, content)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
             title = excluded.title,
             content = excluded.content,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         RETURNING *",
    )
    .bind(&id)
    .bind(project_id)
    .bind(title)
    .bind(content)
    .fetch_one(&mut **tx)
    .await?;
    Ok(script)
}

pub async fn delete_by_project(pool: &SqlitePool, project_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM scripts WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;
    Ok(())
}
