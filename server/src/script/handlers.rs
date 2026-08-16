use axum::{
    extract::{Extension, Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};

use crate::{
    asset::generated_document::{self, GeneratedMarkdownDocument},
    auth::middleware::UserId,
    content_version::{
        handlers::resolve_concurrency_token,
        model::{normalize_source, CommitInput, ContentType},
        repo as version_repo,
    },
    error::{AppError, AppResult},
    project::repo as project_repo,
    AppState,
};

use super::{
    model::{Script, ScriptResponse, UpsertScriptReq},
    repo,
};

pub async fn get_script(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Option<ScriptResponse>>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let script = match repo::find_by_project(&state.db, &project_id).await? {
        Some(script) => script,
        None => return Ok(Json(None)),
    };

    let latest = version_repo::get_latest_version(&state.db, &project_id, ContentType::Script)
        .await
        .map_err(AppError::Sqlx)?;

    // 无版本行时使用的兜底内容哈希（在移动 content 之前计算）
    let fallback_hash = version_repo::sha256_hex(&script.content);

    let response = match latest {
        Some(row) => ScriptResponse::new(script, &row, false),
        None => ScriptResponse {
            id: script.id,
            project_id: script.project_id,
            title: script.title,
            content: script.content,
            created_at: script.created_at,
            updated_at: script.updated_at,
            version: 0,
            version_id: String::new(),
            content_hash: fallback_hash,
            deduplicated: false,
        },
    };

    Ok(Json(Some(response)))
}

pub async fn upsert_script(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpsertScriptReq>,
) -> AppResult<Json<ScriptResponse>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    if req.title.trim().is_empty() {
        return Err(AppError::Validation("剧本标题不能为空".into()));
    }

    // 并发令牌：优先 body.baseVersion，其次 If-Match 头
    let expected_base = resolve_concurrency_token(req.base_version, &headers)?;

    let content = req.content.clone();
    let title = req.title.trim().to_string();
    let source = normalize_source(req.source.as_deref());
    let note = req.note.clone();

    let mut tx = state.db.begin().await?;

    let commit_input = CommitInput {
        project_id: project_id.clone(),
        content_type: ContentType::Script,
        content: content.clone(),
        title: Some(title.clone()),
        source,
        created_by: Some(user_id.0.clone()),
        note,
        expected_base,
    };
    let outcome = version_repo::commit_version_tx(&mut tx, &commit_input)
        .await
        .map_err(|err| err.into_app_error())?;

    let script = repo::write_current_tx(&mut tx, &project_id, &title, &content).await?;

    tx.commit().await?;

    let version_row = outcome.version_row().clone();
    let deduplicated = outcome.is_duplicate();
    let response = ScriptResponse::new(script.clone(), &version_row, deduplicated);

    persist_script_document_asset(&state, &script).await?;
    Ok(Json(response))
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
