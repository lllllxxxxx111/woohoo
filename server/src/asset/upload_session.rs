//! 分片上传会话核心逻辑。
//!
//! 设计原则：
//! - 本模块只依赖 `SqlitePool` 与文件系统路径，不依赖 `AppState`，便于在
//!   临时目录 + 临时 SQLite 上做完整的单元/集成测试。
//! - 所有“配额检查 + 状态变更”都在 `BEGIN IMMEDIATE` 事务内完成，SQLite
//!   的单写锁保证并发会话不可能同时突破配额。
//! - 物理文件按 `(SHA-256, 用户)` 内容寻址并做引用计数：同用户相同内容
//!   只存一份；不同用户之间互不共享，响应中也不透露他人物理文件信息。
//! - 分片先写临时目录，完成时校验大小与全文件 SHA-256；正式文件先在目标
//!   目录完成临时复制再原子改名，并在数据库提交前保留源文件以支持失败重试。

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use tokio::fs;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::model::Asset;

/* ───────────────────────── 协议常量 ───────────────────────── */

/// 与前端 `chunkedUpload.ts` 保持一致的分片规划常量。
pub const MIN_CHUNK_SIZE: u64 = 64 * 1024;
pub const MAX_CHUNK_SIZE: u64 = 8 * 1024 * 1024;
pub const MAX_TOTAL_CHUNKS: u32 = 10_000;

pub const DEFAULT_MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;
pub const DEFAULT_MAX_ASSETS_PER_PROJECT: u64 = 500;
pub const DEFAULT_MAX_USER_TOTAL_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// 允许上传的文件扩展名白名单（与旧 multipart 路径共用）。
pub const ALLOWED_EXTENSIONS: &[&str] = &[
    // 图片
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", // 视频
    "mp4", "webm", "mov", "avi", "mkv", // 音频
    "mp3", "wav", "ogg", "flac", "aac", // 文档
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv",
];

const MAX_FILENAME_LENGTH: usize = 100;
const MAX_ERROR_LENGTH: usize = 500;
const COMPLETION_LOCK_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/* ───────────────────────── 策略与路径 ───────────────────────── */

#[derive(Debug, Clone, Copy)]
pub struct UploadPolicy {
    pub max_file_size: u64,
    pub max_assets_per_project: u64,
    pub max_user_total_bytes: u64,
    pub ttl_secs: i64,
}

impl UploadPolicy {
    pub fn production(ttl_secs: i64) -> Self {
        Self {
            max_file_size: DEFAULT_MAX_FILE_SIZE,
            max_assets_per_project: DEFAULT_MAX_ASSETS_PER_PROJECT,
            max_user_total_bytes: DEFAULT_MAX_USER_TOTAL_BYTES,
            ttl_secs: ttl_secs.max(60),
        }
    }
}

#[derive(Debug, Clone)]
pub struct UploadPaths {
    pub assets_dir: PathBuf,
    pub tmp_dir: PathBuf,
    fallback_asset_dirs: Vec<PathBuf>,
}

struct CompletionLock {
    path: PathBuf,
}

impl Drop for CompletionLock {
    fn drop(&mut self) {
        // Drop 中不能 await；删除一个零字节锁文件是短小的本地操作。
        let _ = std::fs::remove_file(&self.path);
    }
}

impl UploadPaths {
    pub fn new(assets_dir: impl Into<PathBuf>, tmp_dir: impl Into<PathBuf>) -> Self {
        Self {
            assets_dir: assets_dir.into(),
            tmp_dir: tmp_dir.into(),
            fallback_asset_dirs: Vec::new(),
        }
    }

    pub fn with_fallback_asset_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        if dir != self.assets_dir && !self.fallback_asset_dirs.contains(&dir) {
            self.fallback_asset_dirs.push(dir);
        }
        self
    }

    pub async fn ensure(&self) -> AppResult<()> {
        fs::create_dir_all(&self.assets_dir)
            .await
            .map_err(|e| AppError::Internal(format!("create assets dir failed: {e}")))?;
        fs::create_dir_all(&self.tmp_dir)
            .await
            .map_err(|e| AppError::Internal(format!("create upload tmp dir failed: {e}")))?;
        Ok(())
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.tmp_dir.join(session_id)
    }

    fn part_path(&self, session_id: &str, part_number: u32) -> PathBuf {
        self.session_dir(session_id)
            .join(format!("part-{:06}", part_number))
    }

    fn merged_path(&self, session_id: &str) -> PathBuf {
        self.session_dir(session_id).join("__merged__")
    }

    pub(crate) fn asset_path(&self, stored_filename: &str) -> PathBuf {
        self.assets_dir.join(stored_filename)
    }

    fn asset_candidates(&self, stored_filename: &str) -> Vec<PathBuf> {
        std::iter::once(&self.assets_dir)
            .chain(self.fallback_asset_dirs.iter())
            .map(|root| root.join(stored_filename))
            .collect()
    }
}

