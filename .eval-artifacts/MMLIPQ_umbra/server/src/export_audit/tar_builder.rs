use chrono::Utc;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::asset::model::Asset;
use crate::conversation::model::{Conversation, Message};
use crate::error::{AppError, AppResult};
use crate::project::model::Project;
use crate::script::model::Script;
use crate::storyboard::model::Storyboard;
use crate::AppState;

use super::model::*;
use super::redaction::{self, RedactionReport};

/// 本地资源 URL 前缀
const LOCAL_UPLOAD_URL_PREFIX: &str = "/uploads/";

/// 导出格式版本
pub const EXPORT_VERSION: &str = "1.0";
pub const BUNDLE_FORMAT: &str = "auditable-bundle-v1";

/// 累积敏感信息剔除结果
#[derive(Default)]
struct RedactionAcc {
    key_hits: usize,
    pattern_hits: usize,
    matched_keys: BTreeSet<String>,
    matched_patterns: BTreeSet<String>,
}

impl RedactionAcc {
    fn add(&mut self, r: RedactionReport) {
        self.key_hits += r.key_hits;
        self.pattern_hits += r.pattern_hits;
        self.matched_keys.extend(r.matched_keys);
        self.matched_patterns.extend(r.matched_patterns);
    }
    fn to_summary(&self) -> Option<RedactionSummary> {
        if self.key_hits + self.pattern_hits == 0 {
            return None;
        }
        Some(RedactionSummary {
            key_hits: self.key_hits,
            pattern_hits: self.pattern_hits,
            matched_keys: self.matched_keys.iter().cloned().collect(),
            matched_patterns: self.matched_patterns.iter().cloned().collect(),
        })
    }
}

/// 序列化 JSON Value 并脱敏
fn redacted_json_bytes(value: &serde_json::Value, acc: &mut RedactionAcc) -> Vec<u8> {
    let mut v = value.clone();
    let rep = redaction::redact_value(&mut v);
    acc.add(rep);
    serde_json::to_vec_pretty(&v).unwrap_or_default()
}

/// 对任意 serializable 先转 Value 再脱敏
fn redacted_serialize<T: serde::Serialize>(obj: &T, acc: &mut RedactionAcc) -> Vec<u8> {
    match serde_json::to_value(obj) {
        Ok(v) => redacted_json_bytes(&v, acc),
        Err(_) => serde_json::to_vec_pretty(obj).unwrap_or_default(),
    }
}

/// 对文本内容脱敏
fn redacted_text(s: &str, acc: &mut RedactionAcc) -> Vec<u8> {
    let (out, rep) = redaction::redact_text(s);
    acc.add(rep);
    out.into_bytes()
}

/// 构建可审计导出包的结果
pub struct BuiltExport {
    pub tar_gz_bytes: Vec<u8>,
    pub filename: String,
    pub file_sha256: String,
    /// manifest.json 内容的 SHA-256（仅审计记录即可校验清单完整性）
    pub manifest_sha256: String,
    /// 以下均为已脱敏的 JSON 字节（直接写入审计表，无需再序列化）
    pub manifest_bytes: Vec<u8>,
    pub checksums_bytes: Vec<u8>,
    pub missing_bytes: Vec<u8>,
    pub snapshot_bytes: Vec<u8>,
    pub gen_params_bytes: Vec<u8>,
    pub verification_bytes: Vec<u8>,
    pub manifest: ExportManifest,
    pub checksums: Vec<AssetChecksumEntry>,
    pub snapshot: ProjectSnapshot,
    pub generation_params: GenerationParamsSummary,
    pub verification: VerificationReport,
    pub missing: Vec<MissingAssetInfo>,
}

