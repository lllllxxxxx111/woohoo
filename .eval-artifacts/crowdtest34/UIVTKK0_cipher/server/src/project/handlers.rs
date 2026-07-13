use super::{model::*, repo};
use crate::{
    auth::middleware::UserId,
    db,
    error::{AppError, AppResult},
    pagination::{PaginatedResponse, PaginationMeta, PaginationQuery},
    AppState,
};
use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};

/// GET /api/projects
///
/// 分页查询用户的项目列表
///
/// 查询参数:
/// - page: 页码（默认1）
/// - per_page: 每页数量（默认20，最大100）
///
/// 响应格式:
/// {
///   "data": [...],
///   "meta": {
///     "page": 1,
///     "per_page": 20,
///     "total": 42,
///     "total_pages": 3,
///     "has_next": true,
///     "has_prev": false
///   }
/// }
pub async fn list_projects(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(pagination): Query<PaginationQuery>,
) -> AppResult<Json<PaginatedResponse<Project>>> {
    let per_page = pagination.per_page();
    let offset = pagination.offset();

    let (projects, total) =
        repo::list_by_user_paginated(&state.db, &user_id.0, per_page, offset).await?;

    let meta = PaginationMeta::new(total, &pagination);

    Ok(Json(PaginatedResponse {
        data: projects,
        pagination: meta,
    }))
}

/// POST /api/projects
pub async fn create_project(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<CreateProjectReq>,
) -> AppResult<(StatusCode, Json<Project>)> {
    tracing::info!(
        "create_project called: user={}, name={}",
        user_id.0,
        req.name
    );
    if req.name.trim().is_empty() {
        return Err(AppError::Validation("项目名称不能为空".into()));
    }
    let desc = req.description.unwrap_or_default();
    let project = match repo::create_project(&state.db, &user_id.0, &req.name, &desc).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("create_project DB error: {}", e);
            return Err(e);
        }
    };
    if let Err(e) =
        db::ensure_project_agent_assignments_for_project(&state.db, &user_id.0, &project.id).await
    {
        tracing::warn!("项目智能体分配初始化失败（非致命）: {}", e);
    }
    Ok((StatusCode::CREATED, Json(project)))
}

/// GET /api/projects/:id
pub async fn get_project(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<Project>> {
    let project = repo::find_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    if project.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权访问".into()));
    }
    Ok(Json(project))
}

/// PUT /api/projects/:id
pub async fn update_project(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<UpdateProjectReq>,
) -> AppResult<Json<Project>> {
    let project = repo::find_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    if project.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权访问".into()));
    }
    let updated = repo::update_project(
        &state.db,
        &id,
        req.name.as_deref(),
        req.description.as_deref(),
        req.status.as_deref(),
        req.phase.as_deref(),
    )
    .await?;
    Ok(Json(updated))
}

/// DELETE /api/projects/:id
pub async fn delete_project(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let project = repo::find_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    if project.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权访问".into()));
    }

    // 删除关联数据
    sqlx::query("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM conversations WHERE project_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM assets WHERE project_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM project_agent_assignments WHERE project_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    repo::delete_project(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