async fn acquire_completion_lock(
    paths: &UploadPaths,
    session_id: &str,
) -> AppResult<CompletionLock> {
    let path = paths.session_dir(session_id).join("__complete_lock__");
    // 锁文件写入持有者令牌并回读校验：stale 清理者可能在我们 create_new 成功
    // 之后删除的是“别人刚重建的新锁”，令牌不一致即说明锁已易主，必须让位。
    // 最终的并发安全由 finalize 事务内的状态复查兜底。
    let token = Uuid::new_v4().to_string();
    for attempt in 0..2 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(mut file) => {
                use tokio::io::AsyncWriteExt;
                if let Err(error) = file.write_all(token.as_bytes()).await {
                    let _ = fs::remove_file(&path).await;
                    return Err(AppError::Internal(format!(
                        "write upload completion lock failed: {error}"
                    )));
                }
                drop(file);
                match fs::read_to_string(&path).await {
                    Ok(content) if content == token => return Ok(CompletionLock { path }),
                    Ok(_) => {
                        // 文件已被他人重建，当前持有者不是我们；不能删除它。
                        return Err(AppError::Conflict(
                            "上传会话正在完成，请稍后重试".into(),
                        ));
                    }
                    Err(_) => {
                        // 锁文件已消失（被 stale 清理者移除），视为竞争失败。
                        return Err(AppError::Conflict(
                            "上传会话正在完成，请稍后重试".into(),
                        ));
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                let stale = fs::metadata(&path)
                    .await
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age >= COMPLETION_LOCK_STALE_AFTER);
                if stale {
                    let _ = fs::remove_file(&path).await;
                    continue;
                }
                return Err(AppError::Conflict("上传会话正在完成，请稍后重试".into()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(AppError::Conflict("上传会话正在完成，请稍后重试".into()));
            }
            Err(error) => {
                return Err(AppError::Internal(format!(
                    "create upload completion lock failed: {error}"
                )));
            }
        }
    }

    Err(AppError::Conflict("上传会话正在完成，请稍后重试".into()))
}

/* ───────────────────────── 协议模型 ───────────────────────── */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitSessionReq {
    pub filename: String,
    pub file_size: u64,
    #[serde(default)]
    pub mime_type: Option<String>,
    pub chunk_size: u64,
    pub total_chunks: u32,
    #[serde(default)]
    pub file_sha256: Option<String>,
    #[serde(default)]
    pub client_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub session_id: String,
    pub project_id: String,
    pub filename: String,
    pub file_size: u64,
    pub mime_type: String,
    pub chunk_size: u64,
    pub total_chunks: u32,
    pub file_sha256: String,
    pub status: String,
    pub bytes_received: u64,
    pub received_part_numbers: Vec<u32>,
    pub asset_id: Option<String>,
    pub expires_at: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartAck {
    pub session_id: String,
    pub part_number: u32,
    pub size_bytes: u64,
    pub bytes_received: u64,
    pub received_part_numbers: Vec<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteResp {
    pub session: SessionView,
    pub asset: Asset,
    pub deduplicated: bool,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub expired_sessions: usize,
    pub removed_session_dirs: usize,
    pub removed_orphan_dirs: usize,
    pub pruned_terminal_sessions: usize,
    pub pruned_part_rows: usize,
}

#[derive(Debug, sqlx::FromRow)]
struct SessionRow {
    id: String,
    user_id: String,
    project_id: String,
    filename: String,
    file_size: i64,
    mime_type: String,
    chunk_size: i64,
    total_chunks: i64,
    file_sha256: String,
    status: String,
    bytes_received: i64,
    asset_id: Option<String>,
    last_error: String,
    expires_at: String,
    created_at: String,
}

/* ───────────────────────── 纯函数校验 ───────────────────────── */

/// 清理用户提供的文件名：只保留白名单字符，杜绝路径遍历。
pub fn sanitize_filename(raw_name: &str) -> String {
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

pub fn is_allowed_extension(extension: &str) -> bool {
    ALLOWED_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}

pub fn is_valid_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn expected_part_size(
    file_size: u64,
    chunk_size: u64,
    total_chunks: u32,
    part_number: u32,
) -> u64 {
    if part_number >= total_chunks {
        file_size.saturating_sub((total_chunks as u64 - 1) * chunk_size)
    } else {
        chunk_size
    }
}

/// 校验初始化请求的分片规划与文件元信息，返回 (安全文件名, 小写扩展名)。
pub fn validate_init_request(
    req: &InitSessionReq,
    policy: &UploadPolicy,
) -> AppResult<(String, String)> {
    let safe_name = sanitize_filename(&req.filename);
    let ext = Path::new(&safe_name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !is_allowed_extension(&ext) {
        return Err(AppError::Validation(format!("不支持的文件类型: .{}", ext)));
    }

    if req.file_size == 0 || req.file_size > policy.max_file_size {
        return Err(AppError::Validation(format!(
            "文件大小无效或超过限制 (最大 {} 字节)",
            policy.max_file_size
        )));
    }

    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&req.chunk_size) {
        return Err(AppError::Validation(format!(
            "分片大小必须在 {} 到 {} 字节之间",
            MIN_CHUNK_SIZE, MAX_CHUNK_SIZE
        )));
    }

    if req.total_chunks == 0 || req.total_chunks > MAX_TOTAL_CHUNKS {
        return Err(AppError::Validation("分片数量非法".into()));
    }

    let computed = req.file_size.div_ceil(req.chunk_size) as u32;
    if computed != req.total_chunks {
        return Err(AppError::Validation(format!(
            "分片规划不一致：按大小与分片大小应为 {} 片",
            computed
        )));
    }

    let sha = req
        .file_sha256
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !is_valid_sha256_hex(&sha) {
        return Err(AppError::Validation(
            "初始化必须提供 64 位十六进制文件 SHA-256 指纹".into(),
        ));
    }

    Ok((safe_name, ext))
}

/* ───────────────────────── 会话生命周期 ───────────────────────── */

/// 初始化分片上传会话（幂等）。
///
/// 同一 `clientToken` 的重复请求直接返回既有会话；内容去重只发生在 complete
/// 的物理 blob 层，不影响会话生命周期。配额检查与插入在同一个 IMMEDIATE
/// 事务内完成。
#[allow(clippy::too_many_arguments)]
pub async fn init_session(
    pool: &SqlitePool,
    policy: &UploadPolicy,
    user_id: &str,
    project_id: &str,
    req: &InitSessionReq,
    now: DateTime<Utc>,
) -> AppResult<SessionView> {
    let (safe_name, _ext) = validate_init_request(req, policy)?;
    let sha = req
        .file_sha256
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let client_token = req.client_token.as_deref().unwrap_or("").trim().to_string();
    let mime_type = req
        .mime_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".into());
    let expires_at = now + Duration::seconds(policy.ttl_secs);
    let now_text = now.to_rfc3339();

    // 幂等快路径：同 clientToken 的活跃会话直接复用。
    if let Some(existing) = find_reusable_active_session(
        pool,
        user_id,
        project_id,
        &sha,
        req.file_size,
        req.chunk_size,
        req.total_chunks,
        &client_token,
        &now_text,
    )
    .await?
    {
        return session_view(pool, &existing).await;
    }

    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let tx_result: AppResult<String> = async {
        // 过期会话不再占用预留，也不能继续命中 clientToken 幂等键。
        sqlx::query(
            "UPDATE upload_sessions
             SET status = 'expired', updated_at = ?
             WHERE status IN ('initiated', 'uploading') AND expires_at <= ?",
        )
        .bind(&now_text)
        .bind(&now_text)
        .execute(&mut *conn)
        .await?;

        // 事务内先查幂等键，再计算配额。并发重复 init 若已被前一个请求创建，
        // 不应把同一会话的预留再次计入并误报超额。
        if let Some(existing) = find_reusable_active_session_with_conn(
            &mut conn,
            user_id,
            project_id,
            &sha,
            req.file_size,
            req.chunk_size,
            req.total_chunks,
            &client_token,
            &now_text,
        )
        .await?
        {
            return Ok(existing.id);
        }

        // 与 verify_quota_with_conn 相同：MAX(...) 钳制负的 sizeBytes 脏数据。
        let used_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(MAX(CAST(json_extract(a.metadata, '$.sizeBytes') AS INTEGER), 0)), 0)
             FROM assets a
             JOIN projects p ON a.project_id = p.id
             WHERE p.user_id = ?",
        )
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await?;

        let reserved_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(file_size), 0)
             FROM upload_sessions
             WHERE user_id = ? AND status IN ('initiated', 'uploading')",
        )
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await?;

        if used_bytes as u64 + reserved_bytes as u64 + req.file_size > policy.max_user_total_bytes {
            return Err(AppError::Validation(
                "存储空间不足：用户总容量已达上限，请清理后重试".into(),
            ));
        }

        let project_asset_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM assets WHERE project_id = ?")
                .bind(project_id)
                .fetch_one(&mut *conn)
                .await?;
        let project_reserved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM upload_sessions
             WHERE project_id = ? AND status IN ('initiated', 'uploading')",
        )
        .bind(project_id)
        .fetch_one(&mut *conn)
        .await?;

        if project_asset_count as u64 + project_reserved as u64 >= policy.max_assets_per_project {
            return Err(AppError::Validation(format!(
                "项目资产数量已达上限 ({})，请清理后重试",
                policy.max_assets_per_project
            )));
        }

        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO upload_sessions
                (id, user_id, project_id, filename, file_size, mime_type,
                 chunk_size, total_chunks, file_sha256, client_token,
                 status, bytes_received, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initiated', 0, ?, ?, ?)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(project_id)
        .bind(&safe_name)
        .bind(req.file_size as i64)
        .bind(&mime_type)
        .bind(req.chunk_size as i64)
        .bind(req.total_chunks as i64)
        .bind(&sha)
        .bind(&client_token)
        .bind(expires_at.to_rfc3339())
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&mut *conn)
        .await?;

        Ok(id)
    }
    .await;

    let session_id = match tx_result {
        Ok(id) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            drop(conn);
            id
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    };

    let row = find_session_by_id(pool, &session_id)
        .await?
        .ok_or_else(|| AppError::Internal("session vanished after insert".into()))?;
    session_view(pool, &row).await
}

/// 查询会话状态与已上传分片（含所有权校验；惰性过期）。
pub async fn get_session(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    session_id: &str,
    now: DateTime<Utc>,
) -> AppResult<SessionView> {
    let row = load_owned_session(pool, user_id, project_id, session_id).await?;
    if is_active(&row.status) && row.expires_at <= now.to_rfc3339() {
        mark_expired(pool, session_id).await?;
        return Err(AppError::NotFound("上传会话已过期".into()));
    }
    session_view(pool, &row).await
}

