use serde::{Deserialize, Serialize};

/// 受版本管理的内容类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentType {
    Script,
    Storyboard,
}

impl ContentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContentType::Script => "script",
            ContentType::Storyboard => "storyboard",
        }
    }

    #[allow(dead_code)]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "script" => Some(ContentType::Script),
            "storyboard" => Some(ContentType::Storyboard),
            _ => None,
        }
    }
}

/// 合法的版本来源标记
pub const VALID_SOURCES: &[&str] = &[
    "manual",
    "ai",
    "pipeline",
    "restore",
    "rewind",
    "baseline",
    "import",
    "collaboration",
];

pub fn normalize_source(value: Option<&str>) -> String {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() {
        return "manual".to_string();
    }
    if VALID_SOURCES.contains(&trimmed) {
        trimmed.to_string()
    } else {
        "manual".to_string()
    }
}

/// content_versions 表的行结构（内部使用，不做 camelCase 转换）
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ContentVersionRow {
    pub id: String,
    pub project_id: String,
    pub content_type: String,
    pub version: i64,
    pub content: String,
    pub content_hash: String,
    pub source: String,
    pub created_by: Option<String>,
    pub note: Option<String>,
    pub title: Option<String>,
    pub created_at: String,
}

/// 对外 API 的版本视图（camelCase）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentVersion {
    pub id: String,
    pub project_id: String,
    pub content_type: String,
    pub version: i64,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created_at: String,
    pub content_hash: String,
    /// 仅版本详情返回完整内容；列表接口不下发，避免超大响应
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

impl ContentVersion {
    pub fn from_row(row: ContentVersionRow, include_content: bool) -> Self {
        ContentVersion {
            id: row.id,
            project_id: row.project_id,
            content_type: row.content_type,
            version: row.version,
            source: row.source,
            created_by: row.created_by,
            note: row.note,
            title: row.title,
            created_at: row.created_at,
            content_hash: row.content_hash,
            content: if include_content {
                Some(row.content)
            } else {
                None
            },
        }
    }
}

/// 保存请求携带的并发令牌解析结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConcurrencyToken {
    /// 客户端明确声明的基线版本（含 0 = 尚无版本）
    BaseVersion(i64),
    /// 客户端未携带任何令牌（兼容旧调用方，按当前版本继续）
    None,
}

/// 版本提交输入
#[derive(Debug, Clone)]
pub struct CommitInput {
    pub project_id: String,
    pub content_type: ContentType,
    pub content: String,
    pub title: Option<String>,
    pub source: String,
    pub created_by: Option<String>,
    pub note: Option<String>,
    pub expected_base: ConcurrencyToken,
}

/// 版本提交结果
#[derive(Debug, Clone)]
pub enum CommitOutcome {
    /// 新建了一个版本
    Created(ContentVersionRow),
    /// 与当前版本内容完全一致，未新增版本（去重命中）
    Duplicate(ContentVersionRow),
}

impl CommitOutcome {
    pub fn version_row(&self) -> &ContentVersionRow {
        match self {
            CommitOutcome::Created(row) => row,
            CommitOutcome::Duplicate(row) => row,
        }
    }

    pub fn is_duplicate(&self) -> bool {
        matches!(self, CommitOutcome::Duplicate(_))
    }
}

/// 结构化冲突信息（映射为 HTTP 409）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionConflict {
    pub base_version: Option<i64>,
    pub current_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_content_hash: Option<String>,
}

/// 版本提交错误
#[derive(Debug)]
pub enum CommitError {
    Conflict(VersionConflict),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for CommitError {
    fn from(error: sqlx::Error) -> Self {
        CommitError::Database(error)
    }
}

/// 分镜快照行（用于稳定序列化与哈希）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardSnapshotLine {
    pub id: String,
    pub scene_number: i64,
    pub description: String,
    pub duration: i64,
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

/// 分镜快照（版本存储格式）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardSnapshot {
    pub lines: Vec<StoryboardSnapshotLine>,
}
