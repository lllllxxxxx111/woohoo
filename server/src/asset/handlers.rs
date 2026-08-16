use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Extension, Multipart, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::put,
    Json, Router,
};
use chrono::Utc;
use sha2::{Digest, Sha256};
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
        Asset, AssetDeleteBlockedResponse, AssetDeleteQuery, AssetReferencesResponse,
        AssetSearchQuery, AssetWithProject, CreateAssetReq, UpdateAssetReq, UpdateAssetTagsReq,
    },
    repo,
    upload_session::{
        self, CompleteResp, InitSessionReq, PartAck, SessionView, UploadPaths, UploadPolicy,
        DEFAULT_MAX_FILE_SIZE, MAX_CHUNK_SIZE,
    },
};

/// 分片上传 HTTP body 上限：单片最大 8MiB，留 1MiB 头部余量；
/// 超出由 `expected_part_size` 精确校验拒绝。
///
/// 分片 PUT 挂专用限流（1200 次/分钟）：大文件合规上传本身就需要成百上千个
/// 分片请求，走通用 100 次/分钟额度必然被 429 打断（全局限流已在中间件里
/// 豁免本路径，见 `middleware::should_skip_rate_limit`）。
pub fn chunk_upload_routes() -> Router<AppState> {
    let upload_rate_limiter = crate::middleware::create_upload_rate_limiter();
    Router::new().route(
        "/api/projects/{project_id}/uploads/{session_id}/parts/{part_number}",
        put(upload_part_bytes)
            .layer(DefaultBodyLimit::max(MAX_CHUNK_SIZE as usize + 1024 * 1024))
            .layer(axum::middleware::from_fn_with_state(
                upload_rate_limiter,
                crate::middleware::rate_limit_middleware,
            )),
    )
}

const LOCAL_UPLOAD_URL_PREFIX: &str = "/uploads/";

pub async fn upload_paths(state: &AppState) -> AppResult<UploadPaths> {
    fs::create_dir_all(&state.config.assets_dir)
        .await
        .map_err(|e| AppError::Internal(format!("create assets dir failed: {e}")))?;
    let assets_dir = fs::canonicalize(&state.config.assets_dir)
        .await
        .map_err(|e| AppError::Internal(format!("resolve assets dir failed: {e}")))?;
    fs::create_dir_all(&state.config.upload_tmp_dir)
        .await
        .map_err(|e| AppError::Internal(format!("create upload tmp dir failed: {e}")))?;
    let tmp_dir = fs::canonicalize(&state.config.upload_tmp_dir)
        .await
        .map_err(|e| AppError::Internal(format!("resolve upload tmp dir failed: {e}")))?;
    let mut paths = UploadPaths::new(assets_dir, tmp_dir);
    if let Some(legacy_root) = resolve_legacy_upload_root().await {
        paths = paths.with_fallback_asset_dir(legacy_root);
    }
    Ok(paths)
}

fn upload_policy(state: &AppState) -> UploadPolicy {
    UploadPolicy::production(state.config.upload_session_ttl_secs)
}

pub async fn list_assets(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Vec<Asset>>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let assets = repo::list_by_project(&state.db, &project_id).await?;
    Ok(Json(assets))
}

pub async fn search_assets(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(params): Query<AssetSearchQuery>,
) -> AppResult<Json<Vec<AssetWithProject>>> {
    if let Some(project_id) = &params.project_id {
        ensure_project_access(&state, &user_id.0, project_id).await?;
    }

    if let Some(asset_type) = params.asset_type.as_deref().map(str::trim) {
        match asset_type {
            "" | "image" | "video" | "audio" | "document" => {}
            _ => return Err(AppError::Validation("Unsupported asset type".into())),
        }
    }

    let assets = repo::search_assets(&state.db, &user_id.0, &params).await?;
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

    let metadata = req.metadata.map(|mut value| {
        // sizeBytes/sha256 等服务端专有键不接受客户端初始值（配额统计依赖它们）。
        repo::strip_server_owned_metadata_keys(&mut value);
        value.to_string()
    });
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

/* ───────────────────── 分片上传协议 ───────────────────── */

/// 初始化分片上传会话（幂等）。
pub async fn init_upload_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<InitSessionReq>,
) -> AppResult<(StatusCode, Json<SessionView>)> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let view = upload_session::init_session(
        &state.db,
        &upload_policy(&state),
        &user_id.0,
        &project_id,
        &req,
        Utc::now(),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(view)))
}