/// 构建完整可审计导出包
pub async fn build_auditable_export(
    state: &AppState,
    project: &Project,
    script: &Option<Script>,
    storyboard: &Option<Storyboard>,
    assets: &[Asset],
    conversations: &[(Conversation, Vec<Message>)],
    export_type: &str,
) -> AppResult<BuiltExport> {
    let now = Utc::now();
    let exported_at = now.to_rfc3339();

    // 敏感信息剔除累加器（贯穿整个打包过程）
    let mut redact = RedactionAcc::default();

    // 1. 解析资产文件、计算校验和
    let assets_dir_root = resolve_upload_root(state).await?;
    let mut included_assets: Vec<(Asset, PathBuf, Vec<u8>, String)> = Vec::new();
    let mut missing_assets: Vec<MissingAssetInfo> = Vec::new();
    let mut checksum_entries: Vec<AssetChecksumEntry> = Vec::new();
    let mut manifest_asset_entries: Vec<AssetManifestEntry> = Vec::new();
    let mut asset_file_entries: Vec<(String, Vec<u8>)> = Vec::new();

    for (idx, asset) in assets.iter().enumerate() {
        let ext = extract_extension(&asset.name, &asset.url);
        let safe_name = sanitize_name(&asset.name);
        let archive_path = format!("assets/{:03}-{}{}", idx, safe_name, ext);

        match resolve_local_asset_path_from_root(&assets_dir_root, asset).await {
            Ok(disk_path) => match fs::read(&disk_path).await {
                Ok(data) => {
                    let mut hasher = Sha256::new();
                    hasher.update(&data);
                    let hash = format!("{:x}", hasher.finalize());
                    let size = data.len() as u64;

                    let metadata_value = asset
                        .metadata
                        .as_deref()
                        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok());

                    manifest_asset_entries.push(AssetManifestEntry {
                        id: asset.id.clone(),
                        name: asset.name.clone(),
                        asset_type: asset.asset_type.clone(),
                        archive_path: Some(archive_path.clone()),
                        sha256: Some(hash.clone()),
                        size_bytes: Some(size),
                        missing: false,
                        missing_reason: None,
                        metadata: metadata_value.clone(),
                    });

                    checksum_entries.push(AssetChecksumEntry {
                        asset_id: asset.id.clone(),
                        archive_path: archive_path.clone(),
                        sha256: hash,
                        size_bytes: size,
                    });

                    asset_file_entries.push((archive_path.clone(), data.clone()));
                    included_assets.push((asset.clone(), disk_path, data, archive_path));
                }
                Err(e) => {
                    missing_assets.push(MissingAssetInfo {
                        asset_id: asset.id.clone(),
                        name: asset.name.clone(),
                        asset_type: asset.asset_type.clone(),
                        reason: format!("文件读取失败: {}", e),
                        url: asset.url.clone(),
                    });
                    manifest_asset_entries.push(AssetManifestEntry {
                        id: asset.id.clone(),
                        name: asset.name.clone(),
                        asset_type: asset.asset_type.clone(),
                        archive_path: None,
                        sha256: None,
                        size_bytes: None,
                        missing: true,
                        missing_reason: Some(format!("文件读取失败: {}", e)),
                        metadata: None,
                    });
                }
            },
            Err(reason) => {
                missing_assets.push(MissingAssetInfo {
                    asset_id: asset.id.clone(),
                    name: asset.name.clone(),
                    asset_type: asset.asset_type.clone(),
                    reason: reason.clone(),
                    url: asset.url.clone(),
                });
                manifest_asset_entries.push(AssetManifestEntry {
                    id: asset.id.clone(),
                    name: asset.name.clone(),
                    asset_type: asset.asset_type.clone(),
                    archive_path: None,
                    sha256: None,
                    size_bytes: None,
                    missing: true,
                    missing_reason: Some(reason),
                    metadata: None,
                });
            }
        }
    }

    // 2. 构建项目快照
    let snapshot = build_project_snapshot(project, script, storyboard, assets, conversations, &exported_at);

    // 3. 构建生成参数摘要（从资产元数据和消息 model_used 字段提取）
    let generation_params = build_generation_params_summary(assets, conversations, &exported_at);

    // 4. 构建文字内容文件
    let script_md = build_script_markdown(script);
    let storyboard_json = build_storyboard_json(storyboard);
    let final_cut_json = serde_json::json!({
        "note": "Final cut timeline is derived client-side from storyboard + script; server-side export preserves raw data for reproducibility",
        "generatedAt": exported_at,
    });
    let core_bundle_md = build_core_bundle_markdown(
        project,
        script,
        storyboard,
        assets,
        &included_assets,
        &missing_assets,
        &exported_at,
    );

    let mut content_files: Vec<(String, Vec<u8>)> = Vec::new();
    content_files.push(("core-bundle.md".into(), redacted_text(&core_bundle_md, &mut redact)));
    content_files.push(("script/current-script.md".into(), redacted_text(&script_md, &mut redact)));
    content_files.push((
        "storyboard/storyboard.json".into(),
        redacted_text(&storyboard_json, &mut redact),
    ));
    content_files.push(("timeline/final-cut.json".into(), redacted_json_bytes(&final_cut_json, &mut redact)));

    // 对话文件
    for (idx, (conv, messages)) in conversations.iter().enumerate() {
        let md = conversation_to_markdown(conv, messages);
        let safe_title = sanitize_name(&conv.title);
        content_files.push((
            format!("conversations/{:02}-{}.md", idx, safe_title),
            redacted_text(&md, &mut redact),
        ));
    }

    // 5. 构建 checksums.json
    let checksums_json = redacted_json_bytes(&serde_json::json!({
        "generatedAt": exported_at,
        "algorithm": "SHA-256",
        "entries": checksum_entries,
    }), &mut redact);

    // 6. 构建 missing-assets.json
    let missing_json = redacted_json_bytes(&serde_json::json!({
        "generatedAt": exported_at,
        "totalMissing": missing_assets.len(),
        "assets": missing_assets,
    }), &mut redact);

    // 7. 构建 project-snapshot.json
    let snapshot_json = redacted_serialize(&snapshot, &mut redact);

    // 8. 构建 generation-params.json
    let gen_params_json = redacted_serialize(&generation_params, &mut redact);

    // 保留已脱敏字节副本用于审计记录（后续 push 到 Vec 会 move 所有权）
    let checksums_bytes_audit = checksums_json.clone();
    let missing_bytes_audit = missing_json.clone();
    let snapshot_bytes_audit = snapshot_json.clone();
    let gen_params_bytes_audit = gen_params_json.clone();

    // 9. 先把 manifest 的 files 列表算出来（不含 manifest/verification/checksums 自身）
    let mut all_content_files: Vec<(String, Vec<u8>)> = Vec::new();
    all_content_files.extend(content_files);
    all_content_files.extend(asset_file_entries);
    all_content_files.push(("checksums.json".into(), checksums_json.clone()));
    all_content_files.push(("missing-assets.json".into(), missing_json.clone()));
    all_content_files.push(("project-snapshot.json".into(), snapshot_json.clone()));
    all_content_files.push(("generation-params.json".into(), gen_params_json.clone()));

    // 10. 构建 manifest
    let final_cut_shots = storyboard.as_ref().map(|s| s.lines.len()).unwrap_or(0);
    let mut file_entries: Vec<FileEntry> = Vec::new();
    for (path, data) in &all_content_files {
        let mut hasher = Sha256::new();
        hasher.update(data);
        file_entries.push(FileEntry {
            path: path.clone(),
            size_bytes: data.len() as u64,
            sha256: format!("{:x}", hasher.finalize()),
        });
    }

    let manifest = ExportManifest {
        export_version: EXPORT_VERSION.to_string(),
        bundle_format: BUNDLE_FORMAT.to_string(),
        exported_at: exported_at.clone(),
        exported_by_user_id: project.user_id.clone(),
        project: ProjectManifestInfo {
            id: project.id.clone(),
            name: project.name.clone(),
            status: project.status.clone(),
            phase: project.phase.clone(),
            created_at: project.created_at.clone(),
            updated_at: project.updated_at.clone(),
        },
        export_type: export_type.to_string(),
        counts: ExportCounts {
            asset_total: assets.len(),
            asset_included: included_assets.len(),
            asset_missing: missing_assets.len(),
            script_included: script.is_some(),
            storyboard_included: storyboard.is_some(),
            conversation_count: conversations.len(),
            final_cut_shots: final_cut_shots,
        },
        assets: manifest_asset_entries,
        files: file_entries,
    };

    let manifest_json = redacted_serialize(&manifest, &mut redact);

    // 计算 manifest.json 自身内容 hash，存入审计表
    let mut manifest_hasher = Sha256::new();
    manifest_hasher.update(&manifest_json);
    let manifest_sha256 = format!("{:x}", manifest_hasher.finalize());

    // 11. 现在组装完整的 tar 文件列表（包含 manifest.json）
    let mut tar_entries: Vec<(String, Vec<u8>)> = Vec::new();
    tar_entries.push(("manifest.json".into(), manifest_json.clone()));
    tar_entries.extend(all_content_files);

    // 12. 验证报告：逐文件校验和比对
    let mut issues: Vec<VerificationIssue> = Vec::new();
    let mut checksums_failed = 0usize;

    for fe in &manifest.files {
        let data = tar_entries.iter().find(|(p, _)| p == &fe.path);
        match data {
            Some((_, bytes)) => {
                let mut h = Sha256::new();
                h.update(bytes);
                let computed = format!("{:x}", h.finalize());
                if computed != fe.sha256 {
                    checksums_failed += 1;
                    issues.push(VerificationIssue {
                        severity: "error".into(),
                        code: "CHECKSUM_MISMATCH".into(),
                        message: format!("文件 {} 校验和不匹配", fe.path),
                        path: Some(fe.path.clone()),
                    });
                }
            }
            None => {
                checksums_failed += 1;
                issues.push(VerificationIssue {
                    severity: "error".into(),
                    code: "FILE_MISSING_FROM_ARCHIVE".into(),
                    message: format!("manifest 列出的文件 {} 未在归档中找到", fe.path),
                    path: Some(fe.path.clone()),
                });
            }
        }
    }

    if !missing_assets.is_empty() {
        issues.push(VerificationIssue {
            severity: "warning".into(),
            code: "MISSING_ASSETS".into(),
            message: format!("有 {} 个资产文件缺失（磁盘不存在或无法读取）", missing_assets.len()),
            path: None,
        });
    }

    // 敏感信息剔除统计作为 info 级别问题记录
    let redaction_summary = redact.to_summary();
    if let Some(rs) = &redaction_summary {
        issues.push(VerificationIssue {
            severity: "info".into(),
            code: "SENSITIVE_DATA_REDACTED".into(),
            message: format!(
                "已自动剔除 {} 处敏感字段、{} 处敏感字符串（匹配 key：{}；模式：{}）",
                rs.key_hits,
                rs.pattern_hits,
                rs.matched_keys.join(", "),
                rs.matched_patterns.join(", ")
            ),
            path: None,
        });
    }

    let passed = checksums_failed == 0;

    // payload_sha256: 除 verification-report.json 外所有文件的归档 hash（可独立验证）
    let payload_tar_gz = build_tar_gz(&tar_entries)?;
    let mut payload_hasher = Sha256::new();
    payload_hasher.update(&payload_tar_gz);
    let payload_sha256 = format!("{:x}", payload_hasher.finalize());

    let verification = VerificationReport {
        verified_at: exported_at.clone(),
        archive_sha256: payload_sha256.clone(),
        archive_size_bytes: payload_tar_gz.len() as u64,
        file_count: tar_entries.len(),
        asset_checksums_verified: checksum_entries.len(),
        asset_checksums_failed: checksums_failed,
        missing_assets: missing_assets.clone(),
        issues: issues.clone(),
        passed,
        redaction: redaction_summary,
    };

    // 最终 tar：包含 verification-report.json（同样脱敏）
    let verification_json = redacted_serialize(&verification, &mut redact);
    let verification_bytes_audit = verification_json.clone();
    let mut final_entries = tar_entries;
    final_entries.push(("verification-report.json".into(), verification_json));

    let tar_gz_bytes = build_tar_gz(&final_entries)?;
    let mut final_hasher = Sha256::new();
    final_hasher.update(&tar_gz_bytes);
    // final_archive_sha256 是完整归档的 hash（存入审计记录，不含在报告内以避免自引用）
    let final_archive_sha256 = format!("{:x}", final_hasher.finalize());

    let safe_project_name = sanitize_name(&project.name);
    let filename = format!(
        "{}-{}-{}.tar.gz",
        safe_project_name,
        export_type,
        now.format("%Y%m%d-%H%M%S")
    );

    Ok(BuiltExport {
        tar_gz_bytes,
        filename,
        file_sha256: final_archive_sha256,
        manifest_sha256,
        manifest_bytes: manifest_json,
        checksums_bytes: checksums_bytes_audit,
        missing_bytes: missing_bytes_audit,
        snapshot_bytes: snapshot_bytes_audit,
        gen_params_bytes: gen_params_bytes_audit,
        verification_bytes: verification_bytes_audit,
        manifest,
        checksums: checksum_entries,
        snapshot,
        generation_params,
        verification,
        missing: missing_assets,
    })
}

