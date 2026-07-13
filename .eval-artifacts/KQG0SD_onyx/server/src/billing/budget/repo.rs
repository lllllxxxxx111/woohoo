use anyhow::{anyhow, Result};
use chrono::{Datelike, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::{BudgetBlock, BudgetCheckResult, BudgetStatus, UpdateBudgetConfigInput, UserBudgetConfig};
use crate::error::AppError;

/// 1000 token = 1 积分（与前端一致）
const TOKENS_PER_CREDIT: f64 = 1000.0;

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 确保用户有预算配置行（不存在则创建默认配置）
pub async fn ensure_user_budget_config(pool: &SqlitePool, user_id: &str) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO user_budget_configs (id, user_id, daily_credit_limit, monthly_credit_limit, warn_ratio, is_enabled, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 0.8, 1, ?, ?)
         ON CONFLICT(user_id) DO NOTHING",
    )
    .bind(&id)
    .bind(user_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}

/// 获取用户预算配置
pub async fn get_user_budget_config(pool: &SqlitePool, user_id: &str) -> Result<UserBudgetConfig> {
    ensure_user_budget_config(pool, user_id).await?;

    sqlx::query_as::<_, UserBudgetConfig>(
        "SELECT * FROM user_budget_configs WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(|error| anyhow!(error))
}

/// 更新用户预算配置
pub async fn update_user_budget_config(
    pool: &SqlitePool,
    user_id: &str,
    input: &UpdateBudgetConfigInput,
) -> Result<UserBudgetConfig> {
    // 验证输入
    if let Some(warn_ratio) = input.warn_ratio {
        if warn_ratio < 0.0 || warn_ratio > 1.0 {
            return Err(anyhow!("warn_ratio must be between 0 and 1"));
        }
    }

    if let Some(daily_limit) = input.daily_credit_limit {
        if daily_limit < 0.0 {
            return Err(anyhow!("daily_credit_limit cannot be negative"));
        }
    }

    if let Some(monthly_limit) = input.monthly_credit_limit {
        if monthly_limit < 0.0 {
            return Err(anyhow!("monthly_credit_limit cannot be negative"));
        }
    }

    ensure_user_budget_config(pool, user_id).await?;

    let now = now_rfc3339();
    let mut tx = pool.begin().await?;

    // 动态构建更新语句
    let mut updates = Vec::new();
    if let Some(daily_limit) = input.daily_credit_limit {
        updates.push(format!("daily_credit_limit = {}", daily_limit));
    }
    if let Some(monthly_limit) = input.monthly_credit_limit {
        updates.push(format!("monthly_credit_limit = {}", monthly_limit));
    }
    if let Some(warn_ratio) = input.warn_ratio {
        updates.push(format!("warn_ratio = {}", warn_ratio));
    }
    if let Some(is_enabled) = input.is_enabled {
        updates.push(format!("is_enabled = {}", if is_enabled { 1 } else { 0 }));
    }
    updates.push(format!("updated_at = '{}'", now));

    let update_sql = format!(
        "UPDATE user_budget_configs SET {} WHERE user_id = ?",
        updates.join(", ")
    );

    sqlx::query(&update_sql)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    get_user_budget_config(pool, user_id).await
}

/// 计算今日消耗积分
async fn get_daily_usage(pool: &SqlitePool, user_id: &str) -> Result<f64> {
    let now = Utc::now();
    let start_of_day = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
    let start_str = start_of_day.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let total_tokens: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(total_tokens), 0) FROM ai_usage_events 
         WHERE user_id = ? AND created_at >= ? AND status = 'success'",
    )
    .bind(user_id)
    .bind(&start_str)
    .fetch_one(pool)
    .await?;

    Ok((total_tokens.unwrap_or(0) as f64) / TOKENS_PER_CREDIT)
}

/// 计算本月消耗积分
async fn get_monthly_usage(pool: &SqlitePool, user_id: &str) -> Result<f64> {
    let now = Utc::now();
    let start_of_month = now.date_naive().with_day(1).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc();
    let start_str = start_of_month.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let total_tokens: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(total_tokens), 0) FROM ai_usage_events 
         WHERE user_id = ? AND created_at >= ? AND status = 'success'",
    )
    .bind(user_id)
    .bind(&start_str)
    .fetch_one(pool)
    .await?;

    Ok((total_tokens.unwrap_or(0) as f64) / TOKENS_PER_CREDIT)
}

