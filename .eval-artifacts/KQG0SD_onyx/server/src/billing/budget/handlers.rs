use axum::extract::{Json, Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::SqlitePool;

use super::model::{BudgetBlock, BudgetStatus, UpdateBudgetConfigInput, UserBudgetConfig};
use super::repo;
use crate::auth::extractors::AuthenticatedUser;
use crate::error::AppResult;
use crate::AppState;

/// 获取当前用户的预算状态
pub async fn get_budget(
    State(pool): State<SqlitePool>,
    user: AuthenticatedUser,
) -> AppResult<Json<BudgetStatus>> {
    let status = repo::get_budget_status(&pool, &user.user_id).await?;
    Ok(Json(status))
}

/// 更新当前用户的预算配置
pub async fn update_budget(
    State(pool): State<SqlitePool>,
    user: AuthenticatedUser,
    Json(input): Json<UpdateBudgetConfigInput>,
) -> AppResult<Json<UserBudgetConfig>> {
    // 验证输入
    if let Some(warn_ratio) = input.warn_ratio {
        if warn_ratio < 0.0 || warn_ratio > 1.0 {
            return Err(crate::error::AppError::Validation(
                "预警比例必须在 0 到 1 之间".to_string(),
            ));
        }
    }

    if let Some(daily_limit) = input.daily_credit_limit {
        if daily_limit < 0.0 {
            return Err(crate::error::AppError::Validation(
                "日预算不能为负数".to_string(),
            ));
        }
    }

    if let Some(monthly_limit) = input.monthly_credit_limit {
        if monthly_limit < 0.0 {
            return Err(crate::error::AppError::Validation(
                "月预算不能为负数".to_string(),
            ));
        }
    }

    let config = repo::update_user_budget_config(&pool, &user.user_id, &input).await?;
    Ok(Json(config))
}

/// 获取最近的预算拦截记录
pub async fn list_budget_blocks(
    State(pool): State<SqlitePool>,
    user: AuthenticatedUser,
) -> AppResult<Json<Vec<BudgetBlock>>> {
    let blocks = repo::get_recent_budget_blocks(&pool, &user.user_id, 20).await?;
    Ok(Json(blocks))
}

/// 预算检查中间件函数（用于在 AI 调用前检查）
pub async fn check_budget_before_ai_call(
    pool: &SqlitePool,
    user_id: &str,
    operation: &str,
) -> AppResult<()> {
    let check_result = repo::check_budget(pool, user_id).await?;

    if !check_result.allowed {
        // 记录拦截事件
        let reason = check_result.reason.as_deref().unwrap_or("unknown");
        let (usage, limit) = match reason {
            "daily_exceeded" => (
                check_result.daily_usage,
                check_result.daily_limit.unwrap_or(0.0),
            ),
            "monthly_exceeded" => (
                check_result.monthly_usage,
                check_result.monthly_limit.unwrap_or(0.0),
            ),
            _ => (0.0, 0.0),
        };

        // 异步记录拦截事件（不阻塞主流程）
        let pool_clone = pool.clone();
        let user_id_clone = user_id.to_string();
        let operation_clone = operation.to_string();
        let reason_clone = reason.to_string();
        tokio::spawn(async move {
            if let Err(e) = repo::record_budget_block(
                &pool_clone,
                &user_id_clone,
                &operation_clone,
                &reason_clone,
                usage,
                limit,
                None,
            )
            .await
            {
                tracing::warn!("记录预算拦截事件失败: {}", e);
            }
        });

        return Err(repo::budget_exceeded_error(&check_result));
    }

    Ok(())
}
