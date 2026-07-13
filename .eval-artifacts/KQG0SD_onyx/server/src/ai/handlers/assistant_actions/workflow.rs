use super::*;

pub(crate) fn preview_assistant_actions(
    envelope: &AssistantActionEnvelope,
) -> Vec<AssistantActionResult> {
    envelope
        .actions
        .iter()
        .map(|action| match action {
            AssistantAction::AssignExistingAgent {
                agent_id,
                agent_name,
                responsibility_kind,
                responsibility_label,
            } => {
                let display_name =
                    agent_name.as_deref().or(agent_id.as_deref()).unwrap_or("未命名智能体");
                let role_label = responsibility_label
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| role_kind_label(responsibility_kind.as_deref()));
                AssistantActionResult {
                    action_type: "assign_existing_agent".to_string(),
                    status: "needs_confirmation".to_string(),
                    summary: format!("待确认：将 {} 加入当前项目，职责 {}。", display_name, role_label),
                    agent_id: agent_id.clone(),
                    agent_name: agent_name.clone(),
                    responsibility_kind: responsibility_kind.clone(),
                    responsibility_label: responsibility_label.clone(),
                }
            }
            AssistantAction::CreateProjectAgent {
                name,
                role,
                responsibility_kind,
                responsibility_label,
                ..
            } => {
                let role_label = responsibility_label
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| {
                        responsibility_kind
                            .as_deref()
                            .map(|value| role_kind_label(Some(value)))
                            .unwrap_or(role)
                    });
                AssistantActionResult {
                    action_type: "create_project_agent".to_string(),
                    status: "needs_confirmation".to_string(),
                    summary: format!("待确认：在当前项目新建智能体 {}，职责 {}。", name, role_label),
                    agent_id: None,
                    agent_name: Some(name.clone()),
                    responsibility_kind: responsibility_kind.clone(),
                    responsibility_label: responsibility_label.clone(),
                }
            }
            AssistantAction::RemoveProjectAgent { agent_id, agent_name } => {
                let display_name =
                    agent_name.as_deref().or(agent_id.as_deref()).unwrap_or("未命名智能体");
                AssistantActionResult {
                    action_type: "remove_project_agent".to_string(),
                    status: "needs_confirmation".to_string(),
                    summary: format!("待确认：将 {} 从当前项目移出。", display_name),
                    agent_id: agent_id.clone(),
                    agent_name: agent_name.clone(),
                    responsibility_kind: None,
                    responsibility_label: None,
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
            } => AssistantActionResult {
                action_type: "search_project_files".to_string(),
                status: "needs_confirmation".to_string(),
                summary: format!(
                    "待确认：检索当前项目文件（query={}，type={}，createdAfter={}，createdBefore={}，minSize={}，maxSize={}，limit={}）。",
                    normalize_optional(query.clone()).unwrap_or_else(|| "无".to_string()),
                    normalize_optional(file_type.clone()).unwrap_or_else(|| "无".to_string()),
                    normalize_optional(created_after.clone()).unwrap_or_else(|| "无".to_string()),
                    normalize_optional(created_before.clone()).unwrap_or_else(|| "无".to_string()),
                    min_size.map(|value| value.to_string()).unwrap_or_else(|| "无".to_string()),
                    max_size.map(|value| value.to_string()).unwrap_or_else(|| "无".to_string()),
                    limit.map(|value| value.to_string()).unwrap_or_else(|| "默认".to_string()),
                ),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            },
            AssistantAction::CreateProjectDirectory { path } => AssistantActionResult {
                action_type: "create_project_directory".to_string(),
                status: "needs_confirmation".to_string(),
                summary: format!("待确认：在当前项目创建目录 {}。", compact_text(path)),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            },
            AssistantAction::CreateProjectFile { path, overwrite, .. } => AssistantActionResult {
                action_type: "create_project_file".to_string(),
                status: "needs_confirmation".to_string(),
                summary: format!(
                    "待确认：在当前项目写入文件 {}（覆盖模式：{}）。",
                    compact_text(path),
                    if overwrite.unwrap_or(false) { "覆盖已有文件" } else { "仅新建" }
                ),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            },
            AssistantAction::DeleteProjectPath { path, recursive } => AssistantActionResult {
                action_type: "delete_project_path".to_string(),
                status: "needs_confirmation".to_string(),
                summary: format!(
                    "待确认：删除当前项目路径 {}（递归：{}）。",
                    compact_text(path),
                    if recursive.unwrap_or(false) { "是" } else { "否" }
                ),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            },
            AssistantAction::MoveProjectPath {
                from_path,
                to_path,
                overwrite,
            } => AssistantActionResult {
                action_type: "move_project_path".to_string(),
                status: "needs_confirmation".to_string(),
                summary: format!(
                    "待确认：移动当前项目路径 {} -> {}（覆盖：{}）。",
                    compact_text(from_path),
                    compact_text(to_path),
                    if overwrite.unwrap_or(false) { "允许" } else { "不允许" }
                ),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            },
        })
        .collect()
}