/// 接收单个分片：校验编号/范围/大小/可选哈希，原子落盘，幂等 UPSERT。
pub async fn upload_part(
    pool: &SqlitePool,
    paths: &UploadPaths,
    user_id: &str,
    project_id: &str,
    session_id: &str,
    part_number: u32,
    data: &[u8],
    part_sha256: Option<&str>,
    now: DateTime<Utc>,
) -> AppResult<PartAck> {
    let row = load_owned_session(pool, user_id, project_id, session_id).await?;

    if row.status == "completed" {
        return Err(AppError::Conflict("上传会话已完成".into()));
    }
    if !is_active(&row.status) {
        return Err(AppError::Conflict(format!(
            "上传会话状态为 {}，无法继续上传分片",
            row.status
        )));
    }
    if row.expires_at <= now.to_rfc3339() {
        mark_expired(pool, session_id).await?;
        return Err(AppError::NotFound("上传会话已过期".into()));
    }

    let total = row.total_chunks as u32;
    let chunk_size = row.chunk_size as u64;
    let file_size = row.file_size as u64;
    if part_number == 0 || part_number > total {
        return Err(AppError::Validation(format!(
            "分片编号越界：{part_number}，合法范围 1..={total}"
        )));
    }

    let expected = expected_part_size(file_size, chunk_size, total, part_number);
    if data.len() as u64 != expected {
        return Err(AppError::Validation(format!(
            "分片 {} 大小错误：收到 {} 字节，应为 {} 字节",
            part_number,
            data.len(),
            expected
        )));
    }

    if let Some(part_hash) = part_sha256 {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let actual = hex_encode(&hasher.finalize());
        if actual != part_hash.trim().to_lowercase() {
            return Err(AppError::Validation(format!(
                "分片 {part_number} 哈希校验失败"
            )));
        }
    }

    // 原子写入：先写临时文件再 rename，避免崩溃/并发留下半个分片。
    paths.ensure().await?;
    let dir = paths.session_dir(session_id);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Internal(format!("create session tmp dir failed: {e}")))?;
    let final_path = paths.part_path(session_id, part_number);
    let staging_path = dir.join(format!(
        "part-{:06}.staging-{}",
        part_number,
        Uuid::new_v4()
    ));
    fs::write(&staging_path, data)
        .await
        .map_err(|e| AppError::Internal(format!("write part failed: {e}")))?;
    if let Err(error) = fs::rename(&staging_path, &final_path).await {
        let _ = fs::remove_file(&staging_path).await;
        return Err(AppError::Internal(format!("finalize part failed: {error}")));
    }

    let part_hash = part_sha256.unwrap_or("").trim().to_lowercase();
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let result: AppResult<()> = async {
        // 上面的状态校验与这里之间存在多个 await（哈希、落盘）；迟到/重复的
        // 分片请求必须在写事务内复查状态，否则会把 completed/aborted 会话
        // 复活成 uploading，导致配额被双倍占用、幂等 complete 失效。
        let current_status: String = sqlx::query_scalar("SELECT status FROM upload_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(&mut *conn)
            .await?;
        if !is_active(&current_status) {
            return Err(AppError::Conflict(format!(
                "上传会话状态为 {current_status}，无法继续上传分片"
            )));
        }

        sqlx::query(
            "INSERT INTO upload_session_parts (session_id, part_number, size_bytes, sha256)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id, part_number) DO UPDATE SET
                size_bytes = excluded.size_bytes,
                sha256 = excluded.sha256",
        )
        .bind(session_id)
        .bind(part_number as i64)
        .bind(data.len() as i64)
        .bind(&part_hash)
        .execute(&mut *conn)
        .await?;

        let received: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM upload_session_parts WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_one(&mut *conn)
        .await?;

        sqlx::query(
            "UPDATE upload_sessions
             SET bytes_received = ?, status = 'uploading', updated_at = ?
             WHERE id = ? AND status IN ('initiated', 'uploading')",
        )
        .bind(received)
        .bind(now.to_rfc3339())
        .bind(session_id)
        .execute(&mut *conn)
        .await?;
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            drop(conn);
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    }

    let ack_parts = list_received_parts(pool, session_id).await?;
    let received_bytes: i64 =
        sqlx::query_scalar("SELECT bytes_received FROM upload_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(pool)
            .await?;

    Ok(PartAck {
        session_id: session_id.to_string(),
        part_number,
        size_bytes: data.len() as u64,
        bytes_received: received_bytes as u64,
        received_part_numbers: ack_parts,
    })
}

/// 完成上传：校验分片齐全 → 顺序合并 → 校验总大小与 SHA-256 →
/// 原子移动到正式目录 → 事务内创建资产与物理文件引用计数。
pub async fn complete_session(
    pool: &SqlitePool,
    paths: &UploadPaths,
    policy: &UploadPolicy,
    user_id: &str,
    project_id: &str,
    session_id: &str,
    now: DateTime<Utc>,
) -> AppResult<CompleteResp> {
    let row = load_owned_session(pool, user_id, project_id, session_id).await?;

    // 幂等：已完成会话直接返回既有资产，绝不重复建资产记录。
    if row.status == "completed" {
        let asset = load_completed_asset(pool, &row).await?;
        let view = session_view(pool, &row).await?;
        return Ok(CompleteResp {
            session: view,
            asset,
            deduplicated: false,
        });
    }
    if !is_active(&row.status) {
        return Err(AppError::Conflict(format!(
            "上传会话状态为 {}，无法完成",
            row.status
        )));
    }
    if row.expires_at <= now.to_rfc3339() {
        mark_expired(pool, session_id).await?;
        return Err(AppError::NotFound("上传会话已过期".into()));
    }

    let total = row.total_chunks as u32;
    let chunk_size = row.chunk_size as u64;
    let file_size = row.file_size as u64;

    let received = list_received_parts(pool, session_id).await?;
    if received.len() as u32 != total {
        return Err(AppError::Validation(format!(
            "分片不完整：已接收 {}/{}，请续传缺失分片后再完成",
            received.len(),
            total
        )));
    }
    for index in 1..=total {
        if !received.contains(&index) {
            return Err(AppError::Validation(format!("缺失分片 {index}")));
        }
        let part_path = paths.part_path(session_id, index);
        let metadata = fs::metadata(&part_path).await.map_err(|_| {
            AppError::Validation(format!("分片 {index} 的临时文件丢失，请重新上传该分片"))
        })?;
        let expected = expected_part_size(file_size, chunk_size, total, index);
        if metadata.len() != expected {
            return Err(AppError::Validation(format!(
                "分片 {index} 临时文件大小异常，请重新上传该分片"
            )));
        }
    }

    // 同一会话的 complete 必须串行：否则两个请求会同时截断/写入同一个
    // merged 文件，并可能重复创建逻辑资产。锁文件使用 create_new 原子抢占，
    // 对同机多进程同样有效；调用结束或异常展开时由 Drop 自动释放。
    let _completion_lock = acquire_completion_lock(paths, session_id).await?;

    // 拿到锁后重读会话：上面的状态/完整性校验发生在锁之前，期间可能已有
    // 并发请求完成了同一会话（其收尾会删除分片文件）。不重读会导致本请求
    // 对已删除的分片做合并，最后还把 completed 覆写成 failed。
    let row = load_owned_session(pool, user_id, project_id, session_id).await?;
    if row.status == "completed" {
        let asset = load_completed_asset(pool, &row).await?;
        let view = session_view(pool, &row).await?;
        return Ok(CompleteResp {
            session: view,
            asset,
            deduplicated: false,
        });
    }
    if !is_active(&row.status) {
        return Err(AppError::Conflict(format!(
            "上传会话状态为 {}，无法完成",
            row.status
        )));
    }
    if row.expires_at <= now.to_rfc3339() {
        mark_expired(pool, session_id).await?;
        return Err(AppError::NotFound("上传会话已过期".into()));
    }

    // 顺序合并并计算最终哈希（合并中间态仍在临时目录）。
    paths.ensure().await?;
    let merged_path = paths.merged_path(session_id);
    let merge_result =
        merge_and_verify(paths, session_id, total, file_size, &row.file_sha256).await;
    if let Err(error) = merge_result {
        let _ = fs::remove_file(&merged_path).await;
        if let Err(mark_error) = mark_failed(pool, session_id, &error_message(&error)).await {
            tracing::warn!(error = %mark_error, "标记失败会话状态时出错");
        }
        return Err(error);
    }

    let ext = Path::new(&row.filename)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    let asset_type = infer_asset_type(&row.mime_type);

    // 配额复核 + 资产创建 + 引用计数，单事务收口。
    let outcome = finalize_completed_session(
        pool,
        paths,
        policy,
        &row,
        &merged_path,
        &ext,
        asset_type,
        now,
    )
    .await;

    match &outcome {
        Ok(_) => {
            // 成功后清理会话临时目录与分片行（行保留短期幂等用途）。
            remove_session_dir(paths, session_id).await;
            if let Err(error) = delete_session_parts(pool, session_id).await {
                tracing::warn!(error = %error, "清理已完成会话的分片行失败");
            }
        }
        Err(error) => {
            // 最终落盘或数据库收口失败通常是可恢复的瞬时错误。保留分片与
            // merged 文件、维持 active 状态，客户端可直接重试 complete。
            if let Err(record_error) =
                record_retryable_error(pool, session_id, &error_message(error)).await
            {
                tracing::warn!(error = %record_error, "记录可重试上传错误时出错");
            }
        }
    }

    outcome
}

/// 取消会话：幂等；释放配额预留（状态变更即释放）并清理临时分片。
pub async fn abort_session(
    pool: &SqlitePool,
    paths: &UploadPaths,
    user_id: &str,
    project_id: &str,
    session_id: &str,
) -> AppResult<()> {
    let row = load_owned_session(pool, user_id, project_id, session_id).await?;
    if row.status == "completed" {
        return Err(AppError::Conflict("已完成的上传会话不能取消".into()));
    }
    if row.status != "aborted" {
        // 仅允许从活跃态迁移到 aborted；rows_affected == 0 说明读取之后有并发
        // 请求把会话推入了终态（典型：complete 刚提交）。
        let updated = sqlx::query(
            "UPDATE upload_sessions SET status = 'aborted', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
             WHERE id = ? AND status IN ('initiated', 'uploading')",
        )
        .bind(session_id)
        .execute(pool)
        .await?;
        if updated.rows_affected() == 0 {
            let fresh = load_owned_session(pool, user_id, project_id, session_id).await?;
            if fresh.status == "completed" {
                return Err(AppError::Conflict("已完成的上传会话不能取消".into()));
            }
        }
    }
    remove_session_dir(paths, session_id).await;
    if let Err(error) = delete_session_parts(pool, session_id).await {
        tracing::warn!(error = %error, "清理已取消会话的分片行失败");
    }
    Ok(())
}

/// 删除某个会话的全部分片行。终态会话的 parts 行没有读取方。
async fn delete_session_parts(pool: &SqlitePool, session_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM upload_session_parts WHERE session_id = ?")
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 单次清理：过期会话、终态会话行与孤儿临时目录。
///
/// 不依赖任何常驻外部进程；服务启动时与后台定时任务都会调用。
pub async fn cleanup_expired(
    pool: &SqlitePool,
    paths: &UploadPaths,
    now: DateTime<Utc>,
) -> AppResult<CleanupReport> {
    let mut report = CleanupReport::default();

    // 1. 活跃但已过期的会话 → 标记 expired 并删除其临时目录。
    let expired_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM upload_sessions
         WHERE status IN ('initiated', 'uploading') AND expires_at <= ?",
    )
    .bind(now.to_rfc3339())
    .fetch_all(pool)
    .await?;

    for id in &expired_ids {
        mark_expired(pool, id).await?;
        remove_session_dir(paths, id).await;
        report.expired_sessions += 1;
        report.removed_session_dirs += 1;
    }

    // 2. 所有终态会话的临时目录都没有续传价值（失败/取消/完成/过期），
    //    统一清理磁盘残留；行保留短期幂等/审计用途。
    let terminal_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM upload_sessions
         WHERE status IN ('completed', 'aborted', 'failed', 'expired')",
    )
    .fetch_all(pool)
    .await?;
    for id in &terminal_ids {
        remove_session_dir(paths, id).await;
    }

    // 2b. 终态会话的 parts 行已无读取方（续传只面向活跃会话），及时删除，
    //     防止 upload_session_parts 随时间无限膨胀（每会话可达数百行）。
    let removed_parts = sqlx::query(
        "DELETE FROM upload_session_parts
         WHERE session_id IN (
             SELECT id FROM upload_sessions
             WHERE status IN ('completed', 'aborted', 'failed', 'expired')
         )",
    )
    .execute(pool)
    .await?
    .rows_affected();
    if removed_parts > 0 {
        report.pruned_part_rows = removed_parts as usize;
    }

    // 3. 清理一天前的终态会话行（completed 行只用于短期幂等返回）。
    let cutoff = (now - Duration::seconds(86_400)).to_rfc3339();
    let pruned = sqlx::query(
        "DELETE FROM upload_sessions
         WHERE status IN ('completed', 'aborted', 'expired', 'failed') AND updated_at < ?",
    )
    .bind(cutoff)
    .execute(pool)
    .await?
    .rows_affected();
    report.pruned_terminal_sessions = pruned as usize;

    // 4. 孤儿临时目录：名字不在会话表里的目录一律清理
    //    （覆盖进程崩溃 / 手动删库等异常路径）。
    if let Ok(mut entries) = fs::read_dir(&paths.tmp_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
                continue;
            };
            let exists: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM upload_sessions WHERE id = ?")
                    .bind(name)
                    .fetch_one(pool)
                    .await
                    .unwrap_or(0);
            if exists == 0 {
                if fs::remove_dir_all(&path).await.is_ok() {
                    report.removed_orphan_dirs += 1;
                }
            }
        }
    }

    // 5. 正式资产目录中残留的 .upload-*.tmp：finalize 在“复制完成、改名前/
    //    提交前”崩溃时留下。改名窗口只有毫秒级，超过 1 小时的必然是残留。
    sweep_stale_upload_tmp_files(&paths.assets_dir).await;

    if report.expired_sessions > 0 || report.removed_orphan_dirs > 0 {
        tracing::info!(
            expired_sessions = report.expired_sessions,
            removed_orphan_dirs = report.removed_orphan_dirs,
            pruned_terminal_sessions = report.pruned_terminal_sessions,
            pruned_part_rows = report.pruned_part_rows,
            "分片上传清理完成"
        );
    }
    Ok(report)
}