/// 查询会话状态与已上传分片（用于刷新后续传）。
pub async fn get_upload_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, session_id)): Path<(String, String)>,
) -> AppResult<Json<SessionView>> {
    let view =
        upload_session::get_session(&state.db, &user_id.0, &project_id, &session_id, Utc::now())
            .await?;
    Ok(Json(view))
}

/// 上传单个分片（原始字节流，幂等重传）。
pub async fn upload_part_bytes(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, session_id, part_number)): Path<(String, String, u32)>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<PartAck>> {
    let paths = upload_paths(&state).await?;
    let part_sha256 = headers
        .get("x-part-sha256")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let ack = upload_session::upload_part(
        &state.db,
        &paths,
        &user_id.0,
        &project_id,
        &session_id,
        part_number,
        &body,
        part_sha256.as_deref(),
        Utc::now(),
    )
    .await?;
    Ok(Json(ack))
}

/// 完成上传：合并、校验、原子入库。
pub async fn complete_upload_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, session_id)): Path<(String, String)>,
) -> AppResult<(StatusCode, Json<CompleteResp>)> {
    let paths = upload_paths(&state).await?;
    let outcome = upload_session::complete_session(
        &state.db,
        &paths,
        &upload_policy(&state),
        &user_id.0,
        &project_id,
        &session_id,
        Utc::now(),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(outcome)))
}

