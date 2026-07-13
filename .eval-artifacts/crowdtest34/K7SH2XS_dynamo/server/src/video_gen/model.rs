use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 视频生成状态枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoGenerationStatus {
    Pending,
    Processing,
    Completed,
    Failed,
}

impl VideoGenerationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

impl TryFrom<&str> for VideoGenerationStatus {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "pending" => Ok(Self::Pending),
            "processing" => Ok(Self::Processing),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(format!("unknown video generation status: {}", other)),
        }
    }
}

/// 视频生成记录数据库模型
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct VideoGeneration {
    pub id: String,
    pub user_id: String,
    pub project_id: Option<String>,
    pub prompt: String,
    pub model: String,
    pub duration_seconds: Option<f64>,
    pub aspect_ratio: String,
    pub status: String,
    pub error_message: Option<String>,
    pub result_url: Option<String>,
    pub result_b64_json: Option<String>,
    pub cost_credits: f64,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// 创建视频生成请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVideoGenerationReq {
    pub prompt: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default = "default_aspect_ratio")]
    pub aspect_ratio: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub endpoint_id: Option<String>,
}

/// 视频生成响应
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerationResponse {
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub duration_seconds: Option<f64>,
    pub aspect_ratio: String,
    pub status: String,
    pub error_message: Option<String>,
    pub url: Option<String>,
    pub b64_data: Option<String>,
    pub cost_credits: f64,
    pub created_at: String,
    pub completed_at: Option<String>,
}

fn default_model() -> String {
    "wan2.1-t2v-480p".to_string()
}

fn default_aspect_ratio() -> String {
    "16:9".to_string()
}
