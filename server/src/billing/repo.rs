// TODO: f64 存储金额存在浮点精度问题，长期运行可能导致余额与流水不一致
// 应迁移为整数（分/毫单位）或 rust_decimal，需要同步修改数据库 schema
use anyhow::{anyhow, Result};
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::{CreditTransaction, CreditTransactionKind, UserCredits};

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

    // 使用 BEGIN IMMEDIATE：额度操作均为“先读后写”，WAL 模式下延迟事务在并发时
    // 可能因读快照过期而抛不可重试的 SQLITE_BUSY；立即事务在开始即串行化写入。
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(CreditTransactionKind::Spent.as_str())
    .bind(reason)
    .bind(ref_type)
    .bind(ref_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(new_balance)
}

/// 退款（默认 ref_type = image_generation）。
///
/// @deprecated 保留作为公共 API，供历史调用方与未来场景使用；
///   现行 billing 路径统一走 `refund_outstanding_for_ref`，按 (ref_type, ref_id)
///   幂等退款，避免并发重复退款。
#[deprecated(note = "使用 refund_outstanding_for_ref 替代，确保按 ref_id 幂等退款")]
#[allow(dead_code)]
pub async fn refund(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
    ref_id: Option<&str>,
) -> Result<()> {
    refund_with_ref_type(pool, user_id, amount, reason, "image_generation", ref_id).await
}

/// 退款（指定 ref_type），用于不同业务类型的退款。
///
/// @deprecated 保留作为公共 API；现行 billing 路径统一走
///   `refund_outstanding_for_ref`，按 (ref_type, ref_id) 幂等退款，
///   避免并发重复退款。该函数不进行幂等检查，多次调用会产生多笔 refund。
#[deprecated(note = "使用 refund_outstanding_for_ref 替代，确保按 ref_id 幂等退款")]
#[allow(dead_code)]
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

    // 使用 BEGIN IMMEDIATE：额度操作均为“先读后写”，WAL 模式下延迟事务在并发时
    // 可能因读快照过期而抛不可重试的 SQLITE_BUSY；立即事务在开始即串行化写入。
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(CreditTransactionKind::Refund.as_str())
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
///
/// @deprecated 此函数存在并发竞态：两个并发请求可能选到同一行或互相覆盖，
///   导致账单与生成任务错配。新版应使用 `check_and_deduct_idempotent` 在扣费时
///   直接带 ref_id 写入。保留此函数仅为兼容性，不再有调用方。
#[deprecated(note = "使用 check_and_deduct_idempotent 替代，避免并发竞态")]
#[allow(dead_code)]
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
             WHERE user_id = ? AND kind = ? AND ref_type = ? AND ref_id IS NULL
             ORDER BY created_at DESC
             LIMIT 1
         )",
    )
    .bind(ref_id)
    .bind(user_id)
    .bind(CreditTransactionKind::Spent.as_str())
    .bind(ref_type)
    .execute(pool)
    .await?;

    Ok(())
}

/**
 * 幂等扣费：扣减用户积分并写入 spent 流水，按 (ref_type, ref_id) 幂等。
 *
 * 替代旧版 `check_and_deduct + update_spent_ref_id` 两步流程，消除并发竞态：
 *   1. 在同一事务内扣减余额 + 写入 spent 记录，ref_id 在写入时直接绑定；
 *   2. 依赖 028 migration 建立的 `idx_credit_txn_spent_ref_unique` 唯一索引，
 *      同一 (ref_type, ref_id) 的第二次扣费会因 UNIQUE 约束失败；
 *   3. 检测到 UNIQUE 冲突时回滚本次扣费，返回当前余额（视为已扣费过）。
 *
 * 适用场景：每次生成请求在创建 generation 记录前，预先生成 generation_id
 *   并作为 ref_id 传入。重复请求（如客户端重试）不会重复扣费。
 *
 * @param pool 数据库连接池
 * @param user_id 用户 ID
 * @param amount 扣费金额（必须 > 0）
 * @param reason 扣费原因（写入 credit_transactions.reason）
 * @param ref_type 关联类型（如 "image_generation" / "video_generation"）
 * @param ref_id 关联 ID（即预先生成的 generation_id）
 * @returns 扣费后的新余额；若已扣过费返回当前余额（幂等）
 */
