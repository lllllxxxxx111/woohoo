use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::ImageGeneration;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/**
 * 创建图片生成记录
 */
pub async fn create_generation(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    prompt: &str,
    model: &str,
    size: &str,
    n: i64,
) -> Result<ImageGeneration> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();

    sqlx::query(
        "INSERT INTO image_generations (id, user_id, project_id, prompt, model, size, n, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(project_id)
    .bind(prompt)
    .bind(model)
    .bind(size)
    .bind(n)
    .bind(&now)
    .execute(pool)
    .await?;

    get_generation_for_user(pool, &id, user_id).await
}

/**
 * 查询单条图片生成记录
 */
pub async fn get_generation(pool: &SqlitePool, generation_id: &str) -> Result<ImageGeneration> {
    let gen = sqlx::query_as::<_, ImageGeneration>("SELECT * FROM image_generations WHERE id = ?")
        .bind(generation_id)
        .fetch_one(pool)
        .await?;

    Ok(gen)
}

/**
 * 查询当前用户的一条图片生成记录
 */
pub async fn get_generation_for_user(
    pool: &SqlitePool,
    generation_id: &str,
    user_id: &str,
) -> Result<ImageGeneration> {
    let gen = sqlx::query_as::<_, ImageGeneration>(
        "SELECT * FROM image_generations WHERE id = ? AND user_id = ?",
    )
    .bind(generation_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok(gen)
}

/**
 * 更新图片生成状态为处理中
 */
pub async fn set_processing(pool: &SqlitePool, generation_id: &str) -> Result<()> {
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
    result_b64_json: &[String],
    asset_ids: &[String],
    revised_prompt: Option<&str>,
    cost_credits: f64,
) -> Result<()> {
    let now = now_iso();
    let urls_json = serde_json::to_string(result_urls)?;
    let b64_json = serde_json::to_string(result_b64_json)?;
    let asset_ids_json = serde_json::to_string(asset_ids)?;

    sqlx::query(
        "UPDATE image_generations
         SET status = 'completed',
             result_urls = ?,
             result_b64_json = ?,
             asset_ids = ?,
             revised_prompt = ?,
             cost_credits = ?,
             completed_at = ?
         WHERE id = ?",
    )
    .bind(&urls_json)
    .bind(&b64_json)
    .bind(&asset_ids_json)
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
pub async fn set_failed(pool: &SqlitePool, generation_id: &str, error_message: &str) -> Result<()> {
    let now = now_iso();

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
pub async fn list_interrupted_generations(pool: &SqlitePool) -> Result<Vec<ImageGeneration>> {
    let gens = sqlx::query_as::<_, ImageGeneration>(
        "SELECT * FROM image_generations WHERE status IN ('pending', 'processing')",
    )
    .fetch_all(pool)
    .await?;

    Ok(gens)
}

pub async fn fail_interrupted_generations(pool: &SqlitePool) -> Result<u64> {
    let now = now_iso();
    let result = sqlx::query(
        "UPDATE image_generations
         SET status = 'failed',
             error_message = '服务重启或任务中断，图片生成未完成，未扣除积分',
             completed_at = ?
         WHERE status IN ('pending', 'processing')",
    )
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

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
