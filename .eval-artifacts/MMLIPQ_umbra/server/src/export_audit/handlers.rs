use axum::{
    extract::{Extension, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use std::path::PathBuf;
use tokio::fs;

use crate::{
    asset::{repo as asset_repo},
    auth::middleware::UserId,
    conversation::repo as conv_repo,
    error::{AppError, AppResult},
    project::repo as project_repo,
    script::repo as script_repo,
    storyboard::repo as storyboard_repo,
    AppState,
};

use super::{
    model::*,
    preflight_rules::{classify_asset_url, duplicate_scene_numbers, is_sensitive_filename, AssetUrlKind},
    repo as audit_repo,
    tar_builder::{self, BuiltExport, EXPORT_VERSION},
};

const LOCAL_UPLOAD_URL_PREFIX: &str = "/uploads/";

/// GET /api/projects/{project_id}/export/preflight
///
/// 在真正触发导出前进行多维度检查，返回 blocking/warning/info 分级 findings：
/// - 脚本：存在性、是否空内容、字节长度
/// - 分镜：存在性、空描述场景、重复场次号、未挂载资产场景
/// - 资产：URL 合法性、磁盘存在性、空文件（size=0）、外部 URL、重复文件名
/// - 项目：资产总数为 0、对话数、估算包大小
pub async fn preflight_export(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<ExportPreflightResponse>> {
    let project = project_repo::find_by_id(&state.db, &project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    if project.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权限访问该项目".into()));
    }

    let assets = asset_repo::list_by_project(&state.db, &project_id).await?;
    let script = script_repo::find_by_project(&state.db, &project_id).await?;
    let storyboard = storyboard_repo::find_by_project(&state.db, &project_id).await?;
    let conversations = conv_repo::list_by_project(&state.db, &project_id, &user_id.0).await?;

    let assets_root = match fs::canonicalize(&state.config.assets_dir).await {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!(assets_dir = %state.config.assets_dir, error = %e, "assets_dir 无法访问");
            None
        }
    };

    let mut findings: Vec<PreflightFinding> = Vec::new();
    let mut missing_assets: Vec<MissingAssetInfo> = Vec::new();
    let mut on_disk = 0usize;
    let mut empty_file_count = 0usize;
    let mut external_url_count = 0usize;
    let mut estimated_size = 0u64;

    // ── 资产检查 ──────────────────────────────────
    // 1. 重复文件名
    let mut name_counts: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for asset in &assets {
        name_counts
            .entry(asset.name.clone())
            .or_default()
            .push(asset.id.clone());
    }
    let mut duplicate_filenames: Vec<DuplicateFilenameGroup> = Vec::new();
    for (name, ids) in name_counts.iter() {<function_never_used_51bce0c785ca2f68081bfa7d91973934=      if ids.len() > 1 {
            duplicate_filenames.push(DuplicateFilenameGroup {
                name: name.clone(),
                count: ids.len(),
                asset_ids: ids.clone(),
            });
        }
    }
    if !duplicate_filenames.is_empty() {
        let sample = duplicate_filenames.iter().take(3)
            .map(|g| format!("\"{}\" (×{})", g.name, g.count))
            .collect::<Vec<_>>()
            .join("、");
        findings.push(PreflightFinding {
            severity: "warning".into(),
            code: "DUPLICATE_FILENAME".into(),
            message: format!("存在 {} 组重名资产，归档时会自动加序号前缀覆盖，但交付时可能产生混淆：{}",
                duplicate_filenames.len(), sample),
            locator: None,
        });
    }

    // 2. 逐资产检查
    for asset in &assets {
        // 空文件名
        let trimmed_name = asset.name.trim();
        if trimmed_name.is_empty() {
            findings.push(PreflightFinding {
                severity: "warning".into(),
                code: "ASSET_EMPTY_NAME".into(),
                message: format!("资产 {} 名称为空", &asset.id[..8]),
                locator: Some(asset.id.clone()),
            });
        }

        // URL 合法性
        let url_kind = classify_asset_url(&asset.url);
        match url_kind {
            AssetUrlKind::Empty => {
                missing_assets.push(MissingAssetInfo {
                    asset_id: asset.id.clone(),
                    name: asset.name.clone(),
                    asset_type: asset.asset_type.clone(),
                    reason: "URL 字段为空".into(),
                    url: asset.url.clone(),
                });
                findings.push(PreflightFinding {
                    severity: "warning".into(),
                    code: "ASSET_URL_EMPTY".into(),
                    message: format!("资产 \"{}\" URL 为空", asset.name),
                    locator: Some(asset.id.clone()),
                });
                continue;
            }
            AssetUrlKind::InvalidLocalPath => {
                findings.push(PreflightFinding {
                    severity: "warning".into(),
                    code: "ASSET_URL_INVALID".into(),
                    message: format!("资产 \"{}\" URL 包含非法路径字符", asset.name),
                    locator: Some(asset.id.clone()),
                });
                continue;
            }
            AssetUrlKind::Local => {}  // proceed to disk check
            AssetUrlKind::External => {} // handled below
        }

        let is_local = matches!(url_kind, AssetUrlKind::Local);
        if is_local {
            // 本地资产：磁盘检查
            let mut size_on_disk: Option<u64> = None;
            if let Some(root) = &assets_root {
                match probe_local_asset(root, asset).await {
                    Ok(size) => {
                        on_disk += 1;
                        size_on_disk = Some(size);
                        if size == 0 {
                            empty_file_count += 1;
                            findings.push(PreflightFinding {
                                severity: "warning".into(),
                                code: "ASSET_ZERO_BYTES".into(),
                                message: format!("资产 \"{}\" 文件大小为 0 字节，可能已损坏", asset.name),
                                locator: Some(asset.id.clone()),
                            });
                        }
                    }
                    Err(reason) => {
                        missing_assets.push(MissingAssetInfo {
                            asset_id: asset.id.clone(),
                            name: asset.name.clone(),
                            asset_type: asset.asset_type.clone(),
                            reason: reason.clone(),
                            url: asset.url.clone(),
                        });
                        findings.push(PreflightFinding {
                            severity: "warning".into(),
                            code: "ASSET_NOT_FOUND".into(),
                            message: format!("资产 \"{}\" {}", asset.name, reason),
                            locator: Some(asset.id.clone()),
                        });
                    }
                }
            } else {
                findings.push(PreflightFinding {
                    severity: "blocking".into(),
                    code: "ASSETS_DIR_INACCESSIBLE".into(),
                    message: "服务器资产目录无法访问，无法导出本地资产".into(),
                    locator: None,
                });
            }

            // 取磁盘真实大小，metadata.sizeBytes 仅作为回退
            if let Some(sz) = size_on_disk {
                estimated_size += sz;
            } else if let Some(meta_str) = &asset.metadata {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(meta_str) {
                    if let Some(size) = meta.get("sizeBytes").and_then(|v| v.as_u64()) {
                        estimated_size += size;
                    }
                }
            }
        } else {
            // 外部 URL 资产
            external_url_count += 1;
            missing_assets.push(MissingAssetInfo {
                asset_id: asset.id.clone(),
                name: asset.name.clone(),
                asset_type: asset.asset_type.clone(),
                reason: "外部 URL 资产，导出包无法打包（仅记录元数据）".into(),
                url: asset.url.clone(),
            });
            findings.push(PreflightFinding {
                severity: "info".into(),
                code: "ASSET_EXTERNAL_URL".into(),
                message: format!("资产 \"{}\" 为外部 URL（{}），二进制不会被打包",
                    asset.name,
                    if asset.url.len() > 50 { format!("{}…", &asset.url[..47]) } else { asset.url.clone() }),
                locator: Some(asset.id.clone()),
            });
        }

        // metadata 中可能携带的敏感信息提示（不扫描内容，仅提示）
        if asset.asset_type == "document" && is_sensitive_filename(&asset.name) {
                findings.push(PreflightFinding {
                    severity: "warning".into(),
                    code: "POTENTIAL_SENSITIVE_FILE".into(),
                    message: format!("资产 \"{}\" 文件名疑似包含敏感信息（密码/密钥/.env），导出包将明文包含，请确认是否应交付",
                        asset.name),
                    locator: Some(asset.id.clone()),
                });
        }
    }

    // ── 脚本检查 ──────────────────────────────────
    let script_empty = match &script {
        None => true,
        Some(s) => s.content.trim().is_empty(),
    };
    let script_size = script.as_ref().map(|s| s.content.len()).unwrap_or(0);

    if script.is_none() {
        findings.push(PreflightFinding {
            severity: "warning".into(),
            code: "SCRIPT_MISSING".into(),
            message: "项目未设置剧本，导出的 script/current-script.md 将为空".into(),
            locator: None,
        });
    } else if script_empty {
        findings.push(PreflightFinding {
            severity: "warning".into(),
            code: "SCRIPT_EMPTY".into(),
            message: "剧本存在但内容为空".into(),
            locator: None,
        });
    } else if script_size < 50 {
        findings.push(PreflightFinding {
            severity: "info".into(),
            code: "SCRIPT_SHORT".into(),
            message: format<[PLHD87_never_used_51bce0c785ca2f68081bfa7d91973934]>          format!("剧本内容仅 {} 字节，可能不完整", script_size),
            locator: None,
        });
    } else {
        findings.push(PreflightFinding {
            severity: "info".into(),
            code: "SCRIPT_OK".into(),
            message: format!("剧本就绪，{} 字节", script_size),
            locator: None,
        });
    }

    // ── 分镜检查 ──────────────────────────────────
    let mut empty_scenes = 0usize;
    let mut unassigned_scenes = 0usize;
    let mut scene_numbers: Vec<i64> = Vec::new();
    if let Some(sb) = &storyboard {
        for line in &sb.lines {
            if line.description.trim().is_empty() {
                empty_scenes += 1;
            }
            if line.assets.is_empty() && line.duration > 0 {
                unassigned_scenes += 1;
            }
            scene_numbers.push(line.scene_number);
        }
    }

    // 重复场次号（使用测试覆盖的纯函数）
    scene_numbers.sort_unstable();
    let duplicate_scenes = duplicate_scene_numbers(&scene_numbers);

    if storyboard.is_none() {
        findings.push(PreflightFinding {
            severity: "warning".into(),
            code: "STORYBOARD_MISSING".into(),
            message: "项目未设置分镜，storyboard/storyboard.json 将为空，final-cut 时间线无法生成".into(),
            locator: None,
        });
    } else {
        if storyboard.as_ref().is_some_and(|s| s.lines.is_empty()) {
            findings.push(PreflightFinding {
                severity: "warning".into(),
                code: "STORYBOARD_EMPTY".into(),
                message: "分镜记录存在但没有任何场次".into(),
                locator: None,
            });
        }
        if empty_scenes > 0 {
            findings.push(PreflightFinding {
                severity: "warning".into(),
                code: "STORYBOARD_EMPTY_SCENES".into(),
                message: format!("{} 个场次描述为空", empty_scenes),
                locator: None,
            });
        }
        if unassigned_scenes > 0 {
            findings.push(PreflightFinding {
                severity: "info".into(),
                code: "STORYBOARD_UNASSIGNED_ASSETS".into(),
                message: format!("{} 个场次时长>0但未挂载资产", unassigned_scenes),
                locator: None,
            });
        }
        if !duplicate_scenes.is_empty() {
            let nums: Vec<String> = duplicate_scenes.iter().take(5).map(|n| n.to_string()).collect();
            findings.push(PreflightFinding {
                severity: "warning".into(),
                code: "STORYBOARD_DUPLICATE_SCENES".into(),
                message: format!(
                    "存在重复场次号：{}{}",
                    nums.join(", "),
                    if duplicate_scenes.len() > 5 { "…" } else { "" }
                ),
                locator: None,
            });
        }
    }

    // ── 项目级检查 ────────────────────────────────
    if assets.is_empty() && script.is_none() {
        findings.push(PreflightFinding {
            severity: "blocking".into(),
            code: "PROJECT_EMPTY".into(),
            message: "项目既无剧本也无资产，导出的包没有任何实质内容".into(),
            locator: None,
        });
    }

    if assets.is_empty() {
        findings.push(PreflightFinding {
            severity: "info".into(),
            code: "NO_ASSETS".into(),
            message: "项目无资产，导出包仅包含文字内容".into(),
            locator: None,
        });
    }

    if conversations.is_empty() {
        findings.push(PreflightFinding {
            severity: "info".into(),
            code: "NO_CONVERSATIONS".into(),
            message: "项目无对话记录，conversations/ 目录将为空".into(),
            locator: None,
        });
    } else {
        findings.push(PreflightFinding {
            severity: "info".into(),
            code: "CONVERSATION_COUNT".into(),
            message: format!("包含 {} 段对话历史", conversations.len()),
            locator: None,
        });
    }

    if estimated_size > 500 * 1024 * 1024 {
        findings.push(PreflightFinding {
            severity: "warning".into(),
            code: "PACKAGE_LARGE".into(),
            message: format!(
                "估算包体积约 {}，上传/下载可能耗时较长",
                format_bytes(estimated_size)
            ),
            locator: None,
        });
    } else {
        findings.push(PreflightFinding {
            severity: "info".into(),
            code: "PACKAGE_SIZE".into(),
            message: format!("估算包体积约 {}", format_bytes(estimated_size)),
            locator: None,
        });
    }

    // 统计
    let blocking_count = findings.iter().filter(|f| f.severity == "blocking").count();
    let warning_count = findings.iter().filter(|f| f.severity == "warning").count();
    let info_count = findings.iter().filter(|f| f.severity == "info").count();
    let ready = blocking_count == 0;

    Ok(Json(ExportPreflightResponse {
        project_id: project.id.clone(),
        project_name: project.name,
        asset_total: assets.len(),
        asset_on_disk: on_disk,
        asset_missing: missing_assets.len(),
        asset_empty: empty_file_count,
        asset_external_url: external_url_count,
        estimated_size_bytes: estimated_size,
        missing_assets,
        script_present: script.is_some(),
        script_empty,
        script_size_bytes: script_size,
        storyboard_present: storyboard.is_some(),
        storyboard_empty_scenes: empty_scenes,
        storyboard_duplicate_scenes: duplicate_scenes,
        conversation_count: conversations.len(),
        duplicate_filenames,
        findings,
        blocking_count,
        warning_count,
        info_count,
        ready,
    }))
}

/* ── 辅助 ──────────────────────────────────────── */

/// 探测本地资产是否可读，返回文件大小（字节）
async fn probe_local_asset(root: &std::path::Path, asset: &crate::asset::model::Asset) -> Result<u64, String> {
    let filename = asset
        .url
        .strip_prefix(LOCAL_UPLOAD_URL_PREFIX)
        .ok_or_else(|| "URL 非本地路径前缀".to_string())?;
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err("URL 包含非法路径字符".into());
    }
    let candidate = root.join(filename);
    let meta = fs::metadata(&candidate).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "磁盘文件不存在".to_string()
        } else {
            format!("文件无法访问: {}", e)
        }
    })?;
    if !meta.is_file() {
        return Err("路径不是常规文件".into());
    }
    Ok(meta.len())
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 { format!("{} B", bytes) }
    else if bytes < 1024 * 1024 { format!("{:.1} KB", bytes as f64 / 1024.0) }
    else if bytes < 1024 * 1024 * 1024 { format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0)) }
    else { format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0)) }
}