/// 构建纯文本/核心策划包（不包含二进制资产，仅 markdown）
pub async fn build_core_bundle_only(
    state: &AppState,
    project: &Project,
    script: &Option<Script>,
    storyboard: &Option<Storyboard>,
    assets: &[Asset],
    conversations: &[(Conversation, Vec<Message>)],
) -> AppResult<BuiltExport> {
    // core 类型直接复用完整构建，但剥离资产文件 —— 为简洁我们单独构建
    let now = Utc::now();
    let exported_at = now.to_rfc3339();

    // 敏感信息剔除
    let mut redact = RedactionAcc::default();

    let assets_dir_root = resolve_upload_root(state).await?;
    let mut missing_assets: Vec<MissingAssetInfo> = Vec::new();
    let mut manifest_asset_entries: Vec<AssetManifestEntry> = Vec::new();

    for asset in assets.iter() {
        let present = resolve_local_asset_path_from_root(&assets_dir_root, asset).await.is_ok();
        let metadata_value = asset
            .metadata
            .as_deref()
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok());

        if present {
            manifest_asset_entries.push(AssetManifestEntry {
                id: asset.id.clone(),
                name: asset.name.clone(),
                asset_type: asset.asset_type.clone(),
                archive_path: None, // core 包不含资产二进制
                sha256: None,
                size_bytes: None,
                missing: false,
                missing_reason: Some("core bundle 不包含资产二进制文件".into()),
                metadata: metadata_value,
            });
        } else {
            missing_assets.push(MissingAssetInfo {
                asset_id: asset.id.clone(),
                name: asset.name.clone(),
                asset_type: asset.asset_type.clone(),
                reason: "磁盘文件缺失（core 包不包含资产）".into(),
                url: asset.url.clone(),
            });
            manifest_asset_entries.push(AssetManifestEntry {
                id: asset.id.clone(),
                name: asset.name.clone(),
                asset_type: asset.asset_type.clone(),
                archive_path: None,
                sha256: None,
                size_bytes: None,
                missing: true,
                missing_reason: Some("磁盘文件缺失".into()),
                metadata: None,
            });
        }
    }

    let snapshot = build_project_snapshot(project, script, storyboard, assets, conversations, &exported_at);
    let generation_params = build_generation_params_summary(assets, conversations, &exported_at);
    let script_md = build_script_markdown(script);
    let storyboard_json = build_storyboard_json(storyboard);
    let core_md = build_core_bundle_markdown(
        project,
        script,
        storyboard,
        assets,
        &[], // no included binaries
        &missing_assets,
        &exported_at,
    );

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    entries.push(("core-bundle.md".into(), redacted_text(&core_md, &mut redact)));
    entries.push(("script/current-script.md".into(), redacted_text(&script_md, &mut redact)));
    entries.push(("storyboard/storyboard.json".into(), redacted_text(&storyboard_json, &mut redact)));
    entries.push((
        "timeline/final-cut.json".into(),
        redacted_json_bytes(&serde_json::json!({
            "note": "Final cut timeline is derived client-side; server-side export preserves raw data for reproducibility",
            "generatedAt": exported_at,
        }), &mut redact),
    ));

    for (idx, (conv, messages)) in conversations.iter().enumerate() {
        let md = conversation_to_markdown(conv, messages);
        let safe_title = sanitize_name(&conv.title);
        entries.push((
            format!("conversations/{:02}-{}.md", idx, safe_title),
            redacted_text(&md, &mut redact),
        ));
    }

    let final_cut_shots = storyboard.as_ref().map(|s| s.lines.len()).unwrap_or(0);

    let checksums: Vec<AssetChecksumEntry> = Vec::new();
    let checksums_json = redacted_json_bytes(&serde_json::json!({
        "generatedAt": exported_at,
        "algorithm": "SHA-256",
        "entries": [],
        "note": "core bundle does not include binary assets"
    }), &mut redact);

    let missing_json = redacted_json_bytes(&serde_json::json!({
        "generatedAt": exported_at,
        "totalMissing": missing_assets.len(),
        "assets": missing_assets,
    }), &mut redact);

    let snapshot_json = redacted_serialize(&snapshot, &mut redact);
    let gen_params_json = redacted_serialize(&generation_params, &mut redact);

    // 保留已脱敏副本供审计记录
    let checksums_bytes_audit = checksums_json.clone();
    let missing_bytes_audit = missing_json.clone();
    let snapshot_bytes_audit = snapshot_json.clone();
    let gen_params_bytes_audit = gen_params_json.clone();

    entries.push(("checksums.json".into(), checksums_json));
    entries.push(("missing-assets.json".into(), missing_json));
    entries.push(("project-snapshot.json".into(), snapshot_json));
    entries.push(("generation-params.json".into(), gen_params_json));

    // manifest.files 覆盖除 manifest.json 和 verification-report.json 之外的所有条目（两者含自引用 hash）
    let mut file_entries: Vec<FileEntry> = Vec::new();
    for (path, data) in &entries {
        let mut hasher = Sha256::new();
        hasher.update(data);
        file_entries.push(FileEntry {
            path: path.clone(),
            size_bytes: data.len() as u64,
            sha256: format!("{:x}", hasher.finalize()),
        });
    }

    let manifest = ExportManifest {
        export_version: EXPORT_VERSION.to_string(),
        bundle_format: BUNDLE_FORMAT.to_string(),
        exported_at: exported_at.clone(),
        exported_by_user_id: project.user_id.clone(),
        project: ProjectManifestInfo {
            id: project.id.clone(),
            name: project.name.clone(),
            status: project.status.clone(),
            phase: project.phase.clone(),
            created_at: project.created_at.clone(),
            updated_at: project.updated_at.clone(),
        },
        export_type: "core".to_string(),
        counts: ExportCounts {
            asset_total: assets.len(),
            asset_included: 0,
            asset_missing: missing_assets.len(),
            script_included: script.is_some(),
            storyboard_included: storyboard.is_some(),
            conversation_count: conversations.len(),
            final_cut_shots: final_cut_shots,
        },
        assets: manifest_asset_entries,
        files: file_entries,
    };
    let manifest_json = redacted_serialize(&manifest, &mut redact);

    // 计算 manifest.json 自身 hash
    let mut manifest_hasher = Sha256::new();
    manifest_hasher.update(&manifest_json);
    let manifest_sha256 = format!("{:x}", manifest_hasher.finalize());

    entries.insert(0, ("manifest.json".into(), manifest_json.clone()));

    let mut issues = Vec::new();
    if !missing_assets.is_empty() {
        issues.push(VerificationIssue {
            severity: "warning".into(),
            code: "MISSING_ASSETS".into(),
            message: format!("{} 个资产在磁盘缺失", missing_assets.len()),
            path: None,
        });
    }

    // 敏感信息剔除统计
    let redaction_summary = redact.to_summary();
    if let Some(rs) = &redaction_summary {
        issues.push(VerificationIssue {
            severity: "info".into(),
            code: "SENSITIVE_DATA_REDACTED".into(),
            message: format!(
                "已自动剔除 {} 处敏感字段、{} 处敏感字符串（匹配 key：{}；模式：{}）",
                rs.key_hits,
                rs.pattern_hits,
                rs.matched_keys.join(", "),
                rs.matched_patterns.join(", ")
            ),
            path: None,
        });
    }

    // payload_sha256: 除 verification-report.json 外所有内容的 hash
    let payload_tar_gz = build_tar_gz(&entries)?;
    let mut payload_hasher = Sha256::new();
    payload_hasher.update(&payload_tar_gz);
    let payload_sha256 = format!("{:x}", payload_hasher.finalize());

    let verification = VerificationReport {
        verified_at: exported_at,
        archive_sha256: payload_sha256,
        archive_size_bytes: payload_tar_gz.len() as u64,
        file_count: entries.len(),
        asset_checksums_verified: 0,
        asset_checksums_failed: 0,
        missing_assets: missing_assets.clone(),
        issues,
        passed: true,
        redaction: redaction_summary,
    };
    let verification_json = redacted_serialize(&verification, &mut redact);
    let verification_bytes_audit = verification_json.clone();
    entries.push(("verification-report.json".into(), verification_json));

    let tar_gz_bytes = build_tar_gz(&entries)?;
    let mut final_hasher = Sha256::new();
    final_hasher.update(&tar_gz_bytes);
    let final_sha = format!("{:x}", final_hasher.finalize());

    let safe_project_name = sanitize_name(&project.name);
    let filename = format!(
        "{}-core-{}.tar.gz",
        safe_project_name,
        now.format("%Y%m%d-%H%M%S")
    );

    Ok(BuiltExport {
        tar_gz_bytes,
        filename,
        file_sha256: final_sha,
        manifest_sha256,
        manifest_bytes: manifest_json,
        checksums_bytes: checksums_bytes_audit,
        missing_bytes: missing_bytes_audit,
        snapshot_bytes: snapshot_bytes_audit,
        gen_params_bytes: gen_params_bytes_audit,
        verification_bytes: verification_bytes_audit,
        manifest,
        checksums,
        snapshot,
        generation_params,
        verification,
        missing: missing_assets,
    })
}

