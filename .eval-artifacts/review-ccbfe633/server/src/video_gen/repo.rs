use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::VideoGeneration;

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 创建视频生成记录
pub async fn create_generation(
    pool: &SqlitePool,
    user_id: &str,
    project_id: Option<&str>,
    prompt: &str,
    model: &str,
    duration_seconds: Option<f64>,
    aspect_ratio: &str,
    cost_credits: f64,
) -> Result<VideoGeneration> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO video_generations (id, user_id, project_id, prompt, model, duration_seconds, aspect_ratio, status, cost_credits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(project_id)
    .bind(prompt)
    .bind(model)
    .bind(duration_seconds)
    .bind(aspect_ratio)
    .bind(cost_credits)
    .bind(&now)
    .execute(pool)
    .await?;

    get_generation(pool, &id).await
}

/// 查询单条视频生成记录
pub async fn get_generation(pool: &SqlitePool, generation_id: &str) -> Result<VideoGeneration> {
    let generation =
        sqlx::query_as::<_, VideoGeneration>("SELECT * FROM video_generations WHERE id = ?")
            .bind(generation_id)
            .fetch_one(pool)
            .await?;

    Ok(generation)
}

/// 标记为处理中
pub async fn set_processing(pool: &SqlitePool, generation_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE video_generations SET status = 'processing' WHERE id = ? AND status = 'pending'",
    )
    .bind(generation_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// 标记为完成
pub async fn set_completed(
    pool: &SqlitePool,
    generation_id: &str,
    result_url: Option<&str>,
    result_b64_json: Option<&str>,
    cost_credits: f64,
) -> Result<()> {
    let now = now_rfc3339();

    sqlx::query(
        "UPDATE video_generations
         SET status = 'completed',
             result_url = ?,
             result_b64_json = ?,
             cost_credits = ?,
             completed_at = ?
         WHERE id = ?",
    )
    .bind(result_url)
    .bind(result_b64_json)
    .bind(cost_credits)
    .bind(&now)
    .bind(generation_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// 标记为失败
pub async fn set_failed(pool: &SqlitePool, generation_id: &str, error_message: &str) -> Result<()> {
    let now = now_rfc3339();

    sqlx::query(
        "UPDATE video_generations
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

/// 列出用户的视频生成记录
pub async fn list_user_generations(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<VideoGeneration>> {
    let generations = sqlx::query_as::<_, VideoGeneration>(
        "SELECT * FROM video_generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(generations)
}

/// 列出中断的视频生成记录
pub async fn list_interrupted_generations(pool: &SqlitePool) -> Result<Vec<VideoGeneration>> {
    let generations = sqlx::query_as::<_, VideoGeneration>(
        "SELECT *
         FROM video_generations
         WHERE status IN ('pending', 'processing')
         ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await?;

    Ok(generations)
}

/// 将中断的视频生成标记为失败
pub async fn fail_interrupted_generations(pool: &SqlitePool) -> Result<u64> {
    let now = now_rfc3339();
    let result = sqlx::query(
        "UPDATE video_generations
         SET status = 'failed',
             error_message = 'video generation interrupted by server restart',
             completed_at = ?
         WHERE status IN ('pending', 'processing')",
    )
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}
