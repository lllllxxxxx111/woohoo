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

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AssetWithProject {
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

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssetReq {
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub url: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetReq {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub asset_type: Option<String>,
    pub url: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchQuery {
    pub query: Option<String>,
    #[serde(rename = "type", alias = "assetType")]
    pub asset_type: Option<String>,
    pub project_id: Option<String>,
    pub favorite_only: Option<bool>,
    pub rating_min: Option<i32>,
    pub tag: Option<String>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReference {
    pub ref_type: AssetReferenceType,
    pub project_id: String,
    pub project_name: String,
    pub title: String,
    pub sub_locator: Option<String>,
    pub entity_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AssetReferenceType {
    Storyboard,
    PipelineStep,
    PipelineStepInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetReferencesResponse {
    pub asset_id: String,
    pub references: Vec<AssetReference>,
    pub total_count: usize,
    pub has_references: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDeleteBlockedResponse {
    pub error: String,
    pub error_code: &'static str,
    pub references: Vec<AssetReference>,
    pub reference_count: usize,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetDeleteQuery {
    pub force: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetTagsReq {
    pub tags: Vec<String>,
}
