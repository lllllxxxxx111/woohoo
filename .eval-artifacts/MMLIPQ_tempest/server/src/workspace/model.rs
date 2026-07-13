use serde::Serialize;

use crate::ai::config::{AgentContact, ProjectWorkflowSummary};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBootstrap {
    pub projects: Vec<WorkspaceProject>,
    pub assets: Vec<WorkspaceAsset>,
    pub scripts: Vec<WorkspaceScript>,
    pub storyboards: Vec<WorkspaceStoryboard>,
    pub agents: Vec<AgentContact>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    pub status: String,
    pub phase: String,
    pub chat_sessions: Vec<WorkspaceChatSession>,
    pub agent_roster: Vec<AgentContact>,
    pub workflow: ProjectWorkflowSummary,
    pub assets_count: usize,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChatSession {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub messages: Vec<WorkspaceMessage>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub status: &'static str,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAsset {
    pub id: String,
    pub project_id: String,
    pub owner_user_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub url: String,
    pub metadata: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScript {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub content: String,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStoryboard {
    pub id: String,
    pub project_id: String,
    pub lines: Vec<WorkspaceStoryboardLine>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStoryboardLine {
    pub id: String,
    pub scene_number: i64,
    pub description: String,
    pub duration: i64,
    pub assets: Vec<WorkspaceAsset>,
}