/// 删除资产目录中超过 1 小时的 `.upload-*.tmp` 暂存文件（finalize 崩溃残留）。
async fn sweep_stale_upload_tmp_files(assets_dir: &Path) {
    const TMP_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(3600);
    let Ok(mut entries) = fs::read_dir(assets_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if !(name.starts_with(".upload-") && name.ends_with(".tmp")) {
            continue;
        }
        let stale = entry
            .metadata()
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= TMP_STALE_AFTER);
        if stale {
            let _ = fs::remove_file(&path).await;
        }
    }
}

/// 启动进程内清理任务：启动时先跑一次，之后每小时一次。
///
/// 不依赖任何常驻外部服务；清理逻辑本身就是 `cleanup_expired`，
/// 也可以被测试/运维脚本单独调用。
pub fn start_cleanup_worker(pool: SqlitePool, paths: UploadPaths) {
    tokio::spawn(async move {
        if let Err(error) = cleanup_expired(&pool, &paths, Utc::now()).await {
            tracing::warn!(error = %error, "启动时清理过期上传会话失败");
        }

        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = cleanup_expired(&pool, &paths, Utc::now()).await {
                tracing::warn!(error = %error, "定时清理过期上传会话失败");
            }
        }
    });
}

/* ─────────────── 旧 multipart 路径复用：去重 + 配额事务 ─────────────── */

/// 旧 multipart 上传落盘后的统一收口：
/// 在 IMMEDIATE 事务内做配额复核、同用户内容去重与资产创建。
///
/// - 若该用户已有相同 SHA-256 的物理文件，删除本次新文件、复用既有文件；
/// - 否则为本次文件登记引用计数。
/// 返回创建好的资产与是否命中去重。
pub async fn finalize_legacy_upload(
    pool: &SqlitePool,
    paths: &UploadPaths,
    policy: &UploadPolicy,
    user_id: &str,
    project_id: &str,
    safe_name: &str,
    asset_type: &str,
    stored_filename: &str,
    file_size: u64,
    sha256: &str,
    now: DateTime<Utc>,
) -> AppResult<(Asset, bool)> {
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let result: AppResult<(Asset, bool, bool)> = async {
        verify_quota_with_conn(&mut conn, policy, user_id, project_id, file_size, None).await?;

        let existing: Option<(String,)> = sqlx::query_as(
            "SELECT stored_filename FROM asset_blobs
             WHERE sha256 = ? AND user_id = ? AND ref_count > 0",
        )
        .bind(sha256)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;

        let (url, deduplicated, should_remove_new_file) =
            if let Some((existing_filename,)) = existing {
                sqlx::query(
                    "UPDATE asset_blobs SET ref_count = ref_count + 1
                 WHERE sha256 = ? AND user_id = ?",
                )
                .bind(sha256)
                .bind(user_id)
                .execute(&mut *conn)
                .await?;
                (format!("/uploads/{existing_filename}"), true, true)
            } else {
                sqlx::query(
                "INSERT INTO asset_blobs (sha256, user_id, stored_filename, size_bytes, ref_count)
                 VALUES (?, ?, ?, ?, 1)",
            )
            .bind(sha256)
            .bind(user_id)
            .bind(stored_filename)
            .bind(file_size as i64)
            .execute(&mut *conn)
            .await?;
                (format!("/uploads/{stored_filename}"), false, false)
            };

        let metadata = serde_json::json!({
            "sizeBytes": file_size,
            "uploadedAt": now.to_rfc3339(),
            "contentSha256": sha256,
            "deduplicated": deduplicated,
            "chunked": false,
        })
        .to_string();

        let asset = insert_asset_with_conn(
            &mut conn, project_id, safe_name, asset_type, &url, &metadata,
        )
        .await?;

        Ok((asset, deduplicated, should_remove_new_file))
    }
    .await;

    match result {
        Ok((asset, deduplicated, should_remove_new_file)) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            drop(conn);
            if should_remove_new_file {
                // 命中同用户去重：删除本次新落盘的物理文件，只保留被复用的那份。
                let redundant = paths.asset_path(stored_filename);
                match fs::remove_file(&redundant).await {
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => tracing::warn!(error = %error, "去重后清理冗余物理文件失败"),
                }
            }
            Ok((asset, deduplicated))
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

/// 删除资产时释放物理文件引用：事务内删除资产行并递减引用计数，
/// 仅当计数归零时才在事务外真正删除物理文件。
///
/// 这样同一用户的多个资产共享一份物理文件时，删除其中一个不会影响其他资产。
pub async fn release_asset_with_blob_refcount(
    pool: &SqlitePool,
    paths: &UploadPaths,
    asset: &Asset,
) -> AppResult<()> {
    let Some(stored_filename) = extract_local_filename(&asset.url) else {
        // 非本地上传资源：直接删除资产行即可。
        sqlx::query("DELETE FROM assets WHERE id = ?")
            .bind(&asset.id)
            .execute(pool)
            .await?;
        return Ok(());
    };

    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let result: AppResult<Option<String>> = async {
        sqlx::query("DELETE FROM assets WHERE id = ?")
            .bind(&asset.id)
            .execute(&mut *conn)
            .await?;

        let blob: Option<(i64,)> =
            sqlx::query_as("SELECT ref_count FROM asset_blobs WHERE stored_filename = ?")
                .bind(stored_filename)
                .fetch_optional(&mut *conn)
                .await?;

        let mut file_to_remove: Option<String> = None;
        if let Some((ref_count,)) = blob {
            let next = ref_count - 1;
            if next <= 0 {
                sqlx::query("DELETE FROM asset_blobs WHERE stored_filename = ?")
                    .bind(stored_filename)
                    .execute(&mut *conn)
                    .await?;
                file_to_remove = Some(stored_filename.to_string());
            } else {
                sqlx::query("UPDATE asset_blobs SET ref_count = ? WHERE stored_filename = ?")
                    .bind(next)
                    .bind(stored_filename)
                    .execute(&mut *conn)
                    .await?;
            }
        } else {
            // 旧版资产（feature 上线前上传，无 blob 登记）：保持旧行为，直接删文件。
            file_to_remove = Some(stored_filename.to_string());
        }
        Ok(file_to_remove)
    }
    .await;

    let file_to_remove = match result {
        Ok(value) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            value
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    };

    if let Some(filename) = file_to_remove {
        for path in paths.asset_candidates(&filename) {
            match fs::remove_file(&path).await {
                Ok(_) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    tracing::warn!(error = %error, "释放资产物理文件失败");
                    break;
                }
            }
        }
    }
    Ok(())
}

/* ───────────────────────── 内部实现 ───────────────────────── */

fn is_active(status: &str) -> bool {
    matches!(status, "initiated" | "uploading")
}

fn infer_asset_type(mime_type: &str) -> &'static str {
    if mime_type.starts_with("image/") {
        "image"
    } else if mime_type.starts_with("video/") {
        "video"
    } else if mime_type.starts_with("audio/") {
        "audio"
    } else {
        "document"
    }
}

fn extract_local_filename(asset_url: &str) -> Option<&str> {
    let filename = asset_url.strip_prefix("/uploads/")?;
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return None;
    }
    Some(filename)
}