/// 获取预算状态（包含配置和消耗数据）
pub async fn get_budget_status(pool: &SqlitePool, user_id: &str) -> Result<BudgetStatus> {
    let config = get_user_budget_config(pool, user_id).await?;
    let daily_usage = get_daily_usage(pool, user_id).await?;
    let monthly_usage = get_monthly_usage(pool, user_id).await?;

    // 计算使用率
    let daily_usage_ratio = match config.daily_credit_limit {
        Some(limit) if limit > 0.0 => (daily_usage / limit).min(1.0),
        _ => 0.0,
    };

    let monthly_usage_ratio = match config.monthly_credit_limit {
        Some(limit) if limit > 0.0 => (monthly_usage / limit).min(1.0),
        _ => 0.0,
    };

    // 计算预警和超限状态
    let is_daily_warning = config.daily_credit_limit.is_some() 
        && config.daily_credit_limit.unwrap() > 0.0 
        && daily_usage_ratio >= config.warn_ratio 
        && daily_usage_ratio < 1.0;

    let is_monthly_warning = config.monthly_credit_limit.is_some() 
        && config.monthly_credit_limit.unwrap() > 0.0 
        && monthly_usage_ratio >= config.warn_ratio 
        && monthly_usage_ratio < 1.0;

    let is_daily_exceeded = config.daily_credit_limit.is_some() 
        && config.daily_credit_limit.unwrap() > 0.0 
        && daily_usage_ratio >= 1.0;

    let is_monthly_exceeded = config.monthly_credit_limit.is_some() 
        && config.monthly_credit_limit.unwrap() > 0.0 
        && monthly_usage_ratio >= 1.0;

    Ok(BudgetStatus {
        config,
        daily_usage,
        monthly_usage,
        daily_usage_ratio,
        monthly_usage_ratio,
        is_daily_warning,
        is_monthly_warning,
        is_daily_exceeded,
        is_monthly_exceeded,
        has_warning: is_daily_warning || is_monthly_warning,
        has_exceeded: is_daily_exceeded || is_monthly_exceeded,
    })
}

/// 检查预算是否允许操作
pub async fn check_budget(pool: &SqlitePool, user_id: &str) -> Result<BudgetCheckResult> {
    let status = get_budget_status(pool, user_id).await?;

    // 如果预算功能未启用，直接允许
    if !status.config.is_enabled {
        return Ok(BudgetCheckResult {
            allowed: true,
            reason: None,
            daily_usage: status.daily_usage,
            monthly_usage: status.monthly_usage,
            daily_limit: status.config.daily_credit_limit,
            monthly_limit: status.config.monthly_credit_limit,
        });
    }

    // 检查日预算超限
    if status.is_daily_exceeded {
        return Ok(BudgetCheckResult {
            allowed: false,
            reason: Some("daily_exceeded".to_string()),
            daily_usage: status.daily_usage,
            monthly_usage: status.monthly_usage,
            daily_limit: status.config.daily_credit_limit,
            monthly_limit: status.config.monthly_credit_limit,
        });
    }

    // 检查月预算超限
    if status.is_monthly_exceeded {
        return Ok(BudgetCheckResult {
            allowed: false,
            reason: Some("monthly_exceeded".to_string()),
            daily_usage: status.daily_usage,
            monthly_usage: status.monthly_usage,
            daily_limit: status.config.daily_credit_limit,
            monthly_limit: status.config.monthly_credit_limit,
        });
    }

    Ok(BudgetCheckResult {
        allowed: true,
        reason: None,
        daily_usage: status.daily_usage,
        monthly_usage: status.monthly_usage,
        daily_limit: status.config.daily_credit_limit,
        monthly_limit: status.config.monthly_credit_limit,
    })
}

/// 记录预算拦截事件
pub async fn record_budget_block(
    pool: &SqlitePool,
    user_id: &str,
    operation: &str,
    reason: &str,
    current_usage: f64,
    limit_value: f64,
    request_details: Option<&str>,
) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO budget_blocks (id, user_id, operation, reason, current_usage, limit_value, request_details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(operation)
    .bind(reason)
    .bind(current_usage)
    .bind(limit_value)
    .bind(request_details)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}

/// 获取最近的预算拦截记录
pub async fn get_recent_budget_blocks(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
) -> Result<Vec<BudgetBlock>> {
    let blocks = sqlx::query_as::<_, BudgetBlock>(
        "SELECT * FROM budget_blocks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(blocks)
}

/// 转换预算检查错误为 AppError
pub fn budget_exceeded_error(check_result: &BudgetCheckResult) -> AppError {
    let reason = check_result.reason.as_deref().unwrap_or("unknown");
    let limit = match reason {
        "daily_exceeded" => check_result.daily_limit.unwrap_or(0.0),
        "monthly_exceeded" => check_result.monthly_limit.unwrap_or(0.0),
        _ => 0.0,
    };
    let usage = match reason {
        "daily_exceeded" => check_result.daily_usage,
        "monthly_exceeded" => check_result.monthly_usage,
        _ => 0.0,
    };

    let message = format!(
        "预算超限：{} 当前已使用 {:.2} 积分，上限 {:.2} 积分。请调整预算或等待周期重置。",
        if reason == "daily_exceeded" { "日预算" } else { "月预算" },
        usage,
        limit
    );

    AppError::BudgetExceeded(message)
}
