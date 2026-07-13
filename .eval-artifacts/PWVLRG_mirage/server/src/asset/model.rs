use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub url: String,
    pub metadata: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssetReq {
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub url: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetReq {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub asset_type: Option<String>,
    pub url: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

/**
 * 跨项目素材搜索结果项（附带项目名称）
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchItem {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub url: String,
    pub metadata: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/**
 * 跨项目素材搜索查询参数
 */
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchQuery {
    /// 模糊搜索关键字（匹配素材名、项目名、metadata.prompt/summary/description/tags）
    pub query: Option<String>,
    /// 素材类型过滤：image / video / audio / document
    pub asset_type: Option<String>,
    /// 限定单个项目
    pub project_id: Option<String>,
    /// 仅收藏
    pub favorite_only: Option<bool>,
    /// 最低评分 (1-5)
    pub rating_min: Option<i64>,
    /// 标签过滤（metadata.tags 数组包含此标签）
    pub tag: Option<String>,
    /// 排序字段: created_at (default) / name / updated_at / rating
    pub sort: Option<String>,
    /// 排序方向: asc / desc (default desc)
    pub order: Option<String>,
    /// 分页偏移
    pub offset: Option<i64>,
    /// 分页大小 (默认 50, 最大 200)
    pub limit: Option<i64>,
}

/**
 * 搜索响应
 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchResponse {
    pub items: Vec<AssetSearchItem>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

/**
 * 单条引用关系
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AssetReference {
    /// 引用类型: storyboard_line / pipeline_step_output
    pub ref_type: String,
    pub project_id: String,
    pub project_name: String,
    /// 关联的目标 ID（分镜行 ID 或 pipeline step output ID）
    pub ref_id: String,
    /// 可展示标题（如 "场景3 - 分镜描述..." 或 "Pipeline: 设计步骤..."）
    pub title: String,
    /// 附加信息（如 scene_number, step_key, step_name）
    pub detail: Option<String>,
    pub created_at: Option<String>,
}

/**
 * 引用关系查询响应
 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReferencesResponse {
    pub asset_id: String,
    pub references: Vec<AssetReference>,
    pub total: usize,
    /// 是否可以安全删除（无引用）
    pub can_delete: bool,
}

/**
 * 删除资产的查询参数（通过 ?force=true 强制删除）
 */
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAssetQuery {
    /// 强制删除（即使存在引用）
    pub force: Option<bool>,
}
