use axum::{
    extract::{Extension, State},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::{fs, process::Command};

use crate::{
    asset,
    auth::middleware::UserId,
    error::{AppError, AppResult},
    project, AppState,
};

/// 单个片段下载/读取的大小上限：512 MB
const CLIP_MAX_BYTES: usize = 512 * 1024 * 1024;
/// 单个片段下载超时（秒）
const CLIP_DOWNLOAD_TIMEOUT_SECS: u64 = 300;
/// ffmpeg 进程超时（秒）
const FFMPEG_TIMEOUT_SECS: u64 = 1800;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeFinalCutReq {
    pub project_id: String,
    /// 按时间线顺序排列的视频片段资产 ID（≥1 个）
    pub clip_asset_ids: Vec<String>,
    /// 合成产物名称，缺省用 "合成成片 {时间}"
    #[serde(default)]
    pub name: Option<String>,
}

/// ffmpeg 检测结果：不可用时带安装提示文案
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegAvailability {
    pub available: bool,
    pub hint: Option<String>,
}

/**
 * 合成成片视频
 *
 * POST /api/export/final-cut
 *
 * 按 clipAssetIds 顺序把已生成的镜头视频拼接为一个 MP4：
 *   1. 校验项目归属，逐个解析片段为本地文件
 *      （/uploads/ 资产直接读 assets_dir；远程 URL 经 SSRF 校验后下载）；
 *   2. ffmpeg concat demuxer 先尝试流复制（-c copy，快、无损），
 *      失败（编码参数不一致等）再回退到 H.264 重编码；
 *   3. 产物写入 assets_dir 并注册为 assets(type='video')。
 *
 * 依赖本机安装 ffmpeg；未安装时返回带安装提示的 500。
 */
pub async fn compose_final_cut(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Json(req): Json<ComposeFinalCutReq>,
) -> AppResult<Json<asset::model::Asset>> {
    if req.clip_asset_ids.is_empty() {
        return Err(AppError::Validation("至少需要一个视频片段".into()));
    }
    if req.clip_asset_ids.len() > 200 {
        return Err(AppError::Validation("片段数量超出上限（200）".into()));
    }

    // 项目归属校验（与 precheck 一致）
    let project = project::repo::find_by_id(&state.db, &req.project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
    if project.user_id != user_id.0 {
        return Err(AppError::Forbidden("无权访问该项目".into()));
    }

    if !ensure_ffmpeg_available().await {
        return Err(AppError::Internal(
            "未检测到 ffmpeg，无法合成成片视频。请先安装 ffmpeg 并确保其在 PATH 中，然后重试。"
                .into(),
        ));
    }

    let assets_root = resolve_assets_root(&state.config.assets_dir).await?;
    let temp_dir = assets_root.join(format!("compose-tmp-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).await.map_err(|error| {
        AppError::Internal(format!("failed to create compose temp dir: {error}"))
    })?;

    let result = compose_clips(&state, &user_id.0, &req, &assets_root, &temp_dir).await;

    // best-effort 清理临时目录（含下载的远程片段）
    let _ = fs::remove_dir_all(&temp_dir).await;

    result.map(Json)
}

/// 供 GET /api/export/ffmpeg-availability 使用的前置检测
pub async fn ffmpeg_availability() -> Json<FfmpegAvailability> {
    let available = ensure_ffmpeg_available().await;
    Json(FfmpegAvailability {
        available,
        hint: (!available).then(|| {
            "未检测到 ffmpeg。请安装后重试（Windows: winget install ffmpeg 或从 ffmpeg.org 下载）。".to_string()
        }),
    })
}
async fn compose_clips(
    state: &AppState,
    user_id: &str,
    req: &ComposeFinalCutReq,
    assets_root: &std::path::Path,
    temp_dir: &std::path::Path,
) -> AppResult<asset::model::Asset> {
    // 逐片段解析为本地文件（下载的放 temp_dir，本地的直接引用）
    let mut clip_paths: Vec<PathBuf> = Vec::with_capacity(req.clip_asset_ids.len());
    let mut clip_names: Vec<String> = Vec::with_capacity(req.clip_asset_ids.len());
    for (index, asset_id) in req.clip_asset_ids.iter().enumerate() {
        let asset = load_owned_video_asset(state, user_id, asset_id).await?;
        let path = resolve_clip_to_local_file(state, &asset, temp_dir, index).await?;
        clip_paths.push(path);
        clip_names.push(asset.name);
    }

    // concat 清单：ffmpeg concat demuxer 要求 `file '<path>'`，路径内单引号转义
    let list_path = temp_dir.join("concat-list.txt");
    let list_content = build_concat_list(&clip_paths);
    fs::write(&list_path, &list_content)
        .await
        .map_err(|error| AppError::Internal(format!("failed to write concat list: {error}")))?;

    let output_filename = format!("final-cut-{}.mp4", uuid::Uuid::new_v4());
    let output_path = assets_root.join(&output_filename);
    if !output_path.starts_with(assets_root) {
        return Err(AppError::Forbidden("invalid output path".into()));
    }

    // 第一遍：流复制（要求各片段编码参数一致；wan2.1 产物通常满足）
    let copied = run_ffmpeg(
        &[
            "-y".as_ref(),
            "-f".as_ref(),
            "concat".as_ref(),
            "-safe".as_ref(),
            "0".as_ref(),
            "-i".as_ref(),
            list_path.as_os_str(),
            "-c".as_ref(),
            "copy".as_ref(),
            "-movflags".as_ref(),
            "+faststart".as_ref(),
            output_path.as_os_str(),
        ],
        temp_dir,
    )
    .await;

    if copied.is_err() {
        // 第二遍：H.264 重编码（参数不一致/混编码源），慢但稳
        run_ffmpeg(
            &[
                "-y".as_ref(),
                "-f".as_ref(),
                "concat".as_ref(),
                "-safe".as_ref(),
                "0".as_ref(),
                "-i".as_ref(),
                list_path.as_os_str(),
                "-c:v".as_ref(),
                "libx264".as_ref(),
                "-preset".as_ref(),
                "veryfast".as_ref(),
                "-crf".as_ref(),
                "20".as_ref(),
                "-pix_fmt".as_ref(),
                "yuv420p".as_ref(),
                "-c:a".as_ref(),
                "aac".as_ref(),
                "-movflags".as_ref(),
                "+faststart".as_ref(),
                output_path.as_os_str(),
            ],
            temp_dir,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!("ffmpeg 合成失败（已尝试流复制与重编码）：{error}"))
        })?;
    }

    let size_bytes = fs::metadata(&output_path)
        .await
        .map(|meta| meta.len() as i64)
        .unwrap_or(0);

    let metadata = serde_json::json!({
        "origin": "final_cut_compose",
        "source": "final_cut_compose",
        "clipAssetIds": req.clip_asset_ids,
        "clipCount": clip_paths.len(),
        "clipNames": clip_names,
        "composedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "sizeBytes": size_bytes,
        "creator": "剪辑与合成",
    });

    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("合成成片 {}", Utc::now().format("%Y-%m-%d %H-%M-%S")));

    asset::repo::create_asset(
        &state.db,
        &req.project_id,
        &name,
        "video",
        &format!("/uploads/{output_filename}"),
        Some(&metadata.to_string()),
    )
    .await
}

