use std::collections::HashMap;

use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{
    asset::model::Asset,
    error::{AppError, AppResult},
};

use super::model::{Storyboard, StoryboardLine, StoryboardLineInput, StoryboardRecord};

#[derive(Debug, Clone, FromRow)]
struct StoryboardLineRow {
    id: String,
    storyboard_id: String,
    scene_number: i64,
    description: String,
    duration: i64,
}

#[derive(Debug, Clone, FromRow)]
struct StoryboardLineAssetRow {
    storyboard_line_id: String,
    id: String,
    project_id: String,
    name: String,
    asset_type: String,
    url: String,
    metadata: Option<String>,
    created_at: String,
    updated_at: String,
}

pub async fn find_by_project(pool: &SqlitePool, project_id: &str) -> AppResult<Option<Storyboard>> {
    let record =
        sqlx::query_as::<_, StoryboardRecord>("SELECT * FROM storyboards WHERE project_id = ?")
            .bind(project_id)
            .fetch_optional(pool)
            .await?;

    match record {
        Some(record) => Ok(Some(load_storyboard(pool, record).await?)),
        None => Ok(None),
    }
}

/// 事务内读取当前分镜（与写操作同一事务，读到的一定是本事务的状态）。
pub async fn find_by_project_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    project_id: &str,
) -> AppResult<Option<Storyboard>> {
    let record =
        sqlx::query_as::<_, StoryboardRecord>("SELECT * FROM storyboards WHERE project_id = ?")
            .bind(project_id)
            .fetch_optional(&mut **tx)
            .await?;

    match record {
        Some(record) => Ok(Some(load_storyboard_with(&mut **tx, record).await?)),
        None => Ok(None),
    }
}
pub async fn list_by_user(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Storyboard>> {
    let records = sqlx::query_as::<_, StoryboardRecord>(
        "SELECT s.*
         FROM storyboards s
         INNER JOIN projects p ON p.id = s.project_id
         WHERE p.user_id = ?
         ORDER BY s.updated_at DESC, s.id DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    if records.is_empty() {
        return Ok(Vec::new());
    }

    let line_rows = sqlx::query_as::<_, StoryboardLineRow>(
        "SELECT sl.id, sl.storyboard_id, sl.scene_number, sl.description, sl.duration
         FROM storyboard_lines sl
         INNER JOIN storyboards s ON s.id = sl.storyboard_id
         INNER JOIN projects p ON p.id = s.project_id
         WHERE p.user_id = ?
         ORDER BY sl.storyboard_id ASC, sl.sort_order ASC, sl.scene_number ASC, sl.id ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let asset_rows = sqlx::query_as::<_, StoryboardLineAssetRow>(
        "SELECT sla.storyboard_line_id, a.id, a.project_id, a.name, a.asset_type, a.url, a.metadata, a.created_at, a.updated_at
         FROM storyboard_line_assets sla
         INNER JOIN storyboard_lines sl ON sl.id = sla.storyboard_line_id
         INNER JOIN storyboards s ON s.id = sl.storyboard_id
         INNER JOIN projects p ON p.id = s.project_id
         INNER JOIN assets a ON a.id = sla.asset_id
         WHERE p.user_id = ?
         ORDER BY sl.storyboard_id ASC, sl.sort_order ASC, a.created_at ASC, a.id ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut line_assets: HashMap<String, Vec<Asset>> = HashMap::new();
    for row in asset_rows {
        line_assets
            .entry(row.storyboard_line_id)
            .or_default()
            .push(Asset {
                id: row.id,
                project_id: row.project_id,
                name: row.name,
                asset_type: row.asset_type,
                url: row.url,
                metadata: row.metadata,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
    }

    let mut storyboard_lines: HashMap<String, Vec<StoryboardLine>> = HashMap::new();
    for row in line_rows {
        let line_id = row.id;
        storyboard_lines
            .entry(row.storyboard_id)
            .or_default()
            .push(StoryboardLine {
                assets: line_assets.remove(&line_id).unwrap_or_default(),
                id: line_id,
                scene_number: row.scene_number,
                description: row.description,
                duration: row.duration,
            });
    }

    Ok(records
        .into_iter()
        .map(|record| Storyboard {
            id: record.id.clone(),
            project_id: record.project_id,
            lines: storyboard_lines.remove(&record.id).unwrap_or_default(),
            updated_at: record.updated_at,
        })
        .collect())
}

/**
 * 在给定事务内写入“当前分镜”（storyboards + storyboard_lines + storyboard_line_assets）。
 *
 * `strict_assets`：
 *   - true（常规保存）：引用不存在的项目资产时返回校验错误。
 *   - false（历史恢复）：跳过已不存在的资产，避免旧版本引用失效资产导致整体恢复失败。
 *
 * 抽离为事务版本，便于与版本历史写入（content_versions）合并到同一事务。
 */
pub async fn upsert_storyboard_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    lines: &[StoryboardLineInput],
    strict_assets: bool,
) -> AppResult<StoryboardRecord> {
    let storyboard_id = Uuid::new_v4().to_string();

    let record = sqlx::query_as::<_, StoryboardRecord>(
        "INSERT INTO storyboards (id, project_id)
         VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         RETURNING *",
    )
    .bind(&storyboard_id)
    .bind(project_id)
    .fetch_one(&mut **tx)
    .await?;

    let existing_line_ids: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM storyboard_lines WHERE storyboard_id = ?")
            .bind(&record.id)
            .fetch_all(&mut **tx)
            .await?;

    for (line_id,) in &existing_line_ids {
        sqlx::query("DELETE FROM storyboard_line_assets WHERE storyboard_line_id = ?")
            .bind(line_id)
            .execute(&mut **tx)
            .await?;
    }

    sqlx::query("DELETE FROM storyboard_lines WHERE storyboard_id = ?")
        .bind(&record.id)
        .execute(&mut **tx)
        .await?;

    for (index, line) in lines.iter().enumerate() {
        let line_id = line
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        sqlx::query(
            "INSERT INTO storyboard_lines (id, storyboard_id, scene_number, description, duration, sort_order)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&line_id)
        .bind(&record.id)
        .bind(line.scene_number)
        .bind(line.description.trim())
        .bind(line.duration)
        .bind(index as i64)
        .execute(&mut **tx)
        .await?;

        for asset_id in &line.asset_ids {
            let owned_asset: Option<(String,)> =
                sqlx::query_as("SELECT id FROM assets WHERE id = ? AND project_id = ?")
                    .bind(asset_id)
                    .bind(project_id)
                    .fetch_optional(&mut **tx)
                    .await?;

            if owned_asset.is_none() {
                if strict_assets {
                    return Err(AppError::Validation("分镜引用了不存在的项目资产".into()));
                }
                // 恢复场景：资产可能已被删除，跳过该引用而不是整体失败
                continue;
            }

            sqlx::query(
                "INSERT INTO storyboard_line_assets (storyboard_line_id, asset_id)
                 VALUES (?, ?)",
            )
            .bind(&line_id)
            .bind(asset_id)
            .execute(&mut **tx)
            .await?;
        }
    }

    Ok(record)
}

/// 既有分镜行的“身份”摘要（id + 定位内容），用于给缺 ID 的输入行回填稳定 ID。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StoryboardLineIdentity {
    pub id: String,
    pub scene_number: i64,
    pub description: String,
    pub duration: i64,
}

/// 按展示顺序读取项目当前分镜各行的身份摘要。
pub async fn list_line_identities(
    pool: &SqlitePool,
    project_id: &str,
) -> AppResult<Vec<StoryboardLineIdentity>> {
    let rows = sqlx::query_as::<_, StoryboardLineIdentity>(
        "SELECT sl.id, sl.scene_number, sl.description, sl.duration
         FROM storyboard_lines sl
         INNER JOIN storyboards s ON s.id = sl.storyboard_id
         WHERE s.project_id = ?
         ORDER BY sl.sort_order ASC, sl.scene_number ASC, sl.id ASC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_by_project(pool: &SqlitePool, project_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM storyboards WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn load_storyboard(pool: &SqlitePool, record: StoryboardRecord) -> AppResult<Storyboard> {
    let mut conn = pool.acquire().await?;
    load_storyboard_with(&mut conn, record).await
}

/// 在指定连接上加载完整分镜。保存链路必须在同一事务内读取，提交后再读
/// 会被并发保存插队，把别人的 lines 和本次的 version_row 错配进同一个响应。
async fn load_storyboard_with(
    conn: &mut sqlx::SqliteConnection,
    record: StoryboardRecord,
) -> AppResult<Storyboard> {
    let line_rows = sqlx::query_as::<_, StoryboardLineRow>(
        "SELECT id, storyboard_id, scene_number, description, duration
         FROM storyboard_lines
         WHERE storyboard_id = ?
         ORDER BY sort_order ASC, scene_number ASC, id ASC",
    )
    .bind(&record.id)
    .fetch_all(&mut *conn)
    .await?;

    let asset_rows = sqlx::query_as::<_, StoryboardLineAssetRow>(
        "SELECT sla.storyboard_line_id, a.id, a.project_id, a.name, a.asset_type, a.url, a.metadata, a.created_at, a.updated_at
         FROM storyboard_line_assets sla
         INNER JOIN assets a ON a.id = sla.asset_id
         INNER JOIN storyboard_lines sl ON sl.id = sla.storyboard_line_id
         WHERE sl.storyboard_id = ?
         ORDER BY sl.sort_order ASC, a.created_at ASC, a.id ASC",
    )
    .bind(&record.id)
    .fetch_all(&mut *conn)
    .await?;

    let mut line_assets: HashMap<String, Vec<Asset>> = HashMap::new();
    for row in asset_rows {
        line_assets
            .entry(row.storyboard_line_id)
            .or_default()
            .push(Asset {
                id: row.id,
                project_id: row.project_id,
                name: row.name,
                asset_type: row.asset_type,
                url: row.url,
                metadata: row.metadata,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
    }

    let lines = line_rows
        .into_iter()
        .map(|row| {
            let line_id = row.id;
            StoryboardLine {
                assets: line_assets.remove(&line_id).unwrap_or_default(),
                id: line_id,
                scene_number: row.scene_number,
                description: row.description,
                duration: row.duration,
            }
        })
        .collect();

    Ok(Storyboard {
        id: record.id,
        project_id: record.project_id,
        lines,
        updated_at: record.updated_at,
    })
}