fn error_message(error: &AppError) -> String {
    let message = error.to_string();
    message.chars().take(MAX_ERROR_LENGTH).collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

async fn find_session_by_id(pool: &SqlitePool, id: &str) -> AppResult<Option<SessionRow>> {
    sqlx::query_as::<_, SessionRow>("SELECT * FROM upload_sessions WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

async fn load_owned_session(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    session_id: &str,
) -> AppResult<SessionRow> {
    let row = find_session_by_id(pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound("上传会话不存在".into()))?;
    // 统一返回 NotFound：不向其他用户泄露会话是否存在。
    if row.user_id != user_id || row.project_id != project_id {
        return Err(AppError::NotFound("上传会话不存在".into()));
    }
    Ok(row)
}

async fn list_received_parts(pool: &SqlitePool, session_id: &str) -> AppResult<Vec<u32>> {
    let numbers: Vec<i64> = sqlx::query_scalar(
        "SELECT part_number FROM upload_session_parts WHERE session_id = ? ORDER BY part_number",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(numbers.into_iter().map(|v| v as u32).collect())
}

async fn session_view(pool: &SqlitePool, row: &SessionRow) -> AppResult<SessionView> {
    let parts = list_received_parts(pool, &row.id).await?;
    Ok(SessionView {
        session_id: row.id.clone(),
        project_id: row.project_id.clone(),
        filename: row.filename.clone(),
        file_size: row.file_size as u64,
        mime_type: row.mime_type.clone(),
        chunk_size: row.chunk_size as u64,
        total_chunks: row.total_chunks as u32,
        file_sha256: row.file_sha256.clone(),
        status: row.status.clone(),
        bytes_received: row.bytes_received as u64,
        received_part_numbers: parts,
        asset_id: row.asset_id.clone(),
        expires_at: row.expires_at.clone(),
        created_at: row.created_at.clone(),
    })
}

async fn find_reusable_active_session(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    sha256: &str,
    file_size: u64,
    chunk_size: u64,
    total_chunks: u32,
    client_token: &str,
    active_after: &str,
) -> AppResult<Option<SessionRow>> {
    let mut conn = pool.acquire().await?;
    find_reusable_active_session_with_conn(
        &mut conn,
        user_id,
        project_id,
        sha256,
        file_size,
        chunk_size,
        total_chunks,
        client_token,
        active_after,
    )
    .await
}

async fn find_reusable_active_session_with_conn(
    conn: &mut sqlx::SqliteConnection,
    user_id: &str,
    project_id: &str,
    sha256: &str,
    file_size: u64,
    chunk_size: u64,
    total_chunks: u32,
    client_token: &str,
    active_after: &str,
) -> AppResult<Option<SessionRow>> {
    // 仅按 clientToken 做会话级幂等复用；内容去重统一在 complete 的 blob 层处理，
    // 避免用户有意重复上传相同文件时被错误合并成一个会话。
    if client_token.is_empty() {
        return Ok(None);
    }
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM upload_sessions
         WHERE user_id = ? AND project_id = ? AND client_token = ?
           AND status IN ('initiated', 'uploading') AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(user_id)
    .bind(project_id)
    .bind(client_token)
    .bind(active_after)
    .fetch_optional(&mut *conn)
    .await?;

    if let Some(existing) = row.as_ref() {
        if existing.file_sha256 != sha256
            || existing.file_size as u64 != file_size
            || existing.chunk_size as u64 != chunk_size
            || existing.total_chunks as u32 != total_chunks
        {
            return Err(AppError::Conflict(
                "clientToken 已用于另一份文件或分片规划".into(),
            ));
        }
    }

    Ok(row)
}

async fn verify_quota_with_conn(
    conn: &mut sqlx::SqliteConnection,
    policy: &UploadPolicy,
    user_id: &str,
    project_id: &str,
    file_size: u64,
    exclude_session_id: Option<&str>,
) -> AppResult<()> {
    // MAX(...) 钳制负值：历史脏数据里若存在负的 sizeBytes，直接 as u64 会变成
    // 极大数把用户永久锁死（配额校验永远不过）。
    let used_bytes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(MAX(CAST(json_extract(a.metadata, '$.sizeBytes') AS INTEGER), 0)), 0)
         FROM assets a JOIN projects p ON a.project_id = p.id
         WHERE p.user_id = ?",
    )
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await?;

    // 完成阶段当前会话自身的预留即将转为实际占用，必须从“其他预留”中排除，
    // 否则同一文件会被计算两次。
    let reserved_bytes: i64 = if let Some(exclude_id) = exclude_session_id {
        sqlx::query_scalar(
            "SELECT COALESCE(SUM(file_size), 0) FROM upload_sessions
             WHERE user_id = ? AND status IN ('initiated', 'uploading') AND id <> ?",
        )
        .bind(user_id)
        .bind(exclude_id)
        .fetch_one(&mut *conn)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT COALESCE(SUM(file_size), 0) FROM upload_sessions
             WHERE user_id = ? AND status IN ('initiated', 'uploading')",
        )
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await?
    };

    if used_bytes as u64 + reserved_bytes as u64 + file_size > policy.max_user_total_bytes {
        return Err(AppError::Validation(
            "存储空间不足：用户总容量已达上限，请清理后重试".into(),
        ));
    }

    let project_asset_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM assets WHERE project_id = ?")
            .bind(project_id)
            .fetch_one(&mut *conn)
            .await?;
    let project_reserved: i64 = if let Some(exclude_id) = exclude_session_id {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM upload_sessions
             WHERE project_id = ? AND status IN ('initiated', 'uploading') AND id <> ?",
        )
        .bind(project_id)
        .bind(exclude_id)
        .fetch_one(&mut *conn)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM upload_sessions
             WHERE project_id = ? AND status IN ('initiated', 'uploading')",
        )
        .bind(project_id)
        .fetch_one(&mut *conn)
        .await?
    };

    if project_asset_count as u64 + project_reserved as u64 >= policy.max_assets_per_project {
        return Err(AppError::Validation(format!(
            "项目资产数量已达上限 ({})，请清理后重试",
            policy.max_assets_per_project
        )));
    }
    Ok(())
}

