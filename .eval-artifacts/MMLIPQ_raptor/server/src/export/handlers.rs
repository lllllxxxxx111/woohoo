use axum::{
    extract::{Extension, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;
use tar::Builder as TarBuilder;

use crate::{
    asset, conversation,
    error::{AppError, AppResult},
    project, script, storyboard,
    AppState,
};
use crate::auth::middleware::UserId;

use super::{model::*, repo, sanitize::{self as san, SanitizeCategory}};

// ─── API 端点 ──────────────────────────────────────

/// 导出预检：检查项目资产完整性、预估大小、识别问题
///
/// 覆盖：脚本/分镜空内容、URL/文件存在性、零字节、重复文件名、外部资产、项目元数据
/// 分级：error(blocking) / warning / info
pub async fn precheck(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<ExportPrecheckRequest>,
) -> AppResult<Json<ExportPrecheckResult>> {
    let project = crate::ai::handlers::shared::ensure_project_access(
        &state.db, &user_id.0, &req.project_id,
    ).await?;

    let assets = asset::repo::list_by_project(&state.db, &req.project_id).await?;
    let script = script::repo::find_by_project(&state.db, &req.project_id).await?;
    let storyboard_opt = storyboard::repo::find_by_project(&state.db, &req.project_id).await?;

    let mut issues: Vec<PrecheckIssue> = Vec::new();
    let mut ready_count = 0usize;
    let mut missing_count = 0usize;
    let mut corrupted_count = 0usize;
    let mut external_count = 0usize;
    let mut duplicate_count = 0usize;
    let mut empty_lines = 0usize;
    let mut estimated_size: u64 = 0;

    // ═══════════════════════════════════════════
    // 1. 脚本检查
    // ═══════════════════════════════════════════
    let script_content = script.as_ref().map(|s| s.content.trim().to_string()).unwrap_or_default();
    let script_present = !script_content.is_empty();
    let script_title = script.as_ref().map(|s| s.title.trim().to_string()).unwrap_or_default();

    match &script {
        None => {
            issues.push(PrecheckIssue {
                severity: "warning".into(),
                code: "NO_SCRIPT".into(),
                field: Some("script".into()),
                message: "项目没有剧本内容，导出包将缺少剧本部分".into(),
                asset_id: None, asset_name: None,
            });
        }
        Some(s) if s.content.trim().is_empty() => {
            issues.push(PrecheckIssue {
                severity: "warning".into(),
                code: "EMPTY_SCRIPT".into(),
                field: Some("script".into()),
                message: "剧本内容为空（仅空白字符），导出包的剧本部分将无实质内容".into(),
                asset_id: None, asset_name: None,
            });
        }
        Some(s) if s.content.trim().len() < 30 => {
            issues.push(PrecheckIssue {
                severity: "info".into(),
                code: "SCRIPT_TOO_SHORT".into(),
                field: Some("script".into()),
                message: format!("剧本内容较短（{}字符），可能影响可复现性", s.content.trim().len()),
                asset_id: None, asset_name: None,
            });
        }
        _ => {}
    }

    if script_present && script_title.is_empty() {
        issues.push(PrecheckIssue {
            severity: "info".into(),
            code: "NO_SCRIPT_TITLE".into(),
            field: Some("script".into()),
            message: "剧本没有标题，导出包中将使用默认名称".into(),
            asset_id: None, asset_name: None,
        });
    }

    // ═══════════════════════════════════════════
    // 2. 分镜检查
    // ═══════════════════════════════════════════
    let storyboard_present = storyboard_opt.is_some();
    let shot_count = storyboard_opt.as_ref().map(|s| s.lines.len() as i64).unwrap_or(0);
    let keyframe_count = shot_count;

    match &storyboard_opt {
        None => {
            issues.push(PrecheckIssue {
                severity: "warning".into(),
                code: "NO_STORYBOARD".into(),
                field: Some("storyboard".into()),
                message: "项目没有分镜数据，导出包将缺少分镜部分".into(),
                asset_id: None, asset_name: None,
            });
        }
        Some(sb) if sb.lines.is_empty() => {
            issues.push(PrecheckIssue {
                severity: "warning".into(),
                code: "EMPTY_STORYBOARD".into(),
                field: Some("storyboard".into()),
                message: "分镜已创建但没有任何镜头行，导出包的分镜将为空".into(),
                asset_id: None, asset_name: None,
            });
        }
        Some(sb) => {
            let mut empty_desc: Vec<String> = Vec::new();
            let mut zero_dur: Vec<String> = Vec::new();
            let mut no_assets: Vec<String> = Vec::new();

            for line in &sb.lines {
                let desc = line.description.trim();
                if desc.is_empty() {
                    empty_desc.push(line.scene_number.to_string());
                }
                if line.duration <= 0 {
                    zero_dur.push(line.scene_number.to_string());
                }
                // assets关联检查
                if line.assets.is_empty() {
                    no_assets.push(line.scene_number.to_string());
                }
            }

            empty_lines = empty_desc.len();

            if !empty_desc.is_empty() {
                let half = sb.lines.len() / 2;
                let preview: Vec<String> = empty_desc.iter().take(5).cloned().collect();
                let more = if empty_desc.len() > 5 { "..." } else { "" };
                issues.push(PrecheckIssue {
                    severity: if empty_desc.len() > half { "warning" } else { "info" }.into(),
                    code: "EMPTY_SHOT_DESCRIPTION".into(),
                    field: Some("storyboard".into()),
                    message: format!("{}个镜头缺少画面描述（镜头{}{}），导出包将不完整", empty_desc.len(), preview.join(", "), more),
                    asset_id: None, asset_name: None,
                });
            }
            if !zero_dur.is_empty() {
                let preview: Vec<String> = zero_dur.iter().take(5).cloned().collect();
                let more = if zero_dur.len() > 5 { "..." } else { "" };
                issues.push(PrecheckIssue {
                    severity: "info".into(),
                    code: "ZERO_DURATION_SHOT".into(),
                    field: Some("storyboard".into()),
                    message: format!("{}个镜头时长为0（镜头{}{}），终剪时间线可能异常", zero_dur.len(), preview.join(", "), more),
                    asset_id: None, asset_name: None,
                });
            }
            if no_assets.len() == sb.lines.len() && !sb.lines.is_empty() {
                issues.push(PrecheckIssue {
                    severity: "info".into(),
                    code: "NO_SHOT_ASSETS".into(),
                    field: Some("storyboard".into(),
                    message: "所有镜头都未关联资产，导出包中仅有文字分镜".into(),
                    asset_id: None, asset_name: None,
                });
            }
        }
    }

    // ═══════════════════════════════════════════
    // 3. 资产检查
    // ═══════════════════════════════════════════

    // 3a. 重复文件名检测
    let mut name_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for asset in &assets {
        let name = asset.name.trim();
        if !name.is_empty() {
            *name_counts.entry(name).or_insert(0) += 1;
        }
    }
    let dup_names: Vec<(&&str, &usize)> = name_counts.iter().filter(|(_, &c)| c > 1).collect();
    duplicate_count = dup_names.len();
    if !dup_names.is_empty() {
        let preview: Vec<String> = dup_names.iter().take(3).map(|(n, _)| format!("\"{}\"", n)).collect();
        let more = if dup_names.len() > 3 { "..." } else { "" };
        issues.push(PrecheckIssue {
            severity: "warning".into(),
            code: "DUPLICATE_ASSET_NAMES".into(),
            field: Some("assets".into()),
            message: format!("发现{}组重复资产名（{}{}），打包时将通过ID后缀区分，但可能造成混淆", dup_names.len(), preview.join(", "), more),
            asset_id: None, asset_name: None,
        });
    }

    // 3b. 无资产提示
    if assets.is_empty() {
        issues.push(PrecheckIssue {
            severity: "info".into(),
            code: "NO_ASSETS".into(),
            field: Some("assets".into()),
            message: "项目当前没有任何资产，导出包将仅包含文本内容".into(),
            asset_id: None, asset_name: None,
        });
    }

    // 3c. 逐资产检查（URL有效性、文件存在性、零字节）
    for asset in &assets {
        let url = asset.url.trim();
        let is_local = url.starts_with("/uploads/");

        // URL空值 → error
        if url.is_empty() {
            missing_count += 1;
            issues.push(PrecheckIssue {
                severity: "error".into(),
                code: "MISSING_ASSET_URL".into(),
                field: Some("assets".into()),
                message: format!("资产 \"{}\" 的URL为空，导出时无法下载", asset.name),
                asset_id: Some(asset.id.clone()),
                asset_name: Some(asset.name.clone()),
            });
            continue;
        }

        // URL格式简单校验
        if !is_local && !url.starts_with("http://") && !url.starts_with("https://") && !url.starts_with("/api/") {
            corrupted_count += 1;
            let truncated = if url.len() > 50 { &url[..50] } else { url };
            issues.push(PrecheckIssue {
                severity: "error".into(),
                code: "INVALID_ASSET_URL".into(),
                field: Some("assets".into()),
                message: format!("资产 \"{}\" 的URL格式异常（\"{}\"），导出时无法下载", asset.name, truncated),
                asset_id: Some(asset.id.clone()),
                asset_name: Some(asset.name.clone()),
            });
            continue;
        }

        if is_local {
            match resolve_asset_file_path(&state, asset).await {
                Ok(path) => {
                    match tokio::fs::metadata(&path).await {
                        Ok(meta) => {
                            if meta.len() == 0 {
                                corrupted_count += 1;
                                issues.push(PrecheckIssue {
                                    severity: "error".into(),
                                    code: "EMPTY_ASSET_FILE".into(),
                                    field: Some("assets".into()),
                                    message: format!("资产 \"{}\" 的本地文件大小为0字节，文件可能已损坏", asset.name),
                                    asset_id: Some(asset.id.clone()),
                                    asset_name: Some(asset.name.clone()),
                                });
                            } else {
                                ready_count += 1;
                                estimated_size += meta.len();
                            }
                        }
                        Err(_) => {
                            missing_count += 1;
                            issues.push(PrecheckIssue {
                                severity: "error".into(),
                                code: "FILE_NOT_FOUND".into(),
                                field: Some("assets".into()),
                                message: format!("资产 \"{}\" 的本地文件不存在", asset.name),
                                asset_id: Some(asset.id.clone()),
                                asset_name: Some(asset.name.clone()),
                            });
                        }
                    }
                }
                Err(_) => {
                    missing_count += 1;
                    issues.push(PrecheckIssue {
                        severity: "error".into(),
                        code: "PATH_RESOLVE_FAILED".into(),
                        field: Some("assets".into()),
                        message: format!("资产 \"{}\" 路径解析失败", asset.name),
                        asset_id: Some(asset.id.clone()),
                        asset_name: Some(asset.name.clone()),
                    });
                }
            }
        } else {
            // 外部URL
            external_count += 1;
            let size_hint: u64 = asset.metadata.as_ref()
                .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
                .and_then(|v| v.get("sizeBytes").and_then(|s| s.as_u64()))
                .unwrap_or(0);
            estimated_size += size_hint;
            let truncated = if url.len() > 40 { format!("{}...", &url[..40]) } else { url.to_string() };
            issues.push(PrecheckIssue {
                severity: "info".into(),
                code: "EXTERNAL_ASSET".into(),
                field: Some("assets".into()),
                message: format!("资产 \"{}\" 是外部URL（{}），导出时将不会打包", asset.name, truncated),
                asset_id: Some(asset.id.clone()),
                asset_name: Some(asset.name.clone()),
            });
        }
    }

    // ═══════════════════════════════════════════
    // 4. 项目级检查
    // ═══════════════════════════════════════════
    let project_name = project.name.trim();
    if project_name.is_empty() || project_name == "Untitled" || project_name == "未命名" {
        issues.push(PrecheckIssue {
            severity: "info".into(),
            code: "DEFAULT_PROJECT_NAME".into(),
            field: Some("project".into()),
            message: "项目使用默认名称，导出时建议先修改项目名以便识别".into(),
            asset_id: None, asset_name: None,
        });
    }

    // 元数据预估
    estimated_size += 250 * 1024;

    let blocking_count = issues.iter().filter(|i| i.severity == "error").count();
    let warning_count = issues.iter().filter(|i| i.severity == "warning").count();
    let info_count = issues.iter().filter(|i| i.severity == "info").count();
    let can_export = blocking_count == 0;

    Ok(Json(ExportPrecheckResult {
        project_id: req.project_id,
        project_name: project.name,
        can_export,
        issues,
        summary: ExportSummary {
            total_assets: assets.len(),
            ready_assets: ready_count,
            missing_assets: missing_count,
            corrupted_assets: corrupted_count,
            external_assets: external_count,
            duplicate_names: duplicate_count,
            estimated_size_bytes: estimated_size,
            estimated_size_human: format_size_human(estimated_size),
            script_present,
            storyboard_present,
            shot_count,
            keyframe_count,
            empty_lines,
            blocking_count,
            warning_count,
            info_count,
        },
    }))
}

/// 创建可审计导出包（服务端打包）
pub async fn create_export(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    headers: HeaderMap,
    Json(req): Json<ExportPackageRequest>,
) -> AppResult<Json<ExportPackageResult>> {
    let export_format = req.export_format.as_deref().unwrap_or("tar.gz");
    if !matches!(export_format, "tar" | "tar.gz") {
        return Err(AppError::Validation("不支持的导出格式，仅支持 tar 或 tar.gz".into()));
    }
    let export_type = req.export_type.clone();
    if !matches!(export_type.as_str(), "full" | "core" | "snapshot") {
        return Err(AppError::Validation("不支持的导出类型".into()));
    }

    let project = crate::ai::handlers::shared::ensure_project_access(
        &state.db, &user_id.0, &req.project_id,
    ).await?;

    let assets = asset::repo::list_by_project(&state.db, &req.project_id).await?;
    let script = script::repo::find_by_project(&state.db, &req.project_id).await?;
    let storyboard_opt = storyboard::repo::find_by_project(&state.db, &req.project_id).await?;
    let conversations = conversation::repo::list_by_project(&state.db, &req.project_id)
        .await.unwrap_or_default();

    let timestamp = Utc::now();
    let timestamp_str = timestamp.format("%Y%m%d-%H%M%S").to_string();
    let safe_project_name = sanitize_filename_segment(&project.name);
    let ext = if export_format == "tar.gz" { "tar.gz" } else { "tar" };
    let package_name = format!("{}-{}-{}.{}", safe_project_name, export_type, timestamp_str, ext);

    // 提取客户端信息（User-Agent）
    let client_info = headers.get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // 创建导出目录
    let export_root = PathBuf::from(&state.config.project_files_dir).join("exports");
    tokio::fs::create_dir_all(&export_root).await.map_err(|e| {
        AppError::Internal(format!("创建导出目录失败: {}", e))
    })?;
    let export_path = export_root.join(&package_name);

    // 创建审计记录（标记为 in_progress）
    let audit_id = repo::create_audit(
        &state.db, &req.project_id, &user_id.0,
        &export_type, export_format, &package_name,
        &project.name, Some(&project.phase),
        client_info.as_deref(),
    ).await?;

    // 计时
    let start = Instant::now();

    // 执行打包
    let build_result = build_export_package(
        &state, &project, &assets, script.as_ref(), storyboard_opt.as_ref(),
        &conversations, &req, &audit_id, export_format, &timestamp, &user_id.0,
    ).await;

    match build_result {
        Ok((package_bytes, manifest, missing_entries, verification,
            included, missing, corrupted, total_size, manifest_sha, sanitization_count)) =>
        {
            let duration_ms = start.elapsed().as_millis() as i64;

            tokio::fs::write(&export_path, &package_bytes).await.map_err(|e| {
                AppError::Internal(format!("写入导出包失败: {}", e))
            })?;

            let package_sha256 = {
                let mut hasher = Sha256::new();
                hasher.update(&package_bytes);
                format!("{:x}", hasher.finalize())
            };

            let script_version = script.as_ref().map(|s| format!("{}:{}", s.id, epoch_millis(&s.updated_at)));
            let storyboard_version = storyboard_opt.as_ref()
                .map(|s| format!("{}:{}", s.id, epoch_millis(&s.updated_at)));

            let keyframe_count = manifest.summary.keyframes as i64;
            let shot_count = manifest.summary.shots as i64;
            let duration_seconds = manifest.summary.duration_seconds;

            let warnings_json = if verification.warnings.is_empty() { None }
                else { Some(serde_json::to_string(&verification.warnings).unwrap_or_default()) };
            let sensitive_json = if verification.sensitive_findings.is_empty() { None }
                else { Some(serde_json::to_string(&verification.sensitive_findings).unwrap_or_default()) };
            let gen_params_json = req.snapshot.as_ref()
                .and_then(|s| s.generation_params.clone())
                .map(|v| serde_json::to_string(&v).unwrap_or_default());

            let verification_passed = verification.overall_status != "fail";

            repo::finalize_audit(
                &state.db, &audit_id,
                package_bytes.len() as i64, &package_sha256, &manifest_sha,
                assets.len() as i64, included as i64, missing as i64, corrupted as i64,
                total_size as i64,
                script_version.as_deref(), storyboard_version.as_deref(),
                keyframe_count, shot_count, duration_seconds,
                verification_passed,
                warnings_json.as_deref(), sensitive_json.as_deref(),
                gen_params_json.as_deref(),
                sanitization_count as i64, duration_ms,
                req.notes.as_deref(),
            ).await?;

            let mut final_manifest = manifest;
            final_manifest.package_checksum = Some(PackageChecksum {
                algorithm: "SHA-256".into(),
                value: package_sha256.clone(),
            });

            tracing::info!(
                audit_id = %audit_id,
                package = %package_name,
                size = package_bytes.len(),
                included = included,
                missing = missing,
                duration_ms = duration_ms,
                manifest_sha = %manifest_sha,
                "导出包创建成功"
            );

            Ok(Json(ExportPackageResult {
                audit_id,
                download_url: format!("/api/exports/{}/download", audit_id),
                package_name,
                package_size_bytes: package_bytes.len() as u64,
                package_sha256,
                export_type,
                exported_at: timestamp.to_rfc3339(),
                manifest: final_manifest,
                missing_assets: missing_entries,
                verification,
            }))
        }
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as i64;
            let err_msg = e.to_string();
            tracing::error!(audit_id = %audit_id, error = %e, duration_ms = duration_ms, "导出包构建失败");
            // 记录失败到审计表（不阻止错误上抛）
            let _ = repo::fail_audit(&state.db, &audit_id, &err_msg, duration_ms).await;
            Err(e)
        }
    }
}

/// 下载导出包
pub async fn download_export(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(audit_id): Path<String>,
) -> AppResult<Response> {
    let audit = repo::find_audit_by_id(&state.db, &audit_id).await?
        .ok_or_else(|| AppError::NotFound("导出记录不存在".into()))?;

    if audit.user_id != user_id.0 {
        crate::ai::handlers::shared::ensure_project_access(&state.db, &user_id.0, &audit.project_id).await?;
    }

    let export_dir = PathBuf::from(&state.config.project_files_dir).join("exports");
    let file_path = export_dir.join(&audit.package_name);

    let file_bytes = tokio::fs::read(&file_path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("导出包文件已过期或不存在，请重新导出".into())
        } else {
            AppError::Internal(format!("读取导出包失败: {}", e))
        }
    })?;

    let content_type = if audit.package_name.ends_with(".tar.gz") {
        "application/gzip"
    } else if audit.package_name.ends_with(".tar") {
        "application/x-tar"
    } else {
        "application/octet-stream"
    };

    let encoded_name = audit.package_name
        .replace(' ', "_")
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let content_disposition = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        encoded_name, url_encode(&audit.package_name)
    );

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, content_disposition.as_str()),
            (header::CACHE_CONTROL, "private, max-age=86400"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        file_bytes,
    ).into_response())
}

