use serde::{Deserialize, Serialize};

use crate::asset::model::Asset;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardRecord {
    pub id: String,
    pub project_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Storyboard {
    pub id: String,
    pub project_id: String,
    pub lines: Vec<StoryboardLine>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardLine {
    pub id: String,
    pub scene_number: i64,
    pub description: String,
    pub duration: i64,
    pub assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertStoryboardReq {
    pub lines: Vec<StoryboardLineInput>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardLineInput {
    pub id: Option<String>,
    pub scene_number: i64,
    pub description: String,
    pub duration: i64,
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

/// 主链路响应：分镜内容 + 当前版本标识
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardResponse {
    pub id: String,
    pub project_id: String,
    pub lines: Vec<StoryboardLine>,
    pub updated_at: String,
    pub version: i64,
    pub version_id: String,
    pub content_hash: String,
    /// 本次保存是否因内容相同而被去重（未新增版本）
    pub deduplicated: bool,
}

impl StoryboardResponse {
    pub fn new(
        storyboard: Storyboard,
        version_row: &crate::content_version::model::ContentVersionRow,
        deduplicated: bool,
    ) -> Self {
        StoryboardResponse {
            id: storyboard.id,
            project_id: storyboard.project_id,
            lines: storyboard.lines,
            updated_at: storyboard.updated_at,
            version: version_row.version,
            version_id: version_row.id.clone(),
            content_hash: version_row.content_hash.clone(),
            deduplicated,
        }
    }
}
