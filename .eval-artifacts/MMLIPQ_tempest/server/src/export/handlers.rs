use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path as StdPath;
use tokio::fs;

use crate::{
    asset, auth::middleware::UserId, error::AppResult, project, script, storyboard, AppState,
};

use super::{
    model::{
        AssetSummary, ContentReadiness, ExportAuditListResponse, ExportPrecheck, PrecheckIssue,
        RecordExportAuditReq,
    },
    repo,
};

#[derive(Debug, Deserialize, Default)]
pub struct AuditListQuery {
    pub project_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Maximum single asset size we warn about (100 MB)
const WARN_SINGLE_ASSET_BYTES: u64 = 100 * 1024 * 1024;
/// Minimum script length (chars) before warning
const MIN_SCRIPT_LENGTH_CHARS: usize = 50;

/// Check if a URL string looks syntactically valid
fn is_valid_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Local upload paths are valid by definition
    if trimmed.starts_with('/') {
        return true;
    }
    // Must start with http:// or https:// or data:
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        // Must have something after the protocol
        let after = if let Some(rest) = trimmed.strip_prefix("http://") {
            rest
        } else {
            trimmed.strip_prefix("https://").unwrap_or("")
        };
        // After removing protocol, need at least host (e.g., "x.y")
        if after.is_empty() || !after.contains('.') && !after.starts_with("localhost") && !after.starts_with("127.0.0.1") {
            // Accept IPs and localhost
            if !after.starts_with("localhost") && !after.starts_with("127.0.0.1") && !after.starts_with("[::1]") {
                return false;
            }
        }
        return true;
    }
    if trimmed.starts_with("data:") {
        return true;
    }
    false
}

/// Check if a remote URL points to a private/loopback address that won't work
/// when the package is opened on another machine.
fn is_private_local_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("://localhost")
        || lower.contains("://127.0.0.1")
        || lower.contains("://[::1]")
        || lower.contains("://192.168.")
        || lower.contains("://10.0.")
        || lower.contains("://172.16.")
        || lower.contains("://0.0.0.0")
}

/// Very rough check: does the script text look like it has structural content
/// (scene headings, dialogue, meaningful paragraphs)?
fn script_has_structure(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    // Check for scene headings (第X场/场景X/INT./EXT./内景/外景)
    let has_scene = t.contains("第") && (t.contains("场") || t.contains("幕"))
        || t.contains("INT.")
        || t.contains("EXT.")
        || t.contains("内景")
        || t.contains("外景")
        || t.contains("场景");
    if has_scene {
        return true;
    }
    // Check for dialogue: lines with speaker：content pattern
    let mut dialogue_lines = 0;
    for line in t.lines() {
        let trimmed = line.trim();
        // 角色名：台词 (Chinese) or Character: dialogue
        if let Some(colon_pos) = trimmed.find(|c: char| c == '：' || c == ':') {
            let speaker = trimmed[..colon_pos].trim();
            // Speaker should be short (1-12 chars), not generic
            if !speaker.is_empty()
                && speaker.chars().count() <= 12
                && !speaker.contains(' ')
                && !speaker.starts_with('#')
                && !speaker.starts_with('-')
            {
                dialogue_lines += 1;
            }
        }
    }
    dialogue_lines >= 2
}

