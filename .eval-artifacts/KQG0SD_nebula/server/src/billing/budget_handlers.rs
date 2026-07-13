use axum::{extract::State, Json};

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::budget_model::{
    BudgetEvent, BudgetSnapshot, UpsertBudgetSettingsReq, UserBudgetSettings,
};
use super::budget_repo;

/// GET /api/billing/budget - 返回完整预算快照（设置 + 用量 + 状态）
pub async fn get_budget(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<BudgetSnapshot>, AppError> {
    let snap = budget_repo::build_snapshot(&state.db, &user_id.0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(snap))
}

/// PUT /api/billing/budget - 更新预算配置
pub async fn update_budget(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(req): Json<UpsertBudgetSettingsReq>,
) -> Result<Json<UserBudgetSettings>, AppError> {
    let settings = budget_repo::upsert_budget_settings(&state.db, &user_id.0, &req)
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?;
    Ok(Json(settings))
}

/// GET /api/billing/budget/events - 最近的预算事件（warning / blocked）
pub async fn list_budget_events(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<Vec<BudgetEvent>>, AppError> {
    let events = budget_repo::list_events(&state.db, &user_id.0, 50)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(events))
}
