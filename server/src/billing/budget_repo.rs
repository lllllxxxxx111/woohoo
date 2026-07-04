use anyhow::{anyhow, Result};
use chrono::{Datelike, SecondsFormat, TimeZone, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::budget_model::{
    BudgetBlockEvent, BudgetBlockInput, BudgetCheckLevel, BudgetCheckResult, BudgetSettings,
    BudgetStatus, BudgetWindowStatus, BudgetWindowType, UpdateBudgetSettingsInput,
};
use super::model::CreditTransactionKind;

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn normalize_limit(value: Option<f64>) -> Option<f64> {
    value.filter(|limit| limit.is_finite() && *limit > 0.0)
}

fn clamp_warning_threshold(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.8;
    }
    value.clamp(0.5, 1.0)
}

fn normalize_high_cost_threshold(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.5
    }
}

async fn ensure_budget_settings_row(pool: &SqlitePool, user_id: &str) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO budget_settings (
            id, user_id, daily_limit, monthly_limit, warning_threshold,
            block_high_cost_only, high_cost_threshold, enabled, created_at, updated_at
         )
         VALUES (?, ?, NULL, NULL, 0.8, 1, 0.5, 0, ?, ?)
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
    ensure_budget_settings_row(pool, user_id).await?;

    sqlx::query_as::<_, BudgetSettings>("SELECT * FROM budget_settings WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .map_err(|error| anyhow!(error))
}

pub async fn update_budget_settings(
    pool: &SqlitePool,
    user_id: &str,
    input: UpdateBudgetSettingsInput,
) -> Result<BudgetSettings> {
    ensure_budget_settings_row(pool, user_id).await?;

    let now = now_rfc3339();
    let daily_limit = normalize_limit(input.daily_limit);
    let monthly_limit = normalize_limit(input.monthly_limit);
    let warning_threshold = clamp_warning_threshold(input.warning_threshold);
    let high_cost_threshold = normalize_high_cost_threshold(input.high_cost_threshold);

    sqlx::query(
        "UPDATE budget_settings
         SET daily_limit = ?,
             monthly_limit = ?,
             warning_threshold = ?,
             block_high_cost_only = ?,
             high_cost_threshold = ?,
             enabled = ?,
             updated_at = ?
         WHERE user_id = ?",
    )
    .bind(daily_limit)
    .bind(monthly_limit)
    .bind(warning_threshold)
    .bind(input.block_high_cost_only)
    .bind(high_cost_threshold)
    .bind(input.enabled)
    .bind(&now)
    .bind(user_id)
    .execute(pool)
    .await?;

    get_budget_settings(pool, user_id).await
}

fn window_bounds(window_type: BudgetWindowType) -> Result<(String, String)> {
    let now = Utc::now();
    let start = match window_type {
        BudgetWindowType::Daily => Utc
            .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
            .single()
            .ok_or_else(|| anyhow!("invalid daily budget window"))?,
        BudgetWindowType::Monthly => Utc
            .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
            .single()
            .ok_or_else(|| anyhow!("invalid monthly budget window"))?,
    };
    let end = match window_type {
        BudgetWindowType::Daily => start + chrono::Duration::days(1),
        BudgetWindowType::Monthly => {
            let (year, month) = if now.month() == 12 {
                (now.year() + 1, 1)
            } else {
                (now.year(), now.month() + 1)
            };
            Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0)
                .single()
                .ok_or_else(|| anyhow!("invalid monthly budget end"))?
        }
    };

    Ok((
        start.to_rfc3339_opts(SecondsFormat::Secs, true),
        end.to_rfc3339_opts(SecondsFormat::Secs, true),
    ))
}

async fn spent_for_window(
    pool: &SqlitePool,
    user_id: &str,
    window_type: BudgetWindowType,
) -> Result<(f64, String, String)> {
    let (start, end) = window_bounds(window_type)?;
    let spent = sqlx::query_scalar::<_, f64>(
        "SELECT COALESCE(SUM(amount), 0)
         FROM credit_transactions
         WHERE user_id = ?
           AND kind = ?
           AND created_at >= ?
           AND created_at < ?",
    )
    .bind(user_id)
    .bind(CreditTransactionKind::Spent.as_str())
    .bind(&start)
    .bind(&end)
    .fetch_one(pool)
    .await?;

    Ok((spent, start, end))
}

fn build_window_status(
    window_type: BudgetWindowType,
    limit: Option<f64>,
    spent: f64,
    warning_threshold: f64,
    window_start: String,
    window_end: String,
) -> BudgetWindowStatus {
    let percent_used = limit.map(|limit| if limit > 0.0 { spent / limit } else { 0.0 });
    let remaining = limit.map(|limit| (limit - spent).max(0.0));
    let warning = percent_used
        .map(|percent| percent >= warning_threshold)
        .unwrap_or(false);
    let blocked = percent_used.map(|percent| percent >= 1.0).unwrap_or(false);

    BudgetWindowStatus {
        window_type,
        limit,
        spent,
        remaining,
        percent_used,
        warning,
        blocked,
        window_start,
        window_end,
    }
}

