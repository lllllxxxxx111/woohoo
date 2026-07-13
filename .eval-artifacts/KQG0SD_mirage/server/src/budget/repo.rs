use anyhow::{anyhow, Result};
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::*;

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn today_key() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

fn month_key() -> String {
    Utc::now().format("%Y-%m").to_string()
}

/// 获取用户预算设置，不存在则返回默认值（不限制）
pub async fn get_budget_settings(pool: &SqlitePool, user_id: &str) -> Result<UserBudgetSettings> {
    let settings = sqlx::query_as::<_, UserBudgetSettings>(
        "SELECT * FROM user_budget_settings WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    match settings {
        Some(s) => Ok(s),
        None => {
            // 返回默认设置（不限预算）
            let now = now_rfc3339();
            Ok(UserBudgetSettings {
                id: String::new(),
                user_id: user_id.to_string(),
                daily_limit: None,
                monthly_limit: None,
                warning_threshold: 0.8,
                block_high_cost_over_budget: true,
                enabled: false,
                created_at: now.clone(),
                updated_at: now,
            })
        }
    }
}

/// 更新用户预算设置
pub async fn update_budget_settings(
    pool: &SqlitePool,
    user_id: &str,
    req: &UpdateBudgetSettingsReq,
) -> Result<UserBudgetSettings> {
    // 验证阈值
    if req.warning_threshold <= 0.0 || req.warning_threshold > 1.0 {
        return Err(anyhow!("warning_threshold 必须在 (0, 1] 范围内"));
    }
    if let Some(daily) = req.daily_limit {
        if daily < 0.0 {
            return Err(anyhow!("daily_limit 不能为负数"));
        }
    }
    if let Some(monthly) = req.monthly_limit {
        if monthly < 0.0 {
            return Err(anyhow!("monthly_limit 不能为负数"));
        }
    }

    let now = now_rfc3339();
    let existing = sqlx::query_as::<_, UserBudgetSettings>(
        "SELECT * FROM user_budget_settings WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    match existing {
        Some(_) => {
            sqlx::query(
                "UPDATE user_budget_settings
                 SET daily_limit = ?, monthly_limit = ?, warning_threshold = ?,
                     block_high_cost_over_budget = ?, enabled = ?, updated_at = ?
                 WHERE user_id = ?",
            )
            .bind(req.daily_limit)
            .bind(req.monthly_limit)
            .bind(req.warning_threshold)
            .bind(if req.block_high_cost_over_budget { 1 } else { 0 })
            .bind(if req.enabled { 1 } else { 0 })
            .bind(&now)
            .bind(user_id)
            .execute(pool)
            .await?;
        }
        None => {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO user_budget_settings
                 (id, user_id, daily_limit, monthly_limit, warning_threshold,
                  block_high_cost_over_budget, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(user_id)
            .bind(req.daily_limit)
            .bind(req.monthly_limit)
            .bind(req.warning_threshold)
            .bind(if req.block_high_cost_over_budget { 1 } else { 0 })
            .bind(if req.enabled { 1 } else { 0 })
            .bind(&now)
            .bind(&now)
            .execute(pool)
            .await?;
        }
    }

    get_budget_settings(pool, user_id).await
}

/// 计算指定周期内用户的积分消耗（从 credit_transactions 表中统计 spent）
async fn get_period_spent(pool: &SqlitePool, user_id: &str, period: BudgetPeriod) -> Result<f64> {
    let (start_str, end_str) = match period {
        BudgetPeriod::Daily => {
            let today = Utc::now().date_naive();
            let tomorrow = today + chrono::Duration::days(1);
            (
                format!("{}T00:00:00Z", today.format("%Y-%m-%d")),
                format!("{}T00:00:00Z", tomorrow.format("%Y-%m-%d")),
            )
        }
        BudgetPeriod::Monthly => {
            let now = Utc::now();
            let (y, m) = (now.year(), now.month());
            let start = format!("{}-{:02}-01T00:00:00Z", y, m);
            let next_month = if m == 12 {
                format!("{}-01-01T00:00:00Z", y + 1)
            } else {
                format!("{}-{:02}-01T00:00:00Z", y, m + 1)
            };
            (start, next_month)
        }
    };

    let spent: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0)
         FROM credit_transactions
         WHERE user_id = ? AND kind = 'spent'
           AND created_at >= ? AND created_at < ?",
    )
    .bind(user_id)
    .bind(&start_str)
    .bind(&end_str)
    .fetch_one(pool)
    .await?;

    Ok(spent.unwrap_or(0.0))
}

