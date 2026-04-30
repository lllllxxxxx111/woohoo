use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::model::{Conversation, Message, MessageHistoryEntry};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct ConversationRewindStats {
    pub removed_message_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectResourceCheckpoint {
    project_id: String,
    assets: Vec<CheckpointAsset>,
    script: Option<CheckpointScript>,
    storyboard: Option<CheckpointStoryboard>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
struct CheckpointAsset {
    id: String,
    project_id: String,
    name: String,
    asset_type: String,
    url: String,
    metadata: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
struct CheckpointScript {
    id: String,
    project_id: String,
    title: String,
    content: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointStoryboard {
    id: String,
    project_id: String,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    lines: Vec<CheckpointStoryboardLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointStoryboardLine {
    id: String,
    storyboard_id: String,
    scene_number: i64,
    description: String,
    duration: i64,
    sort_order: i64,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    asset_ids: Vec<String>,
}

#[derive(Debug, Clone, FromRow)]
struct CheckpointStoryboardRow {
    id: String,
    project_id: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, FromRow)]
struct CheckpointStoryboardLineRow {
    id: String,
    storyboard_id: String,
    scene_number: i64,
    description: String,
    duration: i64,
    sort_order: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, FromRow)]
struct StoryboardLineAssetRef {
    storyboard_line_id: String,
    asset_id: String,
}

#[derive(Debug, Clone, FromRow)]
struct AnchorMessageRow {
    role: String,
    row_id: i64,
}

#[derive(Debug, Clone, FromRow)]
struct MessageRoleRow {
    role: String,
}

#[derive(Debug, Clone, FromRow)]
struct SnapshotRow {
    checkpoint_json: String,
}

/// 创建对话
pub async fn create_conversation(
    pool: &SqlitePool,
    project_id: &str,
    user_id: &str,
    title: &str,
) -> AppResult<Conversation> {
    let id = Uuid::new_v4().to_string();
    sqlx::query_as::<_, Conversation>(
        "INSERT INTO conversations (id, project_id, user_id, title) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .bind(&id)
    .bind(project_id)
    .bind(user_id)
    .bind(title)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

/// 查询项目下的所有对话
pub async fn list_by_project(
    pool: &SqlitePool,
    project_id: &str,
    user_id: &str,
) -> AppResult<Vec<Conversation>> {
    sqlx::query_as::<_, Conversation>(
        "SELECT * FROM conversations WHERE project_id = ? AND user_id = ? ORDER BY updated_at DESC",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_by_user(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Conversation>> {
    sqlx::query_as::<_, Conversation>(
        "SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// 根据 ID 查找对话
pub async fn find_by_id(pool: &SqlitePool, id: &str) -> AppResult<Option<Conversation>> {
    sqlx::query_as::<_, Conversation>("SELECT * FROM conversations WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// 更新对话标题
pub async fn update_title(pool: &SqlitePool, id: &str, title: &str) -> AppResult<Conversation> {
    sqlx::query_as::<_, Conversation>(
        "UPDATE conversations
         SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
         RETURNING *",
    )
    .bind(title)
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

/// 删除对话（级联删除消息）
pub async fn delete_conversation(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/** 仅恢复资产库（不恢复脚本和分镜），用于轻量级撤回 */
async fn restore_assets_only_checkpoint_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    checkpoint: ProjectResourceCheckpoint,
) -> AppResult<()> {
    if checkpoint.project_id != project_id {
        return Err(AppError::Validation(
            "快照与当前项目不匹配，无法回滚".into(),
        ));
    }

    sqlx::query("DELETE FROM assets WHERE project_id = ?")
        .bind(project_id)
        .execute(&mut **tx)
        .await?;

    for asset in checkpoint.assets {
        sqlx::query(
            "INSERT INTO assets (id, project_id, name, asset_type, url, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(asset.id)
        .bind(asset.project_id)
        .bind(asset.name)
        .bind(asset.asset_type)
        .bind(asset.url)
        .bind(asset.metadata)
        .bind(asset.created_at)
        .bind(asset.updated_at)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

/// 删除单条消息
pub async fn delete_message(
    pool: &SqlitePool,
    conversation_id: &str,
    message_id: &str,
) -> AppResult<bool> {
    let mut tx = pool.begin().await?;

    let target_message = sqlx::query_as::<_, AnchorMessageRow>(
        "SELECT role, rowid AS row_id
         FROM messages
         WHERE id = ? AND conversation_id = ?",
    )
    .bind(message_id)
    .bind(conversation_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(target_message) = target_message else {
        return Ok(false);
    };

    let removed_rows = if target_message.role == "user" {
        let next_user_row_id = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MIN(rowid)
             FROM messages
             WHERE conversation_id = ? AND role = 'user' AND rowid > ?",
        )
        .bind(conversation_id)
        .bind(target_message.row_id)
        .fetch_one(&mut *tx)
        .await?;

        if let Some(next_row_id) = next_user_row_id {
            sqlx::query(
                "DELETE FROM conversation_user_message_snapshots
                 WHERE conversation_id = ?
                   AND message_id IN (
                     SELECT id FROM messages
                     WHERE conversation_id = ? AND rowid >= ? AND rowid < ?
                   )",
            )
            .bind(conversation_id)
            .bind(conversation_id)
            .bind(target_message.row_id)
            .bind(next_row_id)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "DELETE FROM messages
                 WHERE conversation_id = ? AND rowid >= ? AND rowid < ?",
            )
            .bind(conversation_id)
            .bind(target_message.row_id)
            .bind(next_row_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
        } else {
            sqlx::query(
                "DELETE FROM conversation_user_message_snapshots
                 WHERE conversation_id = ?
                   AND message_id IN (
                     SELECT id FROM messages
                     WHERE conversation_id = ? AND rowid >= ?
                   )",
            )
            .bind(conversation_id)
            .bind(conversation_id)
            .bind(target_message.row_id)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "DELETE FROM messages
                 WHERE conversation_id = ? AND rowid >= ?",
            )
            .bind(conversation_id)
            .bind(target_message.row_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
        }
    } else {
        sqlx::query(
            "DELETE FROM conversation_user_message_snapshots
             WHERE conversation_id = ? AND message_id = ?",
        )
        .bind(conversation_id)
        .bind(message_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM messages WHERE id = ? AND conversation_id = ?")
            .bind(message_id)
            .bind(conversation_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
    };

    if removed_rows == 0 {
        return Ok(false);
    }

    sqlx::query(
        "UPDATE conversations
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(conversation_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(true)
}

pub async fn find_message_role(
    pool: &SqlitePool,
    conversation_id: &str,
    message_id: &str,
) -> AppResult<Option<String>> {
    let row = sqlx::query_as::<_, MessageRoleRow>(
        "SELECT role
         FROM messages
         WHERE id = ? AND conversation_id = ?",
    )
    .bind(message_id)
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|item| item.role))
}

// ─── 消息操作 ────────────────────────────────────────

/// 添加消息
pub async fn add_message(
    pool: &SqlitePool,
    conversation_id: &str,
    role: &str,
    content: &str,
    msg_type: &str,
    agent_id: Option<&str>,
    model_used: Option<&str>,
    token_usage: Option<&str>,
    meta: Option<&str>,
) -> AppResult<Message> {
    let id = Uuid::new_v4().to_string();
    let msg = sqlx::query_as::<_, Message>(
        "INSERT INTO messages (
             id, conversation_id, role, content, msg_type, agent_id, model_used, token_usage, meta, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         RETURNING *",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(role)
    .bind(content)
    .bind(msg_type)
    .bind(agent_id)
    .bind(model_used)
    .bind(token_usage)
    .bind(meta)
    .fetch_one(pool)
    .await?;

    // 更新对话的 updated_at
    sqlx::query(
        "UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
    )
    .bind(conversation_id)
    .execute(pool)
    .await?;

    Ok(msg)
}

/// 添加用户消息，并记录该消息发送前的项目资源快照（用于撤回回滚）
pub async fn add_user_message_with_snapshot(
    pool: &SqlitePool,
    conversation: &Conversation,
    content: &str,
    msg_type: &str,
    agent_id: Option<&str>,
    model_used: Option<&str>,
    token_usage: Option<&str>,
    meta: Option<&str>,
) -> AppResult<Message> {
    let mut tx = pool.begin().await?;
    let checkpoint =
        capture_project_resource_checkpoint_tx(&mut tx, &conversation.project_id).await?;
    let checkpoint_json = serde_json::to_string(&checkpoint)
        .map_err(|error| AppError::Internal(format!("资源快照序列化失败: {}", error)))?;

    let message_id = Uuid::new_v4().to_string();
    let message = sqlx::query_as::<_, Message>(
        "INSERT INTO messages (
             id, conversation_id, role, content, msg_type, agent_id, model_used, token_usage, meta, updated_at
         )
         VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         RETURNING *",
    )
    .bind(&message_id)
    .bind(&conversation.id)
    .bind(content)
    .bind(msg_type)
    .bind(agent_id)
    .bind(model_used)
    .bind(token_usage)
    .bind(meta)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE conversations
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(&conversation.id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO conversation_user_message_snapshots (
             id, user_id, project_id, conversation_id, message_id, checkpoint_json
         ) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&conversation.user_id)
    .bind(&conversation.project_id)
    .bind(&conversation.id)
    .bind(&message_id)
    .bind(checkpoint_json)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(message)
}

/** 更新消息内容（仅修改 content 字段，不删除消息、不回滚资源） */
pub async fn update_message_content(
    pool: &SqlitePool,
    conversation_id: &str,
    message_id: &str,
    new_content: &str,
) -> AppResult<Message> {
    let updated = sqlx::query_as::<_, Message>(
        "UPDATE messages SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND conversation_id = ?
         RETURNING *",
    )
    .bind(new_content)
    .bind(message_id)
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("要更新的消息不存在".into()))?;

    sqlx::query(
        "UPDATE conversations
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(conversation_id)
    .execute(pool)
    .await?;

    Ok(updated)
}

pub async fn update_message_streaming_content(
    pool: &SqlitePool,
    conversation_id: &str,
    message_id: &str,
    new_content: &str,
    model_used: Option<&str>,
    meta: Option<&str>,
) -> AppResult<Message> {
    let updated = sqlx::query_as::<_, Message>(
        "UPDATE messages
         SET content = ?,
             model_used = ?,
             meta = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND conversation_id = ?
         RETURNING *",
    )
    .bind(new_content)
    .bind(model_used)
    .bind(meta)
    .bind(message_id)
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("要更新的流式消息不存在".into()))?;

    Ok(updated)
}

pub async fn replace_message(
    pool: &SqlitePool,
    conversation_id: &str,
    message_id: &str,
    role: &str,
    content: &str,
    msg_type: &str,
    agent_id: Option<&str>,
    model_used: Option<&str>,
    token_usage: Option<&str>,
    meta: Option<&str>,
) -> AppResult<Message> {
    let updated = sqlx::query_as::<_, Message>(
        "UPDATE messages
         SET role = ?,
             content = ?,
             msg_type = ?,
             agent_id = ?,
             model_used = ?,
             token_usage = ?,
             meta = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND conversation_id = ?
         RETURNING *",
    )
    .bind(role)
    .bind(content)
    .bind(msg_type)
    .bind(agent_id)
    .bind(model_used)
    .bind(token_usage)
    .bind(meta)
    .bind(message_id)
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("要替换的消息不存在".into()))?;

    sqlx::query(
        "UPDATE conversations
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(conversation_id)
    .execute(pool)
    .await?;

    Ok(updated)
}

pub async fn rewind_conversation_from_user_message(
    pool: &SqlitePool,
    conversation: &Conversation,
    anchor_message_id: &str,
    assets_only: bool,
) -> AppResult<ConversationRewindStats> {
    let anchor_message_id = anchor_message_id.trim();
    if anchor_message_id.is_empty() {
        return Err(AppError::Validation("消息ID不能为空".into()));
    }

    let mut tx = pool.begin().await?;
    let anchor = sqlx::query_as::<_, AnchorMessageRow>(
        "SELECT role, rowid AS row_id
         FROM messages
         WHERE id = ? AND conversation_id = ?",
    )
    .bind(anchor_message_id)
    .bind(&conversation.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("要撤回的消息不存在".into()))?;

    if anchor.role != "user" {
        return Err(AppError::Validation("仅支持撤回用户消息".into()));
    }

    let snapshot_row = sqlx::query_as::<_, SnapshotRow>(
        "SELECT checkpoint_json
         FROM conversation_user_message_snapshots
         WHERE conversation_id = ? AND message_id = ?",
    )
    .bind(&conversation.id)
    .bind(anchor_message_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Validation("该用户消息缺少可用快照，无法撤回".into()))?;

    let checkpoint =
        serde_json::from_str::<ProjectResourceCheckpoint>(&snapshot_row.checkpoint_json)
            .map_err(|error| AppError::Internal(format!("资源快照解析失败: {}", error)))?;

    if assets_only {
        restore_assets_only_checkpoint_tx(&mut tx, &conversation.project_id, checkpoint).await?;
    } else {
        restore_project_resource_checkpoint_tx(&mut tx, &conversation.project_id, checkpoint)
            .await?;
    }

    /* 标记被移除的消息为已撤回状态 */
    sqlx::query(
        "UPDATE messages SET meta = json_set(
            COALESCE(meta, '{}'),
            '$.revoked_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            '$.revoked_by', ?
         )
         WHERE conversation_id = ? AND rowid > ?",
    )
    .bind(anchor_message_id)
    .bind(&conversation.id)
    .bind(anchor.row_id)
    .execute(&mut *tx)
    .await?;

    let removed_message_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)
         FROM messages
         WHERE conversation_id = ? AND rowid >= ?",
    )
    .bind(&conversation.id)
    .bind(anchor.row_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "DELETE FROM conversation_user_message_snapshots
         WHERE conversation_id = ?
           AND message_id IN (
             SELECT id FROM messages WHERE conversation_id = ? AND rowid >= ?
           )",
    )
    .bind(&conversation.id)
    .bind(&conversation.id)
    .bind(anchor.row_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "DELETE FROM messages
         WHERE conversation_id = ? AND rowid >= ?",
    )
    .bind(&conversation.id)
    .bind(anchor.row_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE conversations
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(&conversation.id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(ConversationRewindStats {
        removed_message_count,
    })
}

/// 查询对话的所有消息
pub async fn list_messages(pool: &SqlitePool, conversation_id: &str) -> AppResult<Vec<Message>> {
    sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// 查询对话消息（分页）
pub async fn list_messages_paginated(
    pool: &SqlitePool,
    conversation_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<Message>> {
    sqlx::query_as::<_, Message>(
        "SELECT *
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ? OFFSET ?",
    )
    .bind(conversation_id)
    .bind(limit.max(1))
    .bind(offset.max(0))
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_messages_by_user(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Message>> {
    sqlx::query_as::<_, Message>(
        "SELECT m.*
         FROM messages m
         INNER JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = ?
         ORDER BY m.conversation_id ASC, m.created_at ASC, m.id ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_message_history(
    pool: &SqlitePool,
    conversation_id: &str,
) -> AppResult<Vec<MessageHistoryEntry>> {
    sqlx::query_as::<_, MessageHistoryEntry>(
        "SELECT role, content
         FROM messages
         WHERE conversation_id = ?
           AND COALESCE(
               CASE WHEN json_valid(meta) THEN json_extract(meta, '$.taskStatus') END,
               ''
           ) NOT IN ('running', 'queued')
         ORDER BY created_at ASC, id ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

async fn capture_project_resource_checkpoint_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
) -> AppResult<ProjectResourceCheckpoint> {
    let assets = sqlx::query_as::<_, CheckpointAsset>(
        "SELECT id, project_id, name, asset_type, url, metadata, created_at, updated_at
         FROM assets
         WHERE project_id = ?
         ORDER BY created_at ASC, id ASC",
    )
    .bind(project_id)
    .fetch_all(&mut **tx)
    .await?;

    let script = sqlx::query_as::<_, CheckpointScript>(
        "SELECT id, project_id, title, content, created_at, updated_at
         FROM scripts
         WHERE project_id = ?
         LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?;

    let storyboard = sqlx::query_as::<_, CheckpointStoryboardRow>(
        "SELECT id, project_id, created_at, updated_at
         FROM storyboards
         WHERE project_id = ?
         LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?;

    let storyboard = if let Some(storyboard) = storyboard {
        let lines = sqlx::query_as::<_, CheckpointStoryboardLineRow>(
            "SELECT id, storyboard_id, scene_number, description, duration, sort_order, created_at, updated_at
             FROM storyboard_lines
             WHERE storyboard_id = ?
             ORDER BY sort_order ASC, scene_number ASC, id ASC",
        )
        .bind(&storyboard.id)
        .fetch_all(&mut **tx)
        .await?;

        let line_assets = sqlx::query_as::<_, StoryboardLineAssetRef>(
            "SELECT sla.storyboard_line_id, sla.asset_id
             FROM storyboard_line_assets sla
             INNER JOIN storyboard_lines sl ON sl.id = sla.storyboard_line_id
             WHERE sl.storyboard_id = ?
             ORDER BY sl.sort_order ASC, sla.asset_id ASC",
        )
        .bind(&storyboard.id)
        .fetch_all(&mut **tx)
        .await?;

        let mut line_asset_map: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for item in line_assets {
            line_asset_map
                .entry(item.storyboard_line_id)
                .or_default()
                .push(item.asset_id);
        }

        let lines = lines
            .into_iter()
            .map(|line| CheckpointStoryboardLine {
                asset_ids: line_asset_map.remove(&line.id).unwrap_or_default(),
                id: line.id,
                storyboard_id: line.storyboard_id,
                scene_number: line.scene_number,
                description: line.description,
                duration: line.duration,
                sort_order: line.sort_order,
                created_at: line.created_at,
                updated_at: line.updated_at,
            })
            .collect();

        Some(CheckpointStoryboard {
            id: storyboard.id,
            project_id: storyboard.project_id,
            created_at: storyboard.created_at,
            updated_at: storyboard.updated_at,
            lines,
        })
    } else {
        None
    };

    Ok(ProjectResourceCheckpoint {
        project_id: project_id.to_string(),
        assets,
        script,
        storyboard,
    })
}

async fn restore_project_resource_checkpoint_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    checkpoint: ProjectResourceCheckpoint,
) -> AppResult<()> {
    if checkpoint.project_id != project_id {
        return Err(AppError::Validation(
            "快照与当前项目不匹配，无法回滚".into(),
        ));
    }

    sqlx::query("DELETE FROM storyboards WHERE project_id = ?")
        .bind(project_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM scripts WHERE project_id = ?")
        .bind(project_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM assets WHERE project_id = ?")
        .bind(project_id)
        .execute(&mut **tx)
        .await?;

    for asset in checkpoint.assets {
        sqlx::query(
            "INSERT INTO assets (id, project_id, name, asset_type, url, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(asset.id)
        .bind(asset.project_id)
        .bind(asset.name)
        .bind(asset.asset_type)
        .bind(asset.url)
        .bind(asset.metadata)
        .bind(asset.created_at)
        .bind(asset.updated_at)
        .execute(&mut **tx)
        .await?;
    }

    if let Some(script) = checkpoint.script {
        sqlx::query(
            "INSERT INTO scripts (id, project_id, title, content, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(script.id)
        .bind(script.project_id)
        .bind(script.title)
        .bind(script.content)
        .bind(script.created_at)
        .bind(script.updated_at)
        .execute(&mut **tx)
        .await?;
    }

    if let Some(storyboard) = checkpoint.storyboard {
        sqlx::query(
            "INSERT INTO storyboards (id, project_id, created_at, updated_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(&storyboard.id)
        .bind(&storyboard.project_id)
        .bind(&storyboard.created_at)
        .bind(&storyboard.updated_at)
        .execute(&mut **tx)
        .await?;

        for line in storyboard.lines {
            sqlx::query(
                "INSERT INTO storyboard_lines (
                     id, storyboard_id, scene_number, description, duration, sort_order, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&line.id)
            .bind(&line.storyboard_id)
            .bind(line.scene_number)
            .bind(&line.description)
            .bind(line.duration)
            .bind(line.sort_order)
            .bind(&line.created_at)
            .bind(&line.updated_at)
            .execute(&mut **tx)
            .await?;

            for asset_id in line.asset_ids {
                sqlx::query(
                    "INSERT INTO storyboard_line_assets (storyboard_line_id, asset_id)
                     VALUES (?, ?)",
                )
                .bind(&line.id)
                .bind(asset_id)
                .execute(&mut **tx)
                .await?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create sqlite memory pool");

        sqlx::query(
            "CREATE TABLE conversations (
                id TEXT PRIMARY KEY NOT NULL,
                updated_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create conversations table");

        sqlx::query(
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT ''
            )",
        )
        .execute(&pool)
        .await
        .expect("create messages table");

        sqlx::query(
            "CREATE TABLE conversation_user_message_snapshots (
                id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create snapshots table");

        sqlx::query(
            "INSERT INTO conversations (id, updated_at)
             VALUES ('conv-1', '2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("seed conversation");

        pool
    }

    async fn list_message_ids(pool: &SqlitePool) -> Vec<String> {
        sqlx::query_scalar::<_, String>("SELECT id FROM messages ORDER BY rowid ASC")
            .fetch_all(pool)
            .await
            .expect("query message ids")
    }

    async fn list_snapshot_message_ids(pool: &SqlitePool) -> Vec<String> {
        sqlx::query_scalar::<_, String>(
            "SELECT message_id
             FROM conversation_user_message_snapshots
             ORDER BY message_id ASC",
        )
        .fetch_all(pool)
        .await
        .expect("query snapshot message ids")
    }

    #[tokio::test]
    async fn delete_user_message_removes_related_ai_messages_until_next_user() {
        let pool = setup_test_pool().await;

        for (id, role) in [
            ("u1", "user"),
            ("a1", "assistant"),
            ("s1", "system"),
            ("u2", "user"),
            ("a2", "assistant"),
        ] {
            sqlx::query(
                "INSERT INTO messages (id, conversation_id, role, content)
                 VALUES (?, 'conv-1', ?, '')",
            )
            .bind(id)
            .bind(role)
            .execute(&pool)
            .await
            .expect("seed message");
        }

        for (id, message_id) in [("snap-1", "u1"), ("snap-2", "u2")] {
            sqlx::query(
                "INSERT INTO conversation_user_message_snapshots (id, conversation_id, message_id)
                 VALUES (?, 'conv-1', ?)",
            )
            .bind(id)
            .bind(message_id)
            .execute(&pool)
            .await
            .expect("seed snapshot");
        }

        let deleted = delete_message(&pool, "conv-1", "u1")
            .await
            .expect("delete message");
        assert!(deleted);

        assert_eq!(
            list_message_ids(&pool).await,
            vec!["u2".to_string(), "a2".to_string()]
        );
        assert_eq!(
            list_snapshot_message_ids(&pool).await,
            vec!["u2".to_string()]
        );
    }

    #[tokio::test]
    async fn delete_ai_message_only_removes_target_message() {
        let pool = setup_test_pool().await;

        for (id, role) in [("u1", "user"), ("a1", "assistant"), ("u2", "user")] {
            sqlx::query(
                "INSERT INTO messages (id, conversation_id, role, content)
                 VALUES (?, 'conv-1', ?, '')",
            )
            .bind(id)
            .bind(role)
            .execute(&pool)
            .await
            .expect("seed message");
        }

        for (id, message_id) in [("snap-1", "u1"), ("snap-2", "u2")] {
            sqlx::query(
                "INSERT INTO conversation_user_message_snapshots (id, conversation_id, message_id)
                 VALUES (?, 'conv-1', ?)",
            )
            .bind(id)
            .bind(message_id)
            .execute(&pool)
            .await
            .expect("seed snapshot");
        }

        let deleted = delete_message(&pool, "conv-1", "a1")
            .await
            .expect("delete message");
        assert!(deleted);

        assert_eq!(
            list_message_ids(&pool).await,
            vec!["u1".to_string(), "u2".to_string()]
        );
        assert_eq!(
            list_snapshot_message_ids(&pool).await,
            vec!["u1".to_string(), "u2".to_string()]
        );
    }
}