/// POST /api/projects/{project_id}/export
///
/// 执行可审计导出：构建 tar.gz 到磁盘、记录审计、返回元数据
pub async fn create_export(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateExportReq>,
) -> AppResult<Json<ExportAuditDetail>> {
    let project = project_repo::find_by_id(&state.db, &project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    if project.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权限访问该项目".into()));
    }

    let export_type = req.export_type.as_str();
    if !["full", "core"].contains(&export_type) {
        return Err(AppError::Validation(
            "export_type 必须为 full 或 core".into(),
        ));
    }

    // 加载全部项目数据
    let assets = asset_repo::list_by_project(&state.db, &project_id).await?;
    let script = script_repo::find_by_project(&state.db, &project_id).await?;
    let storyboard = storyboard_repo::find_by_project(&state.db, &project_id).await?;
    let conversations = conv_repo::list_by_project(&state.db, &project_id, &user_id.0).await?;

    let mut conv_with_msgs: Vec<(crate::conversation::model::Conversation, Vec<crate::conversation::model::Message>)> = Vec::new();
    for conv in &conversations {
        let msgs = conv_repo::list_messages(&state.db, &conv.id).await?;
        conv_with_msgs.push((conv.clone(), msgs));
    }

    // 构建 tar.gz
    let built: BuiltExport = match export_type {
        "core" => {
            tar_builder::build_core_bundle_only(
                &state,
                &project,
                &script,
                &storyboard,
                &assets,
                &conv_with_msgs,
            )
            .await?
        }
        _ => {
            tar_builder::build_auditable_export(
                &state,
                &project,
                &script,
                &storyboard,
                &assets,
                &conv_with_msgs,
                "full",
            )
            .await?
        }
    };

    // 写到磁盘 exports_dir
    fs::create_dir_all(&state.config.exports_dir)
        .await
        .map_err(|e| AppError::Internal(format!("无法创建 exports 目录: {}", e)))?;

    let file_path_buf = PathBuf::from(&state.config.exports_dir).join(&built.filename);
    fs::write(&file_path_buf, &built.tar_gz_bytes)
        .await
        .map_err(|e| AppError::Internal(format!("写入导出文件失败: {}", e)))?;

    // 直接使用 tar_builder 已脱敏的字节写入审计表，避免二次序列化泄露
    // missing_asset_ids 列存纯数组（与 to_detail_response 的 Vec<MissingAssetInfo> 对应）；
    // missing_bytes 是包装过的 missing-assets.json（带 generatedAt 等），两者都脱敏过
    let missing_asset_ids_json = serde_json::to_string(&built.missing).unwrap_or_else(|_| "[]".into());
    let manifest_json = String::from_utf8(built.manifest_bytes.clone()).unwrap_or_else(|_| "{}".into());
    let checksums_json = String::from_utf8(built.checksums_bytes.clone()).unwrap_or_else(|_| "[]".into());
    let snapshot_json = String::from_utf8(built.snapshot_bytes.clone()).unwrap_or_else(|_| "{}".into());
    let gen_params_json = String::from_utf8(built.gen_params_bytes.clone()).unwrap_or_else(|_| "{}".into());
    let verification_json = String::from_utf8(built.verification_bytes.clone()).unwrap_or_else(|_| "{}".into());

    let status = if built.verification.passed && built.missing.is_empty() {
        "completed"
    } else if built.verification.passed {
        "partial"
    } else {
        "failed"
    };

    let id = audit_repo::new_id();
    let record = ExportAuditRecord {
        id: id.clone(),
        project_id: project.id.clone(),
        user_id: user_id.0.clone(),
        export_type: export_type.to_string(),
        export_version: EXPORT_VERSION.to_string(),
        filename: built.filename.clone(),
        file_path: file_path_buf.to_string_lossy().to_string(),
        file_size: built.tar_gz_bytes.len() as i64,
        file_sha256: Some(built.file_sha256.clone()),
        manifest_sha256: Some(built.manifest_sha256.clone()),
        asset_total: assets.len() as i64,
        asset_included: built.checksums.len() as i64,
        asset_missing: built.missing.len() as i64,
        missing_asset_ids: missing_asset_ids_json,
        manifest_json,
        checksums_json,
        project_snapshot_json: snapshot_json,
        generation_params_json: gen_params_json,
        verification_report_json: verification_json,
        status: status.to_string(),
        error_message: None,
        created_at: Utc::now().to_rfc3339(),
        expires_at: None,
    };

    audit_repo::insert_audit(&state.db, &record).await?;

    tracing::info!(
        audit_id = %id,
        project_id = %project.id,
        export_type = %export_type,
        file_size = built.tar_gz_bytes.len(),
        asset_included = built.checksums.len(),
        asset_missing = built.missing.len(),
        status = %status,
        "导出包创建完成"
    );

    Ok(Json(to_detail_response(&record)))
}

