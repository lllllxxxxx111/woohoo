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