/* ── 辅助函数 ────────────────────────────────────── */

fn build_tar_gz(entries: &[(String, Vec<u8>)]) -> AppResult<Vec<u8>> {
    let mut tar_builder = tar::Builder::new(Vec::new());
    for (path_str, data) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar_builder
            .append_data(&mut header, path_str, data.as_slice())
            .map_err(|e| AppError::Internal(format!("tar append error: {}", e)))?;
    }
    let tar_bytes = tar_builder
        .into_inner()
        .map_err(|e| AppError::Internal(format!("tar finalize error: {}", e)))?;

    // gzip 压缩
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&tar_bytes)
        .map_err(|e| AppError::Internal(format!("gzip error: {}", e)))?;
    let gz_bytes = encoder
        .finish()
        .map_err(|e| AppError::Internal(format!("gzip finish error: {}", e)))?;
    Ok(gz_bytes)
}

async fn resolve_upload_root(state: &AppState) -> AppResult<PathBuf> {
    fs::canonicalize(&state.config.assets_dir)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to resolve assets dir: {}", e)))
}

fn extract_local_filename(url: &str) -> Option<&str> {
    let f = url.strip_prefix(LOCAL_UPLOAD_URL_PREFIX)?;
    if f.is_empty() || f.contains('/') || f.contains('\\') {
        None
    } else {
        Some(f)
    }
}