pub async fn check_and_deduct_idempotent(
    pool: &SqlitePool,
    user_id: &str,
    amount: f64,
    reason: &str,
    ref_type: &str,
    ref_id: &str,
) -> Result<f64> {
    if amount <= 0.0 {
        return Err(anyhow!("amount must be positive"));
    }

    ensure_user_credits_row(pool, user_id).await?;

    // 使用 BEGIN IMMEDIATE：额度操作均为“先读后写”，WAL 模式下延迟事务在并发时
    // 可能因读快照过期而抛不可重试的 SQLITE_BUSY；立即事务在开始即串行化写入。
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let now = now_rfc3339();

    // 扣减余额（原子条件更新：余额不足时不影响任何行）
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

    // 写入 spent 记录；若 (ref_type, ref_id) 已存在（UNIQUE 冲突），说明
    // 并发请求已扣过费，回滚本次扣费并返回当前余额。
    let insert_result = sqlx::query(
        "INSERT INTO credit_transactions (id, user_id, amount, balance_after, kind, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(CreditTransactionKind::Spent.as_str())
    .bind(reason)
    .bind(ref_type)
    .bind(ref_id)
    .bind(&now)
    .execute(&mut *tx)
    .await;

    match insert_result {
        Ok(_) => {
            tx.commit().await?;
            Ok(new_balance)
        }
        Err(sqlx::Error::Database(db_err))
            if is_unique_violation_code(db_err.code().as_deref()) =>
        {
            // UNIQUE 冲突：另一并发请求已为同一 (ref_type, ref_id) 扣费。
            // 回滚本次扣费（恢复余额），返回当前余额。
            tx.rollback().await?;
            tracing::info!(
                user_id = user_id,
                ref_type = ref_type,
                ref_id = ref_id,
                "扣费幂等命中：已存在相同 ref 的 spent 记录，跳过重复扣费"
            );
            let balance =
                sqlx::query_scalar::<_, f64>("SELECT balance FROM user_credits WHERE user_id = ?")
                    .bind(user_id)
                    .fetch_one(pool)
                    .await?;
            Ok(balance)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(anyhow!(error))
        }
    }
}

/**
 * 判断 SQLite 错误码是否为 UNIQUE 约束冲突。
 *
 * SQLite UNIQUE 约束冲突的错误码为 2067 (SQLITE_CONSTRAINT_UNIQUE)，
 * 通用约束冲突码为 19 (SQLITE_CONSTRAINT)。
 *
 * @param code 数据库错误码（已通过 `db_err.code().as_deref()` 转为 Option<&str>）
 * @returns true 表示是 UNIQUE 冲突
 */
fn is_unique_violation_code(code: Option<&str>) -> bool {
    matches!(code, Some("2067") | Some("19") | Some("constraint_unique"))
}

/// MVP placeholder for a future protected admin/billing route.
#[allow(dead_code)]
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

    // 使用 BEGIN IMMEDIATE：额度操作均为“先读后写”，WAL 模式下延迟事务在并发时
    // 可能因读快照过期而抛不可重试的 SQLITE_BUSY；立即事务在开始即串行化写入。
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
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
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(CreditTransactionKind::Earned.as_str())
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

    // 使用 BEGIN IMMEDIATE：额度操作均为“先读后写”，WAL 模式下延迟事务在并发时
    // 可能因读快照过期而抛不可重试的 SQLITE_BUSY；立即事务在开始即串行化写入。
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let already_refunded = sqlx::query_scalar::<_, String>(
        "SELECT id
         FROM credit_transactions
         WHERE user_id = ? AND kind = ? AND ref_type = ? AND ref_id = ?
         LIMIT 1",
    )
    .bind(user_id)
    .bind(CreditTransactionKind::Refund.as_str())
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
         WHERE user_id = ? AND kind = ? AND ref_type = ? AND ref_id = ?
         ORDER BY created_at DESC
         LIMIT 1",
    )
    .bind(user_id)
    .bind(CreditTransactionKind::Spent.as_str())
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

    // 写入 refund 记录；若 (ref_type, ref_id) 已存在 refund（UNIQUE 冲突），
    // 说明并发请求已退款，回滚本次退款（恢复余额不变），返回 0.0。
    let insert_result = sqlx::query(
        "INSERT INTO credit_transactions (id, user_id, amount, balance_after, kind, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&txn_id)
    .bind(user_id)
    .bind(amount)
    .bind(new_balance)
    .bind(CreditTransactionKind::Refund.as_str())
    .bind(reason)
    .bind(ref_type)
    .bind(ref_id)
    .bind(&now)
    .execute(&mut *tx)
    .await;

    match insert_result {
        Ok(_) => {
            tx.commit().await?;
            Ok(amount)
        }
        Err(sqlx::Error::Database(db_err))
            if is_unique_violation_code(db_err.code().as_deref()) =>
        {
            // UNIQUE 冲突：另一并发请求已为同一 (ref_type, ref_id) 退款。
            // 回滚本次退款（恢复余额），返回 0.0 表示未执行退款。
            tx.rollback().await?;
            tracing::info!(
                user_id = user_id,
                ref_type = ref_type,
                ref_id = ref_id,
                "退款幂等命中：已存在相同 ref 的 refund 记录，跳过重复退款"
            );
            Ok(0.0)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(anyhow!(error))
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use sqlx::Row;

    /**
     * 构造测试用 SQLite 连接池（含完整 schema，含 028 唯一索引）。
     *
     * 使用 init_db 自动运行所有迁移，确保 credit_transactions 上的
     * (ref_type, ref_id) partial unique index 已建立，可以真实验证
     * 并发场景下 UNIQUE 约束是否生效。
     */
    async fn create_test_pool() -> SqlitePool {
        let db_path = std::env::temp_dir().join(format!(
            "woohoo-billing-concurrency-{}.sqlite",
            Uuid::new_v4()
        ));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
        init_db(&database_url, 10).await
    }

    /// 创建测试用户（含初始积分行）
    async fn seed_user(pool: &SqlitePool, user_id: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (?, ?, ?, '')",
        )
        .bind(user_id)
        .bind(format!("user-{}", user_id))
        .bind(format!("{}@test.local", user_id))
        .execute(pool)
        .await
        .expect("failed to seed user");
        // 触发 ensure_user_credits_row，保证有 user_credits 行
        get_user_credits(pool, user_id)
            .await
            .expect("failed to init credits row");
    }

    /// 统计指定 ref_id 的 spent 记录数
    async fn count_spent_for_ref(pool: &SqlitePool, ref_id: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM credit_transactions
             WHERE kind = 'spent' AND ref_id = ?",
        )
        .bind(ref_id)
        .fetch_one(pool)
        .await
        .expect("failed to count spent records")
    }

    /// 统计指定 ref_id 的 refund 记录数
    async fn count_refund_for_ref(pool: &SqlitePool, ref_id: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM credit_transactions
             WHERE kind = 'refund' AND ref_id = ?",
        )
        .bind(ref_id)
        .fetch_one(pool)
        .await
        .expect("failed to count refund records")
    }

    /**
     * 测试 1：两个并发图片生成扣费请求不会绑定同一笔消费记录。
     *
     * 验证点：
     *   - 两次 check_and_deduct_idempotent 用不同 ref_id 并发执行；
     *   - 最终 credit_transactions 中应有两条 spent 记录，ref_id 各不相同；
     *   - 用户余额减少 2 * cost（说明两次扣费都生效，未被错误合并）；
     *   - 不会出现"一个 ref_id 没有记录，另一个 ref_id 有两条记录"的旧版竞态。
     *
     * 这对应"两个并发图片生成请求不会绑定同一笔消费记录"的要求。
     */
    #[tokio::test]
    async fn concurrent_image_generation_does_not_share_spent_record() {
        let pool = create_test_pool().await;
        let user_id = "concurrent-img-user";
        seed_user(&pool, user_id).await;

        let cost = 5.0;
        let ref_id_a = "img-gen-aaa";
        let ref_id_b = "img-gen-bbb";

        // 并发执行：两个不同 ref_id 的扣费请求同时进入
        let (result_a, result_b) = tokio::join!(
            check_and_deduct_idempotent(
                &pool,
                user_id,
                cost,
                "image_generation",
                "image_generation",
                ref_id_a,
            ),
            check_and_deduct_idempotent(
                &pool,
                user_id,
                cost,
                "image_generation",
                "image_generation",
                ref_id_b,
            ),
        );

        // 两次扣费都应成功
        assert!(result_a.is_ok(), "ref_id_a 扣费失败: {:?}", result_a.err());
        assert!(result_b.is_ok(), "ref_id_b 扣费失败: {:?}", result_b.err());

        // 验证：每个 ref_id 各有恰好一条 spent 记录
        let count_a = count_spent_for_ref(&pool, ref_id_a).await;
        let count_b = count_spent_for_ref(&pool, ref_id_b).await;
        assert_eq!(
            count_a, 1,
            "ref_id_a 应有 1 条 spent 记录，实际 {} 条（可能被并发请求错绑）",
            count_a
        );
        assert_eq!(
            count_b, 1,
            "ref_id_b 应有 1 条 spent 记录，实际 {} 条（可能被并发请求错绑）",
            count_b
        );

        // 验证：余额正好减少 2 * cost（旧版竞态会因互相覆盖导致只扣一次或多扣）
        let credits = get_user_credits(&pool, user_id).await.unwrap();
        assert!(
            (credits.balance - (100.0 - 2.0 * cost)).abs() < 0.001,
            "余额应为 {}, 实际 {}（并发扣费可能错乱）",
            100.0 - 2.0 * cost,
            credits.balance
        );
        assert!(
            (credits.total_spent - 2.0 * cost).abs() < 0.001,
            "total_spent 应为 {}, 实际 {}",
            2.0 * cost,
            credits.total_spent
        );

        pool.close().await;
    }

    /**
     * 测试 2：两个并发视频生成扣费请求不会绑定同一笔消费记录。
     *
     * 与测试 1 对称，但 ref_type = "video_generation"，验证视频生成路径
     * 同样不会因并发导致扣费记录错绑。
     */
    #[tokio::test]
    async fn concurrent_video_generation_does_not_share_spent_record() {
        let pool = create_test_pool().await;
        let user_id = "concurrent-vid-user";
        seed_user(&pool, user_id).await;

        let cost = 10.0;
        let ref_id_a = "vid-gen-aaa";
        let ref_id_b = "vid-gen-bbb";

        let (result_a, result_b) = tokio::join!(
            check_and_deduct_idempotent(
                &pool,
                user_id,
                cost,
                "video_generation",
                "video_generation",
                ref_id_a,
            ),
            check_and_deduct_idempotent(
                &pool,
                user_id,
                cost,
                "video_generation",
                "video_generation",
                ref_id_b,
            ),
        );

        assert!(result_a.is_ok(), "ref_id_a 扣费失败: {:?}", result_a.err());
        assert!(result_b.is_ok(), "ref_id_b 扣费失败: {:?}", result_b.err());

        let count_a = count_spent_for_ref(&pool, ref_id_a).await;
        let count_b = count_spent_for_ref(&pool, ref_id_b).await;
        assert_eq!(
            count_a, 1,
            "ref_id_a 应有 1 条 spent 记录，实际 {}",
            count_a
        );
        assert_eq!(
            count_b, 1,
            "ref_id_b 应有 1 条 spent 记录，实际 {}",
            count_b
        );

        // 验证余额正好减少 2 * cost
        let credits = get_user_credits(&pool, user_id).await.unwrap();
        assert!(
            (credits.balance - (100.0 - 2.0 * cost)).abs() < 0.001,
            "余额应为 {}, 实际 {}",
            100.0 - 2.0 * cost,
            credits.balance
        );

        pool.close().await;
    }

    /**
     * 测试 3：重复请求不会重复扣费（幂等性）。
     *
     * 验证点：
     *   - 同一 ref_id 并发调用 check_and_deduct_idempotent 两次；
     *   - 只应产生 1 条 spent 记录（UNIQUE 约束拒绝第二次 INSERT）；
     *   - 余额只减少 1 * cost，第二次调用返回当前余额（视为已扣费）。
     *
     * 这对应"重复请求不会重复扣费"的要求，覆盖客户端重试 / 网络抖动场景。
     */
    #[tokio::test]
    async fn duplicate_requests_do_not_double_charge() {
        let pool = create_test_pool().await;
        let user_id = "idempotent-user";
        seed_user(&pool, user_id).await;

        let cost = 7.5;
        let ref_id = "idempotent-ref-1";

        // 同一 ref_id 并发两次扣费（模拟客户端重试）
        let (result_a, result_b) = tokio::join!(
            check_and_deduct_idempotent(
                &pool,
                user_id,
                cost,
                "image_generation",
                "image_generation",
                ref_id,
            ),
            check_and_deduct_idempotent(
                &pool,
                user_id,
                cost,
                "image_generation",
                "image_generation",
                ref_id,
            ),
        );

        // 两次调用都应返回 Ok（第二次返回当前余额，视为幂等命中）
        let balance_a = result_a.expect("first deduct should succeed");
        let balance_b = result_b.expect("second deduct should be idempotent Ok");

        // 验证：只有 1 条 spent 记录
        let count = count_spent_for_ref(&pool, ref_id).await;
        assert_eq!(
            count, 1,
            "同一 ref_id 应只有 1 条 spent 记录，实际 {}（重复扣费发生）",
            count
        );

        // 验证：余额只减少 1 * cost
        let credits = get_user_credits(&pool, user_id).await.unwrap();
        let expected_balance = 100.0 - cost;
        assert!(
            (credits.balance - expected_balance).abs() < 0.001,
            "余额应为 {}（只扣一次），实际 {}",
            expected_balance,
            credits.balance
        );

        // 两次调用返回的余额都应等于扣费后余额（第二次返回当前余额，不重复扣费）
        assert!(
            (balance_a - expected_balance).abs() < 0.001
                || (balance_b - expected_balance).abs() < 0.001,
            "至少有一次返回的余额应为 {}，实际 a={}, b={}",
            expected_balance,
            balance_a,
            balance_b
        );

        pool.close().await;
    }

    /**
     * 测试 4：重复失败回调不会重复退款（退款幂等性）。
     *
     * 场景：任务失败 → refund_and_fail 触发退款；外部 API 重复回调或
     * main.rs 的 reconcile_interrupted_*_generations 启动时补偿退款，
     * 可能对同一 ref_id 多次调用 refund_outstanding_for_ref。
     *
     * 验证点：
     *   - 先扣费（spent 记录）；
     *   - 并发调用 refund_outstanding_for_ref 两次；
     *   - 只应产生 1 条 refund 记录；
     *   - 余额只增加 1 * cost（不重复退款）；
     *   - 第二次调用返回 Ok(0.0)，表示未执行退款。
     */
    #[tokio::test]
    async fn duplicate_failure_callbacks_do_not_double_refund() {
        let pool = create_test_pool().await;
        let user_id = "refund-idempotent-user";
        seed_user(&pool, user_id).await;

        let cost = 8.0;
        let ref_id = "refund-ref-1";

        // 先扣费（模拟生成任务启动）
        check_and_deduct_idempotent(
            &pool,
            user_id,
            cost,
            "image_generation",
            "image_generation",
            ref_id,
        )
        .await
        .expect("deduct should succeed");

        let balance_after_deduct = get_user_credits(&pool, user_id).await.unwrap().balance;
        assert!(
            (balance_after_deduct - (100.0 - cost)).abs() < 0.001,
            "扣费后余额应为 {}，实际 {}",
            100.0 - cost,
            balance_after_deduct
        );

        // 并发调用退款两次（模拟重复失败回调）
        let (refund_a, refund_b) = tokio::join!(
            refund_outstanding_for_ref(
                &pool,
                user_id,
                "image_generation",
                ref_id,
                "image_generation_failed",
            ),
            refund_outstanding_for_ref(
                &pool,
                user_id,
                "image_generation",
                ref_id,
                "image_generation_failed",
            ),
        );

        let refunded_a = refund_a.expect("first refund should not error");
        let refunded_b = refund_b.expect("second refund should not error (idempotent)");

        // 验证：只有 1 条 refund 记录
        let count = count_refund_for_ref(&pool, ref_id).await;
        assert_eq!(
            count, 1,
            "同一 ref_id 应只有 1 条 refund 记录，实际 {}（重复退款发生）",
            count
        );

        // 验证：余额恢复到 100.0（只退一次）
        let credits = get_user_credits(&pool, user_id).await.unwrap();
        assert!(
            (credits.balance - 100.0).abs() < 0.001,
            "退款后余额应恢复为 100.0（只退一次），实际 {}",
            credits.balance
        );

        // 验证：两次退款返回的金额之和等于 cost（一次退 cost，一次退 0）
        assert!(
            (refunded_a + refunded_b - cost).abs() < 0.001,
            "两次退款金额之和应为 {}，实际 a={}, b={}",
            cost,
            refunded_a,
            refunded_b
        );

        pool.close().await;
    }

    /**
     * 测试 5：扣费成功后数据库写入失败时状态可恢复。
     *
     * 场景模拟（与 enqueue_image_generation 的失败恢复路径一致）：
     *   1. check_and_deduct_idempotent 成功（余额扣减 + spent 记录写入）；
     *   2. 模拟"create_generation_with_id 失败"——这里直接不创建 generation 记录；
     *   3. 调用 refund_outstanding_for_ref 进行恢复退款；
     *   4. 验证：余额恢复，spent 记录与 refund 记录均存在且 ref_id 匹配。
     *
     * 关键点：扣费时已写入 ref_id（而非旧版 NULL），所以即使后续步骤失败，
     * refund_outstanding_for_ref 也能通过 ref_id 找到对应的 spent 记录退款，
     * 不需要依赖"最近一条 NULL ref_id 记录"的脆弱假设。
     */
    #[tokio::test]
    async fn state_recoverable_when_db_write_fails_after_deduction() {
        let pool = create_test_pool().await;
        let user_id = "recoverable-user";
        seed_user(&pool, user_id).await;

        let cost = 12.0;
        let ref_id = "recoverable-ref-1";

        // Step 1: 扣费成功（此时 spent 记录已带 ref_id 写入）
        let balance_after = check_and_deduct_idempotent(
            &pool,
            user_id,
            cost,
            "image_generation",
            "image_generation",
            ref_id,
        )
        .await
        .expect("deduct should succeed");

        assert!(
            (balance_after - (100.0 - cost)).abs() < 0.001,
            "扣费后余额应为 {}，实际 {}",
            100.0 - cost,
            balance_after
        );

        // Step 2: 模拟"任务创建失败"——不创建 generation 记录
        // （真实场景中 create_generation_with_id 会因 DB 错误失败，
        //   handler 会调用 refund_outstanding_for_ref 恢复）

        // Step 3: 调用 refund_outstanding_for_ref 恢复退款
        let refunded = refund_outstanding_for_ref(
            &pool,
            user_id,
            "image_generation",
            ref_id,
            "image_generation_record_create_failed",
        )
        .await
        .expect("recovery refund should succeed");

        // 验证：退款金额等于扣费金额
        assert!(
            (refunded - cost).abs() < 0.001,
            "应退款 {}，实际 {}",
            cost,
            refunded
        );

        // 验证：余额恢复
        let credits = get_user_credits(&pool, user_id).await.unwrap();
        assert!(
            (credits.balance - 100.0).abs() < 0.001,
            "恢复退款后余额应为 100.0，实际 {}",
            credits.balance
        );

        // 验证：spent 和 refund 记录都存在且 ref_id 匹配
        assert_eq!(
            count_spent_for_ref(&pool, ref_id).await,
            1,
            "spent 记录应存在"
        );
        assert_eq!(
            count_refund_for_ref(&pool, ref_id).await,
            1,
            "refund 记录应存在"
        );

        // 验证：再次调用 refund_outstanding_for_ref 不会重复退款（幂等）
        let refunded_again = refund_outstanding_for_ref(
            &pool,
            user_id,
            "image_generation",
            ref_id,
            "image_generation_record_create_failed",
        )
        .await
        .expect("second refund should be idempotent Ok");
        assert!(
            refunded_again.abs() < 0.001,
            "已退款后再次调用应返回 0.0，实际 {}",
            refunded_again
        );

        pool.close().await;
    }

    /**
     * 测试 6：退款和账单审计记录保持一致。
     *
     * 验证点（账单审计一致性）：
     *   - 同一 ref_id 的 spent 和 refund 记录都存在；
     *   - spent.amount == refund.amount == cost；
     *   - spent.balance_after + cost == refund.balance_after（余额变化前后一致）；
     *   - user_credits.total_spent 累计 == cost，total_earned 累计 == cost（退款计入 earned）；
     *   - 通过 list_transactions 能查到完整的扣费 + 退款流水。
     *
     * 这对应"退款和账单审计记录保持一致"的要求。
     */
    #[tokio::test]
    async fn refund_and_billing_audit_records_consistent() {
        let pool = create_test_pool().await;
        let user_id = "audit-user";
        seed_user(&pool, user_id).await;

        let cost = 15.0;
        let ref_id = "audit-ref-1";

        // 扣费
        let balance_after_deduct = check_and_deduct_idempotent(
            &pool,
            user_id,
            cost,
            "video_generation",
            "video_generation",
            ref_id,
        )
        .await
        .expect("deduct should succeed");

        // 退款
        let refunded = refund_outstanding_for_ref(
            &pool,
            user_id,
            "video_generation",
            ref_id,
            "video_generation_failed",
        )
        .await
        .expect("refund should succeed");

        assert!((refunded - cost).abs() < 0.001, "退款金额应等于扣费金额");

        // 验证：余额恢复到 100.0
        let credits = get_user_credits(&pool, user_id).await.unwrap();
        assert!(
            (credits.balance - 100.0).abs() < 0.001,
            "退款后余额应恢复 100.0，实际 {}",
            credits.balance
        );
        assert!(
            (credits.total_spent - cost).abs() < 0.001,
            "total_spent 应为 {}，实际 {}",
            cost,
            credits.total_spent
        );
        assert!(
            (credits.total_earned - cost).abs() < 0.001,
            "total_earned 应为 {}（退款计入），实际 {}",
            cost,
            credits.total_earned
        );

        // 验证：list_transactions 能查到 1 条 spent + 1 条 refund
        let txns = list_transactions(&pool, user_id, 100, 0)
            .await
            .expect("list_transactions should succeed");
        let spent_records: Vec<_> = txns
            .iter()
            .filter(|t| {
                t.kind == CreditTransactionKind::Spent.as_str()
                    && t.ref_id.as_deref() == Some(ref_id)
            })
            .collect();
        let refund_records: Vec<_> = txns
            .iter()
            .filter(|t| {
                t.kind == CreditTransactionKind::Refund.as_str()
                    && t.ref_id.as_deref() == Some(ref_id)
            })
            .collect();
        assert_eq!(spent_records.len(), 1, "应有 1 条 spent 记录");
        assert_eq!(refund_records.len(), 1, "应有 1 条 refund 记录");

        let spent = spent_records[0];
        let refund = refund_records[0];

        // 验证：金额匹配
        assert!(
            (spent.amount - cost).abs() < 0.001,
            "spent.amount 应为 {}",
            cost
        );
        assert!(
            (refund.amount - cost).abs() < 0.001,
            "refund.amount 应为 {}",
            cost
        );

        // 验证：ref_type 匹配
        assert_eq!(
            spent.ref_type.as_deref(),
            Some("video_generation"),
            "spent.ref_type 应为 video_generation"
        );
        assert_eq!(
            refund.ref_type.as_deref(),
            Some("video_generation"),
            "refund.ref_type 应为 video_generation"
        );

        // 验证：余额审计一致性（balance_after 变化匹配）
        // 扣费后 balance_after = 100 - cost；退款后 balance_after = 100
        assert!(
            (spent.balance_after - (100.0 - cost)).abs() < 0.001,
            "spent.balance_after 应为 {}，实际 {}",
            100.0 - cost,
            spent.balance_after
        );
        assert!(
            (refund.balance_after - 100.0).abs() < 0.001,
            "refund.balance_after 应为 100.0，实际 {}",
            refund.balance_after
        );

        // 验证：refund.balance_after == spent.balance_after + cost
        assert!(
            (refund.balance_after - (spent.balance_after + cost)).abs() < 0.001,
            "退款后余额应等于扣费后余额 + 退款金额"
        );

        // 通过 SQL 直接查 balance_after 字段（防 FromRow 反序列化遗漏）
        let spent_balance_after: f64 = sqlx::query_scalar(
            "SELECT balance_after FROM credit_transactions
             WHERE user_id = ? AND kind = 'spent' AND ref_id = ?",
        )
        .bind(user_id)
        .bind(ref_id)
        .fetch_one(&pool)
        .await
        .expect("failed to query spent balance_after");
        let refund_balance_after: f64 = sqlx::query_scalar(
            "SELECT balance_after FROM credit_transactions
             WHERE user_id = ? AND kind = 'refund' AND ref_id = ?",
        )
        .bind(user_id)
        .bind(ref_id)
        .fetch_one(&pool)
        .await
        .expect("failed to query refund balance_after");
        assert!(
            (refund_balance_after - (spent_balance_after + cost)).abs() < 0.001,
            "SQL 直查: refund.balance_after ({}) 应等于 spent.balance_after ({}) + cost ({})",
            refund_balance_after,
            spent_balance_after,
            cost
        );

        // 验证 balance_after 字段确实存在于 credit_transactions 表中（用 Row 兜底）
        let row = sqlx::query(
            "SELECT balance_after FROM credit_transactions
             WHERE user_id = ? AND kind = 'spent' AND ref_id = ? LIMIT 1",
        )
        .bind(user_id)
        .bind(ref_id)
        .fetch_one(&pool)
        .await
        .expect("failed to fetch spent row");
        let balance_val: f64 = row
            .try_get("balance_after")
            .expect("balance_after column should exist");
        assert!(
            (balance_val - (100.0 - cost)).abs() < 0.001,
            "Row 直查 balance_after 应为 {}，实际 {}",
            100.0 - cost,
            balance_val
        );

        let _ = balance_after_deduct; // 已通过其他断言间接验证

        pool.close().await;
    }
}
