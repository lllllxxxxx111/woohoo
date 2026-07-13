use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::AppResult;

use super::model::*;

pub async fn insert_audit(pool: &SqlitePool, audit: &ExportAuditRecord) -> AppResult<()> {
    sqlx::query(
        r#"INSERT INTO export_audits
           (id, project_id, user_id, export_type, export_version,
            filename, file_path, file_size, file_sha256, manifest_sha256,
            asset_total, asset_included, asset_missing, missing_asset_ids,
            manifest_json, checksums_json, project_snapshot_json,
            generation_params_json, verification_report_json,
            status, error_message, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&audit.id)
    .bind(&audit.project_id)
    .bind(&audit.user_id)
    .bind(&audit.export_type)
    .bind(&audit.export_version)
    .bind(&audit.filename)
    .bind(&audit.file_path)
    .bind(audit.file_size)
    .bind(&audit.file_sha256)
    .bind(&audit.manifest_sha256)
    .bind(audit.asset_total)
    .bind(audit.asset_included)
    .bind(audit.asset_missing)
    .bind(&audit.missing_asset_ids)
    .bind(&audit.manifest_json)
    .bind(&audit.checksums_json)
    .bind(&audit.project_snapshot_json)
    .bind(&audit.generation_params_json)
    .bind(&audit.verification_report_json)
    .bind(&audit.status)
    .bind(&audit.error_message)
    .bind(&audit.created_at)
    .bind(&audit.expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn find_by_id(pool: &SqlitePool, id: &str) -> AppResult<Option<ExportAuditRecord>> {
    let record = sqlx::query_as::<_, ExportAuditRecord>(
        r#"SELECT id, project_id, user_id, export_type, export_version,
                  filename, file_path, file_size, file_sha256, manifest_sha256,
                  asset_total, asset_included, asset_missing, missing_asset_ids,
                  manifest_json, checksums_json, project_snapshot_json,
                  generation_params_json, verification_report_json,
                  status, error_message, created_at, expires_at
           FROM export_audits WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(record)
}

pub async fn list_audits(
    pool: &SqlitePool,
    user_id: &str,
    project_id: Option<&str>,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<ExportAuditRecord>> {
    let limit = limit.clamp(1, 100);

    let records = if let Some(pid) = project_id {
        sqlx::query_as::<_, ExportAuditRecord>(
            r#"SELECT id, project_id, user_id, export_type, export_version,
                      filename, file_path, file_size, file_sha256, manifest_sha256,
                      asset_total, asset_included, asset_missing, missing_asset_ids,
                      manifest_json, checksums_json, project_snapshot_json,
                      generation_params_json, verification_report_json,
                      status, error_message, created_at, expires_at
               FROM export_audits
               WHERE user_id = ? AND project_id = ?
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?"#,
        )
        .bind(user_id)
        .bind(pid)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, ExportAuditRecord>(
            r#"SELECT id, project_id, user_id, export_type, export_version,
                      filename, file_path, file_size, file_sha256, manifest_sha256,
                      asset_total, asset_included, asset_missing, missing_asset_ids,
                      manifest_json, checksums_json, project_snapshot_json,
                      generation_params_json, verification_report_json,
                      status, error_message, created_at, expires_at
               FROM export_audits
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?"#,
        )
        .bind(user_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    };

    Ok(records)
}

pub async fn count_audits(
    pool: &SqlitePool,
    user_id: &str,
    project_id: Option<&str>,
) -> AppResult<i64> {
    let count: i64 = if let Some(pid) = project_id {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM export_audits WHERE user_id = ? AND project_id = ?",
        )
        .bind(user_id)
        .bind(pid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar("SELECT COUNT(*) FROM export_audits WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(pool)
            .await?
    };
    Ok(count)
}

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}
