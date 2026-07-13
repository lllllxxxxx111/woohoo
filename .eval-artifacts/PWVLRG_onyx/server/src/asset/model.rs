use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
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

/// 跨项目素材搜索查询参数
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchQuery {
    /// 搜索关键词，匹配素材名、项目名、metadata 中常见字段
    pub query: Option<String>,
    /// 素材类型筛选
    pub asset_type: Option<String>,
    /// 限定项目 ID
    pub project_id: Option<String>,
    /// 只看收藏
    pub favorite_only: Option<bool>,
    /// 最低评分 (1-5)
    pub rating_min: Option<i64>,
    /// 标签筛选（单个标签精确匹配）
    pub tag: Option<String>,
    /// 排序字段: "createdAt" | "updatedAt" | "name" | "rating"
    pub sort: Option<String>,
    /// 排序方向: "asc" | "desc"
    pub order: Option<String>,
    /// 分页偏移
    pub offset: Option<i64>,
    /// 分页限制
    pub limit: Option<i64>,
}

/// 素材引用关系
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AssetReference {
    /// 引用类型: "storyboard" | "pipeline"
    pub ref_type: String,
    /// 引用所在项目 ID
    pub project_id: String,
    /// 引用所在项目名称
    pub project_name: String,
    /// 分镜号或步骤 key
    pub ref_key: String,
    /// 可展示标题
    pub ref_title: String,
}

/// 引用关系汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReferenceSummary {
    /// 素材 ID
    pub asset_id: String,
    /// 是否存在引用
    pub has_references: bool,
    /// 引用总数
    pub total_count: i64,
    /// 引用详情列表
    pub references: Vec<AssetReference>,
}

/// 删除素材请求参数
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAssetQuery {
    /// 强制删除（即使存在引用）
    pub force: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_asset_search_query_deserialization() {
        let json = r#"{
            "query": "夜景",
            "assetType": "image",
            "projectId": "proj-1",
            "favoriteOnly": true,
            "ratingMin": 3,
            "tag": "背景",
            "sort": "createdAt",
            "order": "desc",
            "offset": 10,
            "limit": 20
        }"#;

        let query: AssetSearchQuery = serde_json::from_str(json).unwrap();
        assert_eq!(query.query, Some("夜景".to_string()));
        assert_eq!(query.asset_type, Some("image".to_string()));
        assert_eq!(query.project_id, Some("proj-1".to_string()));
        assert_eq!(query.favorite_only, Some(true));
        assert_eq!(query.rating_min, Some(3));
        assert_eq!(query.tag, Some("背景".to_string()));
        assert_eq!(query.sort, Some("createdAt".to_string()));
        assert_eq!(query.order, Some("desc".to_string()));
        assert_eq!(query.offset, Some(10));
        assert_eq!(query.limit, Some(20));
    }

    #[test]
    fn test_asset_search_query_defaults() {
        let json = "{}";
        let query: AssetSearchQuery = serde_json::from_str(json).unwrap();
        assert!(query.query.is_none());
        assert!(query.asset_type.is_none());
        assert!(query.project_id.is_none());
        assert!(query.favorite_only.is_none());
        assert!(query.rating_min.is_none());
        assert!(query.tag.is_none());
        assert!(query.sort.is_none());
        assert!(query.order.is_none());
        assert_eq!(query.offset, None);
        assert_eq!(query.limit, None);
    }

    #[test]
    fn test_asset_search_query_camel_case() {
        let json = r#"{"assetType": "video", "favoriteOnly": true, "ratingMin": 5}"#;
        let query: AssetSearchQuery = serde_json::from_str(json).unwrap();
        assert_eq!(query.asset_type, Some("video".to_string()));
        assert_eq!(query.favorite_only, Some(true));
        assert_eq!(query.rating_min, Some(5));
    }

    #[test]
    fn test_delete_asset_query_force() {
        let json = r#"{"force": true}"#;
        let query: DeleteAssetQuery = serde_json::from_str(json).unwrap();
        assert_eq!(query.force, Some(true));

        let json2 = r#"{"force": false}"#;
        let query2: DeleteAssetQuery = serde_json::from_str(json2).unwrap();
        assert_eq!(query2.force, Some(false));
    }

    #[test]
    fn test_delete_asset_query_default() {
        let json = "{}";
        let query: DeleteAssetQuery = serde_json::from_str(json).unwrap();
        assert!(query.force.is_none());
    }

    #[test]
    fn test_asset_reference_serialization() {
        let reference = AssetReference {
            ref_type: "storyboard".to_string(),
            project_id: "proj-1".to_string(),
            project_name: "测试项目".to_string(),
            ref_key: "第1镜".to_string(),
            ref_title: "分镜: 城市夜景".to_string(),
        };

        let json = serde_json::to_string(&reference).unwrap();
        assert!(json.contains("refType"));
        assert!(json.contains("projectId"));
        assert!(json.contains("projectName"));
        assert!(json.contains("refKey"));
        assert!(json.contains("refTitle"));

        let deserialized: AssetReference = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.ref_type, "storyboard");
        assert_eq!(deserialized.project_id, "proj-1");
    }

    #[test]
    fn test_asset_reference_summary_serialization() {
        let summary = AssetReferenceSummary {
            asset_id: "asset-1".to_string(),
            has_references: true,
            total_count: 3,
            references: vec![
                AssetReference {
                    ref_type: "storyboard".to_string(),
                    project_id: "proj-1".to_string(),
                    project_name: "项目A".to_string(),
                    ref_key: "第1镜".to_string(),
                    ref_title: "分镜: 开场".to_string(),
                },
                AssetReference {
                    ref_type: "pipeline".to_string(),
                    project_id: "proj-1".to_string(),
                    project_name: "项目A".to_string(),
                    ref_key: "storyboard_render".to_string(),
                    ref_title: "流水线步骤: 分镜渲染".to_string(),
                },
            ],
        };

        let json = serde_json::to_string(&summary).unwrap();
        assert!(json.contains("assetId"));
        assert!(json.contains("hasReferences"));
        assert!(json.contains("totalCount"));
        assert!(json.contains("references"));

        let deserialized: AssetReferenceSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.total_count, 3);
        assert_eq!(deserialized.references.len(), 2);
        assert_eq!(deserialized.references[0].ref_type, "storyboard");
        assert_eq!(deserialized.references[1].ref_type, "pipeline");
    }
}