async fn get_window_status(
    pool: &SqlitePool,
    user_id: &str,
    settings: &BudgetSettings,
    window_type: BudgetWindowType,
) -> Result<BudgetWindowStatus> {
    let limit = match window_type {
        BudgetWindowType::Daily => settings.daily_limit,
        BudgetWindowType::Monthly => settings.monthly_limit,
    };
    let (spent, start, end) = spent_for_window(pool, user_id, window_type).await?;
    Ok(build_window_status(
        window_type,
        limit,
        spent,
        settings.warning_threshold,
        start,
        end,
    ))
}

pub async fn list_recent_block_events(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
) -> Result<Vec<BudgetBlockEvent>> {
    let limit = limit.clamp(1, 100);
    let events = sqlx::query_as::<_, BudgetBlockEvent>(
        "SELECT *
         FROM budget_block_events
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

pub async fn get_budget_status(pool: &SqlitePool, user_id: &str) -> Result<BudgetStatus> {
    let settings = get_budget_settings(pool, user_id).await?;
    let daily = get_window_status(pool, user_id, &settings, BudgetWindowType::Daily).await?;
    let monthly = get_window_status(pool, user_id, &settings, BudgetWindowType::Monthly).await?;
    let recent_blocks = list_recent_block_events(pool, user_id, 20).await?;

    let mut warnings = Vec::new();
    if settings.enabled {
        if daily.blocked {
            warnings.push("Daily budget limit has been reached.".to_string());
        } else if daily.warning {
            warnings.push("Daily budget usage is near the configured limit.".to_string());
        }

        if monthly.blocked {
            warnings.push("Monthly budget limit has been reached.".to_string());
        } else if monthly.warning {
            warnings.push("Monthly budget usage is near the configured limit.".to_string());
        }
    }

    let overall_level = if settings.enabled && (daily.blocked || monthly.blocked) {
        BudgetCheckLevel::Blocked
    } else if settings.enabled && (daily.warning || monthly.warning) {
        BudgetCheckLevel::Warning
    } else {
        BudgetCheckLevel::Ok
    };

    Ok(BudgetStatus {
        settings,
        daily,
        monthly,
        overall_level,
        warnings,
        recent_blocks,
    })
}

pub async fn check_budget(
    pool: &SqlitePool,
    user_id: &str,
    estimated_cost: f64,
    task_type: &str,
    always_high_cost: bool,
) -> Result<BudgetCheckResult> {
    let settings = get_budget_settings(pool, user_id).await?;
    let estimated_cost = estimated_cost.max(0.0);
    let is_high_cost = always_high_cost || estimated_cost >= settings.high_cost_threshold;

    if !settings.enabled {
        return Ok(BudgetCheckResult {
            level: BudgetCheckLevel::Ok,
            message: None,
            window_type: None,
            limit: None,
            spent: 0.0,
            estimated_cost,
        });
    }

    let daily = get_window_status(pool, user_id, &settings, BudgetWindowType::Daily).await?;
    let monthly = get_window_status(pool, user_id, &settings, BudgetWindowType::Monthly).await?;

    for status in [&daily, &monthly] {
        let Some(limit) = status.limit else {
            continue;
        };
        let projected = status.spent + estimated_cost;
        if projected > limit {
            if !settings.block_high_cost_only || is_high_cost {
                let message = format!(
                    "{} budget exceeded: spent {:.2}, estimated {:.2}, limit {:.2}",
                    status.window_type.as_str(),
                    status.spent,
                    estimated_cost,
                    limit
                );
                return Ok(BudgetCheckResult {
                    level: BudgetCheckLevel::Blocked,
                    message: Some(message),
                    window_type: Some(status.window_type),
                    limit: Some(limit),
                    spent: status.spent,
                    estimated_cost,
                });
            }
        }
    }

    for status in [&daily, &monthly] {
        let Some(limit) = status.limit else {
            continue;
        };
        let projected = status.spent + estimated_cost;
        if projected >= limit * settings.warning_threshold {
            let message = format!(
                "{} budget warning: projected {:.2} of {:.2} credits for {}",
                status.window_type.as_str(),
                projected,
                limit,
                task_type
            );
            return Ok(BudgetCheckResult {
                level: BudgetCheckLevel::Warning,
                message: Some(message),
                window_type: Some(status.window_type),
                limit: Some(limit),
                spent: status.spent,
                estimated_cost,
            });
        }
    }

    Ok(BudgetCheckResult {
        level: BudgetCheckLevel::Ok,
        message: None,
        window_type: None,
        limit: None,
        spent: 0.0,
        estimated_cost,
    })
}

pub async fn record_block_event(
    pool: &SqlitePool,
    user_id: &str,
    input: BudgetBlockInput<'_>,
) -> Result<BudgetBlockEvent> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO budget_block_events (
            id, user_id, window_type, limit_amount, spent_amount, estimated_cost,
            task_type, reason, model, project_id, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(input.window_type.as_str())
    .bind(input.limit)
    .bind(input.spent)
    .bind(input.estimated_cost)
    .bind(input.task_type)
    .bind(input.reason)
    .bind(input.model)
    .bind(input.project_id)
    .bind(&now)
    .execute(pool)
    .await?;

    sqlx::query_as::<_, BudgetBlockEvent>("SELECT * FROM budget_block_events WHERE id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await
        .map_err(|error| anyhow!(error))
}
