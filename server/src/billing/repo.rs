// TODO: f64 存储金额存在浮点精度问题，长期运行可能导致余额与流水不一致
// 应迁移为整数（分/毫单位）或 rust_decimal，需要同步修改数据库 schema
use anyhow::{anyhow, Result};
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::{CreditTransaction, UserCredits};

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

async fn ensure_user_credits_row(pool: &SqlitePool, user_id: &str) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO user_credits (id, user_id, balance, total_earned, total_spent, updated_at, created_at)
         VALUES (?, ?, 100, 0, 0, ?, ?)
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

pub async fn get_user_credits(pool: &SqlitePool, user_id: &str) -> Result<UserCredits> {
    ensure_user_credits_row(pool, user_id).await?;

    sqlx::query_as::<_, UserCredits>("SELECT * FROM user_credits WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .map_err(|error| anyhow!(error))
}

pub async fn check_and_deduct(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
    ref_type: Option<&str>,
    ref_id: Option<&str>,
) -> Result<f64> {
    if amount <= 0.0 {
        return Err(anyhow!("amount must be positive"));
    }

    ensure_user_credits_row(pool, user_id).await?;

    let mut tx = pool.begin().await?;
    let now = now_rfc3339();

    let result = sqlx::query(
        "UPDATE user_credits
         SET balance = balance - ?,
             total_spent = total_spent + ?,
             updated_at = ?
         WHERE user_id = ? AND balance >= ?",
    )
    .bind(amount)
    .bind(amount)
    .bind(&now)
    .bind(user_id)
    .bind(amount)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        let current =
            sqlx::query_scalar::<_, f64>("SELECT balance FROM user_credits WHERE user_id = ?")
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await
                .unwrap_or(0.0);

        tx.rollback().await?;
        return Err(anyhow!(
            "insufficient credits: current {}, required {}",
            current,
            amount
        ));
    }

    let new_balance =
        sqlx::query_scalar::<_, f64>("SELECT balance FROM user_credits WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;

    let txn_id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO credit_transactions (id, user_id, amount, balance_after, kind, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, 'spent', ?, ?, ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(reason)
    .bind(ref_type)
    .bind(ref_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(new_balance)
}

pub async fn refund(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
    ref_id: Option<&str>,
) -> Result<()> {
    refund_with_ref_type(pool, user_id, amount, reason, "image_generation", ref_id).await
}

/// 退款（指定 ref_type），用于不同业务类型的退款
pub async fn refund_with_ref_type(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
    ref_type: &str,
    ref_id: Option<&str>,
) -> Result<()> {
    if amount <= 0.0 {
        return Err(anyhow!("amount must be positive"));
    }

    ensure_user_credits_row(pool, user_id).await?;

    let mut tx = pool.begin().await?;
    let now = now_rfc3339();

    sqlx::query(
        "UPDATE user_credits
         SET balance = balance + ?,
             total_earned = total_earned + ?,
             updated_at = ?
         WHERE user_id = ?",
    )
    .bind(amount)
    .bind(amount)
    .bind(&now)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    let new_balance =
        sqlx::query_scalar::<_, f64>("SELECT balance FROM user_credits WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;

    let txn_id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO credit_transactions (id, user_id, amount, balance_after, kind, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, 'refund', ?, ?, ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(reason)
    .bind(ref_type)
    .bind(ref_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// 更新最近一条 spent 记录的 ref_id（用于先扣费后关联的场景）
pub async fn update_spent_ref_id(
    pool: &SqlitePool,
    user_id: &str,
    ref_type: &str,
    ref_id: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE credit_transactions
         SET ref_id = ?
         WHERE rowid = (
             SELECT rowid FROM credit_transactions
             WHERE user_id = ? AND kind = 'spent' AND ref_type = ? AND ref_id IS NULL
             ORDER BY created_at DESC
             LIMIT 1
         )",
    )
    .bind(ref_id)
    .bind(user_id)
    .bind(ref_type)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn top_up(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
) -> Result<UserCredits> {
    if amount <= 0.0 {
        return Err(anyhow!("amount must be positive"));
    }

    ensure_user_credits_row(pool, user_id).await?;

    let mut tx = pool.begin().await?;
    let now = now_rfc3339();

    sqlx::query(
        "UPDATE user_credits
         SET balance = balance + ?,
             total_earned = total_earned + ?,
             updated_at = ?
         WHERE user_id = ?",
    )
    .bind(amount)
    .bind(amount)
    .bind(&now)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    let new_balance =
        sqlx::query_scalar::<_, f64>("SELECT balance FROM user_credits WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;

    let txn_id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO credit_transactions (id, user_id, amount, balance_after, kind, reason, created_at)
         VALUES (?, ?, ?, ?, 'earned', ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(reason)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    get_user_credits(pool, user_id).await
}

pub async fn refund_outstanding_for_ref(
    pool: &SqlitePool,
    user_id: &str,
    ref_type: &str,
    ref_id: &str,
    reason: &str,
) -> Result<f64> {
    ensure_user_credits_row(pool, user_id).await?;

    let mut tx = pool.begin().await?;

    let already_refunded = sqlx::query_scalar::<_, String>(
        "SELECT id
         FROM credit_transactions
         WHERE user_id = ? AND kind = 'refund' AND ref_type = ? AND ref_id = ?
         LIMIT 1",
    )
    .bind(user_id)
    .bind(ref_type)
    .bind(ref_id)
    .fetch_optional(&mut *tx)
    .await?;

    if already_refunded.is_some() {
        tx.rollback().await?;
        return Ok(0.0);
    }

    let amount = sqlx::query_scalar::<_, f64>(
        "SELECT amount
         FROM credit_transactions
         WHERE user_id = ? AND kind = 'spent' AND ref_type = ? AND ref_id = ?
         ORDER BY created_at DESC
         LIMIT 1",
    )
    .bind(user_id)
    .bind(ref_type)
    .bind(ref_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(amount) = amount else {
        tx.rollback().await?;
        return Ok(0.0);
    };

    if amount <= 0.0 {
        tx.rollback().await?;
        return Ok(0.0);
    }

    let now = now_rfc3339();

    sqlx::query(
        "UPDATE user_credits
         SET balance = balance + ?,
             total_earned = total_earned + ?,
             updated_at = ?
         WHERE user_id = ?",
    )
    .bind(amount)
    .bind(amount)
    .bind(&now)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    let new_balance =
        sqlx::query_scalar::<_, f64>("SELECT balance FROM user_credits WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;

    let txn_id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO credit_transactions (id, user_id, amount, balance_after, kind, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, 'refund', ?, ?, ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(reason)
    .bind(ref_type)
    .bind(ref_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(amount)
}

pub async fn list_transactions(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<CreditTransaction>> {
    let txns = sqlx::query_as::<_, CreditTransaction>(
        "SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(txns)
}