pub async fn precheck(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<ExportPrecheck>> {
    // Verify project access and load data
    let project = project::repo::find_by_id(&state.db, &project_id)
        .await?
        .ok_or_else(|| crate::error::AppError::NotFound("项目不存在".into()))?;

    if project.user_id != user_id.0 {
        return Err(crate::error::AppError::Forbidden("无权访问该项目".into()));
    }

    let assets = asset::repo::list_by_project(&state.db, &project_id).await?;
    let script = script::repo::find_by_project(&state.db, &project_id).await?;
    let storyboard = storyboard::repo::find_by_project(&state.db, &project_id).await?;
    let conversations =
        crate::conversation::repo::list_by_project(&state.db, &project_id, &user_id.0).await?;

    // Count messages across all conversations for this project
    let message_count: (i64,) = if !conversations.is_empty() {
        let conv_ids: Vec<String> = conversations.iter().map(|c| c.id.clone()).collect();
        let placeholders = conv_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT COUNT(*) FROM messages WHERE conversation_id IN ({})",
            placeholders
        );
        let mut query = sqlx::query_as::<_, (i64,)>(&sql);
        for id in &conv_ids {
            query = query.bind(id);
        }
        query.fetch_one(&state.db).await?
    } else {
        (0,)
    };

    // ─── Asset analysis ─────────────────────────────────────────────────
    let mut asset_summary = AssetSummary::default();
    let mut blocking_issues = Vec::new();
    let mut warnings = Vec::new();
    let mut info = Vec::new();
    let mut estimated_bytes: u64 = 0;
    let mut seen_names: HashSet<String> = HashSet::new();
    let mut duplicate_name_count = 0usize;
    let mut zero_byte_count = 0usize;
    let mut invalid_url_count = 0usize;
    let mut private_url_count = 0usize;
    let mut oversized_count = 0usize;
    let mut empty_name_count = 0usize;

    for asset in &assets {
        asset_summary.total_assets += 1;
        match asset.asset_type.as_str() {
            "image" => asset_summary.image_count += 1,
            "video" => asset_summary.video_count += 1,
            "audio" => asset_summary.audio_count += 1,
            "document" => asset_summary.document_count += 1,
            _ => {}
        }

        // Check for empty name
        if asset.name.trim().is_empty() {
            empty_name_count += 1;
            warnings.push(PrecheckIssue {
                code: "ASSET_EMPTY_NAME".into(),
                severity: "warning",
                message: format!("资产 ID {} 的文件名为空，导出时将用 ID 替代", asset.id),
                asset_id: Some(asset.id.clone()),
            });
        }

        // Check for duplicate names (tar collision)
        if !asset.name.trim().is_empty() {
            let key = asset.name.trim().to_lowercase();
            if !seen_names.insert(key) {
                duplicate_name_count += 1;
                warnings.push(PrecheckIssue {
                    code: "DUPLICATE_ASSET_NAME".into(),
                    severity: "warning",
                    message: format!(
                        "资产「{}」与其他资产重名，导出时可能产生文件覆盖",
                        asset.name
                    ),
                    asset_id: Some(asset.id.clone()),
                });
            }
        }

        let is_local = asset.url.starts_with("/uploads/");
        if is_local {
            asset_summary.local_assets += 1;
            let file_path = StdPath::new(&state.config.assets_dir)
                .join(asset.url.trim_start_matches("/uploads/"));
            match fs::metadata(&file_path).await {
                Ok(meta) => {
                    let size = meta.len();
                    estimated_bytes += size;
                    if size == 0 {
                        zero_byte_count += 1;
                        warnings.push(PrecheckIssue {
                            code: "ASSET_ZERO_BYTES".into(),
                            severity: "warning",
                            message: format!(
                                "资产「{}」的本地文件大小为 0 字节，可能已损坏",
                                asset.name
                            ),
                            asset_id: Some(asset.id.clone()),
                        });
                    }
                    if size > WARN_SINGLE_ASSET_BYTES {
                        oversized_count += 1;
                        warnings.push(PrecheckIssue {
                            code: "ASSET_OVERSIZED".into(),
                            severity: "warning",
                            message: format!(
                                "资产「{}」体积较大 ({} MB)，可能导致导出包过大",
                                asset.name,
                                size / (1024 * 1024)
                            ),
                            asset_id: Some(asset.id.clone()),
                        });
                    }
                }
                Err(_) => {
                    asset_summary.missing_or_broken += 1;
                    blocking_issues.push(PrecheckIssue {
                        code: "ASSET_FILE_MISSING".into(),
                        severity: "error",
                        message: format!(
                            "资产「{}」的本地文件缺失，导出时将被跳过",
                            asset.name
                        ),
                        asset_id: Some(asset.id.clone()),
                    });
                }
            }
        } else {
            asset_summary.remote_assets += 1;

            // Validate URL format
            if !is_valid_url(&asset.url) {
                invalid_url_count += 1;
                blocking_issues.push(PrecheckIssue {
                    code: "ASSET_INVALID_URL".into(),
                    severity: "error",
                    message: format!(
                        "资产「{}」的 URL 格式无效或为空 ({})",
                        asset.name,
                        if asset.url.trim().is_empty() {
                            "空 URL".to_string()
                        } else {
                            asset.url.chars().take(60).collect::<String>()
                        }
                    ),
                    asset_id: Some(asset.id.clone()),
                });
            } else if is_private_local_url(&asset.url) {
                private_url_count += 1;
                warnings.push(PrecheckIssue {
                    code: "ASSET_PRIVATE_URL".into(),
                    severity: "warning",
                    message: format!(
                        "资产「{}」指向本地/私有地址，外部接收者可能无法访问",
                        asset.name
                    ),
                    asset_id: Some(asset.id.clone()),
                });
            } else {
                warnings.push(PrecheckIssue {
                    code: "REMOTE_ASSET_UNVERIFIED".into(),
                    severity: "warning",
                    message: format!(
                        "资产「{}」是外部 URL，导出时将尝试下载但可能失败",
                        asset.name
                    ),
                    asset_id: Some(asset.id.clone()),
                });
            }

            estimated_bytes += match asset.asset_type.as_str() {
                "image" => 200 * 1024,
                "video" => 5 * 1024 * 1024,
                "audio" => 500 * 1024,
                _ => 50 * 1024,
            };
        }
    }

    asset_summary.estimated_total_bytes = estimated_bytes;

    // ─── Content readiness ──────────────────────────────────────────────
    let script_content = script
        .as_ref()
        .map(|s| s.content.trim().to_string())
        .unwrap_or_default();
    let script_word_count = script_content.chars().count();
    let has_script = !script_content.is_empty();
    let storyboard_line_count = storyboard
        .as_ref()
        .map(|sb| sb.lines.len() as i64)
        .unwrap_or(0);
    let total_duration_seconds: i64 = storyboard
        .as_ref()
        .map(|sb| sb.lines.iter().map(|l| l.duration.max(0)).sum())
        .unwrap_or(0);

    let content_readiness = ContentReadiness {
        has_script,
        script_word_count,
        has_storyboard: storyboard_line_count > 0,
        storyboard_line_count: storyboard_line_count as usize,
        has_conversations: !conversations.is_empty(),
        conversation_count: conversations.len(),
        message_count: message_count.0 as usize,
        total_duration_seconds,
    };

    // ─── Content checks ─────────────────────────────────────────────────
    // Check for empty project (blocking)
    if !has_script && storyboard_line_count == 0 && assets.is_empty() {
        blocking_issues.push(PrecheckIssue {
            code: "PROJECT_EMPTY".into(),
            severity: "error",
            message: "项目没有剧本、分镜或资产，导出内容为空".into(),
            asset_id: None,
        });
    }

    // Script checks
    if !has_script {
        warnings.push(PrecheckIssue {
            code: "NO_SCRIPT".into(),
            severity: "warning",
            message: "项目尚未保存剧本，导出包中将不包含剧本内容".into(),
            asset_id: None,
        });
    } else {
        // Script exists but check quality
        if script_word_count < MIN_SCRIPT_LENGTH_CHARS {
            warnings.push(PrecheckIssue {
                code: "SCRIPT_TOO_SHORT".into(),
                severity: "warning",
                message: format!(
                    "剧本内容较短（仅 {} 字），可能是草稿或占位文本",
                    script_word_count
                ),
                asset_id: None,
            });
        }
        if !script_has_structure(&script_content) && script_word_count >= MIN_SCRIPT_LENGTH_CHARS {
            info.push(PrecheckIssue {
                code: "SCRIPT_NO_STRUCTURE".into(),
                severity: "info",
                message: "剧本未检测到明确的场景标题或对白结构，可能是散文/大纲形式".into(),
                asset_id: None,
            });
        }
    }

    // Storyboard checks
    if storyboard_line_count == 0 {
        warnings.push(PrecheckIssue {
            code: "NO_STORYBOARD".into(),
            severity: "warning",
            message: "项目尚未创建分镜，视频计划和关键帧将为空".into(),
            asset_id: None,
        });
    } else {
        // Check individual storyboard lines
        if let Some(sb) = &storyboard {
            let empty_desc_count = sb
                .lines
                .iter()
                .filter(|l| l.description.trim().is_empty())
                .count();
            if empty_desc_count > 0 {
                warnings.push(PrecheckIssue {
                    code: "STORYBOARD_EMPTY_DESCRIPTIONS".into(),
                    severity: "warning",
                    message: format!(
                        "分镜中有 {} 个场景描述为空，导出后这些镜头将无内容",
                        empty_desc_count
                    ),
                    asset_id: None,
                });
            }
            let zero_duration_count = sb.lines.iter().filter(|l| l.duration <= 0).count();
            if zero_duration_count > 0 {
                info.push(PrecheckIssue {
                    code: "STORYBOARD_ZERO_DURATION".into(),
                    severity: "info",
                    message: format!(
                        "分镜中有 {} 个镜头时长为 0，成片时间线可能不准确",
                        zero_duration_count
                    ),
                    asset_id: None,
                });
            }
        }

        if total_duration_seconds == 0 && storyboard_line_count > 0 {
            warnings.push(PrecheckIssue {
                code: "STORYBOARD_ZERO_TOTAL_DURATION".into(),
                severity: "warning",
                message: "分镜总时长为 0 秒，请确认每个镜头都设置了时长".into(),
                asset_id: None,
            });
        }
    }

    // ─── Positive info signals ──────────────────────────────────────────
    if asset_summary.missing_or_broken == 0 && invalid_url_count == 0 && !assets.is_empty() {
        info.push(PrecheckIssue {
            code: "ALL_ASSETS_VERIFIED".into(),
            severity: "info",
            message: format!(
                "所有 {} 个资产链接有效，可正常打包",
                assets.len()
            ),
            asset_id: None,
        });
    }

    if has_script
        && script_word_count >= MIN_SCRIPT_LENGTH_CHARS
        && storyboard_line_count > 0
    {
        info.push(PrecheckIssue {
            code: "CONTENT_COMPLETE".into(),
            severity: "info",
            message: "剧本和分镜均已就绪，导出包内容完整".into(),
            asset_id: None,
        });
    }

    if !conversations.is_empty() && message_count.0 > 0 {
        info.push(PrecheckIssue {
            code: "CONVERSATIONS_PRESENT".into(),
            severity: "info",
            message: format!(
                "包含 {} 个对话会话，共 {} 条消息，将包含在导出包中",
                conversations.len(),
                message_count.0
            ),
            asset_id: None,
        });
    }

    if duplicate_name_count == 0 && !assets.is_empty() {
        info.push(PrecheckIssue {
            code: "NO_DUPLICATE_NAMES".into(),
            severity: "info",
            message: "资产文件名无重复，不会产生打包冲突".into(),
            asset_id: None,
        });
    }

    if estimated_bytes > 0 && estimated_bytes < 50 * 1024 * 1024 {
        info.push(PrecheckIssue {
            code: "BUNDLE_SIZE_REASONABLE".into(),
            severity: "info",
            message: format!(
                "预估导出包大小约 {}，大小适中",
                if estimated_bytes >= 1024 * 1024 {
                    format!("{} MB", estimated_bytes / (1024 * 1024))
                } else {
                    format!("{} KB", estimated_bytes / 1024)
                }
            ),
            asset_id: None,
        });
    }

    let can_export = blocking_issues.iter().all(|i| i.severity != "error");

    Ok(Json(ExportPrecheck {
        project_id: project.id,
        project_name: project.name,
        can_export,
        blocking_issues,
        warnings,
        info,
        asset_summary,
        content_readiness,
        estimated_bundle_size_bytes: estimated_bytes,
        checked_at: Utc::now().to_rfc3339(),
    }))
}

