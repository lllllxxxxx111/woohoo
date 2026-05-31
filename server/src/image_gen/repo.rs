use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::ImageGeneration;

/**
 * 创建图片生成记录
 */
pub async fn create_generation(
    pool: &SqlitePool,
    user_id: &str,
    prompt: &str,
    model: &str,
    size: &str,
    n: i64,
) -> Result<ImageGeneration> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "INSERT INTO image_generations (id, user_id, prompt, model, size, n, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(prompt)
    .bind(model)
    .bind(size)
    .bind(n)
    .bind(&now)
    .execute(pool)
    .await?;

    get_generation(pool, &id).await
}

/**
 * 查询单条图片生成记录
 */
pub async fn get_generation(
    pool: &SqlitePool,
    generation_id: &str,
) -> Result<ImageGeneration> {
    let gen = sqlx::query_as::<_, ImageGeneration>(
        "SELECT * FROM image_generations WHERE id = ?",
    )
    .bind(generation_id)
    .fetch_one(pool)
    .await?;

    Ok(gen)
}

/**
 * 更新图片生成状态为处理中
 */
pub async fn set_processing(
    pool: &SqlitePool,
    generation_id: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE image_generations SET status = 'processing' WHERE id = ? AND status = 'pending'",
    )
    .bind(generation_id)
    .execute(pool)
    .await?;

    Ok(())
}

/**
 * 更新图片生成结果（成功）
 */
pub async fn set_completed(
    pool: &SqlitePool,
    generation_id: &str,
    result_urls: &[String],
    result_b64_json: Option<&str>,
    revised_prompt: Option<&str>,
    cost_credits: f64,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";
    let urls_json = serde_json::to_string(result_urls)?;

    sqlx::query(
        "UPDATE image_generations
         SET status = 'completed',
             result_urls = ?,
             result_b64_json = ?,
             revised_prompt = ?,
             cost_credits = ?,
             completed_at = ?
         WHERE id = ?"
    )
    .bind(&urls_json)
    .bind(result_b64_json)
    .bind(revised_prompt)
    .bind(cost_credits)
    .bind(&now)
    .bind(generation_id)
    .execute(pool)
    .await?;

    Ok(())
}

/**
 * 更新图片生成结果（失败）
 */
pub async fn set_failed(
    pool: &SqlitePool,
    generation_id: &str,
    error_message: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) + "Z";

    sqlx::query(
        "UPDATE image_generations SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?"
    )
    .bind(error_message)
    .bind(&now)
    .bind(generation_id)
    .execute(pool)
    .await?;

    Ok(())
}

/**
 * 查询用户的图片生成历史
 */
pub async fn list_user_generations(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<ImageGeneration>> {
    let gens = sqlx::query_as::<_, ImageGeneration>(
        "SELECT * FROM image_generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(gens)
}