pub(crate) fn build_assistant_action_workflow_guard(
    action_results: &[AssistantActionResult],
) -> WorkflowGuard {
    let action_excerpt = action_results
        .iter()
        .take(2)
        .map(|result| result.summary.trim_start_matches("待确认：").to_string())
        .collect::<Vec<_>>()
        .join("；");
    WorkflowGuard {
        title: "确认待执行动作".to_string(),
        summary: Some("以下动作需要你确认后才会真正执行。".to_string()),
        confirm_label: Some("确认执行".to_string()),
        suggested_reply: Some(format!(
            "我确认执行以下动作：{}。请现在应用变更并继续当前流程。",
            action_excerpt
        )),
        confirmed_at: None,
        consumed_at: None,
        reopened_at: None,
        items: action_results
            .iter()
            .map(|result| WorkflowGuardChecklistItem {
                label: result.summary.trim_start_matches("待确认：").to_string(),
                done: false,
                required: true,
                hint: Some("确认后才会在当前项目中执行。".to_string()),
            })
            .collect(),
    }
}

pub(crate) fn merge_workflow_guards(
    existing_guard: WorkflowGuard,
    action_guard: WorkflowGuard,
) -> WorkflowGuard {
    let mut items = existing_guard.items;
    items.extend(action_guard.items);

    let summary = match (existing_guard.summary, action_guard.summary) {
        (Some(existing), Some(action))
            if !existing.trim().is_empty() && !action.trim().is_empty() =>
        {
            Some(format!("{}\n\n{}", existing.trim(), action.trim()))
        }
        (Some(existing), _) => Some(existing),
        (_, Some(action)) => Some(action),
        _ => None,
    };

    WorkflowGuard {
        title: existing_guard.title,
        summary,
        confirm_label: existing_guard.confirm_label.or(action_guard.confirm_label),
        suggested_reply: existing_guard
            .suggested_reply
            .or(action_guard.suggested_reply),
        confirmed_at: existing_guard.confirmed_at.or(action_guard.confirmed_at),
        consumed_at: existing_guard.consumed_at.or(action_guard.consumed_at),
        reopened_at: existing_guard.reopened_at.or(action_guard.reopened_at),
        items,
    }
}

pub(crate) fn split_assistant_action_block(
    content: &str,
) -> (String, Option<AssistantActionEnvelope>) {
    let marker = "```woohoo-actions";
    let Some(start) = content.find(marker) else {
        return (content.trim().to_string(), None);
    };
    let after_marker = &content[start + marker.len()..];
    let Some(end_offset) = after_marker.find("```") else {
        return (content.trim().to_string(), None);
    };
    let json_block = after_marker[..end_offset].trim();
    let Some(parsed) = serde_json::from_str::<AssistantActionEnvelope>(json_block).ok() else {
        return (content.trim().to_string(), None);
    };
    let visible = format!(
        "{}\n{}",
        content[..start].trim(),
        after_marker[end_offset + 3..].trim()
    )
    .trim()
    .to_string();

    (visible, Some(parsed))
}

pub(crate) fn visible_stream_content(content: &str) -> String {
    const INTERNAL_BLOCK_MARKERS: [&str; 2] = ["```woohoo-confirm", "```woohoo-actions"];

    let mut visible = String::new();
    let mut cursor = 0usize;

    while cursor < content.len() {
        let remaining = &content[cursor..];
        let next_marker = INTERNAL_BLOCK_MARKERS
            .iter()
            .filter_map(|marker| remaining.find(marker).map(|offset| (offset, *marker)))
            .min_by_key(|(offset, _)| *offset);

        let Some((offset, marker)) = next_marker else {
            visible.push_str(remaining);
            break;
        };

        visible.push_str(&remaining[..offset]);
        let marker_start = cursor + offset;
        let after_marker = &content[marker_start + marker.len()..];
        let Some(end_offset) = after_marker.find("```") else {
            return trim_partial_internal_block_prefix(&visible);
        };
        cursor = marker_start + marker.len() + end_offset + 3;
    }

    trim_partial_internal_block_prefix(&visible)
}

