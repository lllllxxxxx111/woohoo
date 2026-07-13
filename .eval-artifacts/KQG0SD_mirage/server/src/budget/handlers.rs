use axum::{extract::State, Json};
use serde::Deserialize;

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::model::*;
use super::repo;

/// GET /api/budget/status - 获取当前用户预算状态
pub async fn get_budget_status(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<BudgetStatus>, AppError> {
    let status = repo::get_budget_status(&state.db, &user_id.0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(status))
}

/// GET /api/budget/settings - 获取当前用户预算设置
pub async fn get_budget_settings(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<UserBudgetSettings>, AppError> {
    let settings = repo::get_budget_settings(&state.db, &user_id.0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(settings))
}

/// PUT /api/budget/settings - 更新用户预算设置
pub async fn update_budget_settings(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<UpdateBudgetSettingsReq>,
) -> Result<Json<UserBudgetSettings>, AppError> {
    let settings = repo::update_budget_settings(&state.db, &user_id.0, &req)
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?;

    Ok(Json(settings))
}

#[derive(Debug, Deserialize)]
struct BlockEventsQuery {
    limit: Option<i64>,
}

/// GET /api/budget/blocks - 查询最近的预算拦截事件
pub async fn list_block_events(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    axum::extract::Query(query): axum::extract::Query<BlockEventsQuery>,
) -> Result<Json<Vec<BudgetBlockEvent>>, AppError> {
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let events = repo::list_recent_block_events(&state.db, &user_id.0, limit)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(events))
}