/// 列出项目导出历史
pub async fn list_project_exports(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<serde_json::Value>> {
    crate::ai::handlers::shared::ensure_project_access(&state.db, &user_id.0, &project_id).await?;

    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(20);
    let offset: i64 = params.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);

    let records = repo::list_audits_by_project(&state.db, &project_id, limit.min(100), offset).await?;
    Ok(Json(serde_json::json!({ "records": records, "limit": limit, "offset": offset })))
}

/// 列出用户所有导出历史
pub async fn list_my_exports(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<serde_json::Value>> {
    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(20);
    let offset: i64 = params.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);

    let records = repo::list_audits_by_user(&state.db, &user_id.0, limit.min(100), offset).await?;
    Ok(Json(serde_json::json!({ "records": records, "limit": limit, "offset": offset })))
}

/// 获取导出详情
pub async fn get_export_detail(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(audit_id): Path<String>,
) -> AppResult<Json<ExportAuditDetail>> {
    let (record, assets) = repo::get_audit_detail(&state.db, &audit_id).await?
        .ok_or_else(|| AppError::NotFound("导出记录不存在".into()))?;

    if record.user_id != user_id.0 {
        crate::ai::handlers::shared::ensure_project_access(&state.db, &user_id.0, &record.project_id).await?;
    }

    Ok(Json(ExportAuditDetail {
        record,
        warnings: vec![],
        sensitive_findings: vec![],
        generation_params: None,
        asset_details: assets,
    }))
}

