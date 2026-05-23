use std::path::PathBuf;

use serde_json::Value;
use sqlx::SqlitePool;
use tokio::fs;

use crate::{
    error::{AppError, AppResult},
    AppState,
};

use super::{model::Asset, repo};

pub struct GeneratedMarkdownDocument<'a> {
    pub project_id: &'a str,
    pub name: &'a str,
    pub filename_stem: &'a str,
    pub content: &'a str,
    pub metadata: Value,
}

pub async fn persist_markdown_document(
    state: &AppState,
    input: GeneratedMarkdownDocument<'_>,
) -> AppResult<Asset> {
    if input.content.trim().is_empty() {
        return Err(AppError::Validation("document content cannot be empty".into()));
    }

    let assets_root = resolve_assets_root(state).await?;
    let filename = format!("{}.md", sanitize_filename_stem(input.filename_stem));
    let file_path = assets_root.join(&filename);
    if !file_path.starts_with(&assets_root) {
        return Err(AppError::Forbidden("invalid asset file path".into()));
    }

    fs::write(&file_path, input.content)
        .await
        .map_err(|error| AppError::Internal(format!("failed to write document asset: {error}")))?;

    let asset_url = format!("/uploads/{filename}");
    let metadata = input.metadata.to_string();

    if let Some(existing) = find_by_project_url(&state.db, input.project_id, &asset_url).await? {
        let merged_metadata = merge_document_metadata(existing.metadata.as_deref(), &input.metadata);
        return repo::update_asset(
            &state.db,
            &existing.id,
            input.name,
            "document",
            &asset_url,
            Some(&merged_metadata.to_string()),
        )
        .await;
    }

    repo::create_asset(
        &state.db,
        input.project_id,
        input.name,
        "document",
        &asset_url,
        Some(&metadata),
    )
    .await
}

async fn resolve_assets_root(state: &AppState) -> AppResult<PathBuf> {
    fs::create_dir_all(&state.config.assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("failed to create assets dir: {error}")))?;
    fs::canonicalize(&state.config.assets_dir)
        .await
        .map_err(|error| AppError::Internal(format!("failed to resolve assets dir: {error}")))
}

async fn find_by_project_url(
    pool: &SqlitePool,
    project_id: &str,
    url: &str,
) -> AppResult<Option<Asset>> {
    sqlx::query_as::<_, Asset>(
        "SELECT *
         FROM assets
         WHERE project_id = ? AND url = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT 1",
    )
    .bind(project_id)
    .bind(url)
    .fetch_optional(pool)
    .await
    .map_err(Into::into)
}

fn merge_document_metadata(
    existing: Option<&str>,
    next: &serde_json::Value,
) -> serde_json::Value {
    let mut merged = existing
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    if let Some(next_map) = next.as_object() {
        for (key, value) in next_map {
            merged.insert(key.clone(), value.clone());
        }
    }

    serde_json::Value::Object(merged)
}

fn sanitize_filename_stem(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_separator = false;

    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            ch
        } else {
            '-'
        };

        if next == '-' {
            if last_was_separator {
                continue;
            }
            last_was_separator = true;
        } else {
            last_was_separator = false;
        }

        output.push(next);
        if output.len() >= 140 {
            break;
        }
    }

    let trimmed = output.trim_matches('-');
    if trimmed.is_empty() {
        "document-asset".to_string()
    } else {
        trimmed.to_string()
    }
}
