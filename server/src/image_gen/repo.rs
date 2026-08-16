use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::{ImageGeneration, ImageGenerationStatus};

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 创建图片生成记录（自动生成 UUID 作为 id）。
///
/// 保留作为公共 API 入口，供未来需要"非幂等"创建场景使用。
/// 当前所有 billing 路径都走 `create_generation_with_id` 以支持幂等扣费。
#[allow(dead_code)]
pub async fn create_generation(
    pool: &SqlitePool,
    user_id: &str,
    project_id: Option<&str>,
    prompt: &str,
    model: &str,
    size: &str,
    n: i64,
    cost_credits: f64,
) -> Result<ImageGeneration> {
    let id = Uuid::new_v4().to_string();
    create_generation_with_id(
        pool,
        &id,
        user_id,
        project_id,
        prompt,
        model,
        size,
        n,
        cost_credits,
    )
    .await
}

/**
 * 使用预先生成的 ID 创建图片生成记录。
 *
 * 用于 billing 幂等扣费场景：调用方在扣费前预生成 generation_id，
 * 将其作为 ref_id 传给 `check_and_deduct_idempotent`，然后调用本函数
 * 以同一 ID 写入 generation 记录。若并发请求使用相同 ID（如客户端重试），
 * 第二次 INSERT 会因 PRIMARY KEY 冲突失败，调用方据此返回已有记录。
 *
 * @param pool 数据库连接池
 * @param id 预先生成的 generation ID
 * @param user_id 用户 ID
 * @param project_id 关联项目 ID（可选）
 * @param prompt 提示词
 * @param model 模型名
 * @param size 图片尺寸
 * @param n 生成数量
 * @param cost_credits 扣费金额
 * @returns 创建好的 ImageGeneration 记录
 */
pub async fn create_generation_with_id(
    pool: &SqlitePool,
    id: &str,
    user_id: &str,
    project_id: Option<&str>,
    prompt: &str,
    model: &str,
    size: &str,
    n: i64,
    cost_credits: f64,
) -> Result<ImageGeneration> {
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO image_generations (id, user_id, project_id, prompt, model, size, n, status, cost_credits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(user_id)
    .bind(project_id)
    .bind(prompt)
    .bind(model)
    .bind(size)
    .bind(n)
    .bind(ImageGenerationStatus::Pending.as_str())
    .bind(cost_credits)
    .bind(&now)
    .execute(pool)
    .await?;

    get_generation(pool, id).await
}

pub async fn get_generation(pool: &SqlitePool, generation_id: &str) -> Result<ImageGeneration> {
    let generation =
        sqlx::query_as::<_, ImageGeneration>("SELECT * FROM image_generations WHERE id = ?")
            .bind(generation_id)
            .fetch_one(pool)
            .await?;

    Ok(generation)
}

pub async fn set_processing(pool: &SqlitePool, generation_id: &str) -> Result<()> {
    sqlx::query("UPDATE image_generations SET status = ? WHERE id = ? AND status = ?")
        .bind(ImageGenerationStatus::Processing.as_str())
        .bind(generation_id)
        .bind(ImageGenerationStatus::Pending.as_str())
        .execute(pool)
        .await?;

    Ok(())
}

pub async fn set_completed(
    pool: &SqlitePool,
    generation_id: &str,
    result_urls: &[String],
    result_b64_json: Option<&str>,
    asset_ids: &[String],
    revised_prompt: Option<&str>,
    cost_credits: f64,
) -> Result<()> {
    let now = now_rfc3339();
    let urls_json = serde_json::to_string(result_urls)?;
    let asset_ids_json = serde_json::to_string(asset_ids)?;

    sqlx::query(
        "UPDATE image_generations
         SET status = ?,
             result_urls = ?,
             result_b64_json = ?,
             asset_ids = ?,
             revised_prompt = ?,
             cost_credits = ?,
             completed_at = ?
         WHERE id = ?",
    )
    .bind(ImageGenerationStatus::Completed.as_str())
    .bind(&urls_json)
    .bind(result_b64_json)
    .bind(&asset_ids_json)
    .bind(revised_prompt)
    .bind(cost_credits)
    .bind(&now)
    .bind(generation_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn set_failed(pool: &SqlitePool, generation_id: &str, error_message: &str) -> Result<()> {
    let now = now_rfc3339();

    sqlx::query(
        "UPDATE image_generations
         SET status = ?,
             error_message = ?,
             completed_at = ?
         WHERE id = ?",
    )
    .bind(ImageGenerationStatus::Failed.as_str())
    .bind(error_message)
    .bind(&now)
    .bind(generation_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn list_user_generations(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<ImageGeneration>> {
    let generations = sqlx::query_as::<_, ImageGeneration>(
        "SELECT * FROM image_generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(generations)
}

pub async fn list_interrupted_generations(pool: &SqlitePool) -> Result<Vec<ImageGeneration>> {
    let generations = sqlx::query_as::<_, ImageGeneration>(
        "SELECT *
         FROM image_generations
         WHERE status IN (?, ?)
         ORDER BY created_at ASC",
    )
    .bind(ImageGenerationStatus::Pending.as_str())
    .bind(ImageGenerationStatus::Processing.as_str())
    .fetch_all(pool)
    .await?;

    Ok(generations)
}

pub async fn fail_interrupted_generations(pool: &SqlitePool) -> Result<u64> {
    let now = now_rfc3339();
    let result = sqlx::query(
        "UPDATE image_generations
         SET status = ?,
             error_message = 'image generation interrupted by server restart',
             completed_at = ?
         WHERE status IN (?, ?)",
    )
    .bind(ImageGenerationStatus::Failed.as_str())
    .bind(&now)
    .bind(ImageGenerationStatus::Pending.as_str())
    .bind(ImageGenerationStatus::Processing.as_str())
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}
