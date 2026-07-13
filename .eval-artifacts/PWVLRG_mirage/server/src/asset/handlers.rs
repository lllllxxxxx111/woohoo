use axum::{
    extract::{Extension, Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use std::path::{Path as StdPath, PathBuf};
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    project::repo as project_repo,
    AppState,
};

use super::{
    model::{
        Asset, AssetReferencesResponse, AssetSearchQuery, AssetSearchResponse,
        CreateAssetReq, DeleteAssetQuery, UpdateAssetReq,
    },
    repo,
};

/**
 * 允许上传的文件扩展名白名单
 * 限制可上传的文件类型，防止恶意文件上传
 */
const ALLOWED_EXTENSIONS: &[&str] = &[
    // 图片
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", // 视频
    "mp4", "webm", "mov", "avi", "mkv", // 音频
    "mp3", "wav", "ogg", "flac", "aac", // 文档
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv",
];

/**
 * 最大允许的文件名长度
 */
const MAX_FILENAME_LENGTH: usize = 100;

/**
 * 安全的最大文件大小 (50MB)
 */
const MAX_FILE_SIZE_BYTES: usize = 50 * 1024 * 1024;

/**
 * 每用户每项目最大上传配额（文件数量）
 */
const MAX_ASSETS_PER_PROJECT: u64 = 500;

/**
 * 每用户全局最大上传配额（总文件大小，单位：字节，5GB）
 */
const MAX_TOTAL_UPLOAD_SIZE_PER_USER: u64 = 5 * 1024 * 1024 * 1024;

const LOCAL_UPLOAD_URL_PREFIX: &str = "/uploads/";

/**
 * 清理用户提供的文件名，移除危险字符和路径遍历尝试
 */
fn sanitize_filename(raw_name: &str) -> String {
    let sanitized: String = raw_name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_' || *c == ' ')
        .take(MAX_FILENAME_LENGTH)
        .collect();

    if sanitized.trim().is_empty() {
        "unnamed".to_string()
    } else {
        sanitized.trim().to_string()
    }
}

fn is_allowed_extension(extension: &str) -> bool {
    ALLOWED_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}

fn is_valid_file_size(size: usize) -> bool {
    size > 0 && size <= MAX_FILE_SIZE_BYTES
}

// ─── 现有 CRUD 端点 ────────────────────────────────────────────

pub async fn list_assets(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Vec<Asset>>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let assets = repo::list_by_project(&state.db, &project_id).await?;
    Ok(Json(assets))
}

pub async fn create_asset(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateAssetReq>,
) -> AppResult<(StatusCode, Json<Asset>)> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    validate_asset_fields(&req.name, &req.asset_type, &req.url)?;

    let metadata = req.metadata.as_ref().map(|value| value.to_string());
    let asset = repo::create_asset(
        &state.db,
        &project_id,
        req.name.trim(),
        req.asset_type.trim(),
        req.url.trim(),
        metadata.as_deref(),
    )
    .await?;

    Ok((StatusCode::CREATED, Json(asset)))
}

