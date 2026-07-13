use serde::{Deserialize, Serialize};

/// Export bundle schema version, bump when manifest format changes
pub const BUNDLE_SCHEMA_VERSION: &str = "1.0";

/// Pre-check response: tells the frontend what to expect before exporting
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPrecheck {
    pub project_id: String,
    pub project_name: String,
    pub can_export: bool,
    pub blocking_issues: Vec<PrecheckIssue>,
    pub warnings: Vec<PrecheckIssue>,
    pub info: Vec<PrecheckIssue>,
    pub asset_summary: AssetSummary,
    pub content_readiness: ContentReadiness,
    pub estimated_bundle_size_bytes: u64,
    pub checked_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckIssue {
    pub code: String,
    pub severity: &'static str, // "error" | "warning" | "info"
    pub message: String,
    pub asset_id: Option<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub total_assets: usize,
    pub image_count: usize,
    pub video_count: usize,
    pub audio_count: usize,
    pub document_count: usize,
    pub local_assets: usize,
    pub remote_assets: usize,
    pub missing_or_broken: usize,
    pub estimated_total_bytes: u64,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContentReadiness {
    pub has_script: bool,
    pub script_word_count: usize,
    pub has_storyboard: bool,
    pub storyboard_line_count: usize,
    pub has_conversations: bool,
    pub conversation_count: usize,
    pub message_count: usize,
    pub total_duration_seconds: i64,
}

/// Request body to record an export audit from the frontend
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordExportAuditReq {
    pub project_id: String,
    pub export_type: String, // "full" | "core" | "final_cut"
    pub status: String,      // "completed" | "partial" | "failed"
    pub filename: Option<String>,

    // Counts
    pub total_assets: Option<i64>,
    pub included_assets: Option<i64>,
    pub missing_assets: Option<i64>,
    pub script_sections: Option<i64>,
    pub chapters: Option<i64>,
    pub shots: Option<i64>,
    pub conversations: Option<i64>,
    pub total_duration: Option<i64>,
    pub bundle_size_bytes: Option<i64>,

    // Verification
    pub precheck_passed: Option<bool>,
    pub checksums_valid: Option<bool>,
    pub has_sensitive_data: Option<bool>,

    // Fingerprints
    pub script_sha256: Option<String>,
    pub storyboard_sha256: Option<String>,
    pub manifest_sha256: Option<String>,

    pub client_info: Option<serde_json::Value>,
    pub error_message: Option<String>,
    pub notes: Option<String>,
}

/// Audit record returned from the API
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuditRecord {
    pub id: String,
    pub user_id: String,
    pub project_id: String,
    pub export_type: String,
    pub bundle_version: String,
    pub status: String,
    pub filename: String,
    pub total_assets: i64,
    pub included_assets: i64,
    pub missing_assets: i64,
    pub script_sections: i64,
    pub chapters: i64,
    pub shots: i64,
    pub conversations: i64,
    pub total_duration: i64,
    pub bundle_size_bytes: i64,
    pub precheck_passed: i64,
    pub checksums_valid: i64,
    pub has_sensitive_data: i64,
    pub script_sha256: Option<String>,
    pub storyboard_sha256: Option<String>,
    pub manifest_sha256: Option<String>,
    pub client_info: Option<String>,
    pub error_message: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
}

/// Paginated audit log response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuditListResponse {
    pub items: Vec<ExportAuditRecord>,
    pub total: i64,
    pub project_id: Option<String>,
}