/// 校验归属并加载片段资产：assets JOIN projects，确保属于当前用户
async fn load_owned_video_asset(
    state: &AppState,
    user_id: &str,
    asset_id: &str,
) -> AppResult<asset::model::Asset> {
    let asset = sqlx::query_as::<_, asset::model::Asset>(
        "SELECT a.* FROM assets a
         JOIN projects p ON p.id = a.project_id
         WHERE a.id = ? AND p.user_id = ?",
    )
    .bind(asset_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("片段资产不存在或无权访问：{asset_id}")))?;

    if asset.asset_type != "video" {
        return Err(AppError::Validation(format!(
            "片段 {asset_id} 不是视频资产（当前 {}）",
            asset.asset_type
        )));
    }
    Ok(asset)
}

/// 把片段解析为本地文件：/uploads/ 资产直接定位；远程 URL 下载到临时目录
async fn resolve_clip_to_local_file(
    state: &AppState,
    asset: &asset::model::Asset,
    temp_dir: &std::path::Path,
    index: usize,
) -> AppResult<PathBuf> {
    if let Some(filename) = asset.url.strip_prefix("/uploads/") {
        if !filename.is_empty() && !filename.contains('/') && !filename.contains('\\') {
            let assets_root = resolve_assets_root(&state.config.assets_dir).await?;
            let candidate = assets_root.join(filename);
            let canonical = fs::canonicalize(&candidate).await.map_err(|error| {
                AppError::NotFound(format!("片段文件不存在（{}）：{error}", asset.url))
            })?;
            if !canonical.starts_with(&assets_root) {
                return Err(AppError::Forbidden("非法的资产文件路径".into()));
            }
            return Ok(canonical);
        }
        return Err(AppError::Validation(format!(
            "片段 {} 的 URL 非法：{}",
            asset.id, asset.url
        )));
    }

    // 远程 URL：SSRF 校验后下载到临时目录
    if asset.url.starts_with("http://") || asset.url.starts_with("https://") {
        crate::ai::ssrf_guard::validate_endpoint_url(&asset.url).await?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(CLIP_DOWNLOAD_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| {
                AppError::Internal(format!("failed to create HTTP client: {error}"))
            })?;
        let response = client
            .get(&asset.url)
            .send()
            .await
            .map_err(|error| AppError::Internal(format!("片段下载失败：{error}")))?;
        if !response.status().is_success() {
            return Err(AppError::Internal(format!(
                "片段下载返回 {}（{}）",
                response.status(),
                asset.name
            )));
        }

        let mut bytes: Vec<u8> = Vec::new();
        let mut response = response;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| AppError::Internal(format!("片段下载中断：{error}")))?
        {
            if bytes.len() + chunk.len() > CLIP_MAX_BYTES {
                return Err(AppError::Internal(format!(
                    "片段 {} 超出下载大小上限",
                    asset.name
                )));
            }
            bytes.extend_from_slice(&chunk);
        }

        let local_path = temp_dir.join(format!("clip-{index}.mp4"));
        fs::write(&local_path, &bytes)
            .await
            .map_err(|error| AppError::Internal(format!("failed to write clip: {error}")))?;
        return Ok(local_path);
    }

    Err(AppError::Validation(format!(
        "片段 {}（{}）既不是本地 /uploads/ 资产也不是可下载的远程视频，无法合成",
        asset.name, asset.url
    )))
}