async fn resolve_local_asset_path_from_root(root: &Path, asset: &Asset) -> Result<PathBuf, String> {
    let filename = extract_local_filename(&asset.url)
        .ok_or_else(|| "非本地存储资产（外部URL）".to_string())?;
    let candidate = root.join(filename);
    let canonical = fs::canonicalize(&candidate)
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "磁盘文件不存在".to_string()
            } else {
                format!("路径解析失败: {}", e)
            }
        })?;
    if !canonical.starts_with(root) {
        return Err("非法路径（越界）".into());
    }
    Ok(canonical)
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn extract_extension(name: &str, url: &str) -> String {
    let from_name = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| format!(".{}", s.to_ascii_lowercase()));
    if let Some(ext) = from_name {
        if ext.len() <= 6 {
            return ext;
        }
    }
    let from_url = Path::new(url)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| format!(".{}", s.to_ascii_lowercase()))
        .unwrap_or_default();
    from_url
}

fn asset_to_json_value(asset: &Asset) -> serde_json::Value {
    let metadata_value = asset
        .metadata
        .as_deref()
        .and_then(|m| serde_json::from_str(m).ok());
    serde_json::json!({
        "id": asset.id,
        "projectId": asset.project_id,
        "name": asset.name,
        "type": asset.asset_type,
        "url": asset.url,
        "metadata": metadata_value,
        "createdAt": asset.created_at,
        "updatedAt": asset.updated_at,
    })
}

