use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::model::{Asset, AssetReference, AssetReferenceType, AssetSearchQuery, AssetWithProject};

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

/**
 * Merge a new metadata JSON object into the existing metadata string.
 * Preserves existing keys unless explicitly overwritten by the patch.
 */
pub fn merge_metadata(existing: Option<&str>, patch: &serde_json::Value) -> String {
    let mut merged: serde_json::Map<String, serde_json::Value> = existing
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    if let Some(patch_obj) = patch.as_object() {
        for (k, v) in patch_obj {
            merged.insert(k.clone(), v.clone());
        }
    }

    serde_json::Value::Object(merged).to_string()
}

/**
 * Cross-project asset search scoped to a single user.
 *
 * Joins assets with projects for permission filtering and project name display.
 * Applies filters from AssetSearchQuery and returns AssetWithProject rows.
 */
pub async fn search_assets(
    pool: &SqlitePool,
    user_id: &str,
    query: &AssetSearchQuery,
) -> AppResult<Vec<AssetWithProject>> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset = query.offset.unwrap_or(0).max(0);

    // Build dynamic WHERE clause
    let mut conditions = vec!["p.user_id = ?".to_string()];
    let mut params: Vec<String> = vec![user_id.to_string()];

    if let Some(pid) = &query.project_id {
        conditions.push("a.project_id = ?".to_string());
        params.push(pid.clone());
    }

    if let Some(atype) = &query.asset_type {
        conditions.push("a.asset_type = ?".to_string());
        params.push(atype.clone());
    }

    if query.favorite_only.unwrap_or(false) {
        conditions.push(
            "json_extract(a.metadata, '$.favorite') = true".to_string(),
        );
    }

    if let Some(rating_min) = query.rating_min {
        let clamped = rating_min.clamp(1, 5);
        conditions.push(format!(
            "CAST(json_extract(a.metadata, '$.rating') AS INTEGER) >= ?"
        ));
        params.push(clamped.to_string());
    }

    if let Some(tag) = &query.tag {
        if !tag.trim().is_empty() {
            // Check if tag exists in the JSON tags array using json_each
            conditions.push(
                "EXISTS (SELECT 1 FROM json_each(json_extract(a.metadata, '$.tags')) je WHERE je.value = ?)"
                    .to_string(),
            );
            params.push(tag.trim().to_string());
        }
    }

    if let Some(q) = &query.query {
        let q_trimmed = q.trim();
        if !q_trimmed.is_empty() {
            let like = format!("%{}%", q_trimmed.replace('%', "").replace('_', ""));
            conditions.push(format!(
                "(a.name LIKE ? OR p.name LIKE ? OR \
                 IFNULL(json_extract(a.metadata, '$.prompt'), '') LIKE ? OR \
                 IFNULL(json_extract(a.metadata, '$.summary'), '') LIKE ? OR \
                 IFNULL(json_extract(a.metadata, '$.description'), '') LIKE ?)"
            ));
            for _ in 0..5 {
                params.push(like.clone());
            }
        }
    }

    // Build ORDER BY
    let order_clause = match query.sort.as_deref() {
        Some("name") => "a.name ASC",
        Some("rating") => "CAST(IFNULL(json_extract(a.metadata, '$.rating'), 0) AS INTEGER) DESC, a.created_at DESC",
        Some("created") => "a.created_at ASC",
        _ => "a.created_at DESC", // "recent" is default
    };

    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT a.id, a.project_id, p.name AS project_name, a.name, a.asset_type, a.url, \
                a.metadata, a.created_at, a.updated_at
         FROM assets a
         INNER JOIN projects p ON p.id = a.project_id
         {}
         ORDER BY {}
         LIMIT ? OFFSET ?",
        where_sql, order_clause
    );

    // Build query with all bound parameters
    let mut q = sqlx::query_as::<_, AssetWithProject>(&sql);
    for p in &params {
        q = q.bind(p);
    }
    q = q.bind(limit);
    q = q.bind(offset);

    let results = q.fetch_all(pool).await.map_err(|e| {
        tracing::error!(error = %e, "search_assets query failed");
        AppError::Internal(format!("搜索失败: {}", e))
    })?;

    Ok(results)
}

