use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::model::{Asset, AssetReference, AssetSearchQuery};

pub async fn create_asset(
    pool: &SqlitePool,
    project_id: &str,
    name: &str,
    asset_type: &str,
    url: &str,
    metadata: Option<&str>,
) -> AppResult<Asset> {
    let id = Uuid::new_v4().to_string();
    sqlx::query_as::<_, Asset>(
        "INSERT INTO assets (id, project_id, name, asset_type, url, metadata)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&id)
    .bind(project_id)
    .bind(name)
    .bind(asset_type)
    .bind(url)
    .bind(metadata)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_by_project(pool: &SqlitePool, project_id: &str) -> AppResult<Vec<Asset>> {
    sqlx::query_as::<_, Asset>(
        "SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC, id DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_by_user(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Asset>> {
    sqlx::query_as::<_, Asset>(
        "SELECT a.*
         FROM assets a
         INNER JOIN projects p ON p.id = a.project_id
         WHERE p.user_id = ?
         ORDER BY a.created_at DESC, a.id DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn find_by_id(pool: &SqlitePool, id: &str) -> AppResult<Option<Asset>> {
    sqlx::query_as::<_, Asset>("SELECT * FROM assets WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

pub async fn update_asset(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    asset_type: &str,
    url: &str,
    metadata: Option<&str>,
) -> AppResult<Asset> {
    sqlx::query(
        "UPDATE assets
         SET name = ?, asset_type = ?, url = ?, metadata = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(name)
    .bind(asset_type)
    .bind(url)
    .bind(metadata)
    .bind(id)
    .execute(pool)
    .await?;

    find_by_id(pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound("资产不存在".into()))
}

pub async fn delete_asset(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM assets WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 跨项目素材搜索
pub async fn search_assets(
    pool: &SqlitePool,
    user_id: &str,
    query: &AssetSearchQuery,
) -> AppResult<Vec<Asset>> {
    // 构建基础查询：只返回当前用户有权限的素材
    let mut sql = String::from(
        "SELECT DISTINCT a.*
         FROM assets a
         INNER JOIN projects p ON p.id = a.project_id
         WHERE p.user_id = ?",
    );
    let mut bindings: Vec<String> = vec![user_id.to_string()];

    // 项目筛选
    if let Some(ref project_id) = query.project_id {
        sql.push_str(" AND a.project_id = ?");
        bindings.push(project_id.clone());
    }

    // 类型筛选
    if let Some(ref asset_type) = query.asset_type {
        sql.push_str(" AND a.asset_type = ?");
        bindings.push(asset_type.clone());
    }

    // 搜索关键词：匹配素材名、项目名、metadata 中常见字段
    if let Some(ref keyword) = query.query {
        let like_pattern = format!("%{}%", keyword.trim());
        sql.push_str(
            " AND (
                a.name LIKE ? COLLATE NOCASE
                OR p.name LIKE ? COLLATE NOCASE
                OR json_extract(a.metadata, '$.prompt') LIKE ? COLLATE NOCASE
                OR json_extract(a.metadata, '$.summary') LIKE ? COLLATE NOCASE
                OR json_extract(a.metadata, '$.description') LIKE ? COLLATE NOCASE
                OR json_extract(a.metadata, '$.tags') LIKE ? COLLATE NOCASE
            )"
        );
        for _ in 0..6 {
            bindings.push(like_pattern.clone());
        }
    }

    // 收藏筛选
    if query.favorite_only.unwrap_or(false) {
        sql.push_str(" AND json_extract(a.metadata, '$.favorite') = true");
    }

    // 最低评分筛选
    if let Some(rating_min) = query.rating_min {
        if rating_min > 0 {
            sql.push_str(" AND CAST(json_extract(a.metadata, '$.rating') AS INTEGER) >= ?");
            bindings.push(rating_min.to_string());
        }
    }

    // 标签筛选
    if let Some(ref tag) = query.tag {
        sql.push_str(" AND json_extract(a.metadata, '$.tags') LIKE ?");
        bindings.push(format!("%\"{}\"%", tag));
    }

    // 排序
    let sort_field = match query.sort.as_deref() {
        Some("updatedAt") => "a.updated_at",
        Some("name") => "a.name COLLATE NOCASE",
        Some("rating") => "CAST(json_extract(a.metadata, '$.rating') AS INTEGER)",
        _ => "a.created_at",
    };
    let order_dir = match query.order.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };
    sql.push_str(&format!(" ORDER BY {} {}", sort_field, order_dir));

    // 分页
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let offset = query.offset.unwrap_or(0).max(0);
    sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

    // 执行查询
    let mut query_builder = sqlx::query_as::<_, Asset>(&sql);
    for binding in &bindings {
        query_builder = query_builder.bind(binding);
    }

    query_builder.fetch_all(pool).await.map_err(Into::into)
}

/// 查询素材的引用关系（分镜引用 + 流水线引用）
pub async fn find_asset_references(
    pool: &SqlitePool,
    asset_id: &str,
) -> AppResult<Vec<AssetReference>> {
    let mut references = Vec::new();

    // 1. 分镜引用 (storyboard_line_assets)
    let storyboard_refs = sqlx::query_as::<_, AssetReference>(
        "SELECT
            'storyboard' AS ref_type,
            p.id AS project_id,
            p.name AS project_name,
            '第' || sl.scene_number || '镜' AS ref_key,
            '分镜: ' || COALESCE(substr(sl.description, 1, 60), sl.id) AS ref_title
         FROM storyboard_line_assets sla
         INNER JOIN storyboard_lines sl ON sl.id = sla.storyboard_line_id
         INNER JOIN storyboards s ON s.id = sl.storyboard_id
         INNER JOIN projects p ON p.id = s.project_id
         WHERE sla.asset_id = ?
         ORDER BY sl.scene_number ASC",
    )
    .bind(asset_id)
    .fetch_all(pool)
    .await?;
    references.extend(storyboard_refs);

    // 2. 流水线引用 (pipeline_step_outputs)
    // 检查 pipeline_step_outputs.output_json 和 raw_content 中是否包含 asset_id
    let pipeline_refs = sqlx::query_as::<_, AssetReference>(
        "SELECT DISTINCT
            'pipeline' AS ref_type,
            p.id AS project_id,
            p.name AS project_name,
            prs.step_key AS ref_key,
            '流水线步骤: ' || COALESCE(prs.step_name, prs.step_key) AS ref_title
         FROM pipeline_step_outputs pso
         INNER JOIN pipeline_run_steps prs ON prs.id = pso.step_id
         INNER JOIN pipeline_runs pr ON pr.id = pso.run_id
         INNER JOIN projects p ON p.id = pr.project_id
         WHERE (
             pso.output_json LIKE ?
             OR pso.raw_content LIKE ?
         )
         ORDER BY pr.created_at DESC",
    )
    .bind(format!("%\"{}\"%", asset_id))
    .bind(format!("%{}%", asset_id))
    .fetch_all(pool)
    .await?;
    references.extend(pipeline_refs);

    Ok(references)
}

/// 统计素材的引用数量
pub async fn count_asset_references(pool: &SqlitePool, asset_id: &str) -> AppResult<i64> {
    // 统计分镜引用
    let storyboard_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM storyboard_line_assets WHERE asset_id = ?",
    )
    .bind(asset_id)
    .fetch_one(pool)
    .await?;

    // 统计流水线引用
    let pipeline_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT pso.step_id)
         FROM pipeline_step_outputs pso
         WHERE pso.output_json LIKE ? OR pso.raw_content LIKE ?",
    )
    .bind(format!("%\"{}\"%", asset_id))
    .bind(format!("%{}%", asset_id))
    .fetch_one(pool)
    .await?;

    Ok(storyboard_count + pipeline_count)
}

/// 检查素材是否存在引用
pub async fn has_asset_references(pool: &SqlitePool, asset_id: &str) -> AppResult<bool> {
    let count = count_asset_references(pool, asset_id).await?;
    Ok(count > 0)
}
