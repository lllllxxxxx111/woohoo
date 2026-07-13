use anyhow::{anyhow, Result};
use chrono::{Datelike, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::budget_model::*;

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn today_start_utc() -> String {
    // Start of current day in UTC
    let now = Utc::now();
    let midnight = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
    midnight.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn month_start_utc() -> String {
    let now = Utc::now();
    let first = now.date_naive().with_day(1).unwrap();
    let midnight = first.and_hms_opt(0, 0, 0).unwrap();
    midnight.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

async fn ensure_default_settings(pool: &SqlitePool, user_id: &str) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO budget_settings (id, user_id, daily_limit, monthly_limit, warn_threshold, block_high_cost_only, high_cost_threshold, enabled, updated_at, created_at)
         VALUES (?, ?, 0, 0, 0.8, 1, 0.5, 1, ?, ?)
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

pub async fn get_budget_settings(pool: &SqlitePool, user_id: &str) -> Result<BudgetSettings> {
    ensure_default_settings(pool, user_id).await?;

    sqlx::query_as::<_, BudgetSettings>("SELECT * FROM budget_settings WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .map_err(|e| anyhow!(e))
}

pub async fn update_budget_settings(
    pool: &SqlitePool,
    user_id: &str,
    req: &UpdateBudgetSettingsReq,
) -> Result<BudgetSettings> {
    ensure_default_settings(pool, user_id).await?;

    let mut tx = pool.begin().await?;
    let now = now_rfc3339();

    if let Some(daily_limit) = req.daily_limit {
        if daily_limit < 0.0 {
            return Err(anyhow!("daily_limit must be non-negative"));
        }
        sqlx::query("UPDATE budget_settings SET daily_limit = ?, updated_at = ? WHERE user_id = ?")
            .bind(daily_limit)
            .bind(&now)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(monthly_limit) = req.monthly_limit {
        if monthly_limit < 0.0 {
            return Err(anyhow!("monthly_limit must be non-negative"));
        }
        sqlx::query("UPDATE budget_settings SET monthly_limit = ?, updated_at = ? WHERE user_id = ?")
            .bind(monthly_limit)
            .bind(&now)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(warn_threshold) = req.warn_threshold {
        if !(0.0..=1.0).contains(&warn_threshold) {
            return Err(anyhow!("warn_threshold must be between 0.0 and 1.0"));
        }
        sqlx::query("UPDATE budget_settings SET warn_threshold = ?, updated_at = ? WHERE user_id = ?")
            .bind(warn_threshold)
            .bind(&now)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(block_high_cost_only) = req.block_high_cost_only {
        sqlx::query("UPDATE budget_settings SET block_high_cost_only = ?, updated_at = ? WHERE user_id = ?")
            .bind(block_high_cost_only as i32)
            .bind(&now)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(high_cost_threshold) = req.high_cost_threshold {
        if high_cost_threshold < 0.0 {
            return Err(anyhow!("high_cost_threshold must be non-negative"));
        }
        sqlx::query("UPDATE budget_settings SET high_cost_threshold = ?, updated_at = ? WHERE user_id = ?")
            .bind(high_cost_threshold)
            .bind(&now)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(enabled) = req.enabled {
        sqlx::query("UPDATE budget_settings SET enabled = ?, updated_at = ? WHERE user_id = ?")
            .bind(enabled as i32)
            .bind(&now)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    get_budget_settings(pool, user_id).await
}

/// 查询用户在指定时间窗口内的积分消耗（从 credit_transactions 中统计 kind='spent' 的金额）
pub async fn get_spent_since(pool: &SqlitePool, user_id: &str, since_rfc3339: &str) -> Result<f64> {
    // Ensure credits row exists (user may have no transactions yet)
    super::repo::get_user_credits(pool, user_id).await.ok();

    let total: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM credit_transactions
         WHERE user_id = ? AND kind = ? AND created_at >= ?",
    )
    .bind(user_id)
    .bind(super::model::CreditTransactionKind::Spent.as_str())
    .bind(since_rfc3339)
    .fetch_one(pool)
    .await?;

    Ok(total.unwrap_or(0.0))
}

pub async fn get_daily_spent(pool: &SqlitePool, user_id: &str) -> Result<f64> {
    get_spent_since(pool, user_id, &today_start_utc()).await
}

pub async fn get_monthly_spent(pool: &SqlitePool, user_id: &str) -> Result<f64> {
    get_spent_since(pool, user_id, &month_start_utc()).await
}

/// 记录预算拦截事件
pub async fn record_block_event(
    pool: &SqlitePool,
    user_id: &str,
    window: BudgetWindow,
    limit_amount: f64,
    current_spent: f64,
    estimated_cost: f64,
    task_type: &str,
    reason: &str,
    model: Option<&str>,
    project_id: Option<&str>,
) -> Result<BudgetBlockEvent> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO budget_block_events (id, user_id, window_type, limit_amount, current_spent, estimated_cost, task_type, reason, model, project_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(window.as_str())
    .bind(limit_amount)
    .bind(current_spent)
    .bind(estimated_cost)
    .bind(task_type)
    .bind(reason)
    .bind(model)
    .bind(project_id)
    .bind(&now)
    .execute(pool)
    .await?;

    sqlx::query_as::<_, BudgetBlockEvent>("SELECT * FROM budget_block_events WHERE id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await
        .map_err(|e| anyhow!(e))
}

/// 查询最近的预算拦截事件
pub async fn list_recent_blocks(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
) -> Result<Vec<BudgetBlockEvent>> {
    let blocks = sqlx::query_as::<_, BudgetBlockEvent>(
        "SELECT * FROM budget_block_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(blocks)
}

/// 核心预算检查逻辑：在发起 AI 请求前调用
///
/// 返回 BudgetCheckResult：
/// - Ok: 可以执行（可能附带 warning）
/// - Warning: 接近阈值，可以执行但应告知用户
/// - Blocked: 超出预算，应拦截
pub async fn check_budget(
    pool: &SqlitePool,
    user_id: &str,
    estimated_cost: f64,
    task_type: &str,
) -> Result<BudgetCheckResult> {
    let settings = get_budget_settings(pool, user_id).await?;

    // 未启用预算控制，直接放行
    if !settings.enabled {
        return Ok(BudgetCheckResult {
            level: BudgetCheckLevel::Ok,
            window: None,
            message: None,
            estimated_cost,
            daily_spent: 0.0,
            monthly_spent: 0.0,
        });
    }

    let daily_spent = get_daily_spent(pool, user_id).await?;
    let monthly_spent = get_monthly_spent(pool, user_id).await?;

    // 判断是否是高成本任务
    let is_high_cost = estimated_cost >= settings.high_cost_threshold
        || matches!(task_type, "image_generation" | "video_generation");

    let mut level = BudgetCheckLevel::Ok;
    let mut block_window: Option<BudgetWindow> = None;
    let mut messages: Vec<String> = Vec::new();

    // 检查日预算
    if settings.daily_limit > 0.0 {
        let projected = daily_spent + estimated_cost;
        let ratio = daily_spent / settings.daily_limit;
        let projected_ratio = projected / settings.daily_limit;

        if projected_ratio > 1.0 {
            // 会超日预算
            if !settings.block_high_cost_only || is_high_cost {
                level = BudgetCheckLevel::Blocked;
                block_window = Some(BudgetWindow::Daily);
                messages.push(format!(
                    "日预算已超限：当前消耗 {:.2}，预算 {:.2}，本次预估 {:.2}，执行后将达到 {:.2}",
                    daily_spent, settings.daily_limit, estimated_cost, projected
                ));
            } else if level != BudgetCheckLevel::Blocked {
                level = BudgetCheckLevel::Warning;
                messages.push(format!(
                    "日预算即将超限：当前消耗 {:.2}/{:.2}（{:.0}%），本次预估 {:.2}",
                    daily_spent, settings.daily_limit, ratio * 100.0, estimated_cost
                ));
            }
        } else if ratio >= settings.warn_threshold && level == BudgetCheckLevel::Ok {
            level = BudgetCheckLevel::Warning;
            messages.push(format!(
                "日预算使用率 {:.0}%（{:.2}/{:.2}），请注意控制消耗",
                ratio * 100.0, daily_spent, settings.daily_limit
            ));
        }
    }

    // 检查月预算
    if settings.monthly_limit > 0.0 {
        let projected = monthly_spent + estimated_cost;
        let ratio = monthly_spent / settings.monthly_limit;
        let projected_ratio = projected / settings.monthly_limit;

        if projected_ratio > 1.0 {
            if !settings.block_high_cost_only || is_high_cost {
                level = BudgetCheckLevel::Blocked;
                if block_window.is_none() {
                    block_window = Some(BudgetWindow::Monthly);
                }
                messages.push(format!(
                    "月预算已超限：当前消耗 {:.2}，预算 {:.2}，本次预估 {:.2}，执行后将达到 {:.2}",
                    monthly_spent, settings.monthly_limit, estimated_cost, projected
                ));
            } else if level != BudgetCheckLevel::Blocked {
                level = BudgetCheckLevel::Warning;
                messages.push(format!(
                    "月预算即将超限：当前消耗 {:.2}/{:.2}（{:.0}%），本次预估 {:.2}",
                    monthly_spent, settings.monthly_limit, ratio * 100.0, estimated_cost
                ));
            }
        } else if ratio >= settings.warn_threshold && level == BudgetCheckLevel::Ok {
            level = BudgetCheckLevel::Warning;
            messages.push(format!(
                "月预算使用率 {:.0}%（{:.2}/{:.2}），请注意控制消耗",
                ratio * 100.0, monthly_spent, settings.monthly_limit
            ));
        }
    }

    let message = if messages.is_empty() {
        None
    } else {
        Some(messages.join("；"))
    };

    Ok(BudgetCheckResult {
        level,
        window: block_window,
        message,
        estimated_cost,
        daily_spent,
        monthly_spent,
    })
}

/// 构建完整预算状态（设置 + 当前用量 + 警告 + 最近拦截）
pub async fn get_budget_status(pool: &SqlitePool, user_id: &str) -> Result<BudgetStatus> {
    let settings = get_budget_settings(pool, user_id).await?;
    let daily_spent = get_daily_spent(pool, user_id).await?;
    let monthly_spent = get_monthly_spent(pool, user_id).await?;
    let recent_blocks = list_recent_blocks(pool, user_id, 10).await?;

    let daily = BudgetWindowStatus {
        window: "daily".to_string(),
        limit: settings.daily_limit,
        spent: daily_spent,
        remaining: if settings.daily_limit > 0.0 {
            (settings.daily_limit - daily_spent).max(0.0)
        } else {
            0.0
        },
        usage_ratio: if settings.daily_limit > 0.0 {
            (daily_spent / settings.daily_limit).min(1.0)
        } else {
            0.0
        },
        has_limit: settings.daily_limit > 0.0,
    };

    let monthly = BudgetWindowStatus {
        window: "monthly".to_string(),
        limit: settings.monthly_limit,
        spent: monthly_spent,
        remaining: if settings.monthly_limit > 0.0 {
            (settings.monthly_limit - monthly_spent).max(0.0)
        } else {
            0.0
        },
        usage_ratio: if settings.monthly_limit > 0.0 {
            (monthly_spent / settings.monthly_limit).min(1.0)
        } else {
            0.0
        },
        has_limit: settings.monthly_limit > 0.0,
    };

    let mut warnings = Vec::new();
    let mut level = BudgetCheckLevel::Ok;

    if settings.enabled {
        if daily.has_limit && daily.usage_ratio >= 1.0 {
            level = BudgetCheckLevel::Blocked;
            warnings.push(format!("日预算已用尽：{:.2}/{:.2}", daily_spent, settings.daily_limit));
        } else if daily.has_limit && daily.usage_ratio >= settings.warn_threshold {
            if matches!(level, BudgetCheckLevel::Ok) {
                level = BudgetCheckLevel::Warning;
            }
            warnings.push(format!(
                "日预算使用率 {:.0}%（{:.2}/{:.2}）",
                daily.usage_ratio * 100.0,
                daily_spent,
                settings.daily_limit
            ));
        }

        if monthly.has_limit && monthly.usage_ratio >= 1.0 {
            level = BudgetCheckLevel::Blocked;
            warnings.push(format!("月预算已用尽：{:.2}/{:.2}", monthly_spent, settings.monthly_limit));
        } else if monthly.has_limit && monthly.usage_ratio >= settings.warn_threshold {
            if matches!(level, BudgetCheckLevel::Ok) {
                level = BudgetCheckLevel::Warning;
            }
            warnings.push(format!(
                "月预算使用率 {:.0}%（{:.2}/{:.2}）",
                monthly.usage_ratio * 100.0,
                monthly_spent,
                settings.monthly_limit
            ));
        }
    }

    Ok(BudgetStatus {
        settings,
        daily,
        monthly,
        level,
        warnings,
        recent_blocks,
    })
}
