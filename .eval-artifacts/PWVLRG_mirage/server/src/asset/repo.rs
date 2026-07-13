use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::model::{Asset, AssetReference, AssetSearchItem, AssetSearchQuery};

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

// ─── 跨项目搜索 ────────────────────────────────────────────────

/**
 * 构建跨项目搜索的 WHERE 子句和参数绑定
 *
 * 搜索范围：仅限当前用户拥有的项目中的素材
 * 搜索字段：素材名、项目名、metadata.prompt、metadata.summary、metadata.description、metadata.tags
 */
fn build_search_where_clause(query: &AssetSearchQuery) -> (String, Vec<String>) {
    let mut conditions = vec!["p.user_id = ?".to_string()];
    let mut params: Vec<String> = Vec::new();

    // 项目过滤
    if let Some(pid) = &query.project_id {
        conditions.push("a.project_id = ?".to_string());
        params.push(pid.clone());
    }

    // 类型过滤
    if let Some(atype) = &query.asset_type {
        conditions.push("a.asset_type = ?".to_string());
        params.push(atype.clone());
    }

    // 关键字搜索
    if let Some(q) = &query.query {
        let trimmed = q.trim();
        if !trimmed.is_empty() {
            let like = format!("%{}%", trimmed.replace('%', "").replace('_', ""));
            conditions.push(
                "(a.name LIKE ? OR p.name LIKE ? \
                 OR json_extract(a.metadata, '$.prompt') LIKE ? \
                 OR json_extract(a.metadata, '$.summary') LIKE ? \
                 OR json_extract(a.metadata, '$.description') LIKE ? \
                 OR json_extract(a.metadata, '$.tags') LIKE ?)"
                    .to_string(),
            );
            for _ in 0..6 {
                params.push(like.clone());
            }
        }
    }

    // 仅收藏
    if query.favorite_only.unwrap_or(false) {
        conditions.push("json_extract(a.metadata, '$.favorite') = true".to_string());
    }

    // 最低评分
    if let Some(min_rating) = query.rating_min {
        if min_rating > 0 {
            conditions.push(
                "COALESCE(CAST(json_extract(a.metadata, '$.rating') AS INTEGER), 0) >= ?"
                    .to_string(),
            );
            params.push(min_rating.to_string());
        }
    }

    // 标签过滤
    if let Some(tag) = &query.tag {
        let trimmed = tag.trim();
        if !trimmed.is_empty() {
            // SQLite JSON 数组包含检查：tags LIKE '%"tag"%'（简单但有效）
            let tag_like = format!("%\"{}%\"%", trimmed.replace('%', "").replace('_', ""));
            // 也兼容非引号版本（老数据可能是纯值数组）
            let tag_like2 = format!("%{}%", trimmed.replace('%', "").replace('_', ""));
            conditions.push(
                "(json_extract(a.metadata, '$.tags') LIKE ? OR json_extract(a.metadata, '$.tags') LIKE ?)"
                    .to_string(),
            );
            params.push(tag_like);
            params.push(tag_like2);
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    (where_clause, params)
}

/**
 * 跨项目搜索素材（仅返回当前用户有权限的素材）
 */
pub async fn search_assets(
    pool: &SqlitePool,
    user_id: &str,
    query: &AssetSearchQuery,
) -> AppResult<(Vec<AssetSearchItem>, i64)> {
    let (where_clause, params) = build_search_where_clause(query);

    // 排序
    let sort_field = match query.sort.as_deref() {
        Some("name") => "a.name",
        Some("updated_at") | Some("updatedAt") => "a.updated_at",
        Some("rating") => "COALESCE(CAST(json_extract(a.metadata, '$.rating') AS INTEGER), 0)",
        _ => "a.created_at",
    };
    let sort_dir = match query.order.as_deref() {
        Some("asc") | Some("ASC") => "ASC",
        _ => "DESC",
    };

    // 分页
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset = query.offset.unwrap_or(0).max(0);

    // 注意：第一个参数始终是 user_id
    let mut bind_params: Vec<String> = vec![user_id.to_string()];
    bind_params.extend(params);

    // COUNT 查询
    let count_sql = format!(
        "SELECT COUNT(*) FROM assets a
         INNER JOIN projects p ON p.id = a.project_id
         {}",
        where_clause
    );

    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for p in &bind_params {
        count_query = count_query.bind(p);
    }
    let total: i64 = count_query.fetch_one(pool).await?;

    // 数据查询（带 project_name）
    let data_sql = format!(
        "SELECT a.id, a.project_id, p.name AS project_name,
                a.name, a.asset_type AS asset_type, a.url, a.metadata,
                a.created_at, a.updated_at
         FROM assets a
         INNER JOIN projects p ON p.id = a.project_id
         {}
         ORDER BY {} {}
         LIMIT ? OFFSET ?",
        where_clause, sort_field, sort_dir
    );

    let mut data_query = sqlx::query_as::<_, AssetSearchItem>(&data_sql);
    for p in &bind_params {
        data_query = data_query.bind(p);
    }
    data_query = data_query.bind(limit);
    data_query = data_query.bind(offset);

    let items = data_query.fetch_all(pool).await?;

    Ok((items, total))
}

// ─── 引用关系查询 ──────────────────────────────────────────────

/**
 * 查询素材被哪些实体引用
 *
 * 支持的引用类型：
 * 1. storyboard_line: 通过 storyboard_line_assets 关联表
 * 2. pipeline_step_output: 通过 pipeline_step_outputs.output_json 中的 assetId 字段
 */
pub async fn find_asset_references(
    pool: &SqlitePool,
    asset_id: &str,
) -> AppResult<Vec<AssetReference>> {
    let mut references = Vec::new();

    // 1. 分镜引用
    let storyboard_refs = sqlx::query_as::<_, AssetReference>(
        "SELECT
            'storyboard_line' AS ref_type,
            p.id AS project_id,
            p.name AS project_name,
            sl.id AS ref_id,
            COALESCE(
                '场景 ' || sl.scene_number || ' - ' ||
                CASE WHEN length(sl.description) > 60
                     THEN substr(sl.description, 1, 60) || '...'
                     ELSE sl.description END,
                '场景 ' || sl.scene_number
            ) AS title,
            'sceneNumber=' || sl.scene_number AS detail,
            sl.created_at AS created_at
         FROM storyboard_line_assets sla
         INNER JOIN storyboard_lines sl ON sl.id = sla.storyboard_line_id
         INNER JOIN storyboards sb ON sb.id = sl.storyboard_id
         INNER JOIN projects p ON p.id = sb.project_id
         WHERE sla.asset_id = ?
         ORDER BY sl.scene_number ASC, sl.sort_order ASC",
    )
    .bind(asset_id)
    .fetch_all(pool)
    .await
    .map_err(Into::<AppError>::into)?;

    references.extend(storyboard_refs);

    // 2. Pipeline step output 引用（output_json 包含 assetId 字段）
    let pipeline_refs = sqlx::query_as::<_, AssetReference>(
        "SELECT
            'pipeline_step_output' AS ref_type,
            pr.project_id AS project_id,
            p.name AS project_name,
            pso.id AS ref_id,
            COALESCE(
                '流程: ' || prs.step_name || ' (' || pr.pipeline_type || ')',
                '流程步骤输出'
            ) AS title,
            'stepKey=' || prs.step_key || ',runId=' || substr(pr.id, 1, 8) AS detail,
            pso.created_at AS created_at
         FROM pipeline_step_outputs pso
         INNER JOIN pipeline_run_steps prs ON prs.id = pso.step_id
         INNER JOIN pipeline_runs pr ON pr.id = pso.run_id
         INNER JOIN projects p ON p.id = pr.project_id
         WHERE json_extract(pso.output_json, '$.assetId') = ?
         ORDER BY pso.created_at DESC",
    )
    .bind(asset_id)
    .fetch_all(pool)
    .await
    .map_err(Into::<AppError>::into)?;

    references.extend(pipeline_refs);

    Ok(references)
}

/**
 * 快速检查素材是否被引用（用于删除保护）
 */
pub async fn has_asset_references(pool: &SqlitePool, asset_id: &str) -> AppResult<bool> {
    // 检查分镜引用
    let sb_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM storyboard_line_assets WHERE asset_id = ?",
    )
    .bind(asset_id)
    .fetch_one(pool)
    .await?;

    if sb_count > 0 {
        return Ok(true);
    }

    // 检查 pipeline 引用
    let pl_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pipeline_step_outputs
         WHERE json_extract(output_json, '$.assetId') = ?",
    )
    .bind(asset_id)
    .fetch_one(pool)
    .await?;

    Ok(pl_count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_search_where_clause_empty() {
        let q = AssetSearchQuery::default();
        let (where_clause, params) = build_search_where_clause(&q);
        assert_eq!(where_clause, "WHERE p.user_id = ?");
        assert!(params.is_empty());
    }

    #[test]
    fn test_build_search_where_clause_project_id() {
        let q = AssetSearchQuery {
            project_id: Some("proj-1".to_string()),
            ..Default::default()
        };
        let (where_clause, params) = build_search_where_clause(&q);
        assert!(where_clause.contains("a.project_id = ?"));
        assert_eq!(params, vec!["proj-1".to_string()]);
    }

    #[test]
    fn test_build_search_where_clause_type() {
        let q = AssetSearchQuery {
            asset_type: Some("image".to_string()),
            ..Default::default()
        };
        let (where_clause, params) = build_search_where_clause(&q);
        assert!(where_clause.contains("a.asset_type = ?"));
        assert_eq!(params, vec!["image".to_string()]);
    }

    #[test]
    fn test_build_search_where_clause_query() {
        let q = AssetSearchQuery {
            query: Some("test".to_string()),
            ..Default::default()
        };
        let (where_clause, params) = build_search_where_clause(&q);
        assert!(where_clause.contains("a.name LIKE ?"));
        assert!(where_clause.contains("json_extract(a.metadata, '$.prompt')"));
        assert_eq!(params.len(), 6);
        assert!(params.iter().all(|p| p == "%test%"));
    }

    #[test]
    fn test_build_search_where_clause_favorite_and_rating() {
        let q = AssetSearchQuery {
            favorite_only: Some(true),
            rating_min: Some(4),
            ..Default::default()
        };
        let (where_clause, params) = build_search_where_clause(&q);
        assert!(where_clause.contains("json_extract(a.metadata, '$.favorite') = true"));
        assert!(where_clause.contains("$.rating") && where_clause.contains(">= ?"));
        assert_eq!(params, vec!["4".to_string()]);
    }

    #[test]
    fn test_build_search_where_clause_tag() {
        let q = AssetSearchQuery {
            tag: Some("character".to_string()),
            ..Default::default()
        };
        let (where_clause, params) = build_search_where_clause(&q);
        assert!(where_clause.contains("$.tags"));
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn test_build_search_where_clause_combined() {
        let q = AssetSearchQuery {
            query: Some("landscape".to_string()),
            asset_type: Some("image".to_string()),
            favorite_only: Some(true),
            rating_min: Some(3),
            tag: Some("nature".to_string()),
            project_id: Some("proj-1".to_string()),
            ..Default::default()
        };
        let (where_clause, params) = build_search_where_clause(&q);
        // Should have: user_id + project_id + type + 6 query likes + favorite + rating + 2 tag likes
        assert!(where_clause.contains("a.project_id = ?"));
        assert!(where_clause.contains("a.asset_type = ?"));
        assert!(where_clause.contains("a.name LIKE ?"));
        assert!(where_clause.contains("$.favorite") && where_clause.contains("= true"));
        assert!(where_clause.contains("$.rating") && where_clause.contains(">= ?"));
        assert!(where_clause.contains("$.tags"));
        // params: project_id, type, (6x like), rating, (2x tag like) = 11
        assert_eq!(params.len(), 11);
    }
}
