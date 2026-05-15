use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 图片生成状态枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageGenerationStatus {
    Pending,
    Processing,
    Completed,
    Failed,
}

impl ImageGenerationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

impl TryFrom<&str> for ImageGenerationStatus {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "pending" => Ok(Self::Pending),
            "processing" => Ok(Self::Processing),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(format!("unknown image generation status: {}", other)),
        }
    }
}

/// 图片生成记录数据库模型
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ImageGeneration {
    pub id: String,
    pub user_id: String,
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub n: i64,
    pub status: String,
    pub error_message: Option<String>,
    pub result_urls: Option<String>,
    pub result_b64_json: Option<String>,
    pub revised_prompt: Option<String>,
    pub cost_credits: f64,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// 创建图片生成请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImageGenerationReq {
    pub prompt: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_size")]
    pub size: String,
    #[serde(default = "default_n")]
    pub n: i64,
}

/// 图片生成响应（含结果）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationResponse {
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub n: i64,
    pub status: String,
    pub error_message: Option<String>,
    pub urls: Vec<String>,
    pub b64_data: Vec<String>,
    pub revised_prompt: Option<String>,
    pub cost_credits: f64,
    pub created_at: String,
    pub completed_at: Option<String>,
}

fn default_model() -> String {
    "dall-e-3".to_string()
}

fn default_size() -> String {
    "1024x1024".to_string()
}

fn default_n() -> i64 {
    1
}
