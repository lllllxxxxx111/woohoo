use axum::{
    extract::{Extension, State},
    Json,
};
use chrono::{DateTime, Utc};
use std::collections::HashMap;

use crate::{
    ai, asset, auth::middleware::UserId, conversation, error::AppResult, project, script,
    storyboard, AppState,
};

use super::model::{
    WorkspaceAsset, WorkspaceBootstrap, WorkspaceChatSession, WorkspaceMessage, WorkspaceProject,
    WorkspaceScript, WorkspaceStoryboard, WorkspaceStoryboardLine,
};

pub async fn bootstrap(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
) -> AppResult<Json<WorkspaceBootstrap>> {
    let (projects, assets, scripts, storyboards, conversations, messages) = tokio::try_join!(
        project::repo::list_by_user(&state.db, &user_id.0),
        asset::repo::list_by_user(&state.db, &user_id.0),
        script::repo::list_by_user(&state.db, &user_id.0),
        storyboard::repo::list_by_user(&state.db, &user_id.0),
        conversation::repo::list_by_user(&state.db, &user_id.0),
        conversation::repo::list_messages_by_user(&state.db, &user_id.0),
    )?;

    let agents =
        match ai::catalog_handlers::load_agent_contacts(&state.db, &state.ai_runtime, &user_id.0)
            .await
        {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!("加载智能体联系人失败，返回空列表: {}", e);
                vec![]
            }
        };

    let project_ids = projects
        .iter()
        .map(|project| project.id.clone())
        .collect::<Vec<_>>();
    let project_rosters = match ai::catalog_handlers::load_project_agent_contacts(
        &state.db,
        &state.ai_runtime,
        &user_id.0,
        &project_ids,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("加载项目智能体联系人失败，返回空映射: {}", e);
            HashMap::new()
        }
    };
    let task_counts = state.ai_runtime.project_task_counts(&user_id.0).await;

    let mut asset_counts: HashMap<&str, usize> = HashMap::new();
    for asset in &assets {
        *asset_counts.entry(asset.project_id.as_str()).or_insert(0) += 1;
    }

    let mut script_ready_by_project: HashMap<&str, bool> = HashMap::new();
    for script in &scripts {
        script_ready_by_project.insert(
            script.project_id.as_str(),
            !script.content.trim().is_empty(),
        );
    }

    let mut storyboard_line_counts: HashMap<&str, i64> = HashMap::new();
    for storyboard in &storyboards {
        storyboard_line_counts.insert(
            storyboard.project_id.as_str(),
            storyboard.lines.len() as i64,
        );
    }

    let conversation_project_map = conversations
        .iter()
        .map(|conversation| (conversation.id.clone(), conversation.project_id.clone()))
        .collect::<HashMap<_, _>>();

    let mut messages_by_conversation: HashMap<String, Vec<conversation::model::Message>> =
        HashMap::new();
    let mut message_counts_by_project: HashMap<String, i64> = HashMap::new();
    for message in messages {
        if let Some(project_id) = conversation_project_map.get(&message.conversation_id) {
            *message_counts_by_project
                .entry(project_id.clone())
                .or_insert(0) += 1;
        }
        messages_by_conversation
            .entry(message.conversation_id.clone())
            .or_default()
            .push(message);
    }

    let mut conversations_by_project: HashMap<String, Vec<conversation::model::Conversation>> =
        HashMap::new();
    for conversation in conversations {
        conversations_by_project
            .entry(conversation.project_id.clone())
            .or_default()
            .push(conversation);
    }

    let mut project_items = Vec::with_capacity(projects.len());
    for project in projects {
        let project_id = project.id;
        let assets_count = asset_counts.get(project_id.as_str()).copied().unwrap_or(0);
        let agent_roster = project_rosters
            .get(&project_id)
            .cloned()
            .unwrap_or_default();
        let workflow = ai::catalog_handlers::build_project_workflow_summary(
            &project.status,
            &project.phase,
            assets_count as i64,
            script_ready_by_project
                .get(project_id.as_str())
                .copied()
                .unwrap_or(false),
            storyboard_line_counts
                .get(project_id.as_str())
                .copied()
                .unwrap_or(0),
            conversations_by_project
                .get(&project_id)
                .map(|items| items.len() as i64)
                .unwrap_or(0),
            message_counts_by_project
                .get(&project_id)
                .copied()
                .unwrap_or(0),
            agent_roster.len() as i64,
            task_counts.get(&project_id).copied().unwrap_or_default(),
            ai::catalog_handlers::build_project_role_counts(&agent_roster),
        );
        let mut chat_sessions = Vec::new();

        if let Some(project_conversations) = conversations_by_project.remove(&project_id) {
            chat_sessions.reserve(project_conversations.len());

            for conversation in project_conversations {
                chat_sessions.push(WorkspaceChatSession {
                    id: conversation.id.clone(),
                    project_id: conversation.project_id,
                    title: conversation.title,
                    messages: messages_by_conversation
                        .remove(&conversation.id)
                        .unwrap_or_default()
                        .into_iter()
                        .map(map_message)
                        .collect(),
                    updated_at: to_epoch_millis(&conversation.updated_at),
                });
            }
        }

        project_items.push(WorkspaceProject {
            id: project_id,
            name: project.name,
            status: project.status,
            phase: project.phase,
            chat_sessions,
            agent_roster,
            workflow,
            assets_count,
            created_at: to_epoch_millis(&project.created_at),
        });
    }

    let payload = WorkspaceBootstrap {
        projects: project_items,
        assets: assets.into_iter().map(map_asset).collect(),
        scripts: scripts
            .into_iter()
            .map(|script| WorkspaceScript {
                id: script.id,
                project_id: script.project_id,
                title: script.title,
                content: script.content,
                updated_at: to_epoch_millis(&script.updated_at),
            })
            .collect(),
        storyboards: storyboards
            .into_iter()
            .map(|storyboard| WorkspaceStoryboard {
                id: storyboard.id,
                project_id: storyboard.project_id,
                lines: storyboard
                    .lines
                    .into_iter()
                    .map(|line| WorkspaceStoryboardLine {
                        id: line.id,
                        scene_number: line.scene_number,
                        description: line.description,
                        duration: line.duration,
                        assets: line.assets.into_iter().map(map_asset).collect(),
                    })
                    .collect(),
                updated_at: to_epoch_millis(&storyboard.updated_at),
            })
            .collect(),
        agents,
    };

    Ok(Json(payload))
}

fn map_message(message: conversation::model::Message) -> WorkspaceMessage {
    WorkspaceMessage {
        id: message.id,
        role: if message.role == "assistant" {
            "ai".to_string()
        } else {
            message.role
        },
        content: message.content,
        timestamp: to_epoch_millis(&message.created_at),
        agent_id: message.agent_id,
        model: message.model_used,
        status: "done",
        msg_type: message.msg_type,
        meta: message
            .meta
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok()),
    }
}

fn map_asset(asset: asset::model::Asset) -> WorkspaceAsset {
    WorkspaceAsset {
        id: asset.id,
        project_id: asset.project_id,
        name: asset.name,
        asset_type: asset.asset_type,
        url: asset.url,
        metadata: asset
            .metadata
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok()),
        created_at: to_epoch_millis(&asset.created_at),
        updated_at: to_epoch_millis(&asset.updated_at),
    }
}

fn to_epoch_millis(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| Utc::now().timestamp_millis())
}