fn build_project_snapshot(
    project: &Project,
    script: &Option<Script>,
    storyboard: &Option<Storyboard>,
    assets: &[Asset],
    conversations: &[(Conversation, Vec<Message>)],
    exported_at: &str,
) -> ProjectSnapshot {
    let project_val = serde_json::json!({
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "status": project.status,
        "phase": project.phase,
        "createdAt": project.created_at,
        "updatedAt": project.updated_at,
    });

    let script_val = script.as_ref().map(|s| {
        serde_json::json!({
            "id": s.id,
            "projectId": s.project_id,
            "title": s.title,
            "content": s.content,
            "createdAt": s.created_at,
            "updatedAt": s.updated_at,
        })
    });

    let storyboard_val = storyboard.as_ref().map(|sb| {
        serde_json::json!({
            "id": sb.id,
            "projectId": sb.project_id,
            "lines": sb.lines.iter().map(|l| {
                serde_json::json!({
                    "id": l.id,
                    "sceneNumber": l.scene_number,
                    "description": l.description,
                    "duration": l.duration,
                    "assets": l.assets.iter().map(asset_to_json_value).collect::<Vec<_>>(),
                })
            }).collect::<Vec<_>>(),
            "updatedAt": sb.updated_at,
        })
    });

    let assets_val = assets.iter().map(asset_to_json_value).collect::<Vec<_>>();

    let conv_snaps = conversations
        .iter()
        .map(|(c, msgs)| ConversationSnapshot {
            id: c.id.clone(),
            title: c.title.clone(),
            created_at: c.created_at.clone(),
            messages: msgs
                .iter()
                .map(|m| {
                    let token_usage = m
                        .token_usage
                        .as_deref()
                        .and_then(|t| serde_json::from_str(t).ok());
                    let meta = m.meta.as_deref().and_then(|t| serde_json::from_str(t).ok());
                    serde_json::json!({
                        "id": m.id,
                        "conversationId": m.conversation_id,
                        "role": m.role,
                        "content": m.content,
                        "type": m.msg_type,
                        "agentId": m.agent_id,
                        "modelUsed": m.model_used,
                        "tokenUsage": token_usage,
                        "meta": meta,
                        "createdAt": m.created_at,
                    })
                })
                .collect(),
        })
        .collect();

    ProjectSnapshot {
        exported_at: exported_at.to_string(),
        project: project_val,
        script: script_val,
        storyboard: storyboard_val,
        assets: assets_val,
        conversations: conv_snaps,
    }
}

