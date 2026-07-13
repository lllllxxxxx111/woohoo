//! 预算执行辅助函数
//!
//! 在 AI 请求处理前调用，统一处理预算检查、拦截事件记录和错误返回。
use sqlx::SqlitePool;

use crate::error::AppError;

use super::budget_model::{BudgetCheckLevel, BudgetWindow};
use super::budget_repo;

/// 任务类型标签，用于预算拦截记录
pub const TASK_TYPE_CHAT: &str = "chat";
pub const TASK_TYPE_STREAM: &str = "stream";
pub const TASK_TYPE_TASK: &str = "task";
pub const TASK_TYPE_IMAGE: &str = "image_generation";
pub const TASK_TYPE_VIDEO: &str = "video_generation";

/// 估算一次对话请求的积分消耗
///
/// 粗略估算：中文约 1.5 chars/token，英文约 4 chars/token，取平均值 2 chars/token
/// 再加上预估的输出 tokens（取输入的 1.5 倍作为对话场景的估算）
/// 1 credit = 1000 tokens
pub fn estimate_chat_cost(input_chars: i64, max_tokens: Option<i64>) -> f64 {
    let input_tokens_est = (input_chars as f64) / 2.0;
    let output_tokens_est = match max_tokens {
        Some(mt) if mt > 0 => mt as f64,
        _ => input_tokens_est * 1.5, // 假设输出约为输入的 1.5 倍
    };
    let total_tokens = input_tokens_est + output_tokens_est;
    // TOKENS_PER_CREDIT = 1000, defined in frontend credits.ts
    let credits = total_tokens / 1000.0;
    // 最低消费 0.01 积分
    credits.max(0.01)
}

/// 执行预算检查，如果被拦截则记录事件并返回 BudgetExceeded 错误。
///
/// 用法：在 AI 请求处理最开始调用，例如：
/// ```ignore
/// enforce_budget(&state.db, &user_id, estimated_cost, TASK_TYPE_IMAGE, Some(&model), project_id).await?;
/// ```
pub async fn enforce_budget(
    pool: &SqlitePool,
    user_id: &str,
    estimated_cost: f64,
    task_type: &str,
    model: Option<&str>,
    project_id: Option<&str>,
) -> Result<(), AppError> {
    let check = budget_repo::check_budget(pool, user_id, estimated_cost, task_type)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    match check.level {
        BudgetCheckLevel::Blocked => {
            let window = check.window.unwrap_or(BudgetWindow::Daily);
            let (limit, spent) = match window {
                BudgetWindow::Daily => {
                    let daily_limit = budget_repo::get_budget_settings(pool, user_id)
                        .await
                        .map(|s| s.daily_limit)
                        .unwrap_or(0.0);
                    (daily_limit, check.daily_spent)
                }
                BudgetWindow::Monthly => {
                    let monthly_limit = budget_repo::get_budget_settings(pool, user_id)
                        .await
                        .map(|s| s.monthly_limit)
                        .unwrap_or(0.0);
                    (monthly_limit, check.monthly_spent)
                }
            };

            // 记录拦截事件（不阻塞返回，失败仅记录日志）
            if let Err(e) = budget_repo::record_block_event(
                pool,
                user_id,
                window,
                limit,
                spent,
                estimated_cost,
                task_type,
                check.message.as_deref().unwrap_or("预算超限"),
                model,
                project_id,
            )
            .await
            {
                tracing::warn!(error = %e, "failed to record budget block event");
            }

            let window_label = match &check.window {
                Some(BudgetWindow::Daily) => "日",
                Some(BudgetWindow::Monthly) => "月",
                None => "预算",
            };
            let reason = check.message.unwrap_or_else(|| format!("{}预算已超限", window_label));
            Err(AppError::BudgetExceeded(reason))
        }
        BudgetCheckLevel::Warning | BudgetCheckLevel::Ok => Ok(()),
    }
}
