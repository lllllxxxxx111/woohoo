use anyhow::{anyhow, Result};
use chrono::{Datelike, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::budget_model::{
    BudgetEvent, BudgetEventKind, BudgetEventRow, BudgetGateDecision, BudgetOverlimitAction,
    BudgetSnapshot, BudgetWindow, UpsertBudgetSettingsReq, UserBudgetSettings,
    UserBudgetSettingsRow,
};

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 取当前日窗口起点（UTC 当日 00:00:00Z）
fn daily_window_start() -> String {
    let now = Utc::now();
    now.format("%Y-%m-%dT00:00:00Z").to_string()
}

/// 取当前月窗口起点（UTC 当月 1 号 00:00:00Z）
fn monthly_window_start() -> String {
    let now = Utc::now();
    format!("{:04}-{:02}-01T00:00:00Z", now.year(), now.month())
}

/// 确保用户预算记录存在（默认值：无日/月预算、block 策略、80% 阈值、启用）
async fn ensure_budget_row(pool: &SqlitePool, user_id: &str) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();
    sqlx::query(
        "INSERT INTO user_budget_settings
             (id, user_id, daily_limit, monthly_limit, warning_threshold_pct, overlimit_action, enabled, updated_at, created_at)
         VALUES (?, ?, NULL, NULL, 80, 'block', 1, ?, ?)
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

pub async fn get_budget_settings(
    pool: &SqlitePool,
    user_id: &str,
) -> Result<UserBudgetSettings> {
    ensure_budget_row(pool, user_id).await?;
    let row = sqlx::query_as::<_, UserBudgetSettingsRow>(
        "SELECT * FROM user_budget_settings WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

pub async fn upsert_budget_settings(
    pool: &SqlitePool,
    user_id: &str,
    req: &UpsertBudgetSettingsReq,
) -> Result<UserBudgetSettings> {
    ensure_budget_row(pool, user_id).await?;
    let now = now_rfc3339();

    // 校验
    if let Some(limit) = req.daily_limit {
        if limit < 0.0 {
            return Err(anyhow!("daily_limit must be >= 0"));
        }
    }
    if let Some(limit) = req.monthly_limit {
        if limit < 0.0 {
            return Err(anyhow!("monthly_limit must be >= 0"));
        }
    }
    if let Some(pct) = req.warning_threshold_pct {
        if !(1..=100).contains(&pct) {
            return Err(anyhow!("warning_threshold_pct must be between 1 and 100"));
        }
    }
    if let Some(action) = &req.overlimit_action {
        let _ = BudgetOverlimitAction::from_str_loose(action);
    }

    // 始终刷新 updated_at
    sqlx::query("UPDATE user_budget_settings SET updated_at = ? WHERE user_id = ?")
        .bind(&now)
        .bind(user_id)
        .execute(pool)
        .await?;

    if let Some(daily) = req.daily_limit {
        let value: Option<f64> = if daily == 0.0 { None } else { Some(daily) };
        sqlx::query("UPDATE user_budget_settings SET daily_limit = ? WHERE user_id = ?")
            .bind(value)
            .bind(user_id)
            .execute(pool)
            .await?;
    }
    if let Some(monthly) = req.monthly_limit {
        let value: Option<f64> = if monthly == 0.0 { None } else { Some(monthly) };
        sqlx::query("UPDATE user_budget_settings SET monthly_limit = ? WHERE user_id = ?")
            .bind(value)
            .bind(user_id)
            .execute(pool)
            .await?;
    }
    if let Some(pct) = req.warning_threshold_pct {
        sqlx::query(
            "UPDATE user_budget_settings SET warning_threshold_pct = ? WHERE user_id = ?",
        )
        .bind(pct)
        .bind(user_id)
        .execute(pool)
        .await?;
    }
    if let Some(action) = &req.overlimit_action {
        let normalized = BudgetOverlimitAction::from_str_loose(action).as_str();
        sqlx::query("UPDATE user_budget_settings SET overlimit_action = ? WHERE user_id = ?")
            .bind(normalized)
            .bind(user_id)
            .execute(pool)
            .await?;
    }
    if let Some(enabled) = req.enabled {
        sqlx::query("UPDATE user_budget_settings SET enabled = ? WHERE user_id = ?")
            .bind(if enabled { 1_i64 } else { 0 })
            .bind(user_id)
            .execute(pool)
            .await?;
    }

    get_budget_settings(pool, user_id).await
}

/// 计算用户在指定窗口内已消耗的积分
pub async fn fetch_spent_in_window(
    pool: &SqlitePool,
    user_id: &str,
    window: BudgetWindow,
) -> Result<f64> {
    let start = match window {
        BudgetWindow::Daily => daily_window_start(),
        BudgetWindow::Monthly => monthly_window_start(),
    };
    // 注意：credit_transactions 中 spent 是 amount 为正；refund 也用相同 amount 但 kind=refund
    // 真实消耗 = 所有 spent 之和 - 该窗口内针对这些 spent 的 refund 之和
    let spent_sum: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM credit_transactions
         WHERE user_id = ? AND kind = 'spent' AND created_at >= ?",
    )
    .bind(user_id)
    .bind(&start)
    .fetch_one(pool)
    .await?;

    let refund_sum: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM credit_transactions
         WHERE user_id = ? AND kind = 'refund' AND created_at >= ?",
    )
    .bind(user_id)
    .bind(&start)
    .fetch_one(pool)
    .await?;

    let net = (spent_sum.unwrap_or(0.0)) - (refund_sum.unwrap_or(0.0));
    Ok(net.max(0.0))
}

pub async fn build_snapshot(pool: &SqlitePool, user_id: &str) -> Result<BudgetSnapshot> {
    let settings = get_budget_settings(pool, user_id).await?;
    let (daily_spent, monthly_spent) = tokio::try_join!(
        fetch_spent_in_window(pool, user_id, BudgetWindow::Daily),
        fetch_spent_in_window(pool, user_id, BudgetWindow::Monthly),
    )?;

    let pct = |spent: f64, limit: Option<f64>| -> Option<f64> {
        limit.filter(|&l| l > 0.0).map(|l| spent / l * 100.0)
    };
    let remaining = |spent: f64, limit: Option<f64>| -> Option<f64> {
        limit.filter(|&l| l > 0.0).map(|l| (l - spent).max(0.0))
    };
    let exceeded = |spent: f64, limit: Option<f64>| -> bool {
        matches!(limit, Some(l) if l > 0.0 && spent >= l)
    };
    let warning = |spent: f64, limit: Option<f64>, threshold: i64| -> bool {
        match limit {
            Some(l) if l > 0.0 => spent / l * 100.0 >= threshold as f64 && spent < l,
            _ => false,
        }
    };

    Ok(BudgetSnapshot {
        daily_used_pct: pct(daily_spent, settings.daily_limit),
        monthly_used_pct: pct(monthly_spent, settings.monthly_limit),
        daily_remaining: remaining(daily_spent, settings.daily_limit),
        monthly_remaining: remaining(monthly_spent, settings.monthly_limit),
        daily_exceeded: exceeded(daily_spent, settings.daily_limit),
        monthly_exceeded: exceeded(monthly_spent, settings.monthly_limit),
        daily_warning: warning(
            daily_spent,
            settings.daily_limit,
            settings.warning_threshold_pct,
        ),
        monthly_warning: warning(
            monthly_spent,
            settings.monthly_limit,
            settings.warning_threshold_pct,
        ),
        settings,
        daily_spent,
        monthly_spent,
    })
}

/// 记录预算事件
pub async fn record_event(
    pool: &SqlitePool,
    user_id: &str,
    kind: BudgetEventKind,
    window: BudgetWindow,
    spent_amount: f64,
    limit_amount: Option<f64>,
    estimated_cost: Option<f64>,
    resource_kind: Option<&str>,
    reason: &str,
    ref_type: Option<&str>,
    ref_id: Option<&str>,
) -> Result<BudgetEvent> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();
    sqlx::query(
        "INSERT INTO budget_events
             (id, user_id, kind, window, spent_amount, limit_amount, estimated_cost,
              resource_kind, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(kind.as_str())
    .bind(window.as_str())
    .bind(spent_amount)
    .bind(limit_amount)
    .bind(estimated_cost)
    .bind(resource_kind)
    .bind(reason)
    .bind(ref_type)
    .bind(ref_id)
    .bind(&now)
    .execute(pool)
    .await?;

    // 同步更新 last_warning_at 标记（去重用）
    if matches!(kind, BudgetEventKind::Warning) {
        sqlx::query(
            "UPDATE user_budget_settings
             SET last_warning_at = ?, last_warning_kind = ?
             WHERE user_id = ?",
        )
        .bind(&now)
        .bind(window.as_str())
        .bind(user_id)
        .execute(pool)
        .await?;
    }

    // 取回刚插入的行
    let row = sqlx::query_as::<_, BudgetEventRow>(
        "SELECT * FROM budget_events WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

/// 列出某用户最近的预算事件（默认最近 50 条）
pub async fn list_events(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
) -> Result<Vec<BudgetEvent>> {
    let rows = sqlx::query_as::<_, BudgetEventRow>(
        "SELECT * FROM budget_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(BudgetEvent::from).collect())
}

/// 核心闸门：检查一次任务是否能通过预算
///
/// 返回决策（Allow / Warn / Block）。当决策为 Block 时，调用方应直接拒绝该任务；
/// 当决策为 Warn 时，调用方可继续执行但通常会返回提示让前端展示。
pub async fn check_gate(
    pool: &SqlitePool,
    user_id: &str,
    estimated_cost: Option<f64>,
    resource_kind: Option<&str>,
    ref_type: Option<&str>,
    ref_id: Option<&str>,
) -> Result<BudgetGateDecision> {
    let snap = build_snapshot(pool, user_id).await?;

    // 未启用或完全无预算配置，直接放行
    if !snap.settings.enabled
        || (snap.settings.daily_limit.is_none() && snap.settings.monthly_limit.is_none())
    {
        return Ok(BudgetGateDecision::Allow);
    }

    let action = BudgetOverlimitAction::from_str_loose(&snap.settings.overlimit_action);

    // 先检查已超限
    if snap.daily_exceeded {
        let event = record_event(
            pool,
            user_id,
            BudgetEventKind::Blocked,
            BudgetWindow::Daily,
            snap.daily_spent,
            snap.settings.daily_limit,
            estimated_cost,
            resource_kind,
            "daily budget already exceeded",
            ref_type,
            ref_id,
        )
        .await?;
        let _ = event;
        return Ok(BudgetGateDecision::Block {
            window: "daily".into(),
            spent_amount: snap.daily_spent,
            limit_amount: snap.settings.daily_limit.unwrap_or(0.0),
            estimated_cost,
            used_pct: snap.daily_used_pct.unwrap_or(100.0),
            message: format!(
                "今日预算已超限（已用 {:.2} / 上限 {:.2}），请调整日预算或明日再试",
                snap.daily_spent,
                snap.settings.daily_limit.unwrap_or(0.0)
            ),
        });
    }
    if snap.monthly_exceeded {
        let _ = record_event(
            pool,
            user_id,
            BudgetEventKind::Blocked,
            BudgetWindow::Monthly,
            snap.monthly_spent,
            snap.settings.monthly_limit,
            estimated_cost,
            resource_kind,
            "monthly budget already exceeded",
            ref_type,
            ref_id,
        )
        .await?;
        return Ok(BudgetGateDecision::Block {
            window: "monthly".into(),
            spent_amount: snap.monthly_spent,
            limit_amount: snap.settings.monthly_limit.unwrap_or(0.0),
            estimated_cost,
            used_pct: snap.monthly_used_pct.unwrap_or(100.0),
            message: format!(
                "本月预算已超限（已用 {:.2} / 上限 {:.2}），请调整月预算或下月再试",
                snap.monthly_spent,
                snap.settings.monthly_limit.unwrap_or(0.0)
            ),
        });
    }

    // 估算本次之后是否会超限
    if let Some(cost) = estimated_cost {
        if let Some(limit) = snap.settings.daily_limit.filter(|&l| l > 0.0) {
            let projected = snap.daily_spent + cost;
            if projected > limit && matches!(action, BudgetOverlimitAction::Block) {
                let _ = record_event(
                    pool,
                    user_id,
                    BudgetEventKind::Blocked,
                    BudgetWindow::Daily,
                    snap.daily_spent,
                    Some(limit),
                    Some(cost),
                    resource_kind,
                    "would exceed daily budget",
                    ref_type,
                    ref_id,
                )
                .await?;
                return Ok(BudgetGateDecision::Block {
                    window: "daily".into(),
                    spent_amount: snap.daily_spent,
                    limit_amount: limit,
                    estimated_cost: Some(cost),
                    used_pct: snap.daily_used_pct.unwrap_or(0.0),
                    message: format!(
                        "本次任务预计消耗 {:.2} 积分，将使今日预算超限（当前 {:.2} / 上限 {:.2}）",
                        cost, snap.daily_spent, limit
                    ),
                });
            }
        }
        if let Some(limit) = snap.settings.monthly_limit.filter(|&l| l > 0.0) {
            let projected = snap.monthly_spent + cost;
            if projected > limit && matches!(action, BudgetOverlimitAction::Block) {
                let _ = record_event(
                    pool,
                    user_id,
                    BudgetEventKind::Blocked,
                    BudgetWindow::Monthly,
                    snap.monthly_spent,
                    Some(limit),
                    Some(cost),
                    resource_kind,
                    "would exceed monthly budget",
                    ref_type,
                    ref_id,
                )
                .await?;
                return Ok(BudgetGateDecision::Block {
                    window: "monthly".into(),
                    spent_amount: snap.monthly_spent,
                    limit_amount: limit,
                    estimated_cost: Some(cost),
                    used_pct: snap.monthly_used_pct.unwrap_or(0.0),
                    message: format!(
                        "本次任务预计消耗 {:.2} 积分，将使本月预算超限（当前 {:.2} / 上限 {:.2}）",
                        cost, snap.monthly_spent, limit
                    ),
                });
            }
        }
    }

    // 检查是否进入警告阈值
    if snap.daily_warning {
        // 简单去重：同一天的警告只记一次
        let today = daily_window_start();
        let should_emit = match &snap.settings.last_warning_at {
            Some(last) => last < &today || snap.settings.last_warning_kind.as_deref() != Some("daily"),
            None => true,
        };
        if should_emit {
            let _ = record_event(
                pool,
                user_id,
                BudgetEventKind::Warning,
                BudgetWindow::Daily,
                snap.daily_spent,
                snap.settings.daily_limit,
                estimated_cost,
                resource_kind,
                "daily budget threshold reached",
                ref_type,
                ref_id,
            )
            .await?;
        }
        return Ok(BudgetGateDecision::Warn {
            window: "daily".into(),
            spent_amount: snap.daily_spent,
            limit_amount: snap.settings.daily_limit.unwrap_or(0.0),
            used_pct: snap.daily_used_pct.unwrap_or(0.0),
            message: format!(
                "今日预算已使用 {:.1}%（{:.2} / {:.2}），请注意控制消耗",
                snap.daily_used_pct.unwrap_or(0.0),
                snap.daily_spent,
                snap.settings.daily_limit.unwrap_or(0.0)
            ),
        });
    }
    if snap.monthly_warning {
        let month_start = monthly_window_start();
        let should_emit = match &snap.settings.last_warning_at {
            Some(last) => {
                last < &month_start || snap.settings.last_warning_kind.as_deref() != Some("monthly")
            }
            None => true,
        };
        if should_emit {
            let _ = record_event(
                pool,
                user_id,
                BudgetEventKind::Warning,
                BudgetWindow::Monthly,
                snap.monthly_spent,
                snap.settings.monthly_limit,
                estimated_cost,
                resource_kind,
                "monthly budget threshold reached",
                ref_type,
                ref_id,
            )
            .await?;
        }
        return Ok(BudgetGateDecision::Warn {
            window: "monthly".into(),
            spent_amount: snap.monthly_spent,
            limit_amount: snap.settings.monthly_limit.unwrap_or(0.0),
            used_pct: snap.monthly_used_pct.unwrap_or(0.0),
            message: format!(
                "本月预算已使用 {:.1}%（{:.2} / {:.2}），请注意控制消耗",
                snap.monthly_used_pct.unwrap_or(0.0),
                snap.monthly_spent,
                snap.settings.monthly_limit.unwrap_or(0.0)
            ),
        });
    }

    Ok(BudgetGateDecision::Allow)
}