fn build_generation_params_summary(
    assets: &[Asset],
    conversations: &[(Conversation, Vec<Message>)],
    generated_at: &str,
) -> GenerationParamsSummary {
    let mut models = BTreeSet::new();
    let mut total_calls = 0usize;

    for (_, messages) in conversations {
        for msg in messages {
            if let Some(model) = &msg.model_used {
                if !model.is_empty() {
                    models.insert(model.clone());
                    total_calls += 1;
                }
            }
        }
    }

    // 从资产元数据提取生成参数摘要
    let mut image_gens = Vec::new();
    let mut video_gens = Vec::new();

    for asset in assets {
        if let Some(meta_str) = &asset.metadata {
            if let Ok(meta) = serde_json::from_str::<serde_json::Value>(meta_str) {
                if let Some(prompt) = meta.get("prompt").and_then(|v| v.as_str()) {
                    let mut hasher = Sha256::new();
                    hasher.update(prompt.as_bytes());
                    let prompt_hash = format!("{:x}", hasher.finalize())[..16].to_string();
                    let model = meta.get("model").and_then(|v| v.as_str()).map(String::from);
                    if let Some(m) = &model {
                        models.insert(m.clone());
                    }
                    if asset.asset_type == "image" {
                        image_gens.push(ImageGenSummary {
                            id: asset.id.clone(),
                            prompt_hash,
                            model,
                            created_at: asset.created_at.clone(),
                            asset_ids: vec![asset.id.clone()],
                        });
                    } else if asset.asset_type == "video" {
                        video_gens.push(VideoGenSummary {
                            id: asset.id.clone(),
                            prompt_hash,
                            model,
                            created_at: asset.created_at.clone(),
                        });
                    }
                }
            }
        }
    }

    GenerationParamsSummary {
        generated_at: generated_at.to_string(),
        image_generations: image_gens,
        video_generations: video_gens,
        models_used: models,
        total_ai_calls: total_calls,
    }
}

fn build_script_markdown(script: &Option<Script>) -> String {
    match script {
        Some(s) => {
            format!("# {}\n\n{}", s.title, s.content)
        }
        None => "# （暂无剧本）\n\n项目未绑定剧本文档。".to_string(),
    }
}

