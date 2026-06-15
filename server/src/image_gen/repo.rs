use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::ImageGeneration;

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

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
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO image_generations (id, user_id, project_id, prompt, model, size, n, status, cost_credits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(project_id)
    .bind(prompt)
    .bind(model)
    .bind(size)
    .bind(n)
    .bind(cost_credits)
    .bind(&now)
    .execute(pool)
    .await?;

    get_generation(pool, &id).await
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
    sqlx::query(
        "UPDATE image_generations SET status = 'processing' WHERE id = ? AND status = 'pending'",
    )
    .bind(generation_id)
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
         SET status = 'failed',
             error_message = ?,
             completed_at = ?
         WHERE id = ?",
    )
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
         WHERE status IN ('pending', 'processing')
         ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await?;

    Ok(generations)
}

pub async fn fail_interrupted_generations(pool: &SqlitePool) -> Result<u64> {
    let now = now_rfc3339();
    let result = sqlx::query(
        "UPDATE image_generations
         SET status = 'failed',
             error_message = 'image generation interrupted by server restart',
             completed_at = ?
         WHERE status IN ('pending', 'processing')",
    )
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}
