use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertScriptReq {
    pub title: String,
    pub content: String,
    /// 乐观锁基线版本号（客户端读取时的当前版本）。强烈建议提供。
    #[serde(default)]
    pub base_version: Option<i64>,
    /// 写入来源：manual / ai / pipeline / restore / import 等，缺省 manual
    #[serde(default)]
    pub source: Option<String>,
    /// 版本说明
    #[serde(default)]
    pub note: Option<String>,
}

/// 主链路响应：剧本内容 + 当前版本标识
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResponse {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    pub version: i64,
    pub version_id: String,
    pub content_hash: String,
    /// 本次保存是否因内容相同而被去重（未新增版本）
    pub deduplicated: bool,
}

impl ScriptResponse {
    pub fn new(
        script: Script,
        version_row: &crate::content_version::model::ContentVersionRow,
        deduplicated: bool,
    ) -> Self {
        ScriptResponse {
            id: script.id,
            project_id: script.project_id,
            title: script.title,
            content: script.content,
            created_at: script.created_at,
            updated_at: script.updated_at,
            version: version_row.version,
            version_id: version_row.id.clone(),
            content_hash: version_row.content_hash.clone(),
            deduplicated,
        }
    }
}
