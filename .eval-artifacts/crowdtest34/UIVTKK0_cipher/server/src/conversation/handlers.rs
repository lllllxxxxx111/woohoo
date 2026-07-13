use super::{model::*, repo};
use crate::{
    ai::config::{AiTaskFilter, AiTaskStatus},
    auth::middleware::UserId,
    error::{AppError, AppResult},
    project::repo as project_repo,
    AppState,
};
use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

/// GET /api/projects/:project_id/conversations
pub async fn list_conversations(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Vec<Conversation>>> {
    let convs = repo::list_by_project(&state.db, &project_id, &user_id.0).await?;
    Ok(Json(convs))
}

/// POST /api/projects/:project_id/conversations
pub async fn create_conversation(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateConversationReq>,
) -> AppResult<(StatusCode, Json<Conversation>)> {
    let project = project_repo::find_by_id(&state.db, &project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    if project.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权访问".into()));
    }

    let title = req.title.unwrap_or_else(|| "新对话".to_string());
    let conv = repo::create_conversation(&state.db, &project_id, &user_id.0, &title).await?;
    Ok((StatusCode::CREATED, Json(conv)))
}

/// GET /api/conversations/:id/messages
pub async fn list_messages(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Query(query): Query<ListMessagesQuery>,
) -> AppResult<Json<Vec<Message>>> {
    ensure_conversation_access(&state, &user_id.0, &id).await?;
    let msgs = if let Some(limit) = query.normalized_limit() {
        repo::list_messages_paginated(&state.db, &id, limit, query.normalized_offset()).await?
    } else {
        repo::list_messages(&state.db, &id).await?
    };
    Ok(Json(msgs))
}

/// PUT /api/conversations/:id
pub async fn update_conversation(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<UpdateConversationReq>,
) -> AppResult<Json<Conversation>> {
    ensure_conversation_access(&state, &user_id.0, &id).await?;

    let title = req.title.trim();
    if title.is_empty() {
        return Err(AppError::Validation("对话标题不能为空".into()));
    }

    let conversation = repo::update_title(&state.db, &id, title).await?;
    Ok(Json(conversation))
}

/// POST /api/conversations/:id/messages
pub async fn send_message(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<SendMessageReq>,
) -> AppResult<(StatusCode, Json<Message>)> {
    let conversation = ensure_conversation_access(&state, &user_id.0, &id).await?;

    let has_content = !req.content.trim().is_empty();
    let has_attachments = !req.attachments.is_empty();

    if !has_content && !has_attachments {
        return Err(AppError::Validation("消息内容和附件不能同时为空".into()));
    }

    if !matches!(req.role.as_str(), "user" | "assistant" | "system") {
        return Err(AppError::Validation("消息角色不合法".into()));
    }

    /*
     * 合并 attachments 到 meta JSON 中存储
     */
    let token_usage_str = req.token_usage.as_ref().map(|v| v.to_string());

    let final_meta = if has_attachments || req.meta.is_some() {
        let mut meta_map = serde_json::Map::new();

        if let Some(existing_meta) = &req.meta {
            if let Some(obj) = existing_meta.as_object() {
                meta_map = obj.clone();
            }
        }

        if has_attachments {
            let attachments_json = serde_json::to_value(&req.attachments)
                .map_err(|e| AppError::Internal(format!("附件序列化失败: {}", e)))?;
            meta_map.insert("attachments".to_string(), attachments_json);
        }

        Some(serde_json::Value::Object(meta_map).to_string())
    } else {
        None
    };

    let msg = if req.role == "user" {
        repo::add_user_message_with_snapshot(
            &state.db,
            &conversation,
            &req.content,
            &req.msg_type,
            req.agent_id.as_deref(),
            req.model_used.as_deref(),
            token_usage_str.as_deref(),
            final_meta.as_deref(),
        )
        .await?
    } else {
        repo::add_message(
            &state.db,
            &id,
            &req.role,
            &req.content,
            &req.msg_type,
            req.agent_id.as_deref(),
            req.model_used.as_deref(),
            token_usage_str.as_deref(),
            final_meta.as_deref(),
        )
        .await?
    };

    Ok((StatusCode::CREATED, Json(msg)))
}

/// POST /api/conversations/:id/rewind
pub async fn rewind_conversation(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<RewindConversationReq>,
) -> AppResult<Json<RewindConversationResp>> {
    let conversation = ensure_conversation_access(&state, &user_id.0, &id).await?;
    let anchor_message_id = req.message_id.trim().to_string();
    if anchor_message_id.is_empty() {
        return Err(AppError::Validation("消息ID不能为空".into()));
    }
    let cancelled_task_count = cancel_conversation_tasks(
        &state,
        &user_id.0,
        &conversation.id,
        Some("会话已撤回，任务已取消".to_string()),
    )
    .await;
    let stats = repo::rewind_conversation_from_user_message(
        &state.db,
        &conversation,
        &anchor_message_id,
        req.assets_only,
    )
    .await?;

    Ok(Json(RewindConversationResp {
        conversation_id: conversation.id,
        anchor_message_id,
        removed_message_count: stats.removed_message_count,
        cancelled_task_count,
    }))
}

/// DELETE /api/conversations/:id
pub async fn delete_conversation(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let _ = ensure_conversation_access(&state, &user_id.0, &id).await?;
    repo::delete_conversation(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /api/conversations/:id/messages/:message_id
pub async fn delete_message(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((id, message_id)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    let _ = ensure_conversation_access(&state, &user_id.0, &id).await?;
    let target_role = repo::find_message_role(&state.db, &id, &message_id).await?;
    if target_role.as_deref() == Some("user") {
        let _ = cancel_conversation_tasks(
            &state,
            &user_id.0,
            &id,
            Some("关联用户消息已删除，任务已取消".to_string()),
        )
        .await;
    }

    let deleted = repo::delete_message(&state.db, &id, &message_id).await?;
    if !deleted {
        return Err(AppError::NotFound("消息不存在".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// 更新消息内容请求体
#[derive(Debug, Deserialize)]
pub struct UpdateMessageReq {
    pub content: String,
}

/// PUT /api/conversations/:id/messages/:message_id
pub async fn update_message(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((id, message_id)): Path<(String, String)>,
    Json(req): Json<UpdateMessageReq>,
) -> AppResult<Json<Message>> {
    let _ = ensure_conversation_access(&state, &user_id.0, &id).await?;
    let updated = repo::update_message_content(&state.db, &id, &message_id, &req.content).await?;
    Ok(Json(updated))
}

async fn ensure_conversation_access(
    state: &AppState,
    user_id: &str,
    conversation_id: &str,
) -> AppResult<Conversation> {
    let conversation = repo::find_by_id(&state.db, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("对话不存在".into()))?;
    if conversation.user_id != user_id {
        return Err(AppError::Forbidden("无权访问".into()));
    }

    Ok(conversation)
}

async fn cancel_conversation_tasks(
    state: &AppState,
    user_id: &str,
    conversation_id: &str,
    reason: Option<String>,
) -> i64 {
    let tasks = state
        .ai_runtime
        .list_tasks(
            user_id,
            &AiTaskFilter {
                project_id: None,
                conversation_id: Some(conversation_id.to_string()),
                limit: Some(200),
            },
        )
        .await;

    let mut cancelled = 0_i64;
    for task in tasks {
        if !matches!(task.status, AiTaskStatus::Queued | AiTaskStatus::Running | AiTaskStatus::Blocked) {
            continue;
        }

        if state
            .ai_runtime
            .cancel_task(user_id, &task.id, reason.clone())
            .await
            .is_some()
        {
            cancelled += 1;
        }
    }

    cancelled
}
