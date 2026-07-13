use chrono::Utc;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::asset;
use crate::conversation;
use crate::error::AppResult;
use crate::project;
use crate::script;
use crate::storyboard;
use sqlx::SqlitePool;

use super::model::*;

/// Collect everything needed for an export from the database
pub async fn collect_project_data(
    pool: &SqlitePool,
    project_id: &str,
    user_id: &str,
) -> AppResult<CollectedProjectData> {
    let proj = project::repo::find_by_id(pool, project_id).await?;
    let assets = asset::repo::list_by_project(pool, project_id).await?;
    let script_opt = script::repo::find_by_project(pool, project_id).await?;
    let storyboard_opt = storyboard::repo::find_by_project(pool, project_id).await?;
    let conversations = conversation::repo::list_by_project(pool, project_id, user_id).await?;

    let mut conv_messages: HashMap<String, Vec<conversation::model::Message>> = HashMap::new();
    for conv in &conversations {
        let msgs = conversation::repo::list_messages(pool, &conv.id).await?;
        conv_messages.insert(conv.id.clone(), msgs);
    }

    Ok(CollectedProjectData {
        project: proj,
        assets,
        script: script_opt,
        storyboard: storyboard_opt,
        conversations,
        conversation_messages: conv_messages,
    })
}

pub struct CollectedProjectData {
    pub project: Option<project::model::Project>,
    pub assets: Vec<asset::model::Asset>,
    pub script: Option<script::model::Script>,
    pub storyboard: Option<storyboard::model::Storyboard>,
    pub conversations: Vec<conversation::model::Conversation>,
    pub conversation_messages: HashMap<String, Vec<conversation::model::Message>>,
}