pub async fn upload_asset(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<Asset>)> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;

    let project_asset_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM assets WHERE project_id = ?")
            .bind(&project_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0) as u64;

    if project_asset_count >= MAX_ASSETS_PER_PROJECT {
        return Err(AppError::Validation(
            format!(
                "项目资产数量已达上限 ({})，请清理后重试",
                MAX_ASSETS_PER_PROJECT
            )
            .into(),
        ));
    }

    let user_total_size: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(CAST(json_extract(metadata, '$.sizeBytes') AS INTEGER)), 0)
         FROM assets a
         JOIN projects p ON a.project_id = p.id
         WHERE p.user_id = ?",
    )
    .bind(&user_id.0)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let upload_root = resolve_upload_root(&state).await?;
    let mut upload_result: Option<(String, String, String, usize)> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::Internal(format!("Multipart error: {}", error)))?
    {
        if field.name().unwrap_or_default() != "file" {
            continue;
        }

        let original_name = field.file_name().unwrap_or("unnamed").to_string();
        let safe_name = sanitize_filename(&original_name);
        let file_ext = StdPath::new(&safe_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !is_allowed_extension(&file_ext) {
            tracing::warn!(
                original_name = %original_name,
                extension = %file_ext,
                user_id = %user_id.0,
                "上传被阻止：不允许的文件类型"
            );
            return Err(AppError::Validation(
                format!(
                    "不支持的文件类型: .{}，允许的类型: {}",
                    file_ext,
                    ALLOWED_EXTENSIONS.join(", ")
                )
                .into(),
            ));
        }

        let content_type = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_string();
        let asset_type = infer_asset_type_from_content_type(&content_type).to_string();
        let saved_filename = format!("{}.{}", Uuid::new_v4(), file_ext);
        let saved_path = upload_root.join(&saved_filename);
        if !saved_path.starts_with(&upload_root) {
            tracing::error!(
                attempted_path = %saved_path.display(),
                user_id = %user_id.0,
                "安全警告：检测到路径遍历尝试！"
            );
            return Err(AppError::Validation("非法的文件路径".into()));
        }

        let mut output = fs::File::create(&saved_path).await.map_err(|error| {
            AppError::Internal(format!("Failed to create upload file: {}", error))
        })?;

        let mut file_size = 0usize;
        let mut file_field = field;
        while let Some(chunk) = file_field.chunk().await.map_err(|error| {
            AppError::Internal(format!("Failed to read upload stream: {}", error))
        })? {
            file_size = file_size.saturating_add(chunk.len());
            let total_after_upload = user_total_size.saturating_add(file_size as i64);
            if total_after_upload > MAX_TOTAL_UPLOAD_SIZE_PER_USER as i64 {
                let _ = fs::remove_file(&saved_path).await;
                return Err(AppError::Validation(
                    format!(
                        "存储空间不足（当前已用 {}MB，本次文件累计 {}MB，上限 {}MB），请清理后重试",
                        user_total_size / (1024 * 1024),
                        file_size / (1024 * 1024),
                        MAX_TOTAL_UPLOAD_SIZE_PER_USER / (1024 * 1024)
                    )
                    .into(),
                ));
            }
            if file_size > MAX_FILE_SIZE_BYTES {
                let _ = fs::remove_file(&saved_path).await;
                return Err(AppError::Validation(
                    format!(
                        "文件大小无效或超过限制 (当前: {}字节, 最大: {}字节)",
                        file_size, MAX_FILE_SIZE_BYTES
                    )
                    .into(),
                ));
            }
            output
                .write_all(&chunk)
                .await
                .map_err(|error| AppError::Internal(format!("Failed to write file: {}", error)))?;
        }
        output
            .flush()
            .await
            .map_err(|error| AppError::Internal(format!("Failed to flush file: {}", error)))?;

        if !is_valid_file_size(file_size) {
            let _ = fs::remove_file(&saved_path).await;
            return Err(AppError::Validation(
                format!(
                    "文件大小无效或超过限制 (当前: {}字节, 最大: {}字节)",
                    file_size, MAX_FILE_SIZE_BYTES
                )
                .into(),
            ));
        }

        upload_result = Some((
            safe_name,
            asset_type,
            format!("{}{}", LOCAL_UPLOAD_URL_PREFIX, saved_filename),
            file_size,
        ));
        break;
    }

    let (safe_name, asset_type, url, file_size) =
        upload_result.ok_or_else(|| AppError::Validation("No file provided".into()))?;

    let metadata_json = serde_json::json!({
        "sizeBytes": file_size,
        "uploadedAt": chrono::Utc::now().to_rfc3339(),
    })
    .to_string();

    let asset = repo::create_asset(
        &state.db,
        &project_id,
        &safe_name,
        &asset_type,
        &url,
        Some(&metadata_json),
    )
    .await?;

    tracing::info!(
        asset_id = %asset.id,
        filename = %safe_name,
        size_bytes = file_size,
        user_id = %user_id.0,
        "资产上传成功"
    );

    Ok((StatusCode::CREATED, Json(asset)))
}

pub async fn get_asset_file(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let asset = load_asset_owned(&state, &user_id.0, &id).await?;
    let file_path = resolve_local_asset_path(&state, &asset).await?;
    let file_bytes = fs::read(&file_path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("资产文件不存在".into())
        } else {
            AppError::Internal(format!("Failed to read asset file: {}", error))
        }
    })?;
    let content_type = infer_content_type_by_extension(&file_path);

    let encoded_name = asset
        .name
        .replace(' ', "_")
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let content_disposition = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        &encoded_name,
        urlencoding_encode(&asset.name)
    );

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, &content_disposition),
            (header::CACHE_CONTROL, "private, max-age=3600"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        file_bytes,
    )
        .into_response())
}

