use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use serde::Deserialize;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    project,
    AppState,
};

use super::{model::*, repo, service};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// GET /api/projects/{project_id}/export/preflight
/// Pre-export check: asset reachability, completeness, warnings
pub async fn preflight(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<PreflightResult>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let result = service::run_preflight(&state.db, &project_id, &user_id.0).await?;
    Ok(Json(result))
}

/// POST /api/projects/{project_id}/export
/// Record an export operation with manifest and verification (called by client after export completes)
pub async fn record_export(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<RecordExportRequest>,
) -> AppResult<Json<ExportAuditRecord>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;

    let export_type = match req.export_type.as_str() {
        "full" => ExportType::Full,
        "core" => ExportType::Core,
        "final_cut" => ExportType::FinalCut,
        "snapshot" => ExportType::Snapshot,
        other => {
            return Err(AppError::Validation(format!(
                "未知的导出类型: {}",
                other
            )))
        }
    };

    let client_info = req
        .client_info
        .as_ref()
        .map(|c| super::redact::redact_text(c).redacted_text);

    let audit_id = repo::create_audit(
        &state.db,
        &project_id,
        &user_id.0,
        export_type,
        &req.package_format,
        client_info.as_deref(),
    )
    .await?;

    let status = match req.status.as_str() {
        "completed" => ExportStatus::Completed,
        "partial" => ExportStatus::Partial,
        "failed" => ExportStatus::Failed,
        _ => ExportStatus::Completed,
    };

    // Re-redact manifest/verification JSON server-side before storing to
    // prevent any secret leaking into the audit log even if client is
    // compromised or has a bug in its redaction.
    let raw_manifest = req.manifest_json.unwrap_or_default();
    let manifest_json = if raw_manifest.is_empty() {
        raw_manifest
    } else {
        super::redact::redact_text(&raw_manifest).redacted_text
    };
    // Compute SHA-256 of the server-redacted manifest for integrity verification
    let manifest_sha256 = if manifest_json.is_empty() {
        String::new()
    } else {
        super::service::sha256_hex(manifest_json.as_bytes())
    };
    let raw_verification = req.verification_json.unwrap_or_default();
    let verification_json = if raw_verification.is_empty() {
        raw_verification
    } else {
        super::redact::redact_text(&raw_verification).redacted_text
    };
    let error_message = req
        .error_message
        .as_ref()
        .map(|e| super::redact::redact_text(e).redacted_text);

    if status == ExportStatus::Failed {
        repo::update_audit_failure(
            &state.db,
            &audit_id,
            error_message.as_deref().unwrap_or("导出失败"),
        )
        .await?;
    } else {
        repo::update_audit_success(
            &state.db,
            &audit_id,
            status,
            &manifest_json,
            &manifest_sha256,
            &verification_json,
            req.total_assets,
            req.included_assets,
            req.missing_assets,
            req.total_size_bytes,
            &req.filename,
        )
        .await?;
    }

    let record = repo::get_by_id(&state.db, &audit_id)
        .await?
        .ok_or_else(|| AppError::Internal("创建审计记录后无法查询".into()))?;

    tracing::info!(
        audit_id = %audit_id,
        project_id = %project_id,
        export_type = %req.export_type,
        status = %req.status,
        "导出操作已记录"
    );

    Ok(Json(record))
}

/// GET /api/projects/{project_id}/exports
/// List export history for a project
pub async fn list_exports(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<Vec<ExportAuditRecord>>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let records = repo::list_by_project(&state.db, &project_id, limit, offset).await?;
    Ok(Json(records))
}

/// GET /api/exports/{id}
/// Get a single export audit record
pub async fn get_export(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<ExportAuditRecord>> {
    let record = repo::get_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("导出记录 {} 不存在", id)))?;

    // Verify ownership
    if record.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权访问此导出记录".into()));
    }

    Ok(Json(record))
}

/// GET /api/exports
/// List all exports for current user (across all projects)
pub async fn list_my_exports(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<Vec<ExportAuditRecord>>> {
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let records = repo::list_by_user(&state.db, &user_id.0, limit, offset).await?;
    Ok(Json(records))
}

// ─── Helpers ─────────────────────────────────────────────────────────

async fn ensure_project_access(
    state: &AppState,
    user_id: &str,
    project_id: &str,
) -> AppResult<()> {
    let project = project::repo::find_by_id(&state.db, project_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("项目 {} 不存在", project_id)))?;

    if project.user_id != user_id {
        return Err(AppError::Forbidden("无权访问此项目".into()));
    }
    Ok(())
}

// ─── Request types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordExportRequest {
    pub export_type: String,
    #[serde(default = "default_format")]
    pub package_format: String,
    pub status: String,
    pub filename: String,
    #[serde(default)]
    pub total_assets: i64,
    #[serde(default)]
    pub included_assets: i64,
    #[serde(default)]
    pub missing_assets: i64,
    #[serde(default)]
    pub total_size_bytes: i64,
    pub manifest_json: Option<String>,
    pub verification_json: Option<String>,
    pub error_message: Option<String>,
    pub client_info: Option<String>,
}

fn default_format() -> String {
    "tar".to_string()
}
