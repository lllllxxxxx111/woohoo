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

/**
 * Cross-project asset search query parameters.
 *
 * All filters are optional; with no parameters the endpoint returns the user's
 * most recent assets across all projects (subject to limit/offset pagination).
 */
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchQuery {
    /// Full-text query matched against asset name, project name, and metadata
    /// fields (prompt, summary, description, tags).
    pub query: Option<String>,
    /// Filter by asset type: image | video | audio | document
    pub asset_type: Option<String>,
    /// Restrict to a single project (cross-project search if None)
    pub project_id: Option<String>,
    /// Only return favorited assets
    pub favorite_only: Option<bool>,
    /// Minimum rating (1-5)
    pub rating_min: Option<i32>,
    /// Filter by a single tag (must be present in metadata.tags[])
    pub tag: Option<String>,
    /// Sort order: recent | name | rating | created (default: recent)
    pub sort: Option<String>,
    /// Pagination limit (default: 50, max: 200)
    pub limit: Option<i64>,
    /// Pagination offset (default: 0)
    pub offset: Option<i64>,
}

/**
 * A single reference to an asset from another entity (storyboard, pipeline, etc.).
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReference {
    /// Reference type discriminator
    pub ref_type: AssetReferenceType,
    /// ID of the project that owns the referencing entity
    pub project_id: String,
    /// Human-readable project name
    pub project_name: String,
    /// Display title for the referencing entity (e.g. storyboard scene title, pipeline step name)
    pub title: String,
    /// Optional sub-locator (scene number, step key, etc.)
    pub sub_locator: Option<String>,
    /// ID of the referencing entity (storyboard line, pipeline step, etc.)
    pub entity_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AssetReferenceType {
    /// Referenced from a storyboard line via storyboard_line_assets
    Storyboard,
    /// Referenced from a pipeline step output (design/render output references this asset)
    PipelineStep,
    /// Referenced from a pipeline step's input (output_ref or input_summary JSON)
    PipelineStepInput,
}

/**
 * Response body for GET /api/assets/{id}/references
 */
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetReferencesResponse {
    pub asset_id: String,
    pub references: Vec<AssetReference>,
    pub total_count: usize,
    /// True if there are any references (convenience flag for UI)
    pub has_references: bool,
}

/**
 * Response body for DELETE /api/assets/{id} when the asset is still referenced.
 * Returns HTTP 409 Conflict with this payload so the frontend can show the impact.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDeleteBlockedResponse {
    pub error: String,
    pub error_code: &'static str,
    pub references: Vec<AssetReference>,
    pub reference_count: usize,
}

/**
 * Query parameters for DELETE /api/assets/{id} to control safe-delete behavior.
 */
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetDeleteQuery {
    /// If true, force delete even when references exist (cascading cleanup).
    /// Defaults to false (safe mode: block if references exist).
    pub force: Option<bool>,
}

/**
 * Request body for tag update (PUT /api/assets/{id}/tags).
 *
 * Tags are stored in assets.metadata.tags as a JSON array of strings, merged
 * with existing metadata so that favorite/rating/prompt/review fields are preserved.
 */
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetTagsReq {
    /// Complete replacement list of tags (replaces any existing tags).
    pub tags: Vec<String>,
}