/// 构建周期预算状态
async fn build_period_status(
    pool: &SqlitePool,
    user_id: &str,
    period: BudgetPeriod,
    limit: Option<f64>,
    warning_threshold: f64,
) -> Result<BudgetPeriodStatus> {
    let spent = get_period_spent(pool, user_id, period).await?;
    let period_key = match period {
        BudgetPeriod::Daily => today_key(),
        BudgetPeriod::Monthly => month_key(),
    };

    let (usage_ratio, is_warning, is_over_budget, remaining) = match limit {
        Some(limit_val) if limit_val > 0.0 => {
            let ratio = spent / limit_val;
            let remaining_val = (limit_val - spent).max(0.0);
            (
                Some(ratio),
                ratio >= warning_threshold && ratio < 1.0,
                ratio >= 1.0,
                Some(remaining_val),
            )
        }
        _ => (None, false, false, None),
    };

    Ok(BudgetPeriodStatus {
        period_type: period.as_str().to_string(),
        period_key,
        limit,
        spent,
        usage_ratio,
        is_warning,
        is_over_budget,
        remaining,
    })
}

/// 获取用户完整的预算状态（含当日/当月消耗及建议）
pub async fn get_budget_status(pool: &SqlitePool, user_id: &str) -> Result<BudgetStatus> {
    let settings = get_budget_settings(pool, user_id).await?;

    let (daily, monthly) = if settings.enabled {
        let (d, m) = tokio::try_join!(
            build_period_status(
                pool,
                user_id,
                BudgetPeriod::Daily,
                settings.daily_limit,
                settings.warning_threshold
            ),
            build_period_status(
                pool,
                user_id,
                BudgetPeriod::Monthly,
                settings.monthly_limit,
                settings.warning_threshold
            )
        )?;
        (d, m)
    } else {
        let (d, m) = tokio::try_join!(
            build_period_status(pool, user_id, BudgetPeriod::Daily, None, settings.warning_threshold),
            build_period_status(pool, user_id, BudgetPeriod::Monthly, None, settings.warning_threshold),
        )?;
        (d, m)
    };

    let mut can_proceed = true;
    let mut warning_message: Option<String> = None;
    let mut block_reason: Option<String> = None;

    if settings.enabled {
        if daily.is_over_budget || monthly.is_over_budget {
            can_proceed = false;
            if daily.is_over_budget {
                block_reason = Some(format!(
                    "日预算已超限：已消耗 {:.2} / 限额 {:.2} 积分",
                    daily.spent,
                    daily.limit.unwrap_or(0.0)
                ));
            } else if monthly.is_over_budget {
                block_reason = Some(format!(
                    "月预算已超限：已消耗 {:.2} / 限额 {:.2} 积分",
                    monthly.spent,
                    monthly.limit.unwrap_or(0.0)
                ));
            }
        } else if daily.is_warning {
            warning_message = Some(format!(
                "日预算即将耗尽：已消耗 {:.2} / 限额 {:.2} 积分（{:.0}%）",
                daily.spent,
                daily.limit.unwrap_or(0.0),
                daily.usage_ratio.unwrap_or(0.0) * 100.0
            ));
        } else if monthly.is_warning {
            warning_message = Some(format!(
                "月预算即将耗尽：已消耗 {:.2} / 限额 {:.2} 积分（{:.0}%）",
                monthly.spent,
                monthly.limit.unwrap_or(0.0),
                monthly.usage_ratio.unwrap_or(0.0) * 100.0
            ));
        }
    }

    Ok(BudgetStatus {
        settings,
        daily,
        monthly,
        can_proceed,
        warning_message,
        block_reason,
    })
}