/**
 * Find all references to a given asset across storyboards and pipelines.
 *
 * Checks:
 * 1. storyboard_line_assets (direct association table)
 * 2. pipeline_step_outputs (output_json contains assetId)
 * 3. pipeline_run_steps (output_ref field, though it typically points to outputs)
 */
pub async fn find_asset_references(
    pool: &SqlitePool,
    asset_id: &str,
) -> AppResult<Vec<AssetReference>> {
    let mut refs: Vec<AssetReference> = Vec::new();

    // 1. Storyboard references via storyboard_line_assets
    let storyboard_refs = sqlx::query_as::<_, (String, String, String, Option<i64>, String, Option<String>)>(
        "SELECT p.id, p.name, sl.id, sl.scene_number, COALESCE(sl.description, ''), sl.sort_order
         FROM storyboard_line_assets sla
         JOIN storyboard_lines sl ON sl.id = sla.storyboard_line_id
         JOIN storyboards sb ON sb.id = sl.storyboard_id
         JOIN projects p ON p.id = sb.project_id
         WHERE sla.asset_id = ?
         ORDER BY p.name, sl.scene_number, sl.sort_order",
    )
    .bind(asset_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询分镜引用失败: {}", e)))?;

    for (project_id, project_name, line_id, scene_number, description, _sort) in storyboard_refs {
        let scene = scene_number.unwrap_or(0);
        let title = if description.trim().is_empty() {
            format!("第 {} 镜", scene)
        } else {
            let trimmed = description.trim();
            let display = if trimmed.chars().count() > 40 {
                format!("{}...", trimmed.chars().take(40).collect::<String>())
            } else {
                trimmed.to_string()
            };
            format!("第 {} 镜: {}", scene, display)
        };
        refs.push(AssetReference {
            ref_type: AssetReferenceType::Storyboard,
            project_id,
            project_name,
            title,
            sub_locator: Some(format!("scene-{}", scene)),
            entity_id: Some(line_id),
        });
    }

    // 2. Pipeline step output references (output_json contains assetId)
    //    These are documents/artifacts produced by pipeline steps that reference this asset.
    let pipeline_output_refs = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT p.id, p.name, prs.id, prs.step_name, prs.step_key
         FROM pipeline_step_outputs pso
         JOIN pipeline_run_steps prs ON prs.id = pso.step_id
         JOIN pipeline_runs pr ON pr.id = pso.run_id
         JOIN projects p ON p.id = pr.project_id
         WHERE json_extract(pso.output_json, '$.assetId') = ?
         ORDER BY p.name, pr.created_at DESC",
    )
    .bind(asset_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询流水线输出引用失败: {}", e)))?;

    for (project_id, project_name, step_id, step_name, step_key) in pipeline_output_refs {
        refs.push(AssetReference {
            ref_type: AssetReferenceType::PipelineStep,
            project_id,
            project_name,
            title: format!("流水线步骤: {}", step_name),
            sub_locator: step_key,
            entity_id: Some(step_id),
        });
    }

    // 3. Pipeline step input references (output_ref pointing to the asset URL,
    //    or input_summary containing the assetId)
    let pipeline_input_refs = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT p.id, p.name, prs.id, prs.step_name, prs.step_key
         FROM pipeline_run_steps prs
         JOIN pipeline_runs pr ON pr.id = prs.run_id
         JOIN projects p ON p.id = pr.project_id
         WHERE prs.output_ref = ?
            OR json_extract(prs.input_summary, '$.assetId') = ?
         ORDER BY p.name, pr.created_at DESC",
    )
    .bind(asset_id)
    .bind(asset_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询流水线输入引用失败: {}", e)))?;

    for (project_id, project_name, step_id, step_name, step_key) in pipeline_input_refs {
        // Avoid duplicates if already in output_refs
        if refs.iter().any(|r| r.entity_id.as_deref() == Some(&step_id) && r.ref_type == AssetReferenceType::PipelineStepInput) {
            continue;
        }
        refs.push(AssetReference {
            ref_type: AssetReferenceType::PipelineStepInput,
            project_id,
            project_name,
            title: format!("流水线步骤输入: {}", step_name),
            sub_locator: step_key,
            entity_id: Some(step_id),
        });
    }

    Ok(refs)
}

/**
 * Count references to an asset (lightweight check for delete protection).
 */
pub async fn count_asset_references(pool: &SqlitePool, asset_id: &str) -> AppResult<i64> {
    // Count storyboard refs
    let sb_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM storyboard_line_assets WHERE asset_id = ?",
    )
    .bind(asset_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    // Count pipeline output refs
    let pso_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pipeline_step_outputs WHERE json_extract(output_json, '$.assetId') = ?",
    )
    .bind(asset_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    // Count pipeline step input refs
    let psi_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pipeline_run_steps
         WHERE output_ref = ? OR json_extract(input_summary, '$.assetId') = ?",
    )
    .bind(asset_id)
    .bind(asset_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    Ok(sb_count + pso_count + psi_count)
}

/**
 * Update asset tags in metadata. Merges tags array into existing metadata
 * without overwriting favorite/rating/prompt/sizeBytes/etc.
 */
pub async fn update_asset_tags(
    pool: &SqlitePool,
    asset_id: &str,
    tags: &[String],
) -> AppResult<Asset> {
    let asset = find_by_id(pool, asset_id)
        .await?
        .ok_or_else(|| AppError::NotFound("资产不存在".into()))?;

    // Normalize tags: trim, deduplicate (case-sensitive for display; but dedupe case-insensitively)
    let mut normalized: Vec<String> = Vec::new();
    let mut seen_lower = std::collections::HashSet::new();
    for tag in tags {
        let t = tag.trim();
        if t.is_empty() {
            continue;
        }
        if seen_lower.insert(t.to_lowercase()) {
            normalized.push(t.to_string());
        }
    }

    // Build tags patch JSON
    let patch = serde_json::json!({ "tags": normalized });
    let merged = merge_metadata(asset.metadata.as_deref(), &patch);

    sqlx::query(
        "UPDATE assets SET metadata = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
    )
    .bind(&merged)
    .bind(asset_id)
    .execute(pool)
    .await?;

    find_by_id(pool, asset_id)
        .await?
        .ok_or_else(|| AppError::NotFound("资产不存在".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_metadata_preserves_existing_keys() {
        let existing = r#"{"favorite":true,"rating":5,"prompt":"test","sizeBytes":1024}"#;
        let patch = serde_json::json!({"tags": ["a", "b"]});
        let merged: serde_json::Value = serde_json::from_str(&merge_metadata(Some(existing), &patch)).unwrap();

        assert_eq!(merged["favorite"], serde_json::json!(true));
        assert_eq!(merged["rating"], serde_json::json!(5));
        assert_eq!(merged["prompt"], serde_json::json!("test"));
        assert_eq!(merged["sizeBytes"], serde_json::json!(1024));
        assert_eq!(merged["tags"], serde_json::json!(["a", "b"]));
    }

    #[test]
    fn test_merge_metadata_with_null_existing() {
        let patch = serde_json::json!({"tags": ["x"]});
        let merged: serde_json::Value = serde_json::from_str(&merge_metadata(None, &patch)).unwrap();
        assert_eq!(merged["tags"], serde_json::json!(["x"]));
    }

    #[test]
    fn test_merge_metadata_overwrites_specific_key() {
        let existing = r#"{"tags":["old"],"rating":3}"#;
        let patch = serde_json::json!({"tags": ["new"]});
        let merged: serde_json::Value = serde_json::from_str(&merge_metadata(Some(existing), &patch)).unwrap();
        assert_eq!(merged["tags"], serde_json::json!(["new"]));
        assert_eq!(merged["rating"], serde_json::json!(3));
    }

    #[test]
    fn test_merge_metadata_with_invalid_existing() {
        let patch = serde_json::json!({"tags": []});
        let merged: serde_json::Value = serde_json::from_str(&merge_metadata(Some("not-json"), &patch)).unwrap();
        assert_eq!(merged["tags"], serde_json::json!([]));
    }
}