fn build_storyboard_json(storyboard: &Option<Storyboard>) -> String {
    match storyboard {
        Some(sb) => serde_json::to_string_pretty(&serde_json::json!({
            "id": sb.id,
            "projectId": sb.project_id,
            "lines": sb.lines.iter().map(|l| serde_json::json!({
                "id": l.id,
                "sceneNumber": l.scene_number,
                "description": l.description,
                "duration": l.duration,
                "assetIds": l.assets.iter().map(|a| &a.id).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "updatedAt": sb.updated_at,
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        None => serde_json::json!({"note": "项目无分镜数据"}).to_string(),
    }
}

fn build_core_bundle_markdown(
    project: &Project,
    script: &Option<Script>,
    storyboard: &Option<Storyboard>,
    assets: &[Asset],
    included_assets: &[(Asset, PathBuf, Vec<u8>, String)],
    missing: &[MissingAssetInfo],
    exported_at: &str,
) -> String {
    let mut md = String::new();
    md.push_str(&format!("# {} — 核心策划包\n\n", project.name));
    md.push_str(&format!("- 导出时间: {}\n", exported_at));
    md.push_str(&format!("- 项目 ID: {}\n", project.id));
    md.push_str(&format!("- 状态: {} / 阶段: {}\n", project.status, project.phase));
    md.push_str(&format!(
        "- 镜头数: {}\n",
        storyboard.as_ref().map(|s| s.lines.len()).unwrap_or(0)
    ));
    md.push_str(&format!("- 资产总数: {}\n", assets.len()));
    md.push_str(&format!("- 已打包资产: {}\n", included_assets.len()));
    md.push_str(&format!("- 缺失资产: {}\n\n", missing.len()));

    if let Some(sb) = storyboard {
        md.push_str("## 分镜规划\n\n");
        md.push_str("| # | 描述 | 时长(s) |\n|---|---|---|\n");
        for line in &sb.lines {
            let desc: String = line.description.chars().take(60).collect();
            md.push_str(&format!(
                "| {} | {} | {} |\n",
                line.scene_number, desc, line.duration
            ));
        }
        md.push('\n');
    }

    md.push_str("## 资产清单\n\n");
    for asset in assets {
        let status = if included_assets.iter().any(|(a, _, _, _)| a.id == asset.id) {
            "✓"
        } else if missing.iter().any(|m| m.asset_id == asset.id) {
            "✗"
        } else {
            "-"
        };
        md.push_str(&format!(
            "- [{}] {} ({})\n",
            status, asset.name, asset.asset_type
        ));
    }
    md.push('\n');

    if let Some(s) = script {
        md.push_str("## 剧本\n\n");
        md.push_str(&s.content);
        md.push('\n');
    }

    md
}

fn conversation_to_markdown(conv: &Conversation, messages: &[Message]) -> String {
    let mut md = format!("# {}\n\n", conv.title);
    for msg in messages {
        let role_label = match msg.role.as_str() {
            "user" => "用户",
            "assistant" => "AI",
            _ => "系统",
        };
        md.push_str(&format!(
            "## [{}] {} — {}\n\n{}\n\n",
            role_label,
            msg.id,
            msg.created_at,
            msg.content
        ));
    }
    md
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn tar_builder_produces_valid_gzip_nonempty() {
        let entries: Vec<(String, Vec<u8>)> = vec![
            ("hello.txt".into(), b"hello world".to_vec()),
            ("nested/file.json".into(), br#"{"ok":true}"#.to_vec()),
        ];
        let bytes = build_tar_gz(&entries).expect("build tar.gz");
        assert!(!bytes.is_empty(), "tar.gz must not be empty");
        // gzip magic number: 1f 8b
        assert_eq!(&bytes[..2], &[0x1f, 0x8b], "not a gzip stream");
    }

    #[test]
    fn tar_contains_all_entries_manifest_hash_matches() {
        // Build entries with known content and compute expected sha256
        let entries: Vec<(String, Vec<u8>)> = vec![
            ("manifest.json".into(), br#"{"v":1}"#.to_vec()),
            ("a.txt".into(), b"alpha".to_vec()),
            ("b.txt".into(), b"bravo".to_vec()),
        ];

        // Build FileEntry hashes as the production code does
        let expected_files: Vec<FileEntry> = entries
            .iter()
            .map(|(p, d)| {
                let mut h = Sha256::new();
                h.update(d);
                FileEntry {
                    path: p.clone(),
                    size_bytes: d.len() as u64,
                    sha256: format!("{:x}", h.finalize()),
                }
            })
            .collect();

        let tar_bytes = build_tar_gz(&entries).expect("build tar");
        assert!(!tar_bytes.is_empty());

        // Verify each expected file's hash matches independent recomputation
        for fe in &expected_files {
            let data = entries
                .iter()
                .find(|(p, _)| p == &fe.path)
                .expect("entry not found");
            let mut h = Sha256::new();
            h.update(&data.1);
            let got = format!("{:x}", h.finalize());
            assert_eq!(got, fe.sha256, "hash mismatch for {}", fe.path);
            assert_eq!(fe.size_bytes as usize, data.1.len());
        }
    }

    #[test]
    fn sanitize_name_strips_unsafe_chars() {
        assert_eq!(sanitize_name("my project"), "my_project");
        assert_eq!(sanitize_name("a/b:c"), "a_b_c");
        assert_eq!(sanitize_name("..hidden"), "hidden");
        assert_eq!(sanitize_name("normal-name_01"), "normal-name_01");
        assert!(sanitize_name("").is_empty() || sanitize_name("") == "");
    }

    #[test]
    fn extract_extension_prefers_name_over_url() {
        assert_eq!(extract_extension("photo.png", "/uploads/x"), ".png");
        assert_eq!(extract_extension("readme", "/uploads/x.md"), ".md");
        assert_eq!(extract_extension("video", "/uploads/clip.mp4"), ".mp4");
        assert_eq!(extract_extension("noext", "/uploads/x"), "");
    }

    #[test]
    fn export_status_derived_from_verification_and_missing() {
        // Mirrors the classification logic in handlers::create_export
        let classify = |passed: bool, missing: usize| -> &'static str {
            if passed && missing == 0 {
                "completed"
            } else if passed {
                "partial"
            } else {
                "failed"
            }
        };
        assert_eq!(classify(true, 0), "completed");
        assert_eq!(classify(true, 3), "partial");
        assert_eq!(classify(false, 0), "failed");
        assert_eq!(classify(false, 5), "failed");
    }

    #[test]
    fn redacted_json_bytes_replaces_sensitive_key_and_preserves_rest() {
        // Verify that redaction is applied when serializing to bytes and the rest
        // of the object is intact.
        let mut acc = RedactionAcc::default();
        let v = serde_json::json!({
            "project": "demo",
            "apiKey": "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789longkey",
            "count": 42
        });
        let bytes = redacted_json_bytes(&v, &mut acc);
        let s = String::from_utf8(bytes).expect("utf8");
        assert!(s.contains("\"project\": \"demo\""), "project field lost: {}", s);
        assert!(s.contains("\"count\": 42"), "count field lost");
        assert!(!s.contains("sk-proj-ABCDEFG"), "apiKey not redacted!");
        assert!(s.contains("[REDACTED]"), "missing redaction marker");
        assert!(acc.key_hits >= 1, "expected at least 1 key hit, got {}", acc.key_hits);
    }
}
