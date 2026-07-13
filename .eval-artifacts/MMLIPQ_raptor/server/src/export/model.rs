use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// ─── 请求类型 ───────────────────────────────────────

/// 导出预检请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPrecheckRequest {
    pub project_id: String,
    pub export_type: Option<String>, // "full" | "core"，默认 "full"
}

/// 服务端导出请求（前端计算好派生快照后传给后端打包）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPackageRequest {
    pub project_id: String,
    pub export_type: String, // "full" | "core" | "snapshot"
    pub export_format: Option<String>, // "tar.gz" | "tar"，默认 "tar.gz"
    pub client_info: Option<String>,

    // 前端计算好的派生快照
    pub snapshot: Option<ProjectSnapshotInput>,
    // 核心markdown内容（前端生成）
    pub core_markdown: Option<String>,
    // 聊天记录markdown（前端生成）
    pub conversations_markdown: Option<std::collections::HashMap<String, String>>,
    // 资产打包路径映射（前端决定每个资产在包里的路径）
    pub asset_packaging: Option<Vec<AssetPackagingPlan>>,
    // 备注
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshotInput {
    pub script_title: Option<String>,
    pub script_text: Option<String>,
    pub chapters: Option<serde_json::Value>,
    pub characters: Option<serde_json::Value>,
    pub scenes: Option<serde_json::Value>,
    pub keyframes: Option<serde_json::Value>,
    pub video_shots: Option<serde_json::Value>,
    pub final_cut: Option<serde_json::Value>,
    pub generation_params: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPackagingPlan {
    pub asset_id: String,
    pub packaged_path: String, // e.g. "assets/001-character.png"
}

// ─── 响应类型 ───────────────────────────────────────

/// 预检结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPrecheckResult {
    pub project_id: String,
    pub project_name: String,
    pub can_export: bool,
    pub issues: Vec<PrecheckIssue>,
    pub summary: ExportSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckIssue {
    pub severity: String, // "error" | "warning" | "info"
    pub code: String,
    pub message: String,
    pub asset_id: Option<String>,
    pub asset_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub total_assets: usize,
    pub ready_assets: usize,
    pub missing_assets: usize,
    pub corrupted_assets: usize,
    pub external_assets: usize,
    pub duplicate_names: usize,
    pub estimated_size_bytes: u64,
    pub estimated_size_human: String,
    pub script_present: bool,
    pub storyboard_present: bool,
    pub shot_count: i64,
    pub keyframe_count: i64,
    pub empty_lines: usize,
    pub blocking_count: usize,
    pub warning_count: usize,
    pub info_count: usize,
}

/// 导出包结果（打包完成后返回）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPackageResult {
    pub audit_id: String,
    pub download_url: String,
    pub package_name: String,
    pub package_size_bytes: u64,
    pub package_sha256: String,
    pub export_type: String,
    pub exported_at: String,

    pub manifest: ExportManifest,
    pub missing_assets: Vec<MissingAssetEntry>,
    pub verification: VerificationReport,
}

