use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

use super::budget_model::{BudgetBlockInput, BudgetCheckLevel, BudgetWindowType};
use super::budget_repo;

pub async fn enforce_budget(
    pool: &SqlitePool,
    user_id: &str,
    estimated_cost: f64,
    task_type: &str,
    always_high_cost: bool,
    model: Option<&str>,
    project_id: Option<&str>,
) -> AppResult<()> {
    let check =
        budget_repo::check_budget(pool, user_id, estimated_cost, task_type, always_high_cost)
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;

    if check.level != BudgetCheckLevel::Blocked {
        return Ok(());
    }

    let reason = check
        .message
        .clone()
        .unwrap_or_else(|| "Budget limit exceeded".to_string());
    let window_type = check.window_type.unwrap_or(BudgetWindowType::Daily);
    let limit = check.limit.unwrap_or(0.0);

    if let Err(error) = budget_repo::record_block_event(
        pool,
        user_id,
        BudgetBlockInput {
            window_type,
            limit,
            spent: check.spent,
            estimated_cost: check.estimated_cost,
            task_type,
            reason: &reason,
            model,
            project_id,
        },
    )
    .await
    {
        tracing::warn!(error = %error, "failed to record budget block event");
    }

    Err(AppError::BudgetExceeded(reason))
}

pub fn estimate_chat_cost(input_chars: i64, max_tokens: Option<i64>) -> f64 {
    let prompt_tokens = ((input_chars.max(0) + 3) / 4).max(1);
    let completion_tokens = max_tokens.unwrap_or(2048).clamp(0, 200_000);
    let estimated_tokens = prompt_tokens + completion_tokens;
    (estimated_tokens as f64 / 1000.0).max(0.01)
}