// ─── 内部打包逻辑 ──────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn build_export_package(
    state: &AppState,
    project: &project::model::Project,
    assets: &[asset::model::Asset],
    script: Option<&script::model::Script>,
    storyboard: Option<&storyboard::model::Storyboard>,
    conversations: &[conversation::model::Conversation],
    req: &ExportPackageRequest,
    audit_id: &str,
    export_format: &str,
    timestamp: &chrono::DateTime<Utc>,
    user_id: &str,
) -> AppResult<(
    Vec<u8>, ExportManifest, Vec<MissingAssetEntry>, VerificationReport,
    usize, usize, usize, u64, String, usize,
)> {
    let mut tar_data = Vec::new();
    let mut tar_builder = TarBuilder::new(&mut tar_data);

    let mut file_entries: Vec<FileManifestEntry> = Vec::new();
    let mut asset_entries: Vec<AssetManifestEntry> = Vec::new();
    let mut missing_entries: Vec<MissingAssetEntry> = Vec::new();
    let mut verification_checks: Vec<VerificationCheck> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut sensitive_findings: Vec<SensitiveFinding> = Vec::new();

    let mut included_count = 0usize;
    let mut missing_count = 0usize;
    let mut corrupted_count = 0usize;
    let mut corrupted_names = Vec::new();
    let mut total_content_size: u64 = 0;

    let asset_path_map: std::collections::HashMap<String, String> = req
        .asset_packaging.as_ref()
        .map(|plans| plans.iter().map(|p| (p.asset_id.clone(), p.packaged_path.clone())).collect())
        .unwrap_or_default();

    // 1. 打包资产文件
    for (idx, asset) in assets.iter().enumerate() {
        let packaged_path = asset_path_map.get(&asset.id).cloned().unwrap_or_else(|| {
            let ext = std::path::Path::new(&asset.name)
                .extension().and_then(|e| e.to_str()).unwrap_or("bin");
            let safe_name = sanitize_filename_segment(&asset.name);
            format!("assets/{:03}-{}.{}", idx + 1, safe_name, ext)
        });

        let is_local = asset.url.starts_with("/uploads/");
        if is_local {
            match resolve_asset_file_path(state, asset).await {
                Ok(file_path) => {
                    match tokio::fs::read(&file_path).await {
                        Ok(file_bytes) => {
                            if file_bytes.is_empty() {
                                corrupted_count += 1;
                                corrupted_names.push(asset.name.clone());
                                missing_entries.push(make_missing(asset, &packaged_path, "文件为空（0字节），可能已损坏"));
                                asset_entries.push(make_asset_entry(asset, &packaged_path, 0, None, "corrupted"));
                                add_audit_asset_db(state, audit_id, asset, &packaged_path, Some(0), None, "corrupted", Some("文件为空")).await;
                            } else {
                                let mut hasher = Sha256::new();
                                hasher.update(&file_bytes);
                                let file_sha = format!("{:x}", hasher.finalize());
                                let size = file_bytes.len() as u64;

                                append_tar_file(&mut tar_builder, &packaged_path, &file_bytes)?;
                                file_entries.push(FileManifestEntry {
                                    path: packaged_path.clone(),
                                    size_bytes: size,
                                    sha256: file_sha.clone(),
                                });
                                total_content_size += size;
                                included_count += 1;

                                asset_entries.push(make_asset_entry(asset, &packaged_path, size, Some(file_sha.clone()), "included"));
                                add_audit_asset_db(state, audit_id, asset, &packaged_path, Some(size as i64), Some(&file_sha), "included", None).await;
                            }
                        }
                        Err(e) => {
                            missing_count += 1;
                            let reason = format!("文件读取失败: {}", e);
                            missing_entries.push(make_missing(asset, &packaged_path, &reason));
                            asset_entries.push(make_asset_entry(asset, &packaged_path, 0, None, "missing"));
                            add_audit_asset_db(state, audit_id, asset, &packaged_path, None, None, "missing", Some(&reason)).await;
                        }
                    }
                }
                Err(e) => {
                    missing_count += 1;
                    let reason = format!("路径解析失败: {}", e);
                    missing_entries.push(make_missing(asset, &packaged_path, &reason));
                    asset_entries.push(make_asset_entry(asset, &packaged_path, 0, None, "missing"));
                    add_audit_asset_db(state, audit_id, asset, &packaged_path, None, None, "missing", Some(&reason)).await;
                }
            }
        } else {
            asset_entries.push(make_asset_entry(asset, &packaged_path, 0, None, "external"));
            warnings.push(format!("外部资产 \"{}\" ({}) 未打包进导出包", asset.name, asset.url));
            add_audit_asset_db(state, audit_id, asset, &packaged_path, None, None, "external", Some("外部URL，服务端不自动下载")).await;
        }
    }

    // 2. 添加 core-bundle.md（脱敏）
    if let Some(md_content) = &req.core_markdown {
        let sr = san::sanitize_text(md_content);
        append_text_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
            "core-bundle.md", &sr.sanitized)?;
        collect_sanitize_findings("core-bundle.md", &sr.findings, &mut sensitive_findings);
    }

    // 3. 添加 script/current-script.md（脱敏）
    if let Some(s) = script {
        if !s.content.trim().is_empty() {
            let sr = san::sanitize_text(&s.content);
            append_text_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
                "script/current-script.md", &sr.sanitized)?;
            collect_sanitize_findings("script/current-script.md", &sr.findings, &mut sensitive_findings);
        }
    }

    // 4. 添加 storyboard/storyboard.json（递归脱敏后序列化）
    if let Some(sb) = storyboard {
        let sb_val = serde_json::to_value(sb).unwrap_or(serde_json::Value::Null);
        let sb_sanitized = san::sanitize_value(sb_val);
        if let Ok(sb_bytes) = serde_json::to_vec_pretty(&sb_sanitized) {
            append_binary_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
                "storyboard/storyboard.json", &sb_bytes)?;
        }
    }

    // 5. 添加 conversations/*.md（脱敏）
    if let Some(conv_map) = &req.conversations_markdown {
        for (idx, (conv_id, md_content)) in conv_map.iter().enumerate() {
            let title = conversations.iter()
                .find(|c| c.id == *conv_id)
                .map(|c| sanitize_filename_segment(&c.title))
                .unwrap_or_else(|| format!("conversation-{}", idx + 1));
            let conv_path = format!("conversations/{:02}-{}.md", idx + 1, title);
            let sr = san::sanitize_text(md_content);
            append_text_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
                &conv_path, &sr.sanitized)?;
            collect_sanitize_findings(&conv_path, &sr.findings, &mut sensitive_findings);
        }
    }

    // 6. 添加 project-snapshot.json（递归脱敏后序列化）
    if let Some(s) = &req.snapshot {
        let snap_val = san::sanitize_value(serde_json::json!({
            "exportedAt": timestamp.to_rfc3339(),
            "project": {
                "id": project.id,
                "name": project.name,
                "status": project.status,
                "phase": project.phase,
                "createdAt": epoch_millis(&project.created_at),
            },
            "scriptTitle": s.script_title,
            "scriptText": s.script_text,
            "chapters": s.chapters,
            "characters": s.characters,
            "scenes": s.scenes,
            "keyframes": s.keyframes,
            "videoShots": s.video_shots,
            "finalCut": s.final_cut,
        }));
        if let Ok(snap_bytes) = serde_json::to_vec_pretty(&snap_val) {
            append_binary_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
                "project-snapshot.json", &snap_bytes)?;
        }
    }

    // 7. 添加 generation-params.json（递归脱敏后序列化）
    if let Some(s) = &req.snapshot {
        if let Some(gen_params) = &s.generation_params {
            let gen_summary = san::sanitize_value(serde_json::json!({
                "exportedAt": timestamp.to_rfc3339(),
                "parameters": gen_params,
            }));
            if let Ok(gen_bytes) = serde_json::to_vec_pretty(&gen_summary) {
                append_binary_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
                    "generation-params.json", &gen_bytes)?;
            }
        }
    }

    // 7.5 添加 timeline/final-cut.json（递归脱敏后序列化）
    if let Some(s) = &req.snapshot {
        if let Some(final_cut) = &s.final_cut {
            let fc_sanitized = san::sanitize_value(serde_json::to_value(final_cut).unwrap_or(serde_json::Value::Null));
            if let Ok(timeline_bytes) = serde_json::to_vec_pretty(&fc_sanitized) {
                append_binary_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
                    "timeline/final-cut.json", &timeline_bytes)?;
            }
        }
    }

    // 8. 构建验证报告
    verification_checks.push(VerificationCheck {
        name: "asset_integrity".into(),
        status: if corrupted_count == 0 { "pass".into() } else { "warn".into() },
        message: format!("检查了{}个资产，{}个成功，{}个缺失，{}个损坏",
            assets.len(), included_count, missing_count, corrupted_count),
    });
    verification_checks.push(VerificationCheck {
        name: "script_presence".into(),
        status: if script.map(|s| !s.content.trim().is_empty()).unwrap_or(false) { "pass".into() } else { "warn".into() },
        message: if script.map(|s| !s.content.trim().is_empty()).unwrap_or(false) {
            "剧本内容已包含".into() } else { "未检测到剧本内容".into() },
    });
    verification_checks.push(VerificationCheck {
        name: "storyboard_presence".into(),
        status: if storyboard.is_some() { "pass".into() } else { "warn".into() },
        message: if storyboard.is_some() { "分镜数据已包含".into() } else { "未检测到分镜数据".into() },
    });
    verification_checks.push(VerificationCheck {
        name: "checksum_validation".into(),
        status: "pass".into(),
        message: format!("已为{}个文件计算SHA-256校验和", file_entries.len()),
    });
    verification_checks.push(VerificationCheck {
        name: "sensitive_content_sanitization".into(),
        status: if sensitive_findings.is_empty() { "pass".into() } else { "warn".into() },
        message: if sensitive_findings.is_empty() {
            "未检测到需要脱敏的敏感信息".into()
        } else {
            format!("已自动脱敏 {} 处敏感信息（API Key/JWT/密码/路径等已替换为[REDACTED_*]）", sensitive_findings.len())
        },
    });

    if missing_count > 0 {
        warnings.push(format!("{}个资产文件缺失，详见missing-assets.json", missing_count));
    }
    if corrupted_count > 0 {
        errors.push(format!("{}个资产文件损坏: {}", corrupted_count, corrupted_names.join(", ")));
    }
    if !sensitive_findings.is_empty() {
        // 按类别统计
        let mut by_cat: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        for f in &sensitive_findings {
            *by_cat.entry(f.category.clone()).or_insert(0) += 1;
        }
        let summary: Vec<String> = by_cat.iter().map(|(c, n)| format!("{}×{}", c, n)).collect();
        warnings.push(format!("自动脱敏 {} 处敏感信息（{}），已替换为[REDACTED_*]占位符",
            sensitive_findings.len(), summary.join(", ")));
    }

    let overall_status = if !errors.is_empty() { "fail" }
        else if !warnings.is_empty() { "pass_with_warnings" }
        else { "pass" };

    let verification = VerificationReport {
        verified_at: timestamp.to_rfc3339(),
        overall_status: overall_status.into(),
        checks_performed: verification_checks,
        warnings: warnings.clone(),
        errors: errors.clone(),
        sensitive_findings: sensitive_findings.clone(),
        asset_verification: AssetVerificationSummary {
            total_checked: assets.len(),
            passed: included_count,
            failed: corrupted_count,
            missing: missing_count,
            checksums_validated: file_entries.len() + 2, // +2 for verification and checksums themselves
        },
        reproducibility: ReproducibilityInfo {
            can_reproduce: missing_count == 0 && corrupted_count == 0,
            requirements: vec![
                "Woohoo Studio v0.1.0+".into(),
                "project-snapshot.json包含完整项目状态".into(),
                "所有资产文件包含SHA-256校验和".into(),
            ],
            blockers: if missing_count > 0 || corrupted_count > 0 {
                vec![format!("{}个资产缺失/损坏，无法完整复现", missing_count + corrupted_count)]
            } else { vec![] },
            woohoo_version_required: env!("CARGO_PKG_VERSION").into(),
            database_snapshot_included: false,
        },
    };

    // 9. 添加 missing-assets.json（脱敏后写入）
    let missing_val = san::sanitize_value(serde_json::json!({
        "exportedAt": timestamp.to_rfc3339(),
        "exportId": audit_id,
        "totalMissing": missing_entries.len(),
        "missingAssets": missing_entries,
    }));
    let missing_bytes = serde_json::to_vec_pretty(&missing_val).unwrap_or_default();
    append_binary_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
        "missing-assets.json", &missing_bytes)?;

    // 10. 添加 verification-report.json（脱敏后写入）
    let verif_val = san::sanitize_value(serde_json::to_value(&verification).unwrap_or(serde_json::Value::Null));
    let verif_bytes = serde_json::to_vec_pretty(&verif_val).unwrap_or_default();
    append_binary_file(&mut tar_builder, &mut file_entries, &mut total_content_size,
        "verification-report.json", &verif_bytes)?;

    // 11. 计算统计
    let snapshot = &req.snapshot;
    let chapters_count = snapshot.as_ref().and_then(|s| s.chapters.as_ref())
        .and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
    let characters_count = snapshot.as_ref().and_then(|s| s.characters.as_ref())
        .and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
    let scenes_count = snapshot.as_ref().and_then(|s| s.scenes.as_ref())
        .and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
    let keyframes_count = snapshot.as_ref().and_then(|s| s.keyframes.as_ref())
        .and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
    let shots_count = snapshot.as_ref().and_then(|s| s.video_shots.as_ref())
        .and_then(|c| c.as_array()).map(|a| a.len())
        .unwrap_or_else(|| storyboard.map(|sb| sb.lines.len()).unwrap_or(0));
    let duration_secs = snapshot.as_ref().and_then(|s| s.final_cut.as_ref())
        .and_then(|f| f.get("totalDurationSeconds")).and_then(|v| v.as_i64()).unwrap_or(0);
    let script_sections = snapshot.as_ref().and_then(|s| s.script_text.as_ref())
        .map(|_| 1).unwrap_or(0);

    // 12. 构建 manifest（此时file_entries包含: 资产+core-bundle+script+storyboard+conversations
    //     +project-snapshot+generation-params+missing-assets+verification-report）
    //     manifest.files列出这些文件的checksum；manifest自身和checksums.json最后追加
    let manifest_files = file_entries.clone(); // 拷贝当前checksums
    let manifest = ExportManifest {
        manifest_version: "1.0".into(),
        export_id: audit_id.to_string(),
        exported_at: timestamp.to_rfc3339(),
        exported_by: user_id.to_string(),
        export_type: export_type.to_string(),
        export_format: export_format.to_string(),
        woohoo_version: env!("CARGO_PKG_VERSION").to_string(),
        project: ProjectInfo {
            id: project.id.clone(),
            name: project.name.clone(),
            status: project.status.clone(),
            phase: project.phase.clone(),
            created_at: epoch_millis(&project.created_at),
        },
        summary: ManifestSummary {
            script_sections,
            chapters: chapters_count,
            characters: characters_count,
            scenes: scenes_count,
            shots: shots_count,
            keyframes: keyframes_count,
            duration_seconds: duration_secs,
            total_assets: assets.len(),
            included_assets: included_count,
            missing_assets: missing_count,
            total_package_size_bytes: 0, // 最后计算
        },
        versions: VersionInfo {
            script_id: script.map(|s| s.id.clone()),
            script_updated_at: script.map(|s| epoch_millis(&s.updated_at)),
            storyboard_id: storyboard.map(|s| s.id.clone()),
            storyboard_updated_at: storyboard.map(|s| epoch_millis(&s.updated_at)),
            snapshot_fingerprint: None,
        },
        assets: asset_entries,
        files: manifest_files,
        package_checksum: None,
    };

    // manifest 转为Value后脱敏，再序列化和计算hash
    let manifest_val = san::sanitize_value(
        serde_json::to_value(&manifest).unwrap_or(serde_json::Value::Null)
    );
    let manifest_bytes = serde_json::to_vec_pretty(&manifest_val).unwrap_or_default();
    let manifest_sha = {
        let mut hasher = Sha256::new();
        hasher.update(&manifest_bytes);
        format!("{:x}", hasher.finalize())
    };

    // 13. 构建 checksums.json（包含所有内容文件+元文件+manifest，不含自身）
    let mut checksums_files: Vec<FileManifestEntry> = file_entries.clone();
    checksums_files.push(FileManifestEntry {
        path: "manifest.json".into(),
        size_bytes: manifest_bytes.len() as u64,
        sha256: manifest_sha.clone(),
    });
    let checksums_val = san::sanitize_value(serde_json::json!({
        "algorithm": "SHA-256",
        "exportedAt": timestamp.to_rfc3339(),
        "exportId": audit_id,
        "note": "本文件(checksums.json)的SHA-256记录在manifest.packageChecksum中",
        "files": checksums_files.iter().map(|f| serde_json::json!({
            "path": f.path,
            "sizeBytes": f.size_bytes,
            "sha256": f.sha256,
        })).collect::<Vec<_>>(),
    }));
    let checksums_bytes = serde_json::to_vec_pretty(&checksums_val).unwrap_or_default();

    // 14. 追加 checksums.json 和 manifest.json 到tar（这两个不加入file_entries以避免自引用）
    append_tar_file(&mut tar_builder, "checksums.json", &checksums_bytes)?;
    append_tar_file(&mut tar_builder, "manifest.json", &manifest_bytes)?;

    total_content_size += manifest_bytes.len() as u64;
    total_content_size += checksums_bytes.len() as u64;

    // 完成tar构建
    drop(tar_builder);
    let tar_bytes = tar_data;

    // 压缩
    let output_bytes = if export_format == "tar.gz" {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&tar_bytes).map_err(|e| AppError::Internal(format!("Gzip压缩失败: {}", e)))?;
        encoder.finish().map_err(|e| AppError::Internal(format!("Gzip完成失败: {}", e)))?
    } else {
        tar_bytes
    };

    // 计算包整体SHA-256
    let package_sha = {
        let mut hasher = Sha256::new();
        hasher.update(&output_bytes);
        format!("{:x}", hasher.finalize())
    };

    let mut final_manifest = manifest;
    final_manifest.summary.total_package_size_bytes = output_bytes.len() as u64;
    final_manifest.package_checksum = Some(PackageChecksum {
        algorithm: "SHA-256".into(),
        value: package_sha.clone(),
    });

    let sanitization_count = sensitive_findings.len();

    Ok((output_bytes, final_manifest, missing_entries, verification,
        included_count, missing_count, corrupted_count, total_content_size,
        manifest_sha, sanitization_count))
}

