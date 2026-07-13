use axum::{extract::State, Json};

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::budget_model::*;
use super::budget_repo;

/// GET /api/billing/budget - 获取当前用户预算状态（设置 + 用量 + 警告 + 最近拦截）
pub async fn get_budget(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<BudgetStatus>, AppError> {
    let status = budget_repo::get_budget_status(&state.db, &user_id.0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(status))
}

/// PUT /api/billing/budget - 更新预算设置
pub async fn update_budget(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<UpdateBudgetSettingsReq>,
) -> Result<Json<BudgetSettings>, AppError> {
    let settings = budget_repo::update_budget_settings(&state.db, &user_id.0, &req)
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?;

    Ok(Json(settings))
}

/// GET /api/billing/budget/blocks - 获取最近预算拦截记录
pub async fn list_budget_blocks(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<Vec<BudgetBlockEvent>>, AppError> {
    let blocks = budget_repo::list_recent_blocks(&state.db, &user_id.0, 50)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(blocks))
}