async fn insert_asset_with_conn(
    conn: &mut sqlx::SqliteConnection,
    project_id: &str,
    name: &str,
    asset_type: &str,
    url: &str,
    metadata: &str,
) -> AppResult<Asset> {
    let id = Uuid::new_v4().to_string();
    let asset = sqlx::query_as::<_, Asset>(
        "INSERT INTO assets (id, project_id, name, asset_type, url, metadata)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&id)
    .bind(project_id)
    .bind(name)
    .bind(asset_type)
    .bind(url)
    .bind(metadata)
    .fetch_one(&mut *conn)
    .await?;
    Ok(asset)
}

async fn merge_and_verify(
    paths: &UploadPaths,
    session_id: &str,
    total: u32,
    file_size: u64,
    expected_sha256: &str,
) -> AppResult<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let merged_path = paths.merged_path(session_id);
    let mut written: u64 = 0;
    {
        let mut output = fs::File::create(&merged_path)
            .await
            .map_err(|e| AppError::Internal(format!("create merged file failed: {e}")))?;
        for part_number in 1..=total {
            let part_path = paths.part_path(session_id, part_number);
            let mut input = fs::File::open(&part_path)
                .await
                .map_err(|_| AppError::Validation(format!("分片 {part_number} 读取失败")))?;
            let copied = tokio::io::copy(&mut input, &mut output)
                .await
                .map_err(|e| AppError::Internal(format!("merge copy failed: {e}")))?;
            written = written.saturating_add(copied);
        }
        output.flush().await.ok();
    }

    // 重新顺序读一遍合并文件计算全文件哈希（合并中间态仍在临时目录）。
    let mut input = fs::File::open(&merged_path)
        .await
        .map_err(|e| AppError::Internal(format!("reopen merged file failed: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let read = input
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Internal(format!("hash read failed: {e}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }

    if written != file_size {
        return Err(AppError::Validation(format!(
            "文件合并后大小不匹配：期望 {file_size} 字节，实际 {written} 字节"
        )));
    }
    let actual = hex_encode(&hasher.finalize());
    if actual != expected_sha256.trim().to_lowercase() {
        return Err(AppError::Validation(
            "文件 SHA-256 校验失败：内容与初始化时声明的指纹不一致".into(),
        ));
    }
    Ok(())
}

async fn finalize_completed_session(
    pool: &SqlitePool,
    paths: &UploadPaths,
    policy: &UploadPolicy,
    row: &SessionRow,
    merged_path: &Path,
    ext: &str,
    asset_type: &str,
    now: DateTime<Utc>,
) -> AppResult<CompleteResp> {
    let file_size = row.file_size as u64;
    let user_id = row.user_id.clone();
    let project_id = row.project_id.clone();
    let session_id = row.id.clone();

    // 文件复制（可达几十 MB 的 fs::copy）在打开写事务之前完成：BEGIN IMMEDIATE
    // 持有 SQLite 全库写锁，锁内拷贝会把期间所有并发写（包括其他用户的每个
    // 分片事务）全部阻塞，而 busy_timeout 只有 5 秒。复制先落到目标目录中的
    // 临时名，事务内只做同目录原子 rename 与 SQL，耗时与锁持有时间都可忽略。
    let staged = stage_upload_in_assets_dir(paths, merged_path).await?;

    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    // 新物理文件会在事务提交前落到正式目录；若后续 SQL 或 COMMIT 失败，
    // 必须删除它，同时保留 merged_path 与全部分片供客户端直接重试 complete。
    let mut placed_target: Option<PathBuf> = None;
    let result: AppResult<(Asset, bool, Option<PathBuf>)> = async {
        // 事务内复查会话状态：完成锁的 stale-break 竞态理论上可能让两个
        // finalize 并行推进，这里保证只有第一个能把活跃会话推进到 completed，
        // 不会出现双份资产 / 引用计数被加两次。
        let status: String =
            sqlx::query_scalar("SELECT status FROM upload_sessions WHERE id = ?")
                .bind(&session_id)
                .fetch_one(&mut *conn)
                .await?;
        if !is_active(&status) {
            return Err(AppError::Conflict(format!(
                "上传会话状态为 {status}，无法完成"
            )));
        }

        verify_quota_with_conn(
            &mut conn,
            policy,
            &user_id,
            &project_id,
            file_size,
            Some(&session_id),
        )
        .await?;

        let existing: Option<(String,)> = sqlx::query_as(
            "SELECT stored_filename FROM asset_blobs
             WHERE sha256 = ? AND user_id = ? AND ref_count > 0",
        )
        .bind(&row.file_sha256)
        .bind(&user_id)
        .fetch_optional(&mut *conn)
        .await?;

        let (url, deduplicated, staging_to_remove) = if let Some((existing_filename,)) = existing {
            // 同用户同内容：复用物理文件，引用计数 +1。预复制的 staged 文件
            // 已无用处，提交后删除；会话目录（含 merged）由调用方统一清理。
            sqlx::query(
                "UPDATE asset_blobs SET ref_count = ref_count + 1
                 WHERE sha256 = ? AND user_id = ?",
            )
            .bind(&row.file_sha256)
            .bind(&user_id)
            .execute(&mut *conn)
            .await?;
            (
                format!("/uploads/{existing_filename}"),
                true,
                Some(staged.to_path_buf()),
            )
        } else {
            // 新内容：staged 与目标在同一目录，rename 原子且瞬时。数据库提交
            // 失败时回滚目标文件，会话保持 active，客户端可直接重试 complete。
            let stored_filename = format!("{}.{}", Uuid::new_v4(), ext);
            let target = paths.asset_path(&stored_filename);
            if let Err(error) = fs::rename(&staged, &target).await {
                return Err(AppError::Internal(format!(
                    "finalize upload target failed: {error}"
                )));
            }
            placed_target = Some(target);
            sqlx::query(
                "INSERT INTO asset_blobs (sha256, user_id, stored_filename, size_bytes, ref_count)
                 VALUES (?, ?, ?, ?, 1)",
            )
            .bind(&row.file_sha256)
            .bind(&user_id)
            .bind(&stored_filename)
            .bind(row.file_size)
            .execute(&mut *conn)
            .await?;
            (format!("/uploads/{stored_filename}"), false, None)
        };

        let metadata = serde_json::json!({
            "sizeBytes": file_size,
            "uploadedAt": now.to_rfc3339(),
            "contentSha256": row.file_sha256,
            "deduplicated": deduplicated,
            "chunked": true,
        })
        .to_string();

        let asset = insert_asset_with_conn(
            &mut conn,
            &project_id,
            &row.filename,
            asset_type,
            &url,
            &metadata,
        )
        .await?;

        let completed = sqlx::query(
            "UPDATE upload_sessions
             SET status = 'completed', asset_id = ?, completed_at = ?, updated_at = ?
             WHERE id = ? AND status IN ('initiated', 'uploading')",
        )
        .bind(&asset.id)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .bind(&session_id)
        .execute(&mut *conn)
        .await?;
        if completed.rows_affected() == 0 {
            return Err(AppError::Conflict(
                "上传会话状态已变更，无法完成".into(),
            ));
        }

        Ok((asset, deduplicated, staging_to_remove))
    }
    .await;

    let (asset, deduplicated, staging_to_remove) = match result {
        Ok(value) => match sqlx::query("COMMIT").execute(&mut *conn).await {
            Ok(_) => {
                drop(conn);
                value
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                drop(conn);
                if let Some(target) = placed_target.as_deref() {
                    let _ = fs::remove_file(target).await;
                }
                let _ = fs::remove_file(&staged).await;
                return Err(error.into());
            }
        },
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            drop(conn);
            if let Some(target) = placed_target.as_deref() {
                let _ = fs::remove_file(target).await;
            }
            let _ = fs::remove_file(&staged).await;
            return Err(error);
        }
    };

    if let Some(path) = staging_to_remove {
        let _ = fs::remove_file(path).await;
    }

    let updated = find_session_by_id(pool, &session_id)
        .await?
        .ok_or_else(|| AppError::Internal("session vanished after complete".into()))?;
    let view = session_view(pool, &updated).await?;

    Ok(CompleteResp {
        session: view,
        asset,
        deduplicated,
    })
}

/// 将已校验的合并文件复制到正式资产目录中的临时名（`.upload-{uuid}.tmp`）。
/// 复制过程不持有任何数据库事务；调用方在事务内把它原子 rename 成最终文件。
/// 复制完成后校验字节数，防止半截文件进入 rename 阶段。
async fn stage_upload_in_assets_dir(paths: &UploadPaths, from: &Path) -> AppResult<PathBuf> {
    fs::create_dir_all(&paths.assets_dir)
        .await
        .map_err(|e| AppError::Internal(format!("create assets dir failed: {e}")))?;

    let staging = paths
        .assets_dir
        .join(format!(".upload-{}.tmp", Uuid::new_v4()));
    let copied = match fs::copy(from, &staging).await {
        Ok(copied) => copied,
        Err(error) => {
            let _ = fs::remove_file(&staging).await;
            return Err(AppError::Internal(format!(
                "copy upload into target directory failed: {error}"
            )));
        }
    };
    let expected = fs::metadata(from)
        .await
        .map_err(|e| AppError::Internal(format!("read upload source metadata failed: {e}")))?
        .len();
    if copied != expected {
        let _ = fs::remove_file(&staging).await;
        return Err(AppError::Internal(format!(
            "copy upload into target directory was incomplete: expected {expected}, copied {copied}"
        )));
    }
    Ok(staging)
}

async fn mark_expired(pool: &SqlitePool, session_id: &str) -> AppResult<()> {
    // 仅从活跃态迁移：并发 complete 刚提交的 completed 会话不允许被改写，
    // 否则资产已建好而会话却显示 expired，幂等 complete 会被永久破坏。
    sqlx::query("UPDATE upload_sessions SET status = 'expired', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND status IN ('initiated', 'uploading')")
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn mark_failed(pool: &SqlitePool, session_id: &str, reason: &str) -> AppResult<()> {
    // 同 mark_expired：终态不可逆，failed 不能覆盖 completed/aborted/expired。
    sqlx::query("UPDATE upload_sessions SET status = 'failed', last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND status IN ('initiated', 'uploading')")
        .bind(reason)
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn record_retryable_error(
    pool: &SqlitePool,
    session_id: &str,
    reason: &str,
) -> AppResult<()> {
    let message: String = reason.chars().take(MAX_ERROR_LENGTH).collect();
    sqlx::query(
        "UPDATE upload_sessions
         SET last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND status IN ('initiated', 'uploading')",
    )
    .bind(message)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn remove_session_dir(paths: &UploadPaths, session_id: &str) {
    let dir = paths.session_dir(session_id);
    match fs::remove_dir_all(&dir).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            // 仅记录会话标识与错误类别，不输出本机绝对路径。
            tracing::warn!(session_id, error = %error, "清理上传会话临时目录失败");
        }
    }
}

async fn load_completed_asset(pool: &SqlitePool, row: &SessionRow) -> AppResult<Asset> {
    let asset_id = row
        .asset_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("completed session missing asset".into()))?;
    sqlx::query_as::<_, Asset>("SELECT * FROM assets WHERE id = ?")
        .bind(asset_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("资产不存在".into()))
}

/* ───────────────────────── 测试 ───────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    fn test_policy() -> UploadPolicy {
        UploadPolicy {
            max_file_size: 1024 * 1024,
            max_assets_per_project: 5,
            max_user_total_bytes: 10 * 1024 * 1024,
            ttl_secs: 3600,
        }
    }

    async fn test_harness() -> (SqlitePool, UploadPaths, String, String, PathBuf, PathBuf) {
        let db_path = std::env::temp_dir().join(format!("woohoo-upload-{}.sqlite", Uuid::new_v4()));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
        let options = SqliteConnectOptions::from_str(&database_url)
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        crate::db::run_schema_migrations(&pool).await.unwrap();

        let root = std::env::temp_dir().join(format!("woohoo-upload-test-{}", Uuid::new_v4()));
        let assets_dir = root.join("assets");
        let tmp_dir = root.join("tmp");
        fs::create_dir_all(&assets_dir).await.unwrap();
        fs::create_dir_all(&tmp_dir).await.unwrap();
        let paths = UploadPaths::new(assets_dir.clone(), tmp_dir.clone());

        let user_id = "user-1".to_string();
        sqlx::query("INSERT INTO users (id, username, email, password_hash, created_at, updated_at)
                     VALUES ('user-1', 'tester', 't@example.com', 'x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();
        let project_id = "project-1".to_string();
        sqlx::query("INSERT INTO projects (id, user_id, name, status, phase, created_at, updated_at)
                     VALUES ('project-1', 'user-1', 'Test', 'draft', 'ideation', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();

        (pool, paths, user_id, project_id, assets_dir, root)
    }

    fn sha256_hex(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex_encode(&hasher.finalize())
    }

    fn init_req(content: &[u8], chunk_size: u64) -> InitSessionReq {
        InitSessionReq {
            filename: "report.txt".into(),
            file_size: content.len() as u64,
            mime_type: Some("text/plain".into()),
            chunk_size,
            total_chunks: content.len().div_ceil(chunk_size as usize) as u32,
            file_sha256: Some(sha256_hex(content)),
            client_token: Some(Uuid::new_v4().to_string()),
        }
    }

    fn chunks<'a>(content: &'a [u8], chunk_size: u64) -> Vec<&'a [u8]> {
        let size = chunk_size as usize;
        content.chunks(size).collect()
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-12T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn expected_part_size_covers_remainder() {
        assert_eq!(expected_part_size(100, 30, 4, 1), 30);
        assert_eq!(expected_part_size(100, 30, 4, 4), 10);
        assert_eq!(expected_part_size(90, 30, 3, 3), 30);
    }

    #[tokio::test]
    async fn completion_lock_serializes_same_session_and_releases_on_drop() {
        let root = std::env::temp_dir().join(format!("woohoo-upload-lock-{}", Uuid::new_v4()));
        let paths = UploadPaths::new(root.join("assets"), root.join("tmp"));
        paths.ensure().await.unwrap();
        let session_id = "session-lock-test";
        fs::create_dir_all(paths.session_dir(session_id))
            .await
            .unwrap();

        let first = acquire_completion_lock(&paths, session_id).await.unwrap();
        let concurrent = acquire_completion_lock(&paths, session_id).await;
        assert!(matches!(concurrent, Err(AppError::Conflict(_))));

        drop(first);
        let after_release = acquire_completion_lock(&paths, session_id).await;
        assert!(after_release.is_ok());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn validate_rejects_bad_extension_and_plan() {
        let policy = test_policy();
        let bad_ext = InitSessionReq {
            filename: "evil.exe".into(),
            file_size: 100,
            mime_type: None,
            chunk_size: MIN_CHUNK_SIZE,
            total_chunks: 1,
            file_sha256: Some("a".repeat(64)),
            client_token: None,
        };
        assert!(validate_init_request(&bad_ext, &policy).is_err());

        let mismatch = InitSessionReq {
            filename: "ok.txt".into(),
            file_size: 100,
            mime_type: None,
            chunk_size: MIN_CHUNK_SIZE,
            total_chunks: 2, // 实际只需 1 片
            file_sha256: Some("a".repeat(64)),
            client_token: None,
        };
        assert!(validate_init_request(&mismatch, &policy).is_err());

        let bad_hash = InitSessionReq {
            filename: "ok.txt".into(),
            file_size: 100,
            mime_type: None,
            chunk_size: MIN_CHUNK_SIZE,
            total_chunks: 1,
            file_sha256: Some("xyz".into()),
            client_token: None,
        };
        assert!(validate_init_request(&bad_hash, &policy).is_err());
    }

    #[tokio::test]
    async fn full_chunked_lifecycle_completes_and_verifies_content() {
        let (pool, paths, user, project, assets_dir, root) = test_harness().await;
        let content = b"hello woohoo chunked upload!".repeat(10_000); // 280KB
        let chunk_size = 64 * 1024;
        let req = init_req(&content, chunk_size);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        assert_eq!(view.status, "initiated");
        assert_eq!(
            view.total_chunks as usize,
            chunks(&content, chunk_size).len()
        );

        let parts = chunks(&content, chunk_size);
        for (index, data) in parts.iter().enumerate() {
            let ack = upload_part(
                &pool,
                &paths,
                &user,
                &project,
                &view.session_id,
                index as u32 + 1,
                data,
                Some(&sha256_hex(data)),
                now(),
            )
            .await
            .unwrap();
            assert_eq!(ack.size_bytes, data.len() as u64);
        }

        let outcome = complete_session(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            &view.session_id,
            now(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.asset.name, "report.txt");
        let stored = assets_dir.read_dir().unwrap().count();
        assert_eq!(stored, 1, "正式目录应只有一份物理文件");
        assert!(
            !paths.session_dir(&view.session_id).exists(),
            "临时目录应被清理"
        );

        // 物理文件内容必须与上传内容逐字节一致。
        let filename = extract_local_filename(&outcome.asset.url).unwrap();
        let saved = std::fs::read(assets_dir.join(filename)).unwrap();
        assert_eq!(saved, content);

        // 资产元数据记录大小与指纹。
        let metadata: serde_json::Value =
            serde_json::from_str(outcome.asset.metadata.as_deref().unwrap()).unwrap();
        assert_eq!(metadata["sizeBytes"], content.len() as u64);
        assert_eq!(metadata["contentSha256"], sha256_hex(&content));

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn finalization_db_failure_keeps_session_retryable_without_leaking_target_file() {
        let (pool, paths, user, project, assets_dir, root) = test_harness().await;
        let content = b"retryable finalization".repeat(12_000);
        let chunk_size = 64 * 1024;
        let req = init_req(&content, chunk_size);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();

        for (index, data) in chunks(&content, chunk_size).iter().enumerate() {
            upload_part(
                &pool,
                &paths,
                &user,
                &project,
                &view.session_id,
                index as u32 + 1,
                data,
                None,
                now(),
            )
            .await
            .unwrap();
        }

        // 强制在物理文件已复制、blob 已插入之后让资产 INSERT 失败，覆盖
        // “文件系统成功但数据库事务失败”的关键恢复路径。
        sqlx::query(
            "CREATE TRIGGER fail_chunked_asset_insert
             BEFORE INSERT ON assets
             BEGIN
               SELECT RAISE(ABORT, 'forced asset insert failure');
             END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let first = complete_session(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            &view.session_id,
            now(),
        )
        .await;
        assert!(first.is_err());
        assert_eq!(
            assets_dir.read_dir().unwrap().count(),
            0,
            "事务失败时不得泄漏正式文件或目标目录临时文件"
        );
        assert!(
            paths.merged_path(&view.session_id).exists(),
            "数据库失败后应保留已校验合并文件供重试"
        );

        let row = find_session_by_id(&pool, &view.session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "uploading", "可恢复错误不应终结会话");
        assert!(!row.last_error.is_empty());
        let blob_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM asset_blobs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(blob_count, 0, "失败事务中的 blob 记录必须回滚");

        sqlx::query("DROP TRIGGER fail_chunked_asset_insert")
            .execute(&pool)
            .await
            .unwrap();
        let retried = complete_session(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            &view.session_id,
            now(),
        )
        .await
        .unwrap();
        assert_eq!(retried.session.status, "completed");
        assert_eq!(assets_dir.read_dir().unwrap().count(), 1);
        assert!(!paths.session_dir(&view.session_id).exists());

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn duplicate_part_upload_is_idempotent() {
        let (pool, paths, user, project, _a, root) = test_harness().await;
        let content = vec![7u8; 200_000];
        let req = init_req(&content, 64 * 1024);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        let parts = chunks(&content, 64 * 1024);

        let ack1 = upload_part(
            &pool,
            &paths,
            &user,
            &project,
            &view.session_id,
            1,
            parts[0],
            None,
            now(),
        )
        .await
        .unwrap();
        let ack2 = upload_part(
            &pool,
            &paths,
            &user,
            &project,
            &view.session_id,
            1,
            parts[0],
            None,
            now(),
        )
        .await
        .unwrap();
        assert_eq!(ack1.bytes_received, ack2.bytes_received);
        assert_eq!(ack2.received_part_numbers, vec![1]);

        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM upload_session_parts WHERE session_id = ?")
                .bind(&view.session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn wrong_part_size_and_bad_part_hash_are_rejected() {
        let (pool, paths, user, project, _a, root) = test_harness().await;
        let content = vec![3u8; 200_000];
        let req = init_req(&content, 64 * 1024);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();

        let wrong_size = upload_part(
            &pool,
            &paths,
            &user,
            &project,
            &view.session_id,
            1,
            &[1u8; 10],
            None,
            now(),
        )
        .await;
        assert!(wrong_size.is_err());

        let parts = chunks(&content, 64 * 1024);
        let bad_hash = upload_part(
            &pool,
            &paths,
            &user,
            &project,
            &view.session_id,
            1,
            parts[0],
            Some(&"f".repeat(64)),
            now(),
        )
        .await;
        assert!(bad_hash.is_err());

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn out_of_order_parts_then_complete_succeeds() {
        let (pool, paths, user, project, _a, root) = test_harness().await;
        let content = b"out-of-order".repeat(20_000);
        let req = init_req(&content, 64 * 1024);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        let parts = chunks(&content, 64 * 1024);

        for index in (0..parts.len()).rev() {
            upload_part(
                &pool,
                &paths,
                &user,
                &project,
                &view.session_id,
                index as u32 + 1,
                parts[index],
                None,
                now(),
            )
            .await
            .unwrap();
        }

        let outcome = complete_session(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            &view.session_id,
            now(),
        )
        .await
        .unwrap();
        assert_eq!(outcome.session.status, "completed");
        assert_eq!(outcome.session.received_part_numbers.len(), parts.len());

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn complete_with_missing_parts_fails_without_asset() {
        let (pool, paths, user, project, assets_dir, root) = test_harness().await;
        let content = vec![9u8; 200_000];
        let req = init_req(&content, 64 * 1024);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        let parts = chunks(&content, 64 * 1024);
        upload_part(
            &pool,
            &paths,
            &user,
            &project,
            &view.session_id,
            1,
            parts[0],
            None,
            now(),
        )
        .await
        .unwrap();

        let result = complete_session(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            &view.session_id,
            now(),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            assets_dir.read_dir().unwrap().count(),
            0,
            "缺片时不得产生正式文件"
        );

        let row = find_session_by_id(&pool, &view.session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "uploading", "缺片失败不应污染会话状态");

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn final_hash_mismatch_marks_failed_and_leaves_no_file() {
        let (pool, paths, user, project, assets_dir, root) = test_harness().await;
        let content = vec![1u8; 200_000];
        let mut req = init_req(&content, 64 * 1024);
        // 谎报文件指纹。
        req.file_sha256 = Some("f".repeat(64));
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        let parts = chunks(&content, 64 * 1024);
        for (index, data) in parts.iter().enumerate() {
            upload_part(
                &pool,
                &paths,
                &user,
                &project,
                &view.session_id,
                index as u32 + 1,
                data,
                None,
                now(),
            )
            .await
            .unwrap();
        }

        let result = complete_session(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            &view.session_id,
            now(),
        )
        .await;
        assert!(matches!(result, Err(AppError::Validation(_))));
        assert_eq!(assets_dir.read_dir().unwrap().count(), 0);

        let row = find_session_by_id(&pool, &view.session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "failed");
        assert!(!row.last_error.is_empty());
        // 失败会话的临时目录保留分片以便排查，但 merged 中间态必须删除。
        assert!(!paths.merged_path(&view.session_id).exists());

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn abort_releases_reservation_and_removes_tmp() {
        let (pool, paths, user, project, _a, root) = test_harness().await;
        let content = vec![2u8; 200_000];
        let req = init_req(&content, 64 * 1024);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        let parts = chunks(&content, 64 * 1024);
        upload_part(
            &pool,
            &paths,
            &user,
            &project,
            &view.session_id,
            1,
            parts[0],
            None,
            now(),
        )
        .await
        .unwrap();

        abort_session(&pool, &paths, &user, &project, &view.session_id)
            .await
            .unwrap();
        assert!(!paths.session_dir(&view.session_id).exists());

        let (reserved,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM upload_sessions
             WHERE user_id = ? AND status IN ('initiated','uploading')",
        )
        .bind(&user)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(reserved, 0, "取消后配额预留必须释放");

        // 再次取消仍然成功（幂等）。
        abort_session(&pool, &paths, &user, &project, &view.session_id)
            .await
            .unwrap();

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn quota_reservation_blocks_concurrent_oversubscription() {
        let (pool, _paths, user, project, _a, root) = test_harness().await;
        // 用户总容量收紧到 100_000，专门验证预留竞态。
        let policy = UploadPolicy {
            max_user_total_bytes: 100_000,
            ..test_policy()
        };
        let content = vec![4u8; 60_000];

        let req1 = init_req(&content, MIN_CHUNK_SIZE);
        let req2 = init_req(&content, MIN_CHUNK_SIZE);
        let _first = init_session(&pool, &policy, &user, &project, &req1, now())
            .await
            .unwrap();
        // 第二个 60KB 会话：已用 0 + 预留 60_000 + 60_000 > 100_000 → 拒绝。
        let second = init_session(&pool, &policy, &user, &project, &req2, now()).await;
        assert!(matches!(second, Err(AppError::Validation(_))));

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn other_user_cannot_access_session() {
        let (pool, _paths, user, project, _a, root) = test_harness().await;
        let content = vec![5u8; 200_000];
        let req = init_req(&content, 64 * 1024);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();

        sqlx::query("INSERT INTO users (id, username, email, password_hash, created_at, updated_at)
                     VALUES ('user-2', 'other', 'o@example.com', 'x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO projects (id, user_id, name, status, phase, created_at, updated_at)
                     VALUES ('project-2', 'user-2', 'Other', 'draft', 'ideation', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .execute(&pool).await.unwrap();

        let result = get_session(&pool, "user-2", "project-2", &view.session_id, now()).await;
        assert!(matches!(result, Err(AppError::NotFound(_))));

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn same_user_dedup_shares_physical_file_until_last_asset_deleted() {
        let (pool, paths, user, project, assets_dir, root) = test_harness().await;
        let content = b"same content".repeat(10_000);

        // 第一次分片上传。
        let req1 = init_req(&content, 64 * 1024);
        let view1 = init_session(&pool, &test_policy(), &user, &project, &req1, now())
            .await
            .unwrap();
        let parts1 = chunks(&content, 64 * 1024);
        for (index, data) in parts1.iter().enumerate() {
            upload_part(
                &pool,
                &paths,
                &user,
                &project,
                &view1.session_id,
                index as u32 + 1,
                data,
                None,
                now(),
            )
            .await
            .unwrap();
        }
        let first = complete_session(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            &view1.session_id,
            now(),
        )
        .await
        .unwrap();
        assert!(!first.deduplicated);

        // 第二次上传完全相同内容（走旧 multipart 收口路径模拟另一入口）。
        let (second_asset, deduplicated) = finalize_legacy_upload(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            "copy.txt",
            "document",
            "new-uuid-file.txt",
            content.len() as u64,
            &sha256_hex(&content),
            now(),
        )
        .await
        .unwrap();
        assert!(deduplicated);
        assert_eq!(second_asset.url, first.asset.url, "应复用同一物理文件");
        assert_eq!(
            assets_dir.read_dir().unwrap().count(),
            1,
            "物理文件只有一份"
        );

        // 删除第一个资产：文件必须保留（仍被第二个资产引用）。
        let first_asset = first.asset;
        release_asset_with_blob_refcount(&pool, &paths, &first_asset)
            .await
            .unwrap();
        let filename = extract_local_filename(&second_asset.url).unwrap();
        assert!(
            assets_dir.join(filename).exists(),
            "引用未清零时文件不能删除"
        );

        // 删除最后一个资产：文件才真正释放。
        release_asset_with_blob_refcount(&pool, &paths, &second_asset)
            .await
            .unwrap();
        assert!(
            !assets_dir.join(filename).exists(),
            "引用清零后物理文件应删除"
        );

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn cleanup_removes_expired_sessions_and_orphan_dirs() {
        let (pool, paths, user, project, _a, root) = test_harness().await;
        let content = vec![6u8; 200_000];
        let req = init_req(&content, 64 * 1024);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        let parts = chunks(&content, 64 * 1024);
        upload_part(
            &pool,
            &paths,
            &user,
            &project,
            &view.session_id,
            1,
            parts[0],
            None,
            now(),
        )
        .await
        .unwrap();
        assert!(paths.session_dir(&view.session_id).exists());

        // 伪造一个孤儿临时目录。
        let orphan = paths.tmp_dir.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&orphan).await.unwrap();

        let future = now() + Duration::seconds(7200);
        let report = cleanup_expired(&pool, &paths, future).await.unwrap();
        assert_eq!(report.expired_sessions, 1);
        assert_eq!(report.removed_orphan_dirs, 1);
        assert!(!paths.session_dir(&view.session_id).exists());

        let (reserved,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM upload_sessions
             WHERE user_id = ? AND status IN ('initiated','uploading')",
        )
        .bind(&user)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(reserved, 0, "过期清理必须释放配额预留");

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn cleanup_removes_terminal_session_dirs() {
        let (pool, paths, user, project, _a, root) = test_harness().await;
        // 构造一个失败会话并落一个分片目录。
        let content = vec![6u8; 200_000];
        let req = init_req(&content, 64 * 1024);
        let view = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        let parts = chunks(&content, 64 * 1024);
        upload_part(
            &pool,
            &paths,
            &user,
            &project,
            &view.session_id,
            1,
            parts[0],
            None,
            now(),
        )
        .await
        .unwrap();
        mark_failed(&pool, &view.session_id, "test failure")
            .await
            .unwrap();
        assert!(paths.session_dir(&view.session_id).exists());

        let report = cleanup_expired(&pool, &paths, now()).await.unwrap();
        assert!(
            !paths.session_dir(&view.session_id).exists(),
            "终态会话目录应被清理"
        );
        assert_eq!(report.pruned_terminal_sessions, 0, "行仍保留用于审计");

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn legacy_finalize_creates_fresh_blob_and_asset() {
        let (pool, paths, user, project, assets_dir, root) = test_harness().await;
        let content = b"legacy multipart content".repeat(1000);
        let sha = sha256_hex(&content);
        // 先把物理文件放到正式目录（模拟 multipart 流式落盘）。
        let stored = "legacy-uuid.txt".to_string();
        std::fs::write(assets_dir.join(&stored), &content).unwrap();

        let (asset, deduplicated) = finalize_legacy_upload(
            &pool,
            &paths,
            &test_policy(),
            &user,
            &project,
            "old.txt",
            "document",
            &stored,
            content.len() as u64,
            &sha,
            now(),
        )
        .await
        .unwrap();

        assert!(!deduplicated);
        assert_eq!(asset.url, format!("/uploads/{stored}"));
        assert!(assets_dir.join(&stored).exists(), "非去重时保留物理文件");

        // 删除后引用归零，文件被清理。
        release_asset_with_blob_refcount(&pool, &paths, &asset)
            .await
            .unwrap();
        assert!(!assets_dir.join(&stored).exists());

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn deleting_pre_feature_asset_cleans_legacy_fallback_directory() {
        let (pool, paths, _user, project, _assets_dir, root) = test_harness().await;
        let legacy_dir = root.join("legacy-uploads");
        fs::create_dir_all(&legacy_dir).await.unwrap();
        let filename = "legacy-only.txt";
        fs::write(legacy_dir.join(filename), b"legacy content")
            .await
            .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        let asset = insert_asset_with_conn(
            &mut conn,
            &project,
            "legacy.txt",
            "document",
            &format!("/uploads/{filename}"),
            "{}",
        )
        .await
        .unwrap();
        drop(conn);

        let paths = paths.with_fallback_asset_dir(legacy_dir.clone());
        release_asset_with_blob_refcount(&pool, &paths, &asset)
            .await
            .unwrap();
        assert!(
            !legacy_dir.join(filename).exists(),
            "升级前资产删除时仍应清理旧目录中的物理文件"
        );

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn expired_client_token_session_is_replaced_and_releases_quota() {
        let (pool, _paths, user, project, _a, root) = test_harness().await;
        let content = vec![7u8; 200_000];
        let mut req = init_req(&content, 64 * 1024);
        req.client_token = Some("expiring-token".into());

        let mut policy = test_policy();
        policy.max_user_total_bytes = content.len() as u64;
        policy.max_assets_per_project = 1;

        let started_at = now();
        let first = init_session(&pool, &policy, &user, &project, &req, started_at)
            .await
            .unwrap();

        let after_expiry = started_at + Duration::seconds(policy.ttl_secs);
        let second = init_session(&pool, &policy, &user, &project, &req, after_expiry)
            .await
            .unwrap();

        assert_ne!(first.session_id, second.session_id);

        let first_status: String =
            sqlx::query_scalar("SELECT status FROM upload_sessions WHERE id = ?")
                .bind(&first.session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(first_status, "expired");

        let (active_count, reserved_bytes): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(file_size), 0)
             FROM upload_sessions
             WHERE user_id = ? AND project_id = ?
               AND status IN ('initiated', 'uploading')",
        )
        .bind(&user)
        .bind(&project)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(active_count, 1, "过期会话不能继续占用项目数量配额");
        assert_eq!(
            reserved_bytes,
            content.len() as i64,
            "过期会话不能继续占用用户容量配额"
        );

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }

    #[tokio::test]
    async fn init_is_idempotent_for_same_client_token() {
        let (pool, _paths, user, project, _a, root) = test_harness().await;
        let content = vec![8u8; 200_000];
        let mut req = init_req(&content, 64 * 1024);
        req.client_token = Some("fixed-token".into());
        let first = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        let second = init_session(&pool, &test_policy(), &user, &project, &req, now())
            .await
            .unwrap();
        assert_eq!(first.session_id, second.session_id);

        let different_content = vec![9u8; content.len()];
        let mut conflicting = init_req(&different_content, 64 * 1024);
        conflicting.client_token = Some("fixed-token".into());
        let conflict =
            init_session(&pool, &test_policy(), &user, &project, &conflicting, now()).await;
        assert!(matches!(conflict, Err(AppError::Conflict(_))));

        std::fs::remove_dir_all(&root).ok();
        pool.close().await;
    }
}