// ─── 辅助函数 ──────────────────────────────────────

async fn resolve_asset_file_path(
    state: &AppState,
    asset: &asset::model::Asset,
) -> AppResult<PathBuf> {
    let filename = asset.url.strip_prefix("/uploads/")
        .ok_or_else(|| AppError::NotFound("资产不是本地上传资源".into()))?;

    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err(AppError::Validation("非法的资产文件名".into()));
    }

    let upload_root = PathBuf::from(&state.config.assets_dir);
    tokio::fs::create_dir_all(&upload_root).await.ok();
    let canonical_root = tokio::fs::canonicalize(&upload_root).await
        .map_err(|e| AppError::Internal(format!("Failed to resolve upload dir: {}", e)))?;

    let candidate = canonical_root.join(filename);
    let canonical = tokio::fs::canonicalize(&candidate).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("资产文件不存在".into())
        } else {
            AppError::Internal(format!("Failed to resolve asset path: {}", e))
        }
    })?;

    if !canonical.starts_with(&canonical_root) {
        return Err(AppError::Forbidden("非法的资产文件路径".into()));
    }
    Ok(canonical)
}

fn append_tar_file<W: Write>(
    builder: &mut TarBuilder<W>,
    path: &str,
    data: &[u8],
) -> AppResult<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, path, data)
        .map_err(|e| AppError::Internal(format!("添加{}到tar失败: {}", path, e)))
}

