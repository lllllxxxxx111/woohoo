use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    asset::generated_document::{self, GeneratedMarkdownDocument},
    auth::middleware::UserId,
    error::{AppError, AppResult},
    project::repo as project_repo,
    AppState,
};

use super::{
    model::{Storyboard, UpsertStoryboardReq},
    repo,
};

pub async fn get_storyboard(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Option<Storyboard>>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let storyboard = repo::find_by_project(&state.db, &project_id).await?;
    Ok(Json(storyboard))
}

pub async fn upsert_storyboard(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<UpsertStoryboardReq>,
) -> AppResult<Json<Storyboard>> {
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

    let storyboard = repo::upsert_storyboard(&state.db, &project_id, &req.lines).await?;
    persist_storyboard_document_asset(&state, &storyboard).await?;
    Ok(Json(storyboard))
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
    let mut content = String::from("# Storyboard\n\n| Scene | Duration | Description |\n| --- | ---: | --- |\n");
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