pub async fn record_audit(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<RecordExportAuditReq>,
) -> AppResult<Json<serde_json::Value>> {
    let project = project::repo::find_by_id(&state.db, &req.project_id)
        .await?
        .ok_or_else(|| crate::error::AppError::NotFound("项目不存在".into()))?;

    if project.user_id != user_id.0 {
        return Err(crate::error::AppError::Forbidden("无权操作该项目".into()));
    }

    let record = repo::insert_audit(&state.db, &user_id.0, &req).await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "auditId": record.id,
        "createdAt": record.created_at,
    })))
}

pub async fn list_audits(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<AuditListQuery>,
) -> AppResult<Json<ExportAuditListResponse>> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset = query.offset.unwrap_or(0).max(0);

    let (items, total) = if let Some(pid) = &query.project_id {
        let project = project::repo::find_by_id(&state.db, pid)
            .await?
            .ok_or_else(|| crate::error::AppError::NotFound("项目不存在".into()))?;
        if project.user_id != user_id.0 {
            return Err(crate::error::AppError::Forbidden("无权访问该项目".into()));
        }
        repo::list_audits_by_project(&state.db, pid, limit, offset).await?
    } else {
        repo::list_audits_by_user(&state.db, &user_id.0, limit, offset).await?
    };

    Ok(Json(ExportAuditListResponse {
        items,
        total,
        project_id: query.project_id,
    }))
}