fn append_text_file<W: Write>(
    builder: &mut TarBuilder<W>,
    entries: &mut Vec<FileManifestEntry>,
    total_size: &mut u64,
    path: &str,
    content: &str,
) -> AppResult<()> {
    let bytes = content.as_bytes();
    append_tar_file(builder, path, bytes)?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    entries.push(FileManifestEntry {
        path: path.into(),
        size_bytes: bytes.len() as u64,
        sha256: format!("{:x}", hasher.finalize()),
    });
    *total_size += bytes.len() as u64;
    Ok(())
}

fn append_binary_file<W: Write>(
    builder: &mut TarBuilder<W>,
    entries: &mut Vec<FileManifestEntry>,
    total_size: &mut u64,
    path: &str,
    data: &[u8],
) -> AppResult<()> {
    append_tar_file(builder, path, data)?;
    let mut hasher = Sha256::new();
    hasher.update(data);
    entries.push(FileManifestEntry {
        path: path.into(),
        size_bytes: data.len() as u64,
        sha256: format!("{:x}", hasher.finalize()),
    });
    *total_size += data.len() as u64;
    Ok(())
}

fn make_asset_entry(
    asset: &asset::model::Asset,
    packaged_path: &str,
    size: u64,
    sha: Option<String>,
    status: &str,
) -> AssetManifestEntry {
    AssetManifestEntry {
        id: asset.id.clone(),
        name: asset.name.clone(),
        asset_type: asset.asset_type.clone(),
        version_label: None,
        packaged_path: packaged_path.into(),
        size_bytes: size,
        sha256: sha,
        status: status.into(),
        created_at: epoch_millis(&asset.created_at),
        updated_at: epoch_millis(&asset.updated_at),
        metadata: asset.metadata.as_ref()
            .and_then(|m| serde_json::from_str(m).ok()),
    }
}

