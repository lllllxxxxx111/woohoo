use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::model::*;

/// 创建导出审计记录（导出开始时调用）
#[allow(clippy::too_many_arguments)]
pub async fn create_audit(
    pool: &SqlitePool,
    project_id: &str,
    user_id: &str,
    export_type: &str,
    export_format: &str,
    package_name: &str,
    project_name: &str,
    project_phase: Option<&str>,
    client_info: Option<&str>,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO export_audits
            (id, project_id, user_id, export_type, export_format, package_name,
             project_name, project_phase, status, client_info)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?)"
    )
    .bind(&id)
    .bind(project_id)
    .bind(user_id)
    .bind(export_type)
    .bind(export_format)
    .bind(package_name)
    .bind(project_name)
    .bind(project_phase)
    .bind(client_info)
    .execute(pool)
    .await?;
    Ok(id)
}

/// 导出完成时更新审计记录（包含完整统计信息）
#[allow(clippy::too_many_arguments)]
pub async fn finalize_audit(
    pool: &SqlitePool,
    audit_id: &str,
    package_size_bytes: i64,
    package_sha256: &str,
    manifest_sha256: &str,
    total_assets: i64,
    included_assets: i64,
    missing_assets: i64,
    corrupted_assets: i64,
    total_size_bytes: i64,
    script_version: Option<&str>,
    storyboard_version: Option<&str>,
    keyframe_count: i64,
    shot_count: i64,
    duration_seconds: i64,
    verification_passed: bool,
    warnings_json: Option<&str>,
    sensitive_findings_json: Option<&str>,
    generation_params_json: Option<&str>,
    sanitization_findings: i64,
    duration_ms: i64,
    notes: Option<&str>,
) -> AppResult<()> {
    let status = if corrupted_assets > 0 { "partial" } else { "completed" };
    sqlx::query(
        "UPDATE export_audits SET
            package_size_bytes = ?,
            package_sha256 = ?,
            manifest_sha256 = ?,
            total_assets = ?,
            included_assets = ?,
            missing_assets = ?,
            corrupted_assets = ?,
            total_size_bytes = ?,
            script_version = ?,
            storyboard_version = ?,
            keyframe_count = ?,
            shot_count = ?,
            duration_seconds = ?,
            verification_passed = ?,
            warnings_json = ?,
            sensitive_findings_json = ?,
            generation_params_json = ?,
            sanitization_findings = ?,
            duration_ms = ?,
            notes = ?,
            status = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?"
    )
    .bind(package_size_bytes)
    .bind(package_sha256)
    .bind(manifest_sha256)
    .bind(total_assets)
    .bind(included_assets)
    .bind(missing_assets)
    .bind(corrupted_assets)
    .bind(total_size_bytes)
    .bind(script_version)
    .bind(storyboard_version)
    .bind(keyframe_count)
    .bind(shot_count)
    .bind(duration_seconds)
    .bind(verification_passed as i64)
    .bind(warnings_json)
    .bind(sensitive_findings_json)
    .bind(generation_params_json)
    .bind(sanitization_findings)
    .bind(duration_ms)
    .bind(notes)
    .bind(status)
    .bind(audit_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 记录导出失败
pub async fn fail_audit(
    pool: &SqlitePool,
    audit_id: &str,
    error_message: &str,
    duration_ms: i64,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE export_audits SET
            status = 'failed',
            error_message = ?,
            duration_ms = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?"
    )
    .bind(error_message)
    .bind(duration_ms)
    .bind(audit_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 添加导出资产明细记录
#[allow(clippy::too_many_arguments)]
pub async fn add_audit_asset(
    pool: &SqlitePool,
    export_audit_id: &str,
    asset_id: &str,
    asset_name: &str,
    asset_type: &str,
    asset_url: Option<&str>,
    asset_version_label: Option<&str>,
    packaged_path: &str,
    packaged_size_bytes: Option<i64>,
    sha256: Option<&str>,
    status: &str,
    error_reason: Option<&str>,
    metadata_json: Option<&str>,
) -> AppResult<()> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO export_audit_assets
            (id, export_audit_id, asset_id, asset_name, asset_type, asset_url,
             asset_version_label, packaged_path, packaged_size_bytes, sha256,
             status, error_reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(export_audit_id)
    .bind(asset_id)
    .bind(asset_name)
    .bind(asset_type)
    .bind(asset_url)
    .bind(asset_version_label)
    .bind(packaged_path)
    .bind(packaged_size_bytes)
    .bind(sha256)
    .bind(status)
    .bind(error_reason)
    .bind(metadata_json)
    .execute(pool)
    .await?;
    Ok(())
}

const SELECT_AUDIT_COLS: &str =
    "id, project_id, user_id, export_type, export_format, package_name,
     package_size_bytes, package_sha256, manifest_sha256,
     total_assets, included_assets, missing_assets, corrupted_assets, total_size_bytes,
     project_name, project_phase, script_version, storyboard_version,
     keyframe_count, shot_count, duration_seconds, verification_passed,
     sanitization_findings, status, error_message, duration_ms,
     notes, client_info, created_at, completed_at";

/// 查询项目的导出历史
pub async fn list_audits_by_project(
    pool: &SqlitePool,
    project_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<ExportAuditRecord>> {
    let records = sqlx::query_as::<_, ExportAuditRecord>(&format!(
        "SELECT {} FROM export_audits
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?",
        SELECT_AUDIT_COLS
    ))
    .bind(project_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(records)
}

/// 查询用户的所有导出历史
pub async fn list_audits_by_user(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<ExportAuditRecord>> {
    let records = sqlx::query_as::<_, ExportAuditRecord>(&format!(
        "SELECT {} FROM export_audits
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?",
        SELECT_AUDIT_COLS
    ))
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(records)
}

/// 获取单条导出审计详情（含资产明细）
pub async fn get_audit_detail(
    pool: &SqlitePool,
    audit_id: &str,
) -> AppResult<Option<(ExportAuditRecord, Vec<ExportAuditAssetDetail>)>> {
    let record = sqlx::query_as::<_, ExportAuditRecord>(&format!(
        "SELECT {} FROM export_audits WHERE id = ?",
        SELECT_AUDIT_COLS
    ))
    .bind(audit_id)
    .fetch_optional(pool)
    .await?;

    let Some(record) = record else {
        return Ok(None);
    };

    let assets = sqlx::query_as::<_, ExportAuditAssetDetail>(
        "SELECT id, export_audit_id, asset_id, asset_name, asset_type, asset_url,
                asset_version_label, packaged_path, packaged_size_bytes, sha256,
                status, error_reason, created_at
         FROM export_audit_assets
         WHERE export_audit_id = ?
         ORDER BY packaged_path ASC"
    )
    .bind(audit_id)
    .fetch_all(pool)
    .await?;

    Ok(Some((record, assets)))
}

/// 获取导出审计记录（仅记录本身）
pub async fn find_audit_by_id(pool: &SqlitePool, audit_id: &str) -> AppResult<Option<ExportAuditRecord>> {
    let record = sqlx::query_as::<_, ExportAuditRecord>(&format!(
        "SELECT {} FROM export_audits WHERE id = ?",
        SELECT_AUDIT_COLS
    ))
    .bind(audit_id)
    .fetch_optional(pool)
    .await?;
    Ok(record)
}

/// 统计项目的导出总数
pub async fn count_audits_by_project(pool: &SqlitePool, project_id: &str) -> AppResult<i64> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM export_audits WHERE project_id = ?"
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// 清理过期的导出包记录
pub async fn cleanup_expired_audits(pool: &SqlitePool) -> AppResult<u64> {
    let result = sqlx::query(
        "DELETE FROM export_audits
         WHERE expires_at IS NOT NULL AND expires_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}