/// Run preflight check: reachability of assets, completeness of documents,
/// duplicate names, empty content, dangling references, sensitive content.
pub async fn run_preflight(
    pool: &SqlitePool,
    project_id: &str,
    user_id: &str,
) -> AppResult<PreflightResult> {
    use std::collections::HashMap;

    let data = collect_project_data(pool, project_id, user_id).await?;
    let project = data.project.ok_or_else(|| {
        crate::error::AppError::NotFound(format!("Project {} not found", project_id))
    })?;

    let mut findings: Vec<PreflightFinding> = Vec::new();
    let mut asset_checks: Vec<PreflightAssetCheck> = Vec::new();
    let mut name_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut reachable = 0i64;
    let mut missing = 0i64;
    let mut uncertain = 0i64;
    let mut duplicate_names = 0i64;
    let mut zero_byte = 0i64;
    let mut estimated_size = 0i64;
    let upload_root = std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "./uploads".to_string());

    let add_finding = |findings: &mut Vec<PreflightFinding>,
                       severity: PreflightSeverity,
                       code: &str,
                       message: &str,
                       asset_id: Option<String>,
                       subject: Option<String>| {
        findings.push(PreflightFinding {
            severity,
            code: code.to_string(),
            message: message.to_string(),
            asset_id,
            subject,
        });
    };

    // ── Per-asset checks ─────────────────────────────────────────
    for asset in data.assets.iter() {
        let mut asset_findings: Vec<PreflightFinding> = Vec::new>();
        let mut status = VerifyStatus::Pass;
        let mut reason = None;
        let mut size: Option<i64> = None;

        // Check 1: Empty name
        if asset.name.trim().is_empty() {
            asset_findings.push(PreflightFinding {
                severity: PreflightSeverity::Blocking,
                code: "ASSET_EMPTY_NAME".to_string(),
                message: "资产名称为空，将无法在包中正确命名".to_string(),
                asset_id: Some(asset.id.clone()),
                subject: None,
            });
            status = VerifyStatus::Fail;
        }

        // Check 2: Missing URL
        if asset.url.trim().is_empty() {
            asset_findings.push(PreflightFinding {
                severity: PreflightSeverity::Blocking,
                code: "ASSET_NO_URL".to_string(),
                message: "资产缺少 URL，无法下载".to_string(),
                asset_id: Some(asset.id.clone()),
                subject: None,
            });
            status = VerifyStatus::Fail;
            asset_checks.push(PreflightAssetCheck {
                asset_id: asset.id.clone(),
                name: if asset.name.trim().is_empty() {
                    "(unnamed)".to_string()
                } else {
                    asset.name.clone()
                },
                asset_type: asset.asset_type.clone(),
                url: asset.url.clone(),
                status,
                reason: Some("资产缺少 URL".to_string()),
                size_bytes: None,
                findings: if asset_findings.is_empty() {
                    None
                } else {
                    Some(asset_findings.clone())
                },
            });
            missing += 1;

            // Track name for duplicate detection even though URL missing
            if !asset.name.trim().is_empty() {
                let key = asset.name.trim().to_lowercase();
                name_map.entry(key).or_default().push(asset.id.clone());
            }
            continue;
        }

        // Check 3: URL reachability
        if asset.url.starts_with("/uploads/") {
            let filename = asset.url.trim_start_matches("/uploads/");
            let file_path = std::path::Path::new(&upload_root).join(filename);
            match std::fs::metadata(&file_path) {
                Ok(meta) => {
                    status = VerifyStatus::Pass;
                    let sz = meta.len() as i64;
                    size = Some(sz);
                    estimated_size += sz;
                    reachable += 1;
                    if sz == 0 {
                        asset_findings.push(PreflightFinding {
                            severity: PreflightSeverity::Warning,
                            code: "ASSET_ZERO_BYTES".to_string(),
                            message: "资产大小为 0 字节，可能已损坏".to_string(),
                            asset_id: Some(asset.id.clone()),
                            subject: None,
                        });
                        zero_byte += 1;
                    }
                }
                Err(_) => {
                    status = VerifyStatus::Fail;
                    reason = Some(format!("本地文件不存在: {}", file_path.display()));
                    asset_findings.push(PreflightFinding {
                        severity: PreflightSeverity::Blocking,
                        code: "ASSET<[PLHD78_never_used_51bce0c785ca2f68081bfa7d91973934]>_LOCAL_FILE".to_string(),
                        message: format!("本地文件不存在: {}", file_path.display()),
                        asset_id: Some(asset.id.clone()),
                        subject: None,
                    });
                    missing += 1;
                }
            }
        } else if asset.url.starts_with("http://") || asset.url.starts_with("https://") {
            status = VerifyStatus::Warn;
            reason = Some("外部 URL，导出时将尝试下载".to_string());
            uncertain += 1;
            if let Some(ref md) = asset.metadata {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(md) {
                    if let Some(sz) = parsed.get("sizeBytes").and_then(|v| v.as_i64()) {
                        size = Some(sz);
                        estimated_size += sz;
                        if sz == 0 {
                            asset_findings.push(PreflightFinding {
                                severity: PreflightSeverity::Warning,
                                code: "ASSET_ZERO_BYTES".to_string(),
                                message: "资产元数据显示大小为 0 字节".to_string(),
                                asset_id: Some(asset.id.clone()),
                                subject: None,
                            });
                            zero_byte += 1;
                        }
                    }
                }
            }
        } else if asset.url.starts_with("data:") {
            status = VerifyStatus::Pass;
            reachable += 1;
        } else {
            status = VerifyStatus::Fail;
            let url_preview: String = asset.url.chars().take(60).collect();
            reason = Some(format!("无法识别的 URL 格式: {}", url_preview));
            asset_findings.push(PreflightFinding {
                severity: PreflightSeverity::Blocking,
                code: "ASSET_BAD_URL".to_string(),
                message: format!("无法识别的 URL 格式: {}", url_preview),
                asset_id: Some(asset.id.clone()),
                subject: None,
            });
            missing += 1;
        }

        // Check 5: Duplicate name tracking
        if !asset.name.trim().is_empty() {
            let key = asset.name.trim().to_lowercase();
            name_map.entry(key).or_default().push(asset.id.clone());
        }

        // Collect findings
        for f in &asset_findings {
            findings.push(PreflightFinding {
                severity: f.severity.clone(),
                code: f.code.clone(),
                message: f.message.clone(),
                asset_id: f.asset_id.clone(),
                subject: f.subject.clone(),
            });
        }

        asset_checks.push(PreflightAssetCheck {
            asset_id: asset.id.clone(),
            name: if asset.name.trim().is_empty() {
                "(unnamed)".to_string()
            } else {
                asset.name.clone()
            },
            asset_type: asset.asset_type.clone(),
            url: if asset.url.starts_with("data:") {
                asset.url.chars().take(60).collect::<String>() + "..."
            } else {
                asset.url.clone()
            },
            status,
            reason,
            size_bytes: size,
            findings: if asset_findings.is_empty() {
                None
            } else {
                Some(asset_findings)
            },
        });
    }

    // Check 7: Duplicate names
    for (name, ids) in &name_map {
        if ids.len() > 1 {
            duplicate_names += ids.len() as i64;
            add_finding(
                &mut findings,
                PreflightSeverity::Warning,
                "DUPLICATE_ASSET_NAME",
                &format!("存在 {} 个同名资产「{}」，导出时将重命名避免覆盖", ids.len(), name),
                Some(ids[0].clone()),
                Some(name.clone()),
            );
        }
    }

    // ── Script checks ─────────────────────────────────────────────
    let script_content = data
        .script
        .as_ref()
        .map(|s| s.content.trim().to_string())
        .unwrap_or_default();
    let script_ready = !script_content.is_empty();

    match &data.script {
        None => {
            add_finding(
                &mut findings,
                PreflightSeverity::Info,
                "SCRIPT_MISSING",
                "当前项目没有保存剧本（可能只在对话中生成）",
                None,
                None,
            );
        }
        Some(_) if !script_ready => {
            add_finding(
                &mut findings,
                PreflightSeverity::Warning,
                "SCRIPT_EMPTY",
                "剧本记录存在但内容为空，导出包中将缺少剧本文档",
                None,
                None,
            );
        }
        Some(_) if script_content.len() < 50 => {
            add_finding(
                &mut findings,
                PreflightSeverity::Warning,
                "SCRIPT_TOO_SHORT",
                &format!("剧本内容较短 ({} 字符)，可能是草稿", script_content.len()),
                None,
                None,
            );
        }
        Some(_) => {
            add_finding(
                &mut findings,
                PreflightSeverity::Info,
                "SCRIPT_OK",
                &format!("剧本就绪，约 {} 字符", script_content.len()),
                None,
                None,
            );
        }
    }

    if script_ready {
        // Simple string-based sensitive content detection (no regex dep needed)
        let lower = script_content.to_lowercase();
        let has_api_key = lower.contains("sk-")
            || lower.contains("api_key")
            || lower.contains("api key")
            || lower.contains("secret=")
            || lower.contains("secret =")
            || lower.contains("password=");
        if has_api_key {
            add_finding(
                &mut findings,
                PreflightSeverity::Warning,
                "SCRIPT_SENSITIVE_KEY",
                "剧本中检测到可能的 API Key 或密钥，交付前请确认是否需要脱敏",
                None,
                None,
            );
        }

        let has_pii = script_content.contains("@gmail.com")
            || script_content.contains("@qq.com")
            || script_content.contains("@163.com")
            || script_content.contains("身份证")
            || contains_china_phone(&script_content);
        if has_pii {
            add_finding(
                &mut findings,
                PreflightSeverity::Warning,
                "SCRIPT_PII",
                "剧本中检测到可能的个人信息（手机号/邮箱/身份证），交付前请确认是否需要脱敏",
                None,
                None,
            );
        }
    }

    // ── Storyboard checks ─────────────────────────────────────────
    let sb_lines = data
        .storyboard
        .as_ref()
        .map(|s| &s.lines)
        .cloned()
        .unwrap_or_default();
    let storyboard_ready = !sb_lines.is_empty();

    match &data.storyboard {
        None => {
            add_finding(
                &mut findings,
                PreflightSeverity::Info,
                "STORYBOARD_MISSING",
                "当前项目没有分镜数据，导出包中将缺少分镜文件",
                None,
                None,
            );
        }
        Some(_) if !storyboard_ready => {
            add_finding(
                &mut findings,
                PreflightSeverity::Warning,
                "STORYBOARD_EMPTY",
                "分镜记录存在但没有镜头数据",
                None,
                None,
            );
        }
        Some(_) => {
            let empty_descriptions = sb_lines
                .iter()
                .filter(|l| l.description.trim().is_empty())
                .count();
            if empty_descriptions > 0 {
                add_finding(
                    &mut findings,
                    PreflightSeverity::Warning,
                    "STORYBOARD_EMPTY_SCENES",
                    &format!("{} 个分镜缺少场景描述", empty_descriptions),
                    None,
                    None,
                );
            }

            let zero_duration = sb_lines
                .iter()
                .filter(|l| l.duration <= 0)
                .count();
            if zero_duration > 0 {
                add_finding(
                    &mut findings,
                    PreflightSeverity::Info,
                    "STORYBOARD_ZERO_DURATION",
                    &format!("{} 个分镜时长为 0 秒", zero_duration),
                    None,
                    None,
                );
            }

            let total_duration: i64 = sb_lines.iter().map(|l| l.duration.max(0)).sum();
            add_finding(
                &mut findings,
                PreflightSeverity::Info,
                "STORYBOARD_OK",
                &format!(
                    "分镜就绪，{} 个镜头，总时长约 {} 秒",
                    sb_lines.len(),
                    total_duration
                ),
                None,
                None,
            );
        }
    }

    // ── Project-level checks ──────────────────────────────────────
    if data.assets.is_empty() {
        add_finding(
            &mut findings,
            PreflightSeverity::Warning,
            "NO_ASSETS",
            "当前项目没有任何资产文件，导出包仅包含文档",
            None,
            None,
        );
    }

    let conv_count = data.conversations.len();
    if conv_count == 0 {
        add_finding(
            &mut findings,
            PreflightSeverity::Info,
            "NO_CONVERSATIONS",
            "当前项目没有对话记录，导出包将不含对话历史",
            None,
            None,
        );
    } else {
        let total_messages: usize = data.conversation_messages.values().map(|v| v.len()).sum();
        let ai_messages: usize = data
            .conversation_messages
            .values()
            .map(|msgs| msgs.iter().filter(|m| m.role == "assistant").count())
            .sum();
        add_finding(
            &mut findings,
            PreflightSeverity::Info,
            "CONVERSATIONS_OK",
            &format!(
                "{} 个对话，共 {} 条消息（{} 条 AI 回复）",
                conv_count, total_messages, ai_messages
            ),
            None,
            None,
        );
    }

    // ── Classify findings ─────────────────────────────────────────
    let blocking: Vec<PreflightFinding> = findings
        .iter()
        .filter(|f| matches!(f.severity, PreflightSeverity::Blocking))
        .cloned()
        .collect();
    let warnings_list: Vec<PreflightFinding> = findings
        .iter()
        .filter(|f| matches!(f.severity, PreflightSeverity::Warning))
        .cloned()
        .collect();
    let infos: Vec<PreflightFinding> = findings
        .iter()
        .filter(|f| matches!(f.severity, PreflightSeverity::Info))
        .cloned()
        .collect();

    let has_content = script_ready || storyboard_ready || reachable > 0;
    let can_export = has_content;

    let has_url_failures = findings.iter().any(|f| {
        matches!(f.severity, PreflightSeverity::Blocking)
            && (f.code == "ASSET_BAD_URL" || f.code == "ASSET_NO_URL" || f.code == "ASSET_MISSING_LOCAL_FILE")
    });

    let overall_status = if has_url_failures && !script_ready && !storyboard_ready {
        VerifyStatus::Fail
    } else if !blocking.is_empty() {
        VerifyStatus::Warn
    } else if !warnings_list.is_empty() {
        VerifyStatus::Warn
    } else {
        VerifyStatus::Pass
    };

    Ok(PreflightResult {
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        can_export,
        overall_status,
        findings,
        blocking,
        warnings: warnings_list,
        infos,
        assets: asset_checks,
        asset_summary: PreflightAssetSummary {
            total: data.assets.len() as i64,
            reachable,
            missing,
            uncertain,
            duplicate_names,
            zero_byte,
        },
        script_ready,
        storyboard_ready,
        estimated_size_bytes: estimated_size,
        path_collisions: Vec::new(),
    })
}

