use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/* ── 数据库行 ─────────────────────────────────────── */

#[derive(Debug, Clone, FromRow)]
pub struct ExportAuditRecord {
    pub id: String,
    pub project_id: String,
    pub user_id: String,
    pub export_type: String,
    pub export_version: String,
    pub filename: String,
    pub file_path: String,
    pub file_size: i64,
    pub file_sha256: Option<String>,
    pub manifest_sha256: Option<String>,
    pub asset_total: i64,
    pub asset_included: i64,
    pub asset_missing: i64,
    pub missing_asset_ids: String,
    pub manifest_json: String,
    pub checksums_json: String,
    pub project_snapshot_json: String,
    pub generation_params_json: String,
    pub verification_report_json: String,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

/* ── 请求 / 响应类型 ──────────────────────────────── */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateExportReq {
    /// "full" | "core" | "final_cut"
    #[serde(default = "default_export_type")]
    pub export_type: String,
    /// 可选备注
    pub note: Option<String>,
}

fn default_export_type() -> String {
    "full".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportListQuery {
    pub project_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/* ── 预检响应 ─────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightFinding {
    /// "blocking" 会阻止导出 ｜ "warning" 可导出但有风险 ｜ "info" 仅提示
    pub severity: String,
    /// 机器可读错误码：SCRIPT_EMPTY / DUPLICATE_FILENAME / ASSET_NOT_FOUND / ...
    pub code: String,
    /// 人类可读消息
    pub message: String,
    /// 关联路径 / assetId / sceneNumber 等定位信息
    pub locator: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreflightResponse {
    pub project_id: String,
    pub project_name: String,
    pub asset_total: usize,
    pub asset_on_disk: usize,
    pub asset_missing: usize,
    pub asset_empty: usize,
    pub asset_external_url: usize,
    pub estimated_size_bytes: u64,
    pub missing_assets: Vec<MissingAssetInfo>,
    pub script_present: bool,
    pub script_empty: bool,
    pub script_size_bytes: usize,
    pub storyboard_present: bool,
    pub storyboard_empty_scenes: usize,
    pub storyboard_duplicate_scenes: Vec<i64>,
    pub conversation_count: usize,
    pub duplicate_filenames: Vec<DuplicateFilenameGroup>,
    /// 分级检查结果
    pub findings: Vec<PreflightFinding>,
    /// blocking 问题数量（=0 才允许导出）
    pub blocking_count: usize,
    pub warning_count: usize,
    pub info_count: usize,
    /// true 表示没有 blocking 问题，允许点"导出"
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFilenameGroup {
    pub name: String,
    pub count: usize,
    pub asset_ids: Vec<String>,
}

/* ── 缺失资产信息 ─────────────────────────────────── */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingAssetInfo {
    pub asset_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub reason: String,
    pub url: String,
}

/* ── 校验和条目 ───────────────────────────────────── */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetChecksumEntry {
    pub asset_id: String,
    pub archive_path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/* ── Manifest（写入归档根目录） ───────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    /// 导出版本号（向后兼容）
    pub export_version: String,
    /// 导出包格式：auditable-bundle-v1
    pub bundle_format: String,
    pub exported_at: String,
    pub exported_by_user_id: String,
    pub project: ProjectManifestInfo,
    pub export_type: String,
    pub counts: ExportCounts,
    pub assets: Vec<AssetManifestEntry>,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifestInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub phase: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCounts {
    pub asset_total: usize,
    pub asset_included: usize,
    pub asset_missing: usize,
    pub script_included: bool,
    pub storyboard_included: bool,
    pub conversation_count: usize,
    pub final_cut_shots: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifestEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub archive_path: Option<String>,
    pub sha256: Option<String>,
    pub size_bytes: Option<u64>,
    pub missing: bool,
    pub missing_reason: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/* ── 项目快照 ─────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub exported_at: String,
    pub project: serde_json::Value,
    pub script: Option<serde_json::Value>,
    pub storyboard: Option<serde_json::Value>,
    pub assets: Vec<serde_json::Value>,
    pub conversations: Vec<ConversationSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub messages: Vec<serde_json::Value>,
}

/* ── 生成参数摘要 ─────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationParamsSummary {
    pub generated_at: String,
    pub image_generations: Vec<ImageGenSummary>,
    pub video_generations: Vec<VideoGenSummary>,
    pub models_used: std::collections::BTreeSet<String>,
    pub total_ai_calls: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenSummary {
    pub id: String,
    pub prompt_hash: String,
    pub model: Option<String>,
    pub created_at: String,
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenSummary {
    pub id: String,
    pub prompt_hash: String,
    pub model: Option<String>,
    pub created_at: String,
}

/* ── 验证报告 ─────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub verified_at: String,
    pub archive_sha256: String,
    pub archive_size_bytes: u64,
    pub file_count: usize,
    pub asset_checksums_verified: usize,
    pub asset_checksums_failed: usize,
    pub missing_assets: Vec<MissingAssetInfo>,
    pub issues: Vec<VerificationIssue>,
    pub passed: bool,
    /// 敏感信息剔除统计
    pub redaction: Option<RedactionSummary>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RedactionSummary {
    pub key_hits: usize,
    pub pattern_hits: usize,
    pub matched_keys: Vec<String>,
    pub matched_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationIssue {
    pub severity: String, // "error" | "warning" | "info"
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

/* ── 审计列表响应项 ───────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuditSummary {
    pub id: String,
    pub project_id: String,
    pub project_name: Option<String>,
    pub export_type: String,
    pub export_version: String,
    pub filename: String,
    pub file_size: i64,
    pub file_sha256: Option<String>,
    pub manifest_sha256: Option<String>,
    pub asset_total: i64,
    pub asset_included: i64,
    pub asset_missing: i64,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

/* ── 审计详情响应 ─────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuditDetail {
    pub id: String,
    pub project_id: String,
    pub user_id: String,
    pub export_type: String,
    pub export_version: String,
    pub filename: String,
    pub file_size: i64,
    pub file_sha256: Option<String>,
    pub manifest_sha256: Option<String>,
    pub asset_total: i64,
    pub asset_included: i64,
    pub asset_missing: i64,
    pub missing_assets: Vec<MissingAssetInfo>,
    pub manifest: serde_json::Value,
    pub checksums: Vec<AssetChecksumEntry>,
    pub verification_report: serde_json::Value,
    pub generation_params: serde_json::Value,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub download_url: String,
}