/// 生成 ffmpeg concat demuxer 清单；单引号按 ffmpeg 规则转义为 '\''
fn build_concat_list(clip_paths: &[PathBuf]) -> String {
    let mut content = String::new();
    for path in clip_paths {
        let escaped = path.to_string_lossy().replace('\'', "'\\''");
        content.push_str(&format!("file '{escaped}'\n"));
    }
    content
}

/// 确认 ffmpeg 可用（仅在 PATH 上探测 -version）
async fn ensure_ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// 带超时运行 ffmpeg；工作目录设为 temp_dir，错误时带 stderr 摘要
async fn run_ffmpeg(args: &[&std::ffi::OsStr], work_dir: &std::path::Path) -> Result<(), String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(FFMPEG_TIMEOUT_SECS),
        Command::new("ffmpeg")
            .args(args)
            .current_dir(work_dir)
            .output(),
    )
    .await
    .map_err(|_| format!("ffmpeg 超时（{FFMPEG_TIMEOUT_SECS}s）"))?
    .map_err(|error| format!("failed to spawn ffmpeg: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let preview: String = stderr
        .chars()
        .rev()
        .take(400)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Err(format!(
        "ffmpeg 退出码 {:?}：{preview}",
        output.status.code()
    ))
}

/// assets 目录：创建 + canonicalize（与 asset::handlers::resolve_upload_root 一致）
async fn resolve_assets_root(assets_dir: &str) -> AppResult<PathBuf> {
    fs::create_dir_all(assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("failed to create assets dir: {error}")))?;
    fs::canonicalize(assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("failed to resolve assets dir: {error}")))
}

#[cfg(test)]
mod tests {
    use super::build_concat_list;
    use std::path::PathBuf;

    #[test]
    fn concat_list_quotes_paths_and_escapes_single_quotes() {
        let list = build_concat_list(&[
            PathBuf::from("/data/assets/clip 1.mp4"),
            PathBuf::from("/data/assets/it's.mp4"),
        ]);
        assert_eq!(
            list,
            "file '/data/assets/clip 1.mp4'\nfile '/data/assets/it'\\''s.mp4'\n"
        );
    }
}
