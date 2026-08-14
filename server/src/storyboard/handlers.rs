use axum::{
    extract::{Extension, Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use uuid::Uuid;

use crate::{
    asset::generated_document::{self, GeneratedMarkdownDocument},
    auth::middleware::UserId,
    content_version::{
        handlers::resolve_concurrency_token,
        model::{
            normalize_source, CommitInput, ContentType, StoryboardSnapshot, StoryboardSnapshotLine,
        },
        repo as version_repo,
    },
    error::{AppError, AppResult},
    project::repo as project_repo,
    AppState,
};

use super::{
    model::{Storyboard, StoryboardLineInput, StoryboardResponse, UpsertStoryboardReq},
    repo,
};

pub async fn get_storyboard(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Option<StoryboardResponse>>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let storyboard = match repo::find_by_project(&state.db, &project_id).await? {
        Some(storyboard) => storyboard,
        None => return Ok(Json(None)),
    };

    let latest =
        version_repo::get_latest_version(&state.db, &project_id, ContentType::Storyboard)
            .await
            .map_err(AppError::Sqlx)?;

    let response = match latest {
        Some(row) => StoryboardResponse::new(storyboard, &row, false),
        None => {
            let snapshot = build_snapshot_from_storyboard(&storyboard);
            let content = serde_json::to_string(&snapshot).unwrap_or_default();
            StoryboardResponse {
                id: storyboard.id,
                project_id: storyboard.project_id,
                lines: storyboard.lines,
                updated_at: storyboard.updated_at,
                version: 0,
                version_id: String::new(),
                content_hash: version_repo::sha256_hex(&content),
                deduplicated: false,
            }
        }
    };

    Ok(Json(Some(response)))
}

pub async fn upsert_storyboard(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpsertStoryboardReq>,
) -> AppResult<Json<StoryboardResponse>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;

    for line in &req.lines {
        if line.scene_number <= 0 {
            return Err(AppError::Validation("sceneNumber 必须大于 0".into()));
        }
        if line.duration < 0 {
            return Err(AppError::Validation("duration 不能小于 0".into()));
        }
        if line.description.trim().is_empty() {
            return Err(AppError::Validation("分镜描述不能为空".into()));
        }
    }

    // 提前解析行 ID，保证“版本快照”和“当前分镜表”使用同一组 ID，
    // 从而让相同内容的重复保存可以被内容哈希去重。
    let resolved_inputs: Vec<StoryboardLineInput> = req
        .lines
        .iter()
        .map(|line| StoryboardLineInput {
            id: Some(
                line.id
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
            ),
            scene_number: line.scene_number,
            description: line.description.trim().to_string(),
            duration: line.duration,
            asset_ids: line.asset_ids.clone(),
        })
        .collect();

    let snapshot = StoryboardSnapshot {
        lines: resolved_inputs
            .iter()
            .map(|line| StoryboardSnapshotLine {
                id: line.id.clone().unwrap_or_default(),
                scene_number: line.scene_number,
                description: line.description.clone(),
                duration: line.duration,
                asset_ids: line.asset_ids.clone(),
            })
            .collect(),
    };
    let snapshot_content = serde_json::to_string(&snapshot)
        .map_err(|err| AppError::Internal(format!("分镜快照序列化失败: {}", err)))?;

    let expected_base = resolve_concurrency_token(req.base_version, &headers);
    let source = normalize_source(req.source.as_deref());
    let note = req.note.clone();

    let mut tx = state.db.begin().await?;

    let commit_input = CommitInput {
        project_id: project_id.clone(),
        content_type: ContentType::Storyboard,
        content: snapshot_content,
        title: None,
        source,
        created_by: Some(user_id.0.clone()),
        note,
        expected_base,
    };
    let outcome = version_repo::commit_version_tx(&mut tx, &commit_input)
        .await
        .map_err(|err| err.into_app_error())?;

    repo::upsert_storyboard_tx(&mut tx, &project_id, &resolved_inputs, true).await?;

    tx.commit().await?;

    let storyboard = repo::find_by_project(&state.db, &project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("分镜不存在".into()))?;

    let version_row = outcome.version_row().clone();
    let deduplicated = outcome.is_duplicate();
    let response = StoryboardResponse::new(storyboard.clone(), &version_row, deduplicated);

    persist_storyboard_document_asset(&state, &storyboard).await?;
    Ok(Json(response))
}

pub async fn delete_storyboard(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<StatusCode> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    repo::delete_by_project(&state.db, &project_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 从当前分镜构建快照（用于无版本行时计算内容哈希）
fn build_snapshot_from_storyboard(storyboard: &Storyboard) -> StoryboardSnapshot {
    StoryboardSnapshot {
        lines: storyboard
            .lines
            .iter()
            .map(|line| StoryboardSnapshotLine {
                id: line.id.clone(),
                scene_number: line.scene_number,
                description: line.description.clone(),
                duration: line.duration,
                asset_ids: line.assets.iter().map(|asset| asset.id.clone()).collect(),
            })
            .collect(),
    }
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

async fn persist_storyboard_document_asset(
    state: &AppState,
    storyboard: &Storyboard,
) -> AppResult<()> {
    if storyboard.lines.is_empty() {
        return Ok(());
    }

    let content = render_storyboard_markdown(storyboard);
    let metadata = serde_json::json!({
        "origin": "storyboard",
        "format": "markdown",
        "storyboardId": storyboard.id,
        "projectId": storyboard.project_id,
        "sceneCount": storyboard.lines.len(),
        "sizeBytes": content.as_bytes().len(),
        "updatedAt": storyboard.updated_at,
    });
    let filename_stem = format!("storyboard-{}", storyboard.project_id);

    if let Err(error) = generated_document::persist_markdown_document(
        state,
        GeneratedMarkdownDocument {
            project_id: &storyboard.project_id,
            name: "storyboard.md",
            filename_stem: &filename_stem,
            content: &content,
            metadata,
        },
    )
    .await
    {
        tracing::warn!(
            project_id = %storyboard.project_id,
            storyboard_id = %storyboard.id,
            "failed to persist storyboard document asset: {}",
            error
        );
    }

    Ok(())
}

fn render_storyboard_markdown(storyboard: &Storyboard) -> String {
    let mut content =
        String::from("# Storyboard\n\n| Scene | Duration | Description |\n| --- | ---: | --- |\n");
    for line in &storyboard.lines {
        content.push_str(&format!(
            "| {} | {}s | {} |\n",
            line.scene_number,
            line.duration,
            escape_markdown_table_cell(&line.description),
        ));
    }
    content
}

fn escape_markdown_table_cell(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace('\n', "<br>")
        .trim()
        .to_string()
}