pub async fn get_asset(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<Asset>> {
    let asset = load_asset_owned(&state, &user_id.0, &id).await?;
    Ok(Json(asset))
}

pub async fn update_asset(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAssetReq>,
) -> AppResult<Json<Asset>> {
    let current = load_asset_owned(&state, &user_id.0, &id).await?;
    let name = req.name.unwrap_or(current.name).trim().to_string();
    let asset_type = req
        .asset_type
        .unwrap_or(current.asset_type)
        .trim()
        .to_string();
    let url = req.url.unwrap_or(current.url).trim().to_string();

    // 合并 metadata：前端传入的 metadata 字段覆盖现有字段，但保留未涉及的字段
    let metadata = match req.metadata {
        Some(new_meta) => {
            // 解析现有 metadata
            let existing: serde_json::Value = current
                .metadata
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::json!({}));
            // 解析新 metadata
            let new_value = new_meta;
            // 浅合并
            let mut merged = existing.as_object().cloned().unwrap_or_default();
            if let Some(new_obj) = new_value.as_object() {
                for (k, v) in new_obj {
                    merged.insert(k.clone(), v.clone());
                }
            }
            if merged.is_empty() {
                None
            } else {
                Some(serde_json::Value::Object(merged).to_string())
            }
        }
        None => current.metadata,
    };

    validate_asset_fields(&name, &asset_type, &url)?;

    let asset = repo::update_asset(
        &state.db,
        &id,
        &name,
        &asset_type,
        &url,
        metadata.as_deref(),
    )
    .await?;
    Ok(Json(asset))
}

pub async fn delete_asset(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Query(params): Query<DeleteAssetQuery>,
) -> AppResult<StatusCode> {
    let asset = load_asset_owned(&state, &user_id.0, &id).await?;

    let force = params.force.unwrap_or(false);

    if !force {
        // 检查引用关系
        let has_refs = repo::has_asset_references(&state.db, &id).await?;
        if has_refs {
            let references = repo::find_asset_references(&state.db, &id).await?;
            return Err(AppError::Conflict(format!(
                "该素材正在被 {} 处引用，无法直接删除。请先移除引用，或使用 force=true 强制删除。引用详情：{}",
                references.len(),
                references
                    .iter()
                    .take(3)
                    .map(|r| format!("[{}] {}", r.ref_type, r.title))
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
    }

    repo::delete_asset(&state.db, &id).await?;

    if let Err(error) = cleanup_local_asset_file(&state, &asset).await {
        tracing::warn!(asset_id = %asset.id, error = %error, "删除资产记录后清理本地文件失败");
    }
    Ok(StatusCode::NO_CONTENT)
}

// ─── 新增端点：跨项目搜索 ──────────────────────────────────────

/**
 * GET /api/assets/search
 *
 * 跨项目搜索当前用户有权限的素材。
 * 支持按 query、asset_type、project_id、favorite_only、rating_min、tag、sort、limit/offset 过滤。
 */
pub async fn search_assets(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<AssetSearchQuery>,
) -> AppResult<Json<AssetSearchResponse>> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset = query.offset.unwrap_or(0).max(0);

    let (items, total) = repo::search_assets(&state.db, &user_id.0, &query).await?;

    Ok(Json(AssetSearchResponse {
        items,
        total,
        offset,
        limit,
    }))
}

// ─── 新增端点：引用关系查询 ────────────────────────────────────

/**
 * GET /api/assets/{id}/references
 *
 * 查询素材被哪些实体引用（分镜、pipeline 输出等）。
 * 返回引用列表及是否可安全删除。
 */
pub async fn get_asset_references(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<AssetReferencesResponse>> {
    // 先验证所有权
    let _asset = load_asset_owned(&state, &user_id.0, &id).await?;

    let references = repo::find_asset_references(&state.db, &id).await?;
    let total = references.len();
    let can_delete = total == 0;

    Ok(Json(AssetReferencesResponse {
        asset_id: id,
        references,
        total,
        can_delete,
    }))
}

// ─── 辅助函数 ─────────────────────────────────────────────────

async fn ensure_project_access(state: &AppState, user_id: &str, project_id: &str) -> AppResult<()> {
    let project = project_repo::find_by_id(&state.db, project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;

    if project.user_id != user_id {
        return Err(AppError::Forbidden("无权访问".into()));
    }

    Ok(())
}

async fn load_asset_owned(state: &AppState, user_id: &str, asset_id: &str) -> AppResult<Asset> {
    let asset = repo::find_by_id(&state.db, asset_id)
        .await?
        .ok_or_else(|| AppError::NotFound("资产不存在".into()))?;
    ensure_project_access(state, user_id, &asset.project_id).await?;
    Ok(asset)
}

fn validate_asset_fields(name: &str, asset_type: &str, url: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::Validation("资产名称不能为空".into()));
    }

    if url.trim().is_empty() {
        return Err(AppError::Validation("资产地址不能为空".into()));
    }

    match asset_type.trim() {
        "image" | "video" | "audio" | "document" => Ok(()),
        _ => Err(AppError::Validation("不支持的资产类型".into())),
    }
}

async fn resolve_upload_root(state: &AppState) -> AppResult<PathBuf> {
    fs::create_dir_all(&state.config.assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("Failed to create upload dir: {}", error)))?;
    fs::canonicalize(&state.config.assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("Failed to resolve upload dir: {}", error)))
}

fn infer_asset_type_from_content_type(content_type: &str) -> &'static str {
    if content_type.starts_with("image/") {
        "image"
    } else if content_type.starts_with("video/") {
        "video"
    } else if content_type.starts_with("audio/") {
        "audio"
    } else {
        "document"
    }
}

