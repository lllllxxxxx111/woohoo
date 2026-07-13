use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::AppResult;

use super::model::{ExportAuditRecord, ExportStatus, ExportType};

pub async fn create_audit(
    pool: &SqlitePool,
    project_id: &str,
    user_id: &str,
    export_type: ExportType,
    package_format: &str,
    client_info: Option<&str>,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    let export_version = super::model::EXPORT_MANIFEST_VERSION;

    sqlx::query(
        "INSERT INTO export_audits (id, project_id, user_id, export_type, package_format, export_version, status, client_info)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(project_id)
    .bind(user_id)
    .bind(export_type.as_str())
    .bind(package_format)
    .bind(export_version)
    .bind(ExportStatus::Pending.as_str())
    .bind(client_info)
    .execute(pool)
    .await?;

    Ok(id)
}

pub async fn update_audit_success(
    pool: &SqlitePool,
    id: &str,
    status: ExportStatus,
    manifest_json: &str,
    manifest_sha256: &str,
    verification_json: &str,
    total_assets: i64,
    included_assets: i64,
    missing_assets: i64,
    total_size_bytes: i64,
    filename: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE export_audits
         SET status = ?, manifest_json = ?, manifest_sha256 = ?, verification_json = ?,
             total_assets = ?, included_assets = ?, missing_assets = ?,
             total_size_bytes = ?, filename = ?, completed_at = datetime('now')
         WHERE id = ?"
    )
    .bind(status.as_str())
    .bind(manifest_json)
    .bind(manifest_sha256)
    .bind(verification_json)
    .bind(total_assets)
    .bind(included_assets)
    .bind(missing_assets)
    .bind(total_size_bytes)
    .bind(filename)
    .bind(id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn update_audit_failure(
    pool: &SqlitePool,
    id: &str,
    error_message: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE export_audits
         SET status = 'failed', error_message = ?, completed_at = datetime('now')
         WHERE id = ?"
    )
    .bind(error_message)
    .bind(id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn list_by_project(
    pool: &SqlitePool,
    project_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<ExportAuditRecord>> {
    let records = sqlx::query_as::<_, ExportAuditRecord>(
        "SELECT id, project_id, user_id, export_type, package_format, export_version,
                status, manifest_json, manifest_sha256, verification_json,
                total_assets, included_assets, missing_assets, total_size_bytes,
                filename, error_message, client_info, created_at, completed_at
         FROM export_audits
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?"
    )
    .bind(project_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(records)
}

pub async fn list_by_user(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<ExportAuditRecord>> {
    let records = sqlx::query_as::<_, ExportAuditRecord>(
        "SELECT id, project_id, user_id, export_type, package_format, export_version,
                status, manifest_json, manifest_sha256, verification_json,
                total_assets, included_assets, missing_assets, total_size_bytes,
                filename, error_message, client_info, created_at, completed_at
         FROM export_audits
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?"
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(records)
}

pub async fn get_by_id(
    pool: &SqlitePool,
    id: &str,
) -> AppResult<Option<ExportAuditRecord>> {
    let record = sqlx::query_as::<_, ExportAuditRecord>(
        "SELECT id, project_id, user_id, export_type, package_format, export_version,
                status, manifest_json, manifest_sha256, verification_json,
                total_assets, included_assets, missing_assets, total_size_bytes,
                filename, error_message, client_info, created_at, completed_at
         FROM export_audits
         WHERE id = ?"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(record)
}

impl ExportStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExportStatus::Pending => "pending",
            ExportStatus::Completed => "completed",
            ExportStatus::Partial => "partial",
            ExportStatus::Failed => "failed",
        }
    }
}
