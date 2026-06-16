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
    model::{Script, UpsertScriptReq},
    repo,
};

pub async fn get_script(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Option<Script>>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let script = repo::find_by_project(&state.db, &project_id).await?;
    Ok(Json(script))
}

pub async fn upsert_script(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Json(req): Json<UpsertScriptReq>,
) -> AppResult<Json<Script>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    if req.title.trim().is_empty() {
        return Err(AppError::Validation("剧本标题不能为空".into()));
    }

    let script =
        repo::upsert_script(&state.db, &project_id, req.title.trim(), &req.content).await?;
    persist_script_document_asset(&state, &script).await?;
    Ok(Json(script))
}

pub async fn delete_script(
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

async fn persist_script_document_asset(state: &AppState, script: &Script) -> AppResult<()> {
    if script.content.trim().is_empty() {
        return Ok(());
    }

    let asset_name = if script.title.trim().ends_with(".md") {
        script.title.trim().to_string()
    } else {
        format!("{}.md", script.title.trim())
    };
    let metadata = serde_json::json!({
        "origin": "script",
        "format": "markdown",
        "scriptId": script.id,
        "projectId": script.project_id,
        "title": script.title,
        "sizeBytes": script.content.as_bytes().len(),
        "updatedAt": script.updated_at,
    });
    let filename_stem = format!("script-{}", script.project_id);

    if let Err(error) = generated_document::persist_markdown_document(
        state,
        GeneratedMarkdownDocument {
            project_id: &script.project_id,
            name: &asset_name,
            filename_stem: &filename_stem,
            content: &script.content,
            metadata,
        },
    )
    .await
    {
        tracing::warn!(
            project_id = %script.project_id,
            script_id = %script.id,
            "failed to persist script document asset: {}",
            error
        );
    }

    Ok(())
}