/// Build the export manifest (called during export)
pub fn build_manifest(
    export_id: &str,
    user_id: &str,
    data: &CollectedProjectData,
    files: &[FileEntry],
    assets: &[AssetEntry],
    missing_assets: &[MissingAssetEntry],
    verification: VerificationReport,
    client: Option<&str>,
) -> ExportManifest {
    let now = Utc::now().to_rfc3339();

    let project = data.project.as_ref();

    // Compute versions
    let script_version = data.script.as_ref().map(|s| {
        let hash = sha256_hex(s.content.as_bytes());
        DocumentVersion {
            id: s.id.clone(),
            title: Some(s.title.clone()),
            updated_at: parse_timestamp_to_millis(&s.updated_at),
            content_hash: hash.chars().take(16).collect(),
            content_length: s.content.len(),
        }
    });

    let storyboard_version = data.storyboard.as_ref().map(|sb| {
        let content_json = serde_json::to_string(&sb.lines).unwrap_or_default();
        let hash = sha256_hex(content_json.as_bytes());
        DocumentVersion {
            id: sb.id.clone(),
            title: None,
            updated_at: parse_timestamp_to_millis(&sb.updated_at),
            content_hash: hash.chars().take(16).collect(),
            content_length: content_json.len(),
        }
    });

    // Collect generation params from messages
    let mut model_counts: HashMap<String, (i64, Option<i64>)> = HashMap::new();
    let mut total_tokens = 0i64;
    let mut image_count = 0i64;
    let mut video_count = 0i64;
    let mut task_count = 0i64;

    for msgs in data.conversation_messages.values() {
        for msg in msgs {
            if msg.role == "assistant" {
                task_count += 1;
                if let Some(ref model) = msg.model_used {
                    let entry = model_counts.entry(model.clone()).or_insert((0, None));
                    entry.0 += 1;
                }
                if let Some(ref meta_str) = msg.meta {
                    if let Ok(meta) = serde_json::from_str::<serde_json::Value>(meta_str) {
                        if let Some(usage) = meta.get("usage") {
                            let tokens = usage.get("total_tokens")
                                .or_else(|| usage.get("totalTokens"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            total_tokens += tokens;
                            if let Some(ref model) = msg.model_used {
                                let entry = model_counts.entry(model.clone()).or_insert((0, Some(0)));
                                entry.1 = Some(entry.1.unwrap_or(0) + tokens);
                            }
                        }
                        let output_kind = meta.get("outputKind").and_then(|v| v.as_str()).unwrap_or("");
                        if output_kind == "image" { image_count += 1; }
                        if output_kind == "video" { video_count += 1; }
                    }
                }
            }
        }
    }

    let models_used = model_counts.into_iter().map(|(model, (count, tokens))| {
        ModelUsage { model, request_count: count, total_tokens: tokens }
    }).collect();

    // Content flags
    let mut has_external = false;
    let mut has_api_keys = false;
    let mut has_pii = false;
    let mut content_warnings = Vec::new();

    for asset in &data.assets {
        if asset.url.starts_with("http://") || asset.url.starts_with("https://") {
            has_external = true;
        }
    }

    // Check for API key patterns in script/conversations
    let api_key_patterns = ["sk-", "api_key", "API_KEY", "secret=", "password="];
    let pii_patterns = ["@gmail.com", "@qq.com", "@163.com", "手机", "电话", "身份证"];

    if let Some(ref s) = data.script {
        for pat in &api_key_patterns {
            if s.content.contains(pat) { has_api_keys = true; break; }
        }
        for pat in &pii_patterns {
            if s.content.contains(pat) { has_pii = true; break; }
        }
    }

    if has_api_keys {
        content_warnings.push("检测到可能的 API Key 或密钥信息，请确认是否需要脱敏".to_string());
    }
    if has_pii {
        content_warnings.push("检测到可能的个人信息（邮箱/电话等），请确认是否需要脱敏".to_string());
    }
    if has_external {
        content_warnings.push("包中包含外部 URL 资产，解压后需要网络连接才能访问".to_string());
    }

    ExportManifest {
        manifest_version: EXPORT_MANIFEST_VERSION.to_string(),
        export_id: export_id.to_string(),
        exported_at: now.clone(),
        exporter: ExporterInfo {
            tool: "woohoo-studio".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version: EXPORT_MANIFEST_VERSION.to_string(),
            exported_by: Some(user_id.to_string()),
            client: client.map(|s| s.to_string()),
        },
        project: ProjectSnapshotInfo {
            id: project.map(|p| p.id.clone()).unwrap_or_default(),
            name: project.map(|p| p.name.clone()).unwrap_or_default(),
            status: project.map(|p| p.status.clone()).unwrap_or_default(),
            phase: project.map(|p| p.phase.clone()).unwrap_or_default(),
            created_at: project.map(|p| p.created_at.clone()).unwrap_or_default(),
            workflow: None,
        },
        files: files.to_vec(),
        assets: assets.to_vec(),
        missing_assets: missing_assets.to_vec(),
        versions: DocumentVersions {
            script: script_version,
            storyboard: storyboard_version,
            chat_messages_count: data.conversation_messages.values().map(|v| v.len() as i64).sum(),
            pipeline_runs_count: 0, // Could query pipeline runs
        },
        generation_params: GenerationParamsSummary {
            models_used,
            total_ai_tasks: task_count,
            total_tokens_used: if total_tokens > 0 { Some(total_tokens) } else { None },
            image_generations: image_count,
            video_generations: video_count,
        },
        verification,
        content_flags: ContentFlags {
            has_external_urls: has_external,
            has_api_keys,
            has_personal_info: has_pii,
            warnings: content_warnings,
        },
    }
}

/// Compute SHA-256 hex digest of bytes
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in result.iter() {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

fn parse_timestamp_to_millis(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| Utc::now().timestamp_millis())
}

/// Simple China mobile phone number detector (11 digits starting with 1[3-9])
fn contains_china_phone(text: &str) -> bool {
    let bytes = text.as_bytes();
    let n = bytes.len();
    if n < 11 {
        return false;
    }
    for i in 0..=n.saturating_sub(11) {
        if bytes[i] == b'1'
            && bytes[i + 1].is_ascii_digit()
            && (b'3'..=b'9').contains(&bytes[i + 1])
        {
            let mut all_digits = true;
            for j in 0..11 {
                if !bytes[i + j].is_ascii_digit() {
                    all_digits = false;
                    break;
                }
            }
            // Check boundaries (not surrounded by other digits)
            if all_digits {
                let before_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
                let after_ok = i + 11 >= n || !bytes[i + 11].is_ascii_digit();
                if before_ok && after_ok {
                    return true;
                }
            }
        }
    }
    false
}

/// Verify a manifest's file entries against provided data (post-export verification)
pub fn verify_manifest(
    manifest: &ExportManifest,
    file_data: &HashMap<String, Vec<u8>>,
) -> VerificationReport {
    let now = Utc::now().to_rfc3339();
    let mut verified = 0i64;
    let mut failed_checksums = 0i64;
    let mut issues = Vec::new();

    for entry in &manifest.files {
        if let Some(data) = file_data.get(&entry.path) {
            let computed = sha256_hex(data);
            if computed == entry.sha256 {
                verified += 1;
            } else {
                failed_checksums += 1;
                issues.push(format!("校验失败: {} (期望 {}, 实际 {})",
                    entry.path,
                    &entry.sha256[..16],
                    &computed[..16]
                ));
            }
        } else {
            issues.push(format!("清单中声明但包内缺失文件: {}", entry.path));
        }
    }

    let status = if failed_checksums > 0 {
        VerifyStatus::Fail
    } else if !issues.is_empty() {
        VerifyStatus::Warn
    } else {
        VerifyStatus::Pass
    };

    let included_assets = manifest.assets.iter().filter(|a| a.file_path.is_some()).count() as i64;
    VerificationReport {
        status,
        checked_at: now,
        total_files: manifest.files.len() as i64,
        verified_files: verified,
        failed_checksums,
        completeness: CompletenessReport {
            expected_assets: (manifest.assets.len() + manifest.missing_assets.len()) as i64,
            included_assets,
            missing_assets: manifest.missing_assets.len() as i64,
            script_included: manifest.files.iter().any(|f| f.path.starts_with("script/")),
            storyboard_included: manifest.files.iter().any(|f| f.path.starts_with("storyboard/")),
            conversations_included: manifest.files.iter().filter(|f| f.path.starts_with("conversations/")).count() as i64,
        },
        issues,
    }
}
