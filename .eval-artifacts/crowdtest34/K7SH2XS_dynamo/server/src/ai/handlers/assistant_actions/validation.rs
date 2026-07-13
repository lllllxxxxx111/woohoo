use super::*;

pub(crate) fn validate_action_envelope(envelope: &AssistantActionEnvelope) -> AppResult<()> {
    if envelope.actions.len() > MAX_ACTIONS_PER_ENVELOPE {
        return Err(AppError::Validation(
            format!(
                "动作数量超出限制（{} > {}）",
                envelope.actions.len(),
                MAX_ACTIONS_PER_ENVELOPE
            )
            .into(),
        ));
    }

    for (index, action) in envelope.actions.iter().enumerate() {
        validate_single_action(action, index)?;
    }

    Ok(())
}

pub(crate) async fn load_assistant_action_policy(
    pool: &SqlitePool,
    user_id: &str,
) -> AssistantActionPolicy {
    let row = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT policy_json, expires_at FROM user_ai_policies WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await;

    let Ok(Some((policy_json, expires_at))) = row else {
        return AssistantActionPolicy::default();
    };

    if let Some(expires_at) = expires_at {
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&expires_at) {
            if chrono::Utc::now() > parsed.with_timezone(&chrono::Utc) {
                return AssistantActionPolicy::default();
            }
        }
    }

    serde_json::from_str::<AssistantActionPolicy>(&policy_json).unwrap_or_default()
}

fn assistant_action_type(action: &AssistantAction) -> &'static str {
    match action {
        AssistantAction::AssignExistingAgent { .. } => "assign_existing_agent",
        AssistantAction::CreateProjectAgent { .. } => "create_project_agent",
        AssistantAction::RemoveProjectAgent { .. } => "remove_project_agent",
        AssistantAction::SearchProjectFiles { .. } => "search_project_files",
        AssistantAction::CreateProjectDirectory { .. } => "create_project_directory",
        AssistantAction::CreateProjectFile { .. } => "create_project_file",
        AssistantAction::DeleteProjectPath { .. } => "delete_project_path",
        AssistantAction::MoveProjectPath { .. } => "move_project_path",
    }
}

pub(crate) fn validate_action_envelope_with_policy(
    envelope: &AssistantActionEnvelope,
    policy: &AssistantActionPolicy,
) -> AppResult<()> {
    if !policy.enabled {
        return Err(AppError::Validation(
            "当前用户策略已禁用助理动作执行".into(),
        ));
    }

    if envelope.actions.len() > policy.max_actions_per_response {
        return Err(AppError::Validation(
            format!(
                "动作数量超出策略限制（{} > {}）",
                envelope.actions.len(),
                policy.max_actions_per_response
            )
            .into(),
        ));
    }

    if policy.allowed_action_types.is_empty() {
        return Ok(());
    }

    for action in &envelope.actions {
        let action_type = assistant_action_type(action);
        if !policy
            .allowed_action_types
            .iter()
            .any(|value| value == action_type)
        {
            return Err(AppError::Validation(
                format!("动作 {} 不在当前策略白名单中", action_type).into(),
            ));
        }
    }

    Ok(())
}

/**
 * 校验单个动作的合法性和字段安全性
 */