/// GET /api/export-audits
///
/// 列出当前用户的导出历史
pub async fn list_export_audits(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<ExportListQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let limit = query.limit.unwrap_or(20);
    let offset = query.offset.unwrap_or(0);

    let records =
        audit_repo::list_audits(&state.db, &user_id.0, query.project_id.as_deref(), limit, offset)
            .await?;
    let total =
        audit_repo::count_audits(&state.db, &user_id.0, query.project_id.as_deref()).await?;

    // 附加 project_name（从 project_snapshot_json 中提取）
    let items: Vec<ExportAuditSummary> = records
        .into_iter()
        .map(|r| {
            let project_name = serde_json::from_str::<serde_json::Value>(&r.manifest_json)
                .ok()
                .and_then(|v| {
                    v.get("project")
                        .and_then(|p| p.get("name"))
                        .and_then(|n| n.as_str())
                        .map(String::from)
                });
            ExportAuditSummary {
                id: r.id,
                project_id: r.project_id,
                project_name,
                export_type: r.export_type,
                export_version: r.export_version,
                filename: r.filename,
                file_size: r.file_size,
                file_sha256: r.file_sha256,
                manifest_sha256: r.manifest_sha256,
                asset_total: r.asset_total,
                asset_included: r.asset_included,
                asset_missing: r.asset_missing,
                status: r.status,
                error_message: r.error_message,
                created_at: r.created_at,
                expires_at: r.expires_at,
            }
        })
        .collect();

    Ok(Json(serde_json::json!({
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
    })))
}