/// 导出审计记录（用于历史列表）
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuditRecord {
    pub id: String,
    pub project_id: String,
    pub user_id: String,
    pub export_type: String,
    pub export_format: String,
    pub package_name: String,
    pub package_size_bytes: Option<i64>,
    pub package_sha256: Option<String>,
    pub manifest_sha256: Option<String>,
    pub total_assets: i64,
    pub included_assets: i64,
    pub missing_assets: i64,
    pub corrupted_assets: i64,
    pub total_size_bytes: i64,
    pub project_name: String,
    pub project_phase: Option<String>,
    pub script_version: Option<String>,
    pub storyboard_version: Option<String>,
    pub keyframe_count: i64,
    pub shot_count: i64,
    pub duration_seconds: i64,
    pub verification_passed: i64,
    pub sanitization_findings: i64,
    pub status: String,
    pub error_message: Option<String>,
    pub duration_ms: Option<i64>,
    pub notes: Option<String>,
    pub client_info: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// 导出审计详情
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuditDetail {
    #[serde(flatten)]
    pub record: ExportAuditRecord,
    pub warnings: Vec<String>,
    pub sensitive_findings: Vec<SensitiveFinding>,
    pub generation_params: Option<serde_json::Value>,
    pub asset_details: Vec<ExportAuditAssetDetail>,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuditAssetDetail {
    pub id: String,
    pub export_audit_id: String,
    pub asset_id: String,
    pub asset_name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub asset_url: Option<String>,
    pub asset_version_label: Option<String>,
    pub packaged_path: String,
    pub packaged_size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub status: String,
    pub error_reason: Option<String>,
    pub created_at: String,
}

// ─── 导出包内部数据结构 ─────────────────────────────

/// 导出包 manifest.json
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    // 导出元信息
    pub manifest_version: String,
    pub export_id: String,
    pub exported_at: String,
    pub exported_by: String,
    pub export_type: String,
    pub export_format: String,
    pub woohoo_version: String,

    // 项目基本信息
    pub project: ProjectInfo,

    // 内容摘要
    pub summary: ManifestSummary,

    // 版本信息（用于复现）
    pub versions: VersionInfo,

    // 资产索引
    pub assets: Vec<AssetManifestEntry>,

    // 文件索引（包内所有文件及其校验和）
    pub files: Vec<FileManifestEntry>,

    // 包整体校验和
    pub package_checksum: Option<PackageChecksum>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub phase: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSummary {
    pub script_sections: usize,
    pub chapters: usize,
    pub characters: usize,
    pub scenes: usize,
    pub shots: usize,
    pub keyframes: usize,
    pub duration_seconds: i64,
    pub total_assets: usize,
    pub included_assets: usize,
    pub missing_assets: usize,
    pub total_package_size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub script_id: Option<String>,
    pub script_updated_at: Option<i64>,
    pub storyboard_id: Option<String>,
    pub storyboard_updated_at: Option<i64>,
    pub snapshot_fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifestEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub version_label: Option<String>,
    pub packaged_path: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
    pub status: String, // "included" | "missing" | "corrupted" | "external"
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManifestEntry {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageChecksum {
    pub algorithm: String,
    pub value: String,
}

/// 缺失资产清单 missing-assets.json
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingAssetEntry {
    pub asset_id: String,
    pub asset_name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub expected_path: Option<String>,
    pub reason: String,
    pub url: Option<String>,
    pub created_at: i64,
}

/// 验证报告 verification-report.json
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub verified_at: String,
    pub overall_status: String, // "pass" | "pass_with_warnings" | "fail"
    pub checks_performed: Vec<VerificationCheck>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub sensitive_findings: Vec<SensitiveFinding>,
    pub asset_verification: AssetVerificationSummary,
    pub reproducibility: ReproducibilityInfo,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCheck {
    pub name: String,
    pub status: String, // "pass" | "warn" | "fail"
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveFinding {
    pub severity: String,
    pub category: String, // "api_key" | "jwt" | "password" | "email" | "phone" | "personal_name"
    pub file: String,
    pub line_hint: Option<usize>,
    pub description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetVerificationSummary {
    pub total_checked: usize,
    pub passed: usize,
    pub failed: usize,
    pub missing: usize,
    pub checksums_validated: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReproducibilityInfo {
    pub can_reproduce: bool,
    pub requirements: Vec<String>,
    pub blockers: Vec<String>,
    pub woohoo_version_required: String,
    pub database_snapshot_included: bool,
}

/// 生成参数摘要 generation-params.json
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationParamsSummary {
    pub exported_at: String,
    pub models_used: Vec<ModelUsage>,
    pub total_ai_tasks: usize,
    pub pipeline_runs: Vec<PipelineRunSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model_id: String,
    pub task_type: String,
    pub call_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunSummary {
    pub id: String,
    pub stage: String,
    pub status: String,
    pub created_at: String,
}
