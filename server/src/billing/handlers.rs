use axum::{extract::State, Json};

use crate::auth::middleware::UserId;
use crate::error::AppError;
use crate::AppState;

use super::model::*;
use super::repo;

/// 查询当前用户积分余额
pub async fn get_credits(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<UserCredits>, AppError> {
    let credits = repo::get_user_credits(&state.db, &user_id.0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(credits))
}

/// 查询积分流水记录
pub async fn list_credit_transactions(
    State(state): State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
) -> Result<Json<Vec<CreditTransaction>>, AppError> {
    let txns = repo::list_transactions(&state.db, &user_id.0, 50, 0)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(txns))
}