/// GET /api/export-audits/{id}
///
/// 获取单个导出审计详情
pub async fn get_export_audit(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<ExportAuditDetail>> {
    let record = audit_repo::find_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("导出记录不存在".into()))?;
    if record.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权限访问该导出记录".into()));
    }
    Ok(Json(to_detail_response(&record)))
}

/// GET /api/export-audits/{id}/download
///
/// 下载导出的 tar.gz 文件
pub async fn download_export(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let record = audit_repo::find_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("导出记录不存在".into()))?;
    if record.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权限访问该导出文件".into()));
    }

    let path = PathBuf::from(&record.file_path);
    let bytes = fs::read(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("导出文件已被清理，请重新导出".into())
        } else {
            AppError::Internal(format!("读取导出文件失败: {}", e))
        }
    })?;

    let encoded_name = record
        .filename
        .replace(' ', "_")
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let content_disposition = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        encoded_name,
        urlencoding_encode(&record.filename)
    );

    Ok((
        [
            (header::CONTENT_TYPE, "application/gzip"),
            (header::CONTENT_DISPOSITION, content_disposition.as_str()),
            (header::CACHE_CONTROL, "private, max-age=3600"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

/* ── 内部辅助 ────────────────────────────────────── */

fn to_detail_response(record: &ExportAuditRecord) -> ExportAuditDetail {
    let missing_assets: Vec<MissingAssetInfo> =
        serde_json::from_str(&record.missing_asset_ids).unwrap_or_default();
    let manifest: serde_json::Value =
        serde_json::from_str(&record.manifest_json).unwrap_or(serde_json::json!({}));
    let checksums: Vec<AssetChecksumEntry> =
        serde_json::from_str(&record.checksums_json).unwrap_or_default();
    let verification: serde_json::Value =
        serde_json::from_str(&record.verification_report_json).unwrap_or(serde_json::json!({}));
    let gen_params: serde_json::Value = serde_json::from_str(&record.generation_params_json)
        .unwrap_or(serde_json::json!({}));

    ExportAuditDetail {
        id: record.id.clone(),
        project_id: record.project_id.clone(),
        user_id: record.user_id.clone(),
        export_type: record.export_type.clone(),
        export_version: record.export_version.clone(),
        filename: record.filename.clone(),
        file_size: record.file_size,
        file_sha256: record.file_sha256.clone(),
        manifest_sha256: record.manifest_sha256.clone(),
        asset_total: record.asset_total,
        asset_included: record.asset_included,
        asset_missing: record.asset_missing,
        missing_assets,
        manifest,
        checksums,
        verification_report: verification,
        generation_params: gen_params,
        status: record.status.clone(),
        error_message: record.error_message.clone(),
        created_at: record.created_at.clone(),
        download_url: format!("/api/export-audits/{}/download", record.id),
    }
}

/// RFC 5987 简单百分号编码
fn urlencoding_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

// 避免未使用的 warning
#[allow(dead_code)]
fn _type_check(_: StatusCode) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_record(
        export_type: &str,
        file_sha: Option<&str>,
        manifest_sha: Option<&str>,
        asset_total: i64,
        asset_included: i64,
        asset_missing: i64,
    ) -> ExportAuditRecord {
        ExportAuditRecord {
            id: "audit-1".into(),
            project_id: "proj-1".into(),
            user_id: "user-1".into(),
            export_type: export_type.into(),
            export_version: "1.0".into(),
            filename: "demo-full-20250101.tar.gz".into(),
            file_path: "/tmp/demo.tar.gz".into(),
            file_size: 12345,
            file_sha256: file_sha.map(String::from),
            manifest_sha256: manifest_sha.map(String::from),
            asset_total,
            asset_included,
            asset_missing,
            missing_asset_ids: "[]".into(),
            manifest_json: "{\"project\":{\"name\":\"demo\"}}".into(),
            checksums_json: "[]".into(),
            project_snapshot_json: "{}".into(),
            generation_params_json: "{}".into(),
            verification_report_json: "{\"passed\":true}".into(),
            status: if asset_missing == 0 { "completed" } else { "partial" }.into(),
            error_message: None,
            created_at: "2025-01-01T00:00:00Z".into(),
            expires_at: None,
        }
    }

    #[test]
    fn detail_response_exposes_all_summary_fields() {
        let rec = make_record(
            "full",
            Some("abcdef1234567890"),
            Some("0fedcba0987654321"),
            10,
            8,
            2,
        );
        let detail = to_detail_response(&rec);
        assert_eq!(detail.id, "audit-1");
        assert_eq!(detail.project_id, "proj-1");
        assert_eq!(detail.user_id, "user-1");
        assert_eq!(detail.export_type, "full");
        assert_eq!(detail.filename, "demo-full-20250101.tar.gz");
        assert_eq!(detail.file_size, 12345);
        assert_eq!(detail.file_sha256.as_deref(), Some("abcdef1234567890"));
        assert_eq!(detail.manifest_sha256.as_deref(), Some("0fedcba0987654321"));
        assert_eq!(detail.asset_total, 10);
        assert_eq!(detail.asset_included, 8);
        assert_eq!(detail.asset_missing, 2);
        assert_eq!(detail.status, "partial");
        assert!(detail.download_url.contains("/download"));
    }

    #[test]
    fn format_bytes_human_readable() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1048576), "1.0 MB");
        assert!(format_bytes(1073741824).starts_with("1.0") && format_bytes(1073741824).ends_with("GB"));
    }

    #[test]
    fn urlencoding_produces_valid_rfc5987() {
        let encoded = urlencoding_encode("my file.tar.gz");
        assert!(!encoded.contains(' '));
        assert!(encoded.contains("%20"));
        assert_eq!(urlencoding_encode("simple.tar.gz"), "simple.tar.gz");
    }

    #[test]
    fn export_status_determined_by_counts() {
        let rec_ok = make_record("full", Some("a"), Some("b"), 5, 5, 0);
        assert_eq!(rec_ok.status, "completed");
        let rec_partial = make_record("full", Some("a"), Some("b"), 5, 3, 2);
        assert_eq!(rec_partial.status, "partial");
    }
}
