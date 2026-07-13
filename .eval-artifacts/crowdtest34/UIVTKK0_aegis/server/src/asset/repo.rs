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

pub fn merge_metadata(existing: Option<&str>, patch: &serde_json::Value) -> String {
    let mut merged: serde_json::Map<String, serde_json::Value> = existing
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    if let Some(patch_object) = patch.as_object() {
        for (key, value) in patch_object {
            merged.insert(key.clone(), value.clone());
        }
    }

    serde_json::Value::Object(merged).to_string()
}

pub async fn search_assets(
    pool: &SqlitePool,
    user_id: &str,
    query: &AssetSearchQuery,
) -> AppResult<Vec<AssetWithProject>> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset = query.offset.unwrap_or(0).max(0);

    let mut conditions = vec!["p.user_id = ?".to_string()];
    let mut params: Vec<String> = vec![user_id.to_string()];

    if let Some(project_id) = query.project_id.as_deref().map(str::trim) {
        if !project_id.is_empty() {
            conditions.push("a.project_id = ?".to_string());
            params.push(project_id.to_string());
        }
    }

    if let Some(asset_type) = query.asset_type.as_deref().map(str::trim) {
        if !asset_type.is_empty() {
            conditions.push("a.asset_type = ?".to_string());
            params.push(asset_type.to_string());
        }
    }

    if query.favorite_only.unwrap_or(false) {
        conditions.push(
            "json_valid(a.metadata) AND json_extract(a.metadata, '$.favorite') = 1".to_string(),
        );
    }

    if let Some(rating_min) = query.rating_min {
        let clamped = rating_min.clamp(1, 5);
        conditions.push(
            "json_valid(a.metadata)
             AND CAST(IFNULL(json_extract(a.metadata, '$.rating'), 0) AS INTEGER) >= ?"
                .to_string(),
        );
        params.push(clamped.to_string());
    }

    if let Some(tag) = query.tag.as_deref().map(str::trim) {
        if !tag.is_empty() {
            conditions.push(
                "json_valid(a.metadata)
                 AND EXISTS (
                    SELECT 1
                    FROM json_each(json_extract(a.metadata, '$.tags')) tag_item
                    WHERE tag_item.value = ?
                 )"
                .to_string(),
            );
            params.push(tag.to_string());
        }
    }

    if let Some(search) = query.query.as_deref().map(str::trim) {
        if !search.is_empty() {
            let like = format!("%{}%", search.replace('%', "").replace('_', ""));
            conditions.push(
                "(a.name LIKE ? OR p.name LIKE ?
                  OR CASE WHEN json_valid(a.metadata)
                     THEN IFNULL(json_extract(a.metadata, '$.prompt'), '')
                     ELSE ''
                     END LIKE ?
                  OR CASE WHEN json_valid(a.metadata)
                     THEN IFNULL(json_extract(a.metadata, '$.summary'), '')
                     ELSE ''
                     END LIKE ?
                  OR CASE WHEN json_valid(a.metadata)
                     THEN IFNULL(json_extract(a.metadata, '$.description'), '')
                     ELSE ''
                     END LIKE ?)"
                    .to_string(),
            );
            for _ in 0..5 {
                params.push(like.clone());
            }
        }
    }

    let order_clause = match query.sort.as_deref() {
        Some("name") => "a.name ASC",
        Some("rating") => {
            "CAST(CASE WHEN json_valid(a.metadata)
                THEN IFNULL(json_extract(a.metadata, '$.rating'), 0)
                ELSE 0
             END AS INTEGER) DESC, a.created_at DESC"
        }
        Some("created") => "a.created_at ASC",
        _ => "a.created_at DESC",
    };

    let sql = format!(
        "SELECT a.id, a.project_id, p.name AS project_name, a.name, a.asset_type, a.url,
                a.metadata, a.created_at, a.updated_at
         FROM assets a
         INNER JOIN projects p ON p.id = a.project_id
         WHERE {}
         ORDER BY {}
         LIMIT ? OFFSET ?",
        conditions.join(" AND "),
        order_clause
    );

    let mut db_query = sqlx::query_as::<_, AssetWithProject>(&sql);
    for param in &params {
        db_query = db_query.bind(param);
    }
    db_query = db_query.bind(limit).bind(offset);

    db_query.fetch_all(pool).await.map_err(Into::into)
}