fn validate_single_action(action: &AssistantAction, index: usize) -> AppResult<()> {
    let action_type = match action {
        AssistantAction::AssignExistingAgent { .. } => "assign_existing_agent",
        AssistantAction::CreateProjectAgent { .. } => "create_project_agent",
        AssistantAction::RemoveProjectAgent { .. } => "remove_project_agent",
        AssistantAction::SearchProjectFiles { .. } => "search_project_files",
        AssistantAction::CreateProjectDirectory { .. } => "create_project_directory",
        AssistantAction::CreateProjectFile { .. } => "create_project_file",
        AssistantAction::DeleteProjectPath { .. } => "delete_project_path",
        AssistantAction::MoveProjectPath { .. } => "move_project_path",
    };

    if !ALLOWED_ACTION_TYPES.contains(&action_type) {
        return Err(AppError::Validation(
            format!("不支持的动作类型: {} (索引 {})", action_type, index).into(),
        ));
    }

    fn check_field_length(value: &str, field_name: &str, max_len: usize) -> AppResult<()> {
        if value.len() > max_len {
            return Err(AppError::Validation(
                format!(
                    "字段 {} 超出长度限制 ({} > {})",
                    field_name,
                    value.len(),
                    max_len
                )
                .into(),
            ));
        }
        Ok(())
    }

    match action {
        AssistantAction::AssignExistingAgent {
            agent_id,
            agent_name,
            responsibility_kind,
            responsibility_label,
        } => {
            if let Some(ref id) = agent_id {
                check_field_length(id, "agent_id", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref name) = agent_name {
                check_field_length(name, "agent_name", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref kind) = responsibility_kind {
                check_field_length(kind, "responsibility_kind", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref label) = responsibility_label {
                check_field_length(label, "responsibility_label", MAX_FIELD_LENGTH)?;
            }
        }
        AssistantAction::CreateProjectAgent {
            name,
            role,
            description,
            system_prompt,
            endpoint_id,
            model,
            badge,
            responsibility_kind,
            responsibility_label,
            ..
        } => {
            check_field_length(name, "name", MAX_FIELD_LENGTH)?;
            check_field_length(role, "role", MAX_FIELD_LENGTH)?;
            if let Some(ref desc) = description {
                check_field_length(desc, "description", MAX_FIELD_LENGTH * 4)?;
            }
            if let Some(ref prompt) = system_prompt {
                check_field_length(prompt, "system_prompt", MAX_SYSTEM_PROMPT_LENGTH)?;
            }
            if let Some(ref eid) = endpoint_id {
                check_field_length(eid, "endpoint_id", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref m) = model {
                check_field_length(m, "model", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref b) = badge {
                check_field_length(b, "badge", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref kind) = responsibility_kind {
                check_field_length(kind, "responsibility_kind", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref label) = responsibility_label {
                check_field_length(label, "responsibility_label", MAX_FIELD_LENGTH)?;
            }
        }
        AssistantAction::RemoveProjectAgent {
            agent_id,
            agent_name,
        } => {
            if let Some(ref id) = agent_id {
                check_field_length(id, "agent_id", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref name) = agent_name {
                check_field_length(name, "agent_name", MAX_FIELD_LENGTH)?;
            }
        }
        AssistantAction::SearchProjectFiles {
            query,
            file_type,
            created_after,
            created_before,
            min_size,
            max_size,
            limit,
        } => {
            if let Some(ref value) = query {
                check_field_length(value, "query", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref value) = file_type {
                check_field_length(value, "file_type", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref value) = created_after {
                check_field_length(value, "created_after", MAX_FIELD_LENGTH)?;
            }
            if let Some(ref value) = created_before {
                check_field_length(value, "created_before", MAX_FIELD_LENGTH)?;
            }
            if let Some(value) = min_size {
                if *value < 0 {
                    return Err(AppError::Validation("min_size 不能小于 0".into()));
                }
            }
            if let Some(value) = max_size {
                if *value < 0 {
                    return Err(AppError::Validation("max_size 不能小于 0".into()));
                }
            }
            if let (Some(min_value), Some(max_value)) = (min_size, max_size) {
                if min_value > max_value {
                    return Err(AppError::Validation("min_size 不能大于 max_size".into()));
                }
            }
            if let Some(value) = limit {
                if *value == 0 || *value > MAX_PROJECT_FILE_SEARCH_RESULTS {
                    return Err(AppError::Validation(
                        format!("limit 必须在 1~{} 之间", MAX_PROJECT_FILE_SEARCH_RESULTS).into(),
                    ));
                }
            }
        }
        AssistantAction::CreateProjectDirectory { path } => {
            check_field_length(path, "path", MAX_PROJECT_PATH_LENGTH)?;
        }
        AssistantAction::CreateProjectFile { path, content, .. } => {
            check_field_length(path, "path", MAX_PROJECT_PATH_LENGTH)?;
            if content.len() > MAX_PROJECT_FILE_CONTENT_LENGTH {
                return Err(AppError::Validation(
                    format!(
                        "文件内容超出限制 ({} > {})",
                        content.len(),
                        MAX_PROJECT_FILE_CONTENT_LENGTH
                    )
                    .into(),
                ));
            }
        }
        AssistantAction::DeleteProjectPath { path, .. } => {
            check_field_length(path, "path", MAX_PROJECT_PATH_LENGTH)?;
        }
        AssistantAction::MoveProjectPath {
            from_path, to_path, ..
        } => {
            check_field_length(from_path, "from_path", MAX_PROJECT_PATH_LENGTH)?;
            check_field_length(to_path, "to_path", MAX_PROJECT_PATH_LENGTH)?;
        }
    }

    Ok(())
}

/**
 * 强制要求变更类动作必须使用agent_id而非agent_name
 * 防止同名智能体误操作
 */
pub(crate) fn require_agent_id_for_mutating_actions(
    action: &AssistantAction,
    action_index: usize,
) -> AppResult<()> {
    match action {
        AssistantAction::RemoveProjectAgent { agent_id, .. } => {
            if agent_id.as_ref().map_or(true, |id| id.trim().is_empty()) {
                return Err(AppError::Validation(
                    format!(
                        "删除智能体动作必须提供agent_id，不允许仅使用agent_name（索引 {}），防止误删同名智能体",
                        action_index
                    )
                    .into(),
                ));
            }
        }
        _ => {}
    }
    Ok(())
}