fn make_missing(asset: &asset::model::Asset, expected_path: &str, reason: &str) -> MissingAssetEntry {
    MissingAssetEntry {
        asset_id: asset.id.clone(),
        asset_name: asset.name.clone(),
        asset_type: asset.asset_type.clone(),
        expected_path: Some(expected_path.into()),
        reason: reason.into(),
        url: Some(asset.url.clone()),
        created_at: epoch_millis(&asset.created_at),
    }
}

async fn add_audit_asset_db(
    state: &AppState,
    audit_id: &str,
    asset: &asset::model::Asset,
    packaged_path: &str,
    size: Option<i64>,
    sha: Option<&str>,
    status: &str,
    error: Option<&str>,
) {
    let _ = repo::add_audit_asset(
        &state.db, audit_id, &asset.id, &asset.name, &asset.asset_type,
        Some(&asset.url), None, packaged_path,
        size, sha, status, error, asset.metadata.as_deref(),
    ).await;
}

fn sanitize_filename_segment(name: &str) -> String {
    let sanitized: String = name.chars().map(|c| {
        if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c }
        else if c == ' ' { '-' }
        else { '_' }
    }).take(80).collect();
    if sanitized.is_empty() { "unnamed".into() } else { sanitized }
}

fn format_size_human(bytes: u64) -> String {
    if bytes < 1024 { format!("{} B", bytes) }
    else if bytes < 1024 * 1024 { format!("{:.1} KB", bytes as f64 / 1024.0) }
    else if bytes < 1024 * 1024 * 1024 { format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0)) }
    else { format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0)) }
}