/// 检查预算并记录拦截事件（如果需要拦截）
pub async fn check_budget_for_operation(
    pool: &SqlitePool,
    user_id: &str,
    operation: &str,
    resource_kind: Option<&str>,
    estimated_cost: f64,
    model: Option<&str>,
    endpoint_id: Option<&str>,
) -> Result<BudgetCheckOutcome> {
    let status = get_budget_status(pool, user_id).await?;

    if !status.settings.enabled {
        return Ok(BudgetCheckOutcome::Allowed { status });
    }

    let is_high_cost = estimated_cost >= HIGH_COST_THRESHOLD;
    let block_high_cost = status.settings.block_high_cost_over_budget;

    // 判断是否需要拦截
    let mut should_block = false;
    let mut block_period: Option<BudgetPeriod> = None;

    if status.daily.is_over_budget {
        should_block = true;
        block_period = Some(BudgetPeriod::Daily);
    } else if status.monthly.is_over_budget {
        should_block = true;
        block_period = Some(BudgetPeriod::Monthly);
    } else if block_high_cost && is_high_cost {
        // 高成本任务：检查加上预估消耗后是否会超预算
        if let Some(limit) = status.daily.limit {
            if status.daily.spent + estimated_cost > limit {
                should_block = true;
                block_period = Some(BudgetPeriod::Daily);
            }
        }
        if !should_block {
            if let Some(limit) = status.monthly.limit {
                if status.monthly.spent + estimated_cost > limit {
                    should_block = true;
                    block_period = Some(BudgetPeriod::Monthly);
                }
            }
        }
    }

    if should_block {
        let period = block_period.unwrap_or(BudgetPeriod::Daily);
        let (period_key, limit_amount, current_spent) = match period {
            BudgetPeriod::Daily => (
                status.daily.period_key.clone(),
                status.daily.limit.unwrap_or(0.0),
                status.daily.spent,
            ),
            BudgetPeriod::Monthly => (
                status.monthly.period_key.clone(),
                status.monthly.limit.unwrap_or(0.0),
                status.monthly.spent,
            ),
        };

        let reason = format!(
            "{}预算限制：当前已消耗 {:.2} / 限额 {:.2}，本次预估消耗 {:.2} 积分{}",
            match period {
                BudgetPeriod::Daily => "日",
                BudgetPeriod::Monthly => "月",
            },
            current_spent,
            limit_amount,
            estimated_cost,
            if is_high_cost { "（高成本任务）" } else { "" }
        );

        // 记录拦截事件
        let event_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO budget_block_events
             (id, user_id, period_type, period_key, limit_amount, current_spent,
              estimated_cost, blocked_operation, blocked_resource_kind, reason, model, endpoint_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&event_id)
        .bind(user_id)
        .bind(period.as_str())
        .bind(&period_key)
        .bind(limit_amount)
        .bind(current_spent)
        .bind(estimated_cost)
        .bind(operation)
        .bind(resource_kind)
        .bind(&reason)
        .bind(model)
        .bind(endpoint_id)
        .bind(now_rfc3339())
        .execute(pool)
        .await?;

        return Ok(BudgetCheckOutcome::Blocked {
            status,
            reason,
            period,
            period_key,
            limit_amount,
            current_spent,
            estimated_cost,
        });
    }

    Ok(BudgetCheckOutcome::Allowed { status })
}

/// 高成本任务阈值（积分）：>= 5 积分视为高成本
pub const HIGH_COST_THRESHOLD: f64 = 5.0;

/// 预算检查结果
#[derive(Debug, Clone)]
pub enum BudgetCheckOutcome {
    Allowed {
        status: BudgetStatus,
    },
    Blocked {
        status: BudgetStatus,
        reason: String,
        period: BudgetPeriod,
        period_key: String,
        limit_amount: f64,
        current_spent: f64,
        estimated_cost: f64,
    },
}

impl BudgetCheckOutcome {
    pub fn is_allowed(&self) -> bool {
        matches!(self, BudgetCheckOutcome::Allowed { .. })
    }

    pub fn block_reason(&self) -> Option<&str> {
        match self {
            BudgetCheckOutcome::Blocked { reason, .. } => Some(reason.as_str()),
            _ => None,
        }
    }

    pub fn status(&self) -> &BudgetStatus {
        match self {
            BudgetCheckOutcome::Allowed { status } => status,
            BudgetCheckOutcome::Blocked { status, .. } => status,
        }
    }
}

/// 查询最近的预算拦截事件
pub async fn list_recent_block_events(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
) -> Result<Vec<BudgetBlockEvent>> {
    let events = sqlx::query_as::<_, BudgetBlockEvent>(
        "SELECT * FROM budget_block_events
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(events)
}
