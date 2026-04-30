use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::model::Asset;

pub async fn create_asset(
    pool: &SqlitePool,
    project_id: &str,
    name: &str,
    asset_type: &str,
    url: &str,
    metadata: Option<&str>,
) -> AppResult<Asset> {
    let id = Uuid::new_v4().to_string();
    sqlx::query_as::<_, Asset>(
        "INSERT INTO assets (id, project_id, name, asset_type, url, metadata)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&id)
    .bind(project_id)
    .bind(name)
    .bind(asset_type)
    .bind(url)
    .bind(metadata)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_by_project(pool: &SqlitePool, project_id: &str) -> AppResult<Vec<Asset>> {
    sqlx::query_as::<_, Asset>(
        "SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC, id DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_by_user(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Asset>> {
    sqlx::query_as::<_, Asset>(
        "SELECT a.*
         FROM assets a
         INNER JOIN projects p ON p.id = a.project_id
         WHERE p.user_id = ?
         ORDER BY a.created_at DESC, a.id DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn find_by_id(pool: &SqlitePool, id: &str) -> AppResult<Option<Asset>> {
    sqlx::query_as::<_, Asset>("SELECT * FROM assets WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

pub async fn update_asset(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    asset_type: &str,
    url: &str,
    metadata: Option<&str>,
) -> AppResult<Asset> {
    sqlx::query(
        "UPDATE assets
         SET name = ?, asset_type = ?, url = ?, metadata = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(name)
    .bind(asset_type)
    .bind(url)
    .bind(metadata)
    .bind(id)
    .execute(pool)
    .await?;

    find_by_id(pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound("资产不存在".into()))
}

pub async fn delete_asset(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM assets WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