fn trim_partial_internal_block_prefix(content: &str) -> String {
    const INTERNAL_BLOCK_MARKERS: [&str; 2] = ["```woohoo-confirm", "```woohoo-actions"];

    let mut trim_len = 0usize;
    for marker in INTERNAL_BLOCK_MARKERS {
        let max_prefix_len = marker.len().saturating_sub(1).min(content.len());
        for prefix_len in (1..=max_prefix_len).rev() {
            let start = content.len() - prefix_len;
            let Some(suffix) = content.get(start..) else {
                continue;
            };
            if suffix == &marker[..prefix_len] {
                trim_len = trim_len.max(prefix_len);
                break;
            }
        }
    }

    if trim_len == 0 {
        content.to_string()
    } else {
        content[..content.len() - trim_len].to_string()
    }
}

pub(crate) async fn load_confirmed_action_source(
    pool: &SqlitePool,
    user_id: &str,
    conversation_id: &str,
    confirmed_message_id: Option<&str>,
) -> AppResult<Option<ConfirmedAssistantActionSource>> {
    let Some(message_id) = confirmed_message_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let meta = sqlx::query_scalar::<_, Option<String>>(
        "SELECT m.meta
         FROM messages m
         INNER JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND m.conversation_id = ? AND m.role = 'assistant' AND c.user_id = ?",
    )
    .bind(message_id)
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .flatten()
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| AppError::Validation("确认来源消息不存在、不可访问或不属于当前对话".into()))?;

    let meta_json: serde_json::Value = serde_json::from_str(&meta)
        .map_err(|_| AppError::Validation("确认来源消息的元数据损坏，无法解析待执行动作".into()))?;

    if meta_json
        .get("workflowGuard")
        .and_then(|value| value.get("consumedAt"))
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        return Ok(None);
    }

    let Some(pending_action_envelope) = meta_json.get("pendingAssistantActions").cloned() else {
        return Ok(None);
    };
    let envelope = serde_json::from_value::<AssistantActionEnvelope>(pending_action_envelope)
        .map_err(|_| AppError::Validation("确认来源消息里的待执行动作格式无效".into()))?;

    Ok(Some(ConfirmedAssistantActionSource {
        message_id: message_id.to_string(),
        envelope,
        original_meta: meta,
    }))
}

pub(crate) async fn claim_confirmed_action_source(
    pool: &SqlitePool,
    user_id: &str,
    conversation_id: &str,
    source: &ConfirmedAssistantActionSource,
) -> AppResult<bool> {
    let mut meta_json: serde_json::Value =
        serde_json::from_str(&source.original_meta).map_err(|_| {
            AppError::Validation("确认来源消息的元数据损坏，无法开始执行待确认动作".into())
        })?;
    let now = chrono::Utc::now().to_rfc3339();

    if !meta_json.is_object() {
        meta_json = serde_json::json!({});
    }
    if meta_json.get("workflowGuard").is_none() {
        meta_json["workflowGuard"] = serde_json::json!({});
    }
    if let Some(workflow_guard) = meta_json
        .get_mut("workflowGuard")
        .and_then(serde_json::Value::as_object_mut)
    {
        if workflow_guard
            .get("consumedAt")
            .and_then(serde_json::Value::as_str)
            .is_some()
        {
            return Ok(false);
        }
        if workflow_guard
            .get("consumingAt")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !is_stale_confirmed_action_claim(value))
            .is_some()
        {
            return Ok(false);
        }
        workflow_guard
            .entry("confirmedAt".to_string())
            .or_insert_with(|| serde_json::Value::String(now.clone()));
        workflow_guard.insert("consumingAt".to_string(), serde_json::Value::String(now));
    }

    let meta_str = serde_json::to_string(&meta_json)
        .map_err(|_| AppError::Internal("无法序列化确认来源消息状态".into()))?;
    let updated = sqlx::query(
        "UPDATE messages
         SET meta = ?
         WHERE id = ? AND conversation_id = ? AND meta = ?
           AND EXISTS (
               SELECT 1 FROM conversations c
               WHERE c.id = messages.conversation_id AND c.user_id = ?
           )",
    )
    .bind(meta_str)
    .bind(&source.message_id)
    .bind(conversation_id)
    .bind(&source.original_meta)
    .bind(user_id)
    .execute(pool)
    .await?;

    Ok(updated.rows_affected() > 0)
}

