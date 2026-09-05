use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::model::{VideoGeneration, VideoGenerationStatus};

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 创建视频生成记录（自动生成 UUID 作为 id）。
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
    duration_seconds: Option<f64>,
    aspect_ratio: &str,
    cost_credits: f64,
) -> Result<VideoGeneration> {
    let id = Uuid::new_v4().to_string();
    create_generation_with_id(
        pool,
        &id,
        user_id,
        project_id,
        prompt,
        model,
        duration_seconds,
        aspect_ratio,
        cost_credits,
    )
    .await
}

/**
 * 使用预先生成的 ID 创建视频生成记录。
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
 * @param duration_seconds 视频时长（秒）
 * @param aspect_ratio 宽高比
 * @param cost_credits 扣费金额
 * @returns 创建好的 VideoGeneration 记录
 */
pub async fn create_generation_with_id(
    pool: &SqlitePool,
    id: &str,
    user_id: &str,
    project_id: Option<&str>,
    prompt: &str,
    model: &str,
    duration_seconds: Option<f64>,
    aspect_ratio: &str,
    cost_credits: f64,
) -> Result<VideoGeneration> {
    let now = now_rfc3339();

    sqlx::query(
        "INSERT INTO video_generations (id, user_id, project_id, prompt, model, duration_seconds, aspect_ratio, status, cost_credits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(user_id)
    .bind(project_id)
    .bind(prompt)
    .bind(model)
    .bind(duration_seconds)
    .bind(aspect_ratio)
    .bind(VideoGenerationStatus::Pending.as_str())
    .bind(cost_credits)
    .bind(&now)
    .execute(pool)
    .await?;

    get_generation(pool, id).await
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
    sqlx::query("UPDATE video_generations SET status = ? WHERE id = ? AND status = ?")
        .bind(VideoGenerationStatus::Processing.as_str())
        .bind(generation_id)
        .bind(VideoGenerationStatus::Pending.as_str())
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
         SET status = ?,
             result_url = ?,
             result_b64_json = ?,
             cost_credits = ?,
             completed_at = ?
         WHERE id = ?",
    )
    .bind(VideoGenerationStatus::Completed.as_str())
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
         SET status = ?,
             error_message = ?,
             completed_at = ?
         WHERE id = ?",
    )
    .bind(VideoGenerationStatus::Failed.as_str())
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
         WHERE status IN (?, ?)
         ORDER BY created_at ASC",
    )
    .bind(VideoGenerationStatus::Pending.as_str())
    .bind(VideoGenerationStatus::Processing.as_str())
    .fetch_all(pool)
    .await?;

    Ok(generations)
}

/// 将中断的视频生成标记为失败
pub async fn fail_interrupted_generations(pool: &SqlitePool) -> Result<u64> {
    let now = now_rfc3339();
    let result = sqlx::query(
        "UPDATE video_generations
         SET status = ?,
             error_message = 'video generation interrupted by server restart',
             completed_at = ?
         WHERE status IN (?, ?)",
    )
    .bind(VideoGenerationStatus::Failed.as_str())
    .bind(&now)
    .bind(VideoGenerationStatus::Pending.as_str())
    .bind(VideoGenerationStatus::Processing.as_str())
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

/// 记录视频生成产物对应的本地资产 ID（migration 036 的 result_asset_id 列）。
///
/// 由 run_generation_task 在视频落盘并注册 assets 后调用；
/// orchestrator 完成 video_gen 步骤时读取该列写入 output_json 的 assetId，
/// 供前端按 stepKey 解析镜头成片素材。
pub async fn set_result_asset(
    pool: &SqlitePool,
    generation_id: &str,
    asset_id: &str,
) -> Result<()> {
    sqlx::query("UPDATE video_generations SET result_asset_id = ? WHERE id = ?")
        .bind(asset_id)
        .bind(generation_id)
        .execute(pool)
        .await?;
    Ok(())
}
