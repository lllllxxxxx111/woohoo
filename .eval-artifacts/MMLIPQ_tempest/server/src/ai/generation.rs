use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::conversation::model::{
    AiGenerationMeta, AiReferencedMeta, AttachmentSource, MessageAttachment,
};
use crate::error::AppResult;

/**
 * AI生成请求参数（用于图片生成等场景）
 */
#[derive(Debug, Clone, Deserialize)]
pub struct AiGenerateAssetReq {
    pub name: String,
    pub mime_type: String,
    pub url: String,
    pub project_id: String,
    #[serde(default)]
    pub generation_method: AiGenerationMethod,
    pub thumbnail_url: Option<String>,
    pub size_bytes: Option<u64>,
}

/**
 * AI生成方式
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiGenerationMethod {
    ImageGeneration {
        model: Option<String>,
        prompt: Option<String>,
        size: Option<String>,
    },
    AssetReference {
        asset_id: String,
        original_name: String,
    },
    DocumentGeneration {
        template_id: Option<String>,
        format: Option<String>,
    },
}

impl Default for AiGenerationMethod {
    fn default() -> Self {
        AiGenerationMethod::ImageGeneration {
            model: None,
            prompt: None,
            size: None,
        }
    }
}

/**
 * 保存AI生成的资产到数据库，并返回MessageAttachment格式
 */
pub async fn save_ai_generated_asset(
    db: &SqlitePool,
    req: AiGenerateAssetReq,
) -> AppResult<MessageAttachment> {
    let asset_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let metadata = serde_json::json!({
        "source": "ai_generated",
        "generatedAt": now,
        "method": req.generation_method,
    });

    sqlx::query(
        "INSERT INTO assets (id, project_id, name, type, url, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&asset_id)
    .bind(&req.project_id)
    .bind(&req.name)
    .bind(if req.mime_type.starts_with("image/") {
        "image"
    } else if req.mime_type.starts_with("video/") {
        "video"
    } else if req.mime_type.starts_with("audio/") {
        "audio"
    } else {
        "document"
    })
    .bind(&req.url)
    .bind(Some(metadata.to_string()))
    .bind(&now)
    .bind(&now)
    .execute(db)
    .await?;

    let generation_meta = AiGenerationMeta {
        generation_time_ms: 0,
        model: match &req.generation_method {
            AiGenerationMethod::ImageGeneration { model, .. } => {
                model.clone().unwrap_or_else(|| "unknown".to_string())
            }
            _ => "unknown".to_string(),
        },
        tokens_used: None,
        generated_at: now,
        regeneratable: true,
    };

    Ok(MessageAttachment {
        url: req.url,
        name: req.name,
        mime_type: req.mime_type,
        size_bytes: req.size_bytes.unwrap_or(0),
        thumbnail_url: req.thumbnail_url,
        source: AttachmentSource::AiGenerated,
        source_meta: Some(
            crate::conversation::model::AttachmentSourceMeta::AiGeneration(generation_meta),
        ),
    })
}

/**
 * 引用现有资产作为AI回复的附件
 */
pub async fn reference_existing_asset(
    db: &SqlitePool,
    asset_id: &str,
    user_id: &str,
) -> AppResult<Option<MessageAttachment>> {
    let asset = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT a.id, a.name, a.type, a.url, a.metadata
         FROM assets a
         JOIN projects p ON a.project_id = p.id
         WHERE a.id = ? AND p.user_id = ?",
    )
    .bind(asset_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    match asset {
        Some((id, name, asset_type, url, metadata)) => {
            let mime_type = match asset_type.as_str() {
                "image" => "image/png",
                "video" => "video/mp4",
                "audio" => "audio/mpeg",
                _ => "application/octet-stream",
            };

            let size_bytes = metadata
                .and_then(|m| serde_json::from_str::<serde_json::Value>(&m).ok())
                .and_then(|v| v.get("sizeBytes").and_then(|s| s.as_u64()))
                .unwrap_or(0);

            let reference_meta = AiReferencedMeta {
                asset_id: id.clone(),
                original_name: name.clone(),
                project_id: None,
            };

            Ok(Some(MessageAttachment {
                url,
                name,
                mime_type: mime_type.to_string(),
                size_bytes,
                thumbnail_url: None,
                source: AttachmentSource::AiReferenced,
                source_meta: Some(
                    crate::conversation::model::AttachmentSourceMeta::AiReference(reference_meta),
                ),
            }))
        }
        None => Ok(None),
    }
}

/**
 * 批量引用多个资产
 */
pub async fn reference_multiple_assets(
    db: &SqlitePool,
    asset_ids: &[String],
    user_id: &str,
) -> AppResult<Vec<MessageAttachment>> {
    let mut attachments = Vec::new();

    for asset_id in asset_ids {
        if let Some(attachment) = reference_existing_asset(db, asset_id, user_id).await? {
            attachments.push(attachment);
        }
    }

    Ok(attachments)
}