pub async fn find_asset_references(
    pool: &SqlitePool,
    asset_id: &str,
) -> AppResult<Vec<AssetReference>> {
    let mut references = Vec::new();

    let storyboard_refs = sqlx::query_as::<_, (String, String, String, i64, String)>(
        "SELECT p.id, p.name, sl.id, sl.scene_number, COALESCE(sl.description, '')
         FROM storyboard_line_assets sla
         INNER JOIN storyboard_lines sl ON sl.id = sla.storyboard_line_id
         INNER JOIN storyboards sb ON sb.id = sl.storyboard_id
         INNER JOIN projects p ON p.id = sb.project_id
         WHERE sla.asset_id = ?
         ORDER BY p.name, sl.scene_number, sl.sort_order",
    )
    .bind(asset_id)
    .fetch_all(pool)
    .await?;

    for (project_id, project_name, line_id, scene_number, description) in storyboard_refs {
        let title = if description.trim().is_empty() {
            format!("Storyboard scene {}", scene_number)
        } else {
            let trimmed = description.trim();
            let display = if trimmed.chars().count() > 40 {
                format!("{}...", trimmed.chars().take(40).collect::<String>())
            } else {
                trimmed.to_string()
            };
            format!("Storyboard scene {} - {}", scene_number, display)
        };
        references.push(AssetReference {
            ref_type: AssetReferenceType::Storyboard,
            project_id,
            project_name,
            title,
            sub_locator: Some(format!("scene-{}", scene_number)),
            entity_id: Some(line_id),
        });
    }

    let pipeline_output_refs =
        sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
            "SELECT p.id, p.name, prs.id, prs.step_name, prs.step_key
         FROM pipeline_step_outputs pso
         INNER JOIN pipeline_run_steps prs ON prs.id = pso.step_id
         INNER JOIN pipeline_runs pr ON pr.id = pso.run_id
         INNER JOIN projects p ON p.id = pr.project_id
         WHERE json_valid(pso.output_json)
           AND (
                json_extract(pso.output_json, '$.assetId') = ?
                OR EXISTS (
                    SELECT 1
                    FROM json_each(json_extract(pso.output_json, '$.assetIds')) asset_id_item
                    WHERE asset_id_item.value = ?
                )
           )
         ORDER BY p.name, pr.created_at DESC",
        )
        .bind(asset_id)
        .bind(asset_id)
        .fetch_all(pool)
        .await?;

    for (project_id, project_name, step_id, step_name, step_key) in pipeline_output_refs {
        references.push(AssetReference {
            ref_type: AssetReferenceType::PipelineStep,
            project_id,
            project_name,
            title: format!("Pipeline step output - {}", step_name),
            sub_locator: step_key,
            entity_id: Some(step_id),
        });
    }

    let pipeline_input_refs =
        sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
            "SELECT p.id, p.name, prs.id, prs.step_name, prs.step_key
         FROM pipeline_run_steps prs
         INNER JOIN pipeline_runs pr ON pr.id = prs.run_id
         INNER JOIN projects p ON p.id = pr.project_id
         WHERE prs.output_ref = ?
            OR (
                json_valid(prs.input_summary)
                AND (
                    json_extract(prs.input_summary, '$.assetId') = ?
                    OR EXISTS (
                        SELECT 1
                        FROM json_each(json_extract(prs.input_summary, '$.assetIds')) asset_id_item
                        WHERE asset_id_item.value = ?
                    )
                )
            )
         ORDER BY p.name, pr.created_at DESC",
        )
        .bind(asset_id)
        .bind(asset_id)
        .bind(asset_id)
        .fetch_all(pool)
        .await?;

    for (project_id, project_name, step_id, step_name, step_key) in pipeline_input_refs {
        references.push(AssetReference {
            ref_type: AssetReferenceType::PipelineStepInput,
            project_id,
            project_name,
            title: format!("Pipeline step input - {}", step_name),
            sub_locator: step_key,
            entity_id: Some(step_id),
        });
    }

    Ok(references)
}

pub async fn count_asset_references(pool: &SqlitePool, asset_id: &str) -> AppResult<i64> {
    let storyboard_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM storyboard_line_assets WHERE asset_id = ?")
            .bind(asset_id)
            .fetch_one(pool)
            .await
            .unwrap_or(0);

    let pipeline_output_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM pipeline_step_outputs
         WHERE json_valid(output_json)
           AND (
                json_extract(output_json, '$.assetId') = ?
                OR EXISTS (
                    SELECT 1
                    FROM json_each(json_extract(output_json, '$.assetIds')) asset_id_item
                    WHERE asset_id_item.value = ?
                )
           )",
    )
    .bind(asset_id)
    .bind(asset_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    let pipeline_input_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM pipeline_run_steps
         WHERE output_ref = ?
            OR (
                json_valid(input_summary)
                AND (
                    json_extract(input_summary, '$.assetId') = ?
                    OR EXISTS (
                        SELECT 1
                        FROM json_each(json_extract(input_summary, '$.assetIds')) asset_id_item
                        WHERE asset_id_item.value = ?
                    )
                )
            )",
    )
    .bind(asset_id)
    .bind(asset_id)
    .bind(asset_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    Ok(storyboard_count + pipeline_output_count + pipeline_input_count)
}

pub async fn update_asset_tags(
    pool: &SqlitePool,
    asset_id: &str,
    tags: &[String],
) -> AppResult<Asset> {
    let asset = find_by_id(pool, asset_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Asset not found".into()))?;

    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_ascii_lowercase()) {
            normalized.push(trimmed.to_string());
        }
    }

    let patch = serde_json::json!({ "tags": normalized });
    let metadata = merge_metadata(asset.metadata.as_deref(), &patch);

    sqlx::query(
        "UPDATE assets
         SET metadata = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(&metadata)
    .bind(asset_id)
    .execute(pool)
    .await?;

    find_by_id(pool, asset_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Asset not found".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_metadata_preserves_existing_keys() {
        let existing = r#"{"favorite":true,"rating":5,"prompt":"test","sizeBytes":1024}"#;
        let patch = serde_json::json!({"tags": ["a", "b"]});
        let merged: serde_json::Value =
            serde_json::from_str(&merge_metadata(Some(existing), &patch)).unwrap();

        assert_eq!(merged["favorite"], serde_json::json!(true));
        assert_eq!(merged["rating"], serde_json::json!(5));
        assert_eq!(merged["prompt"], serde_json::json!("test"));
        assert_eq!(merged["sizeBytes"], serde_json::json!(1024));
        assert_eq!(merged["tags"], serde_json::json!(["a", "b"]));
    }

    #[test]
    fn merge_metadata_handles_empty_or_invalid_existing_value() {
        let patch = serde_json::json!({"tags": ["x"]});

        let empty: serde_json::Value = serde_json::from_str(&merge_metadata(None, &patch)).unwrap();
        let invalid: serde_json::Value =
            serde_json::from_str(&merge_metadata(Some("not-json"), &patch)).unwrap();

        assert_eq!(empty["tags"], serde_json::json!(["x"]));
        assert_eq!(invalid["tags"], serde_json::json!(["x"]));
    }
}