/// 取消上传会话并释放配额预留。
pub async fn abort_upload_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, session_id)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    let paths = upload_paths(&state).await?;
    upload_session::abort_session(&state.db, &paths, &user_id.0, &project_id, &session_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/* ───────────────── 旧 multipart 上传（保持兼容） ───────────────── */

pub async fn upload_asset(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<Asset>)> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;

    let upload_root = resolve_upload_root(&state).await?;
    let mut upload_result: Option<(String, String, String, usize, String)> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::Internal(format!("Multipart error: {}", error)))?
    {
        if field.name().unwrap_or_default() != "file" {
            continue;
        }

        let original_name = field.file_name().unwrap_or("unnamed").to_string();
        let safe_name = upload_session::sanitize_filename(&original_name);
        let file_ext = StdPath::new(&safe_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !upload_session::is_allowed_extension(&file_ext) {
            tracing::warn!(
                extension = %file_ext,
                user_id = %user_id.0,
                "上传被阻止：不允许的文件类型"
            );
            return Err(AppError::Validation(
                format!(
                    "不支持的文件类型: .{}，允许的类型: {}",
                    file_ext,
                    upload_session::ALLOWED_EXTENSIONS.join(", ")
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
                user_id = %user_id.0,
                "安全警告：检测到路径遍历尝试"
            );
            return Err(AppError::Validation("非法的文件路径".into()));
        }

        let mut output = fs::File::create(&saved_path).await.map_err(|error| {
            AppError::Internal(format!("Failed to create upload file: {}", error))
        })?;

        let mut file_size = 0usize;
        let mut hasher = Sha256::new();
        let mut file_field = field;
        loop {
            let chunk = match file_field.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(error) => {
                    drop(output);
                    let _ = fs::remove_file(&saved_path).await;
                    return Err(AppError::Internal(format!(
                        "Failed to read upload stream: {}",
                        error
                    )));
                }
            };
            hasher.update(&chunk);
            file_size = file_size.saturating_add(chunk.len());
            if file_size > DEFAULT_MAX_FILE_SIZE as usize {
                drop(output);
                let _ = fs::remove_file(&saved_path).await;
                return Err(AppError::Validation(
                    format!(
                        "文件大小无效或超过限制 (当前: {}字节, 最大: {}字节)",
                        file_size, DEFAULT_MAX_FILE_SIZE
                    )
                    .into(),
                ));
            }
            if let Err(error) = output.write_all(&chunk).await {
                drop(output);
                let _ = fs::remove_file(&saved_path).await;
                return Err(AppError::Internal(format!(
                    "Failed to write file: {}",
                    error
                )));
            }
        }
        if let Err(error) = output.flush().await {
            drop(output);
            let _ = fs::remove_file(&saved_path).await;
            return Err(AppError::Internal(format!(
                "Failed to flush file: {}",
                error
            )));
        }
        drop(output);

        if file_size == 0 || file_size > DEFAULT_MAX_FILE_SIZE as usize {
            let _ = fs::remove_file(&saved_path).await;
            return Err(AppError::Validation(
                format!(
                    "文件大小无效或超过限制 (当前: {}字节, 最大: {}字节)",
                    file_size, DEFAULT_MAX_FILE_SIZE
                )
                .into(),
            ));
        }

        let sha256 = format!("{:x}", hasher.finalize());
        upload_result = Some((safe_name, asset_type, saved_filename, file_size, sha256));
        break;
    }

    let (safe_name, asset_type, saved_filename, file_size, sha256) =
        upload_result.ok_or_else(|| AppError::Validation("No file provided".into()))?;

    // 配额事务 + 同用户内容去重 + 资产创建统一收口。
    let finalize = upload_session::finalize_legacy_upload(
        &state.db,
        &upload_paths(&state).await?,
        &upload_policy(&state),
        &user_id.0,
        &project_id,
        &safe_name,
        &asset_type,
        &saved_filename,
        file_size as u64,
        &sha256,
        Utc::now(),
    )
    .await;

    let (asset, deduplicated) = match finalize {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = fs::remove_file(upload_root.join(&saved_filename)).await;
            return Err(error);
        }
    };

    tracing::info!(
        asset_id = %asset.id,
        size_bytes = file_size,
        deduplicated,
        user_id = %user_id.0,
        "资产上传成功（multipart 兼容路径）"
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

    /*
     * 安全的 Content-Disposition 头
     * 使用 RFC 5987 编码的 filename* 防止 header injection
     */
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
    let metadata = if let Some(patch) = req.metadata {
        Some(repo::merge_metadata(current.metadata.as_deref(), &patch))
    } else {
        current.metadata
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

pub async fn update_asset_tags(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAssetTagsReq>,
) -> AppResult<Json<Asset>> {
    load_asset_owned(&state, &user_id.0, &id).await?;
    let asset = repo::update_asset_tags(&state.db, &id, &req.tags).await?;
    Ok(Json(asset))
}

pub async fn get_asset_references(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<AssetReferencesResponse>> {
    load_asset_owned(&state, &user_id.0, &id).await?;
    let references = repo::find_asset_references(&state.db, &id).await?;
    let total_count = references.len();

    Ok(Json(AssetReferencesResponse {
        asset_id: id,
        references,
        total_count,
        has_references: total_count > 0,
    }))
}

pub async fn delete_asset(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
    Query(query): Query<AssetDeleteQuery>,
) -> AppResult<Response> {
    let asset = load_asset_owned(&state, &user_id.0, &id).await?;
    let references = repo::find_asset_references(&state.db, &id).await?;
    let force = query.force.unwrap_or(false);

    if !references.is_empty() && !force {
        let blocked = AssetDeleteBlockedResponse {
            error: format!(
                "Asset '{}' is referenced in {} place(s). Remove references or retry with force=true.",
                asset.name,
                references.len()
            ),
            error_code: "ASSET_HAS_REFERENCES",
            reference_count: repo::count_asset_references(&state.db, &id).await? as usize,
            references,
        };
        return Ok((StatusCode::CONFLICT, Json(blocked)).into_response());
    }

    if force {
        sqlx::query("DELETE FROM storyboard_line_assets WHERE asset_id = ?")
            .bind(&id)
            .execute(&state.db)
            .await?;
    }

    // 引用计数式删除：共享物理文件只在最后一个资产删除时落盘清理。
    let paths = upload_paths(&state).await?;
    upload_session::release_asset_with_blob_refcount(&state.db, &paths, &asset).await?;

    Ok(StatusCode::NO_CONTENT.into_response())
}

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

async fn resolve_legacy_upload_root() -> Option<PathBuf> {
    fs::canonicalize("server/uploads").await.ok()
}

/**
 * URL 编码（RFC 3986 percent-encoding）
 * 用于 Content-Disposition header 中的 filename* 参数
 */
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
