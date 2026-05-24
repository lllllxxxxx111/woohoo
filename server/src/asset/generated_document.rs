use std::path::PathBuf;

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
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
    let metadata = with_document_tracking_metadata(input.metadata);

    if let Some(existing) = find_by_project_url(&state.db, input.project_id, &asset_url).await? {
        let merged_metadata = merge_document_metadata(existing.metadata.as_deref(), &metadata);
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
        Some(&metadata.to_string()),
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
    let existing_value = existing.and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
    let existing_change_count = existing_value
        .as_ref()
        .and_then(|value| metadata_i64(value, &["changeCount", "change_count", "revisionCount"]));
    let mut merged = existing_value
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    if let Some(next_map) = next.as_object() {
        for (key, value) in next_map {
            merged.insert(key.clone(), value.clone());
        }
    }
    let now = now_iso();
    merged.insert(
        "changeCount".to_string(),
        json!(existing_change_count.unwrap_or(0).saturating_add(1)),
    );
    merged.insert("modifiedAt".to_string(), json!(now.clone()));
    merged.insert("lastModifiedAt".to_string(), json!(now));

    serde_json::Value::Object(merged)
}

fn with_document_tracking_metadata(mut metadata: Value) -> Value {
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(map) = metadata.as_object_mut() {
        map.entry("changeCount".to_string()).or_insert(json!(0));
        map.entry("createdAt".to_string()).or_insert(json!(now_iso()));
    }

    metadata
}

fn metadata_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        let Some(item) = value.get(*key) else {
            continue;
        };

        if let Some(number) = item.as_i64() {
            return Some(number);
        }

        if let Some(number) = item.as_u64().and_then(|value| i64::try_from(value).ok()) {
            return Some(number);
        }

        if let Some(text) = item.as_str() {
            if let Ok(number) = text.trim().parse::<i64>() {
                return Some(number);
            }
        }
    }

    None
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
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
