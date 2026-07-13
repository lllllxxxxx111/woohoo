use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::budget_model::{
    BudgetBlockEvent, BudgetSettings, BudgetStatus, UpdateBudgetSettingsInput,
};
use super::budget_repo;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetBlocksQuery {
    pub limit: Option<i64>,
}

pub async fn get_budget_status(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<BudgetStatus>, AppError> {
    let status = budget_repo::get_budget_status(&state.db, &user_id.0)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;

    Ok(Json(status))
}

pub async fn update_budget_settings(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Json(input): Json<UpdateBudgetSettingsInput>,
) -> Result<Json<BudgetSettings>, AppError> {
    let settings = budget_repo::update_budget_settings(&state.db, &user_id.0, input)
        .await
        .map_err(|error| AppError::Validation(error.to_string()))?;

    Ok(Json(settings))
}

pub async fn list_budget_blocks(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Query(query): Query<BudgetBlocksQuery>,
) -> Result<Json<Vec<BudgetBlockEvent>>, AppError> {
    let events =
        budget_repo::list_recent_block_events(&state.db, &user_id.0, query.limit.unwrap_or(50))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;

    Ok(Json(events))
}