pub(crate) async fn reconcile_confirmed_action_source_after_execution(
    pool: &SqlitePool,
    user_id: &str,
    conversation_id: &str,
    source: &ConfirmedAssistantActionSource,
    action_results: &[AssistantActionResult],
) -> AppResult<()> {
    let meta = sqlx::query_scalar::<_, Option<String>>(
        "SELECT m.meta
         FROM messages m
         INNER JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND m.conversation_id = ? AND m.role = 'assistant' AND c.user_id = ?",
    )
    .bind(&source.message_id)
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .flatten()
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| AppError::Validation("确认来源消息不存在、无法标记状态".into()))?;

    let mut meta_json: serde_json::Value = serde_json::from_str(&meta)
        .map_err(|_| AppError::Validation("确认来源消息的元数据损坏，无法更新状态".into()))?;
    let now = chrono::Utc::now().to_rfc3339();

    if !meta_json.is_object() {
        meta_json = serde_json::json!({});
    }
    let has_failed_actions = action_results
        .iter()
        .any(|result| result.status == "failed");

    if has_failed_actions {
        let retry_envelope = build_retryable_action_envelope(&source.envelope, action_results);
        let retry_results = preview_assistant_actions(&retry_envelope);
        let mut retry_guard = build_assistant_action_workflow_guard(&retry_results);
        retry_guard.confirmed_at = None;
        retry_guard.consumed_at = None;
        retry_guard.reopened_at = Some(now.clone());
        meta_json["pendingAssistantActions"] = serde_json::to_value(&retry_envelope)
            .map_err(|_| AppError::Internal("无法序列化剩余待确认动作".into()))?;
        meta_json["assistantActions"] = serde_json::to_value(&retry_results)
            .map_err(|_| AppError::Internal("无法序列化待确认动作预览".into()))?;
        meta_json["workflowGuard"] = serde_json::to_value(&retry_guard)
            .map_err(|_| AppError::Internal("无法序列化待确认清单".into()))?;
    } else {
        meta_json["pendingAssistantActions"] = serde_json::Value::Null;
        meta_json["assistantActions"] = serde_json::to_value(action_results)
            .map_err(|_| AppError::Internal("无法序列化成员调整结果".into()))?;

        if meta_json.get("workflowGuard").is_none() {
            meta_json["workflowGuard"] = serde_json::json!({});
        }
        if let Some(workflow_guard) = meta_json
            .get_mut("workflowGuard")
            .and_then(serde_json::Value::as_object_mut)
        {
            workflow_guard
                .entry("confirmedAt".to_string())
                .or_insert_with(|| serde_json::Value::String(now.clone()));
            workflow_guard.insert("consumingAt".to_string(), serde_json::Value::Null);
            workflow_guard.insert("consumedAt".to_string(), serde_json::Value::String(now));
        }
    }

    let meta_str = serde_json::to_string(&meta_json)
        .map_err(|_| AppError::Internal("无法序列化确认来源消息状态".into()))?;
    sqlx::query(
        "UPDATE messages
         SET meta = ?
         WHERE id = ? AND conversation_id = ?",
    )
    .bind(meta_str)
    .bind(&source.message_id)
    .bind(conversation_id)
    .execute(pool)
    .await?;

    Ok(())
}

fn build_retryable_action_envelope(
    original: &AssistantActionEnvelope,
    action_results: &[AssistantActionResult],
) -> AssistantActionEnvelope {
    let mut actions = Vec::new();

    for (index, action) in original.actions.iter().cloned().enumerate() {
        let Some(result) = action_results.get(index) else {
            actions.push(action);
            continue;
        };

        if result.status != "failed" {
            continue;
        }

        actions.push(normalize_retryable_action(action, result));
    }

    if actions.is_empty() {
        return original.clone();
    }

    AssistantActionEnvelope { actions }
}

fn normalize_retryable_action(
    action: AssistantAction,
    result: &AssistantActionResult,
) -> AssistantAction {
    match action {
        AssistantAction::CreateProjectAgent {
            responsibility_kind,
            responsibility_label,
            ..
        } if result.agent_id.is_some() => AssistantAction::AssignExistingAgent {
            agent_id: result.agent_id.clone(),
            agent_name: result.agent_name.clone(),
            responsibility_kind: result.responsibility_kind.clone().or(responsibility_kind),
            responsibility_label: result.responsibility_label.clone().or(responsibility_label),
        },
        other => other,
    }
}

pub(crate) fn merge_action_results_into_content(
    visible_content: &str,
    action_results: &[AssistantActionResult],
) -> String {
    let mut parts = Vec::new();
    let trimmed = visible_content.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }

    if !action_results.is_empty() {
        let applied = action_results
            .iter()
            .filter(|result| result.status != "needs_confirmation")
            .map(|result| format!("- {}", result.summary))
            .collect::<Vec<_>>()
            .join("\n");
        if !applied.is_empty() {
            parts.push(format!("[项目成员变更]\n{}", applied));
        }

        let pending = action_results
            .iter()
            .filter(|result| result.status == "needs_confirmation")
            .map(|result| format!("- {}", result.summary))
            .collect::<Vec<_>>()
            .join("\n");
        if !pending.is_empty() {
            parts.push(format!("[待确认的项目成员调整]\n{}", pending));
        }
    }

    if parts.is_empty() {
        "已执行项目成员调整。".to_string()
    } else {
        parts.join("\n\n")
    }
}
