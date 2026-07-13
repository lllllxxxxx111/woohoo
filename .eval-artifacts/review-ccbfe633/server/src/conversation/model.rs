use serde::{Deserialize, Serialize};

/// 对话实体（对应前端 ChatSession）
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Conversation {
    pub id: String,
    pub project_id: String,
    pub user_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 消息实体（对应前端 Message）
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String, // user, assistant, system
    pub content: String,
    pub msg_type: String, // text, script_gen, storyboard_gen, review_result
    pub agent_id: Option<String>,
    pub model_used: Option<String>,
    pub token_usage: Option<String>, // JSON string
    pub meta: Option<String>,        // JSON string
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MessageHistoryEntry {
    pub role: String,
    pub content: String,
}

/// 消息附件（支持用户上传、AI生成、AI引用三种来源）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageAttachment {
    pub url: String,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: Option<String>,
    pub source: AttachmentSource,
    #[serde(rename = "sourceMeta")]
    pub source_meta: Option<AttachmentSourceMeta>,
}

/// 附件来源枚举
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentSource {
    UserUpload,
    AiGenerated,
    AiReferenced,
}

/// 附件来源元数据（联合类型）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AttachmentSourceMeta {
    UserUpload(UserUploadMeta),
    AiGeneration(AiGenerationMeta),
    AiReference(AiReferencedMeta),
}

/// 用户上传元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserUploadMeta {
    pub upload_time: String,
    pub device_info: Option<String>,
}

/// AI生成元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiGenerationMeta {
    pub generation_time_ms: u64,
    pub model: String,
    pub tokens_used: Option<u64>,
    pub generated_at: String,
    pub regeneratable: bool,
}

/// AI引用元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiReferencedMeta {
    pub asset_id: String,
    pub original_name: String,
    pub project_id: Option<String>,
}

/// 创建对话请求
#[derive(Debug, Deserialize)]
pub struct CreateConversationReq {
    pub title: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListMessagesQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

impl ListMessagesQuery {
    pub fn normalized_limit(&self) -> Option<i64> {
        self.limit.map(|value| value.clamp(1, 500) as i64)
    }

    pub fn normalized_offset(&self) -> i64 {
        self.offset.unwrap_or(0) as i64
    }
}

/// 更新对话请求
#[derive(Debug, Deserialize)]
pub struct UpdateConversationReq {
    pub title: String,
}

/// 发送消息请求
#[derive(Debug, Deserialize)]
pub struct SendMessageReq {
    pub role: String,
    pub content: String,
    #[serde(default = "default_msg_type")]
    pub msg_type: String,
    pub agent_id: Option<String>,
    pub model_used: Option<String>,
    pub token_usage: Option<serde_json::Value>,
    pub meta: Option<serde_json::Value>,
    #[serde(default)]
    pub attachments: Vec<MessageAttachment>,
}

fn default_msg_type() -> String {
    "text".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindConversationReq {
    pub message_id: String,
    #[serde(default)]
    pub assets_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindConversationResp {
    pub conversation_id: String,
    pub anchor_message_id: String,
    pub removed_message_count: i64,
    pub cancelled_task_count: i64,
}
