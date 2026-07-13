use serde::{Deserialize, Serialize};

/// Manifest schema version, increment when format changes
pub const EXPORT_MANIFEST_VERSION: &str = "1.0";

/// Export package types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExportType {
    Full,
    Core,
    FinalCut,
    Snapshot,
}

impl ExportType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExportType::Full => "full",
            ExportType::Core => "core",
            ExportType::FinalCut => "final_cut",
            ExportType::Snapshot => "snapshot",
        }
    }
}

/// Status of an export operation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExportStatus {
    Pending,
    Completed,
    Partial,
    Failed,
}

/// Verification status for an individual asset or the whole package
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VerifyStatus {
    Pass,
    Warn,
    Fail,
    Skip,
}

// ─── Preflight (before export) ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreflightSeverity {
    Blocking,
    Warning,
    Info,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightFinding {
    pub severity: PreflightSeverity,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightAssetCheck {
    pub asset_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub url: String,
    pub status: VerifyStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub findings: Option<Vec<PreflightFinding>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub project_id: String,
    pub project_name: String,
    pub can_export: bool,
    pub overall_status: VerifyStatus,
    /// All findings flat list
    pub findings: Vec<PreflightFinding>,
    /// Grouped by severity
    pub blocking: Vec<PreflightFinding>,
    pub warnings: Vec<PreflightFinding>,
    pub infos: Vec<PreflightFinding>,
    pub assets: Vec<PreflightAssetCheck>,
    pub asset_summary: PreflightAssetSummary,
    pub script_ready: bool,
    pub storyboard_ready: bool,
    pub estimated_size_bytes: i64,
    pub path_collisions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightAssetSummary {
    pub total: i64,
    pub reachable: i64,
    pub missing: i64,
    pub uncertain: i64,
    pub duplicate_names: i64,
    pub zero_byte: i64,
}

// ─── Manifest (inside the tar/package) ───────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    /// Schema version for forward compatibility
    pub manifest_version: String,
    /// Unique export id
    pub export_id: String,
    /// Export timestamp (RFC3339)
    pub exported_at: String,
    /// Export tool/version info for reproducibility
    pub exporter: ExporterInfo,
    /// Project snapshot
    pub project: ProjectSnapshotInfo,
    /// Inventory of all included files with checksums
    pub files: Vec<FileEntry>,
    /// Asset inventory (cross-references to files)
    pub assets: Vec<AssetEntry>,
    /// Missing / failed assets with error reasons
    pub missing_assets: Vec<MissingAssetEntry>,
    /// Versions of key documents (script, storyboard, etc.)
    pub versions: DocumentVersions,
    /// Summary of generation parameters used (for reproducibility)
    pub generation_params: GenerationParamsSummary,
    /// Verification report (checksums validated, completeness)
    pub verification: VerificationReport,
    /// Sensitive content flags
    pub content_flags: ContentFlags,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExporterInfo {
    pub tool: String,
    pub version: String,
    pub schema_version: String,
    pub exported_by: Option<String>,
    pub client: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshotInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub phase: String,
    pub created_at: String,
    pub workflow: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub media_type: String,
    pub added_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub file_path: Option<String>,
    pub sha256: Option<String>,
    pub size_bytes: Option<u64>,
    pub version_label: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub source_url: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingAssetEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub source_url: String,
    pub error: String,
    pub error_code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersions {
    pub script: Option<DocumentVersion>,
    pub storyboard: Option<DocumentVersion>,
    pub chat_messages_count: i64,
    pub pipeline_runs_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: i64,
    pub content_hash: String,
    pub content_length: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationParamsSummary {
    pub models_used: Vec<ModelUsage>,
    pub total_ai_tasks: i64,
    pub total_tokens_used: Option<i64>,
    pub image_generations: i64,
    pub video_generations: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub request_count: i64,
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub status: VerifyStatus,
    pub checked_at: String,
    pub total_files: i64,
    pub verified_files: i64,
    pub failed_checksums: i64,
    pub completeness: CompletenessReport,
    pub issues: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletenessReport {
    pub expected_assets: i64,
    pub included_assets: i64,
    pub missing_assets: i64,
    pub script_included: bool,
    pub storyboard_included: bool,
    pub conversations_included: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentFlags {
    pub has_external_urls: bool,
    pub has_api_keys: bool,
    pub has_personal_info: bool,
    pub warnings: Vec<String>,
}

// ─── Audit record (stored in DB) ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuditRecord {
    pub id: String,
    pub project_id: String,
    pub user_id: String,
    pub export_type: String,
    pub package_format: String,
    pub export_version: String,
    pub status: String,
    pub manifest_json: Option<String>,
    pub manifest_sha256: Option<String>,
    pub verification_json: Option<String>,
    pub total_assets: i64,
    pub included_assets: i64,
    pub missing_assets: i64,
    pub total_size_bytes: i64,
    pub filename: Option<String>,
    pub error_message: Option<String>,
    pub client_info: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

// ─── Request types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    #[serde(default = "default_export_type")]
    pub export_type: String,
    #[serde(default)]
    pub include_assets: bool,
    #[serde(default)]
    pub include_conversations: bool,
    #[serde(default)]
    pub dry_run: bool,
}

fn default_export_type() -> String {
    "full".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub user_agent: Option<String>,
    pub platform: Option<String>,
}
