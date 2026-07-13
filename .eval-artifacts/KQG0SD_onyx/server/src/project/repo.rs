use super::model::Project;
use crate::error::AppResult;
use sqlx::SqlitePool;
use uuid::Uuid;

pub async fn create_project(
    pool: &SqlitePool,
    user_id: &str,
    name: &str,
    description: &str,
) -> AppResult<Project> {
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO projects (id, user_id, name, description) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(user_id)
        .bind(name)
        .bind(description)
        .execute(pool)
        .await?;

    sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(&id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| crate::error::AppError::Internal("项目创建后无法查询".into()))
}

pub async fn list_by_user(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Project>> {
    sqlx::query_as::<_, Project>(
        "SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/**
 * 分页查询用户的项目列表
 *
 * @param pool 数据库连接池
 * @param user_id 用户ID
 * @param per_page 每页记录数
 * @param offset 偏移量
 * @return (项目列表, 总记录数)
 */
pub async fn list_by_user_paginated(
    pool: &SqlitePool,
    user_id: &str,
    per_page: u32,
    offset: u32,
) -> AppResult<(Vec<Project>, u64)> {
    /*
     * 使用事务确保数据一致性
     * 在同一时刻获取列表和总数，避免并发修改导致的数据不一致
     */
    let mut tx = pool.begin().await?;

    // 查询当前页的数据
    let projects = sqlx::query_as::<_, Project>(
        "SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    )
    .bind(user_id)
    .bind(per_page as i64)
    .bind(offset as i64)
    .fetch_all(&mut *tx)
    .await?;

    // 查询总记录数（用于计算总页数）
    let total_row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM projects WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok((projects, total_row.0 as u64))
}

pub async fn find_by_id(pool: &SqlitePool, id: &str) -> AppResult<Option<Project>> {
    sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

pub async fn update_project(
    pool: &SqlitePool,
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
    status: Option<&str>,
    phase: Option<&str>,
) -> AppResult<Project> {
    // 动态构建 SET 子句
    let mut sets = vec!["updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')".to_string()];
    let mut binds: Vec<String> = vec![];

    if let Some(v) = name {
        sets.push(format!("name = ?{}", binds.len() + 1));
        binds.push(v.to_string());
    }
    if let Some(v) = description {
        sets.push(format!("description = ?{}", binds.len() + 1));
        binds.push(v.to_string());
    }
    if let Some(v) = status {
        sets.push(format!("status = ?{}", binds.len() + 1));
        binds.push(v.to_string());
    }
    if let Some(v) = phase {
        sets.push(format!("phase = ?{}", binds.len() + 1));
        binds.push(v.to_string());
    }

    // 简单做法：逐字段更新
    if let Some(v) = name {
        sqlx::query("UPDATE projects SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .bind(v).bind(id).execute(pool).await?;
    }
    if let Some(v) = description {
        sqlx::query("UPDATE projects SET description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .bind(v).bind(id).execute(pool).await?;
    }
    if let Some(v) = status {
        sqlx::query("UPDATE projects SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .bind(v).bind(id).execute(pool).await?;
    }
    if let Some(v) = phase {
        sqlx::query("UPDATE projects SET phase = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .bind(v).bind(id).execute(pool).await?;
    }

    find_by_id(pool, id)
        .await?
        .ok_or_else(|| crate::error::AppError::NotFound("项目不存在".into()))
}

pub async fn delete_project(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
