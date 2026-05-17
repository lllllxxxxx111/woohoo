use anyhow::Result;
use chrono::Utc;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::model::{CreditTransaction, UserCredits};

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

async fn ensure_user_credits_tx(tx: &mut Transaction<'_, Sqlite>, user_id: &str) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();

    sqlx::query(
        "INSERT INTO user_credits (id, user_id, balance, total_earned, total_spent, updated_at, created_at)
         VALUES (?, ?, 100, 100, 0, ?, ?)
         ON CONFLICT(user_id) DO NOTHING",
    )
    .bind(&id)
    .bind(user_id)
    .bind(&now)
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

/**
 * 获取用户积分余额
 */
pub async fn get_user_credits(pool: &SqlitePool, user_id: &str) -> Result<UserCredits> {
    let mut tx = pool.begin().await?;
    ensure_user_credits_tx(&mut tx, user_id).await?;

    let credits = sqlx::query_as::<_, UserCredits>("SELECT * FROM user_credits WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(credits)
}

/**
 * 检查余额并扣减积分（原子操作）
 * 如果余额不足返回错误，不会实际扣减
 */
pub async fn check_and_deduct(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
    ref_type: Option<&str>,
    ref_id: Option<&str>,
) -> Result<f64> {
    let mut tx = pool.begin().await?;
    ensure_user_credits_tx(&mut tx, user_id).await?;

    let current: f64 = sqlx::query_scalar("SELECT balance FROM user_credits WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

    if current < amount {
        tx.rollback().await?;
        return Err(anyhow::anyhow!(
            "积分不足：当前 {}，需要 {}",
            current,
            amount
        ));
    }

    let new_balance = current - amount;
    let now = now_iso();

    sqlx::query(
        "UPDATE user_credits SET balance = ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ?",
    )
    .bind(new_balance)
    .bind(amount)
    .bind(&now)
    .bind(user_id)
    .execute(&mut *tx)
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

/**
 * 退还积分（失败回退）
 */
pub async fn refund(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
    ref_id: Option<&str>,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    ensure_user_credits_tx(&mut tx, user_id).await?;

    let new_balance: f64 =
        sqlx::query_scalar("SELECT balance + ? FROM user_credits WHERE user_id = ?")
            .bind(amount)
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;

    let now = now_iso();

    sqlx::query(
        "UPDATE user_credits SET balance = ?, total_earned = total_earned + ?, updated_at = ? WHERE user_id = ?",
    )
    .bind(new_balance)
    .bind(amount)
    .bind(&now)
    .bind(user_id)
    .execute(&mut *tx)
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
    .bind(Some("image_generation"))
    .bind(ref_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/**
 * 充值积分
 */
pub async fn refund_outstanding_for_ref(
    pool: &SqlitePool,
    user_id: &str,
    ref_type: &str,
    ref_id: &str,
    reason: &str,
) -> Result<f64> {
    let mut tx = pool.begin().await?;
    ensure_user_credits_tx(&mut tx, user_id).await?;

    let spent: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0)
         FROM credit_transactions
         WHERE user_id = ? AND kind = 'spent' AND ref_type = ? AND ref_id = ?",
    )
    .bind(user_id)
    .bind(ref_type)
    .bind(ref_id)
    .fetch_one(&mut *tx)
    .await?;

    let refunded: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0)
         FROM credit_transactions
         WHERE user_id = ? AND kind = 'refund' AND ref_type = ? AND ref_id = ?",
    )
    .bind(user_id)
    .bind(ref_type)
    .bind(ref_id)
    .fetch_one(&mut *tx)
    .await?;

    let amount = (spent - refunded).max(0.0);
    if amount <= f64::EPSILON {
        tx.commit().await?;
        return Ok(0.0);
    }

    let new_balance: f64 =
        sqlx::query_scalar("SELECT balance + ? FROM user_credits WHERE user_id = ?")
            .bind(amount)
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;

    let now = now_iso();

    sqlx::query(
        "UPDATE user_credits SET balance = ?, total_earned = total_earned + ?, updated_at = ? WHERE user_id = ?",
    )
    .bind(new_balance)
    .bind(amount)
    .bind(&now)
    .bind(user_id)
    .execute(&mut *tx)
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

pub async fn top_up(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
) -> Result<UserCredits> {
    let mut tx = pool.begin().await?;
    ensure_user_credits_tx(&mut tx, user_id).await?;

    let new_balance: f64 =
        sqlx::query_scalar("SELECT balance + ? FROM user_credits WHERE user_id = ?")
            .bind(amount)
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;

    let now = now_iso();

    sqlx::query(
        "UPDATE user_credits
         SET balance = ?, total_earned = total_earned + ?, updated_at = ?
         WHERE user_id = ?",
    )
    .bind(new_balance)
    .bind(amount)
    .bind(&now)
    .bind(user_id)
    .execute(&mut *tx)
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

/**
 * 查询用户的积分流水
 */
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
