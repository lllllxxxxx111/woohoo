use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::AppResult;

use super::model::{ExportAuditRecord, RecordExportAuditReq, BUNDLE_SCHEMA_VERSION};

pub async fn insert_audit(
    pool: &SqlitePool,
    user_id: &str,
    req: &RecordExportAuditReq,
) -> AppResult<ExportAuditRecord> {
    let id = Uuid::new_v4().to_string();
    let client_info_json = req
        .client_info
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok());

    sqlx::query_as::<_, ExportAuditRecord>(
        r#"INSERT INTO export_audits
           (id, user_id, project_id, export_type, bundle_version, status, filename,
            total_assets, included_assets, missing_assets,
            script_sections, chapters, shots, conversations, total_duration, bundle_size_bytes,
            precheck_passed, checksums_valid, has_sensitive_data,
            script_sha256, storyboard_sha256, manifest_sha256,
            client_info, error_message, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?,
                   ?, ?, ?, ?, ?, ?,
                   ?, ?, ?,
                   ?, ?, ?,
                   ?, ?, ?)
           RETURNING *"#,
    )
    .bind(&id)
    .bind(user_id)
    .bind(&req.project_id)
    .bind(&req.export_type)
    .bind(BUNDLE_SCHEMA_VERSION)
    .bind(&req.status)
    .bind(req.filename.as_deref().unwrap_or(""))
    .bind(req.total_assets.unwrap_or(0))
    .bind(req.included_assets.unwrap_or(0))
    .bind(req.missing_assets.unwrap_or(0))
    .bind(req.script_sections.unwrap_or(0))
    .bind(req.chapters.unwrap_or(0))
    .bind(req.shots.unwrap_or(0))
    .bind(req.conversations.unwrap_or(0))
    .bind(req.total_duration.unwrap_or(0))
    .bind(req.bundle_size_bytes.unwrap_or(0))
    .bind(req.precheck_passed.unwrap_or(false) as i64)
    .bind(req.checksums_valid.unwrap_or(false) as i64)
    .bind(req.has_sensitive_data.unwrap_or(false) as i64)
    .bind(&req.script_sha256)
    .bind(&req.storyboard_sha256)
    .bind(&req.manifest_sha256)
    .bind(client_info_json)
    .bind(&req.error_message)
    .bind(&req.notes)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_audits_by_project(
    pool: &SqlitePool,
    project_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<(Vec<ExportAuditRecord>, i64)> {
    let items = sqlx::query_as::<_, ExportAuditRecord>(
        r#"SELECT * FROM export_audits
           WHERE project_id = ?
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?"#,
    )
    .bind(project_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM export_audits WHERE project_id = ?")
        .bind(project_id)
        .fetch_one(pool)
        .await?;

    Ok((items, total.0))
}

pub async fn list_audits_by_user(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<(Vec<ExportAuditRecord>, i64)> {
    let items = sqlx::query_as::<_, ExportAuditRecord>(
        r#"SELECT * FROM export_audits
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?"#,
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM export_audits WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await?;

    Ok((items, total.0))
}