fn epoch_millis(ts: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| Utc::now().timestamp_millis())
}

fn url_encode(input: &str) -> String {
    input.bytes().flat_map(|byte| {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'~' || byte == b'.' {
            vec![byte]
        } else {
            format!("%{:02X}", byte).into_bytes()
        }
    }).map(|b| b as char).collect()
}

/// 将 sanitize 模块的 SanitizeFinding 转换为 model::SensitiveFinding，
/// 追加到 verification report 用的 findings 列表
fn collect_sanitize_findings(
    file: &str,
    sf_list: &[san::SanitizeFinding],
    findings: &mut Vec<SensitiveFinding>,
) {
    for sf in sf_list {
        use san::SensitiveCategory::*;
        let (severity, category_str, desc) = match &sf.category {
            PrivateKey => ("high", "private_key", format!("已自动脱敏私钥块（长度{}，已替换为{}）", sf.match_length, sf.redacted)),
            ApiKey => ("high", "api_key", format!("已自动脱敏API Key（长度{}，已替换为{}）", sf.match_length, sf.redacted)),
            Jwt => ("high", "jwt", format!("已自动脱敏JWT令牌（长度{}，已替换为{}）", sf.match_length, sf.redacted)),
            Password => ("high", "password", format!("已自动脱敏密码/密钥字段（长度{}，已替换为{}）", sf.match_length, sf.redacted)),
            AuthHeader => ("high", "auth_header", format!("已自动脱敏Authorization头（长度{}，已替换为{}）", sf.match_length, sf.redacted)),
            DbUrl => ("high", "db_url", format!("已自动脱敏数据库连接串（长度{}，已替换为{}）", sf.match_length, sf.redacted)),
            GenericSecret => ("high", "generic_secret", format!("已自动脱敏疑似密钥（长度{}，已替换为{}）", sf.match_length, sf.redacted)),
            AbsolutePath => ("medium", "absolute_path", format!("已自动脱敏本机绝对路径（已替换用户名部分为{}）", sf.redacted)),
            Email => ("low", "email", format!("已对邮箱地址打码（替换为{}）", sf.redacted)),
            Phone => ("low", "phone", format!("已对手机号打码（替换为{}）", sf.redacted)),
        };
        findings.push(SensitiveFinding {
            severity: severity.into(),
            category: category_str.into(),
            file: file.into(),
            line_hint: None,
            description: desc,
        });
    }
}