fn infer_content_type_by_extension(path: &StdPath) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn extract_local_upload_filename(asset_url: &str) -> Option<&str> {
    let filename = asset_url.strip_prefix(LOCAL_UPLOAD_URL_PREFIX)?;
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return None;
    }
    Some(filename)
}

async fn resolve_local_asset_path(state: &AppState, asset: &Asset) -> AppResult<PathBuf> {
    let filename = extract_local_upload_filename(&asset.url)
        .ok_or_else(|| AppError::NotFound("资产文件不存在或不是本地上传资源".into()))?;
    let mut roots = vec![resolve_upload_root(state).await?];
    if let Some(legacy_root) = resolve_legacy_upload_root().await {
        if legacy_root != roots[0] {
            roots.push(legacy_root);
        }
    }

    for root in roots {
        let candidate = root.join(filename);
        let canonical_path = match fs::canonicalize(&candidate).await {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(AppError::Internal(format!(
                    "Failed to resolve asset file path: {}",
                    error
                )))
            }
        };
        if !canonical_path.starts_with(&root) {
            return Err(AppError::Forbidden("非法的资产文件路径".into()));
        }
        return Ok(canonical_path);
    }

    Err(AppError::NotFound("资产文件不存在".into()))
}

async fn cleanup_local_asset_file(state: &AppState, asset: &Asset) -> AppResult<()> {
    let Some(filename) = extract_local_upload_filename(&asset.url) else {
        return Ok(());
    };
    let mut roots = vec![resolve_upload_root(state).await?];
    if let Some(legacy_root) = resolve_legacy_upload_root().await {
        if legacy_root != roots[0] {
            roots.push(legacy_root);
        }
    }

    for root in roots {
        let candidate = root.join(filename);
        let canonical_path = match fs::canonicalize(&candidate).await {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(AppError::Internal(format!(
                    "Failed to resolve asset cleanup path: {}",
                    error
                )))
            }
        };
        if !canonical_path.starts_with(&root) {
            return Err(AppError::Forbidden("非法的资产文件路径".into()));
        }
        fs::remove_file(canonical_path).await.map_err(|error| {
            AppError::Internal(format!("Failed to remove asset file: {}", error))
        })?;
        return Ok(());
    }

    Ok(())
}

async fn resolve_legacy_upload_root() -> Option<PathBuf> {
    fs::canonicalize("server/uploads").await.ok()
}

fn urlencoding_encode(input: &str) -> String {
    input
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric()
                || byte == b'-'
                || byte == b'_'
                || byte == b'~'
                || byte == b'.'
            {
                vec![byte]
            } else {
                format!("%{:02X}", byte).into_bytes()
            }
        })
        .map(|b| b as char)
        .collect()
}
