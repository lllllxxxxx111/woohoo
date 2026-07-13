use super::validation::{
    load_assistant_action_policy, require_agent_id_for_mutating_actions, validate_action_envelope,
    validate_action_envelope_with_policy,
};
use super::*;

pub(crate) async fn execute_assistant_actions(
    state: &AppState,
    user_id: &str,
    context: &ResolvedChatContext,
    envelope: AssistantActionEnvelope,
) -> Vec<AssistantActionResult> {
    let policy = load_assistant_action_policy(&state.db, user_id).await;
    if let Err(err) = validate_action_envelope_with_policy(&envelope, &policy) {
        return vec![AssistantActionResult {
            action_type: "policy".to_string(),
            status: "failed".to_string(),
            summary: err.to_string(),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        }];
    }

    if let Err(err) = validate_action_envelope(&envelope) {
        return vec![AssistantActionResult {
            action_type: "validation".to_string(),
            status: "failed".to_string(),
            summary: err.to_string(),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        }];
    }

    let mut results = Vec::new();

    for (action_index, action) in envelope.actions.iter().enumerate() {
        if let Err(err) = require_agent_id_for_mutating_actions(action, action_index) {
            results.push(AssistantActionResult {
                action_type: format!("{:?}", action)
                    .split('(')
                    .next()
                    .unwrap_or("unknown")
                    .to_lowercase()
                    .replace('_', ""),
                status: "failed".to_string(),
                summary: err.to_string(),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            });
            continue;
        }

        match action {
            AssistantAction::AssignExistingAgent {
                agent_id,
                agent_name,
                responsibility_kind,
                responsibility_label,
            } => {
                results.push(
                    execute_assign_existing_agent(
                        state,
                        user_id,
                        &context.conversation.project_id,
                        agent_id.as_deref(),
                        agent_name.as_deref(),
                        responsibility_kind.as_deref(),
                        responsibility_label.as_deref(),
                    )
                    .await,
                );
            }
            AssistantAction::CreateProjectAgent {
                name,
                role,
                description,
                system_prompt,
                endpoint_id,
                model,
                temperature,
                max_tokens,
                badge,
                responsibility_kind,
                responsibility_label,
            } => {
                results.push(
                    execute_create_project_agent(
                        state,
                        user_id,
                        &context.conversation.project_id,
                        &name,
                        &role,
                        description.as_deref(),
                        system_prompt.as_deref(),
                        endpoint_id.as_deref(),
                        model.as_deref(),
                        *temperature,
                        *max_tokens,
                        badge.as_deref(),
                        responsibility_kind.as_deref(),
                        responsibility_label.as_deref(),
                    )
                    .await,
                );
            }
            AssistantAction::RemoveProjectAgent {
                agent_id,
                agent_name,
            } => {
                results.push(
                    execute_remove_project_agent(
                        state,
                        user_id,
                        &context.conversation.project_id,
                        agent_id.as_deref(),
                        agent_name.as_deref(),
                    )
                    .await,
                );
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
                results.push(
                    execute_search_project_files(
                        state,
                        user_id,
                        &context.conversation.project_id,
                        query.as_deref(),
                        file_type.as_deref(),
                        created_after.as_deref(),
                        created_before.as_deref(),
                        *min_size,
                        *max_size,
                        *limit,
                    )
                    .await,
                );
            }
            AssistantAction::CreateProjectDirectory { path } => {
                results.push(
                    execute_create_project_directory(
                        state,
                        user_id,
                        &context.conversation.project_id,
                        path,
                    )
                    .await,
                );
            }
            AssistantAction::CreateProjectFile {
                path,
                content,
                overwrite,
            } => {
                results.push(
                    execute_create_project_file(
                        state,
                        user_id,
                        &context.conversation.project_id,
                        path,
                        content,
                        overwrite.unwrap_or(false),
                    )
                    .await,
                );
            }
            AssistantAction::DeleteProjectPath { path, recursive } => {
                results.push(
                    execute_delete_project_path(
                        state,
                        user_id,
                        &context.conversation.project_id,
                        path,
                        recursive.unwrap_or(false),
                    )
                    .await,
                );
            }
            AssistantAction::MoveProjectPath {
                from_path,
                to_path,
                overwrite,
            } => {
                results.push(
                    execute_move_project_path(
                        state,
                        user_id,
                        &context.conversation.project_id,
                        from_path,
                        to_path,
                        overwrite.unwrap_or(false),
                    )
                    .await,
                );
            }
        }
    }

    results
}

async fn execute_assign_existing_agent(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    agent_id: Option<&str>,
    agent_name: Option<&str>,
    responsibility_kind: Option<&str>,
    responsibility_label: Option<&str>,
) -> AssistantActionResult {
    let resolved = resolve_agent_for_project_action(&state.db, user_id, agent_id, agent_name).await;
    match resolved {
        Ok(agent) => {
            match upsert_project_agent_assignment(
                &state.db,
                user_id,
                project_id,
                &agent.id,
                responsibility_kind,
                responsibility_label,
                "existing",
            )
            .await
            {
                Ok(()) => {
                    let agent_name = agent.name.clone();
                    let agent_role = agent.role.clone();
                    let normalized_kind = normalize_responsibility_kind(
                        responsibility_kind,
                        Some(agent_name.as_str()),
                        Some(agent_role.as_str()),
                    )
                    .to_string();
                    AssistantActionResult {
                        action_type: "assign_existing_agent".to_string(),
                        status: "applied".to_string(),
                        summary: format!(
                            "已将 {} 加入当前项目，职责分类 {}。",
                            agent_name,
                            role_kind_label(Some(normalized_kind.as_str()))
                        ),
                        agent_id: Some(agent.id),
                        agent_name: Some(agent_name),
                        responsibility_kind: Some(normalized_kind),
                        responsibility_label: normalize_optional(
                            responsibility_label.map(str::to_string),
                        ),
                    }
                }
                Err(error) => AssistantActionResult {
                    action_type: "assign_existing_agent".to_string(),
                    status: "failed".to_string(),
                    summary: format!("复用智能体失败: {}", error),
                    agent_id: Some(agent.id),
                    agent_name: Some(agent.name),
                    responsibility_kind: None,
                    responsibility_label: None,
                },
            }
        }
        Err(error) => AssistantActionResult {
            action_type: "assign_existing_agent".to_string(),
            status: "failed".to_string(),
            summary: format!("复用智能体失败: {}", error),
            agent_id: agent_id.map(str::to_string),
            agent_name: agent_name.map(str::to_string),
            responsibility_kind: None,
            responsibility_label: None,
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_create_project_agent(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    name: &str,
    role: &str,
    description: Option<&str>,
    system_prompt: Option<&str>,
    endpoint_id: Option<&str>,
    model: Option<&str>,
    temperature: Option<f64>,
    max_tokens: Option<i64>,
    badge: Option<&str>,
    responsibility_kind: Option<&str>,
    responsibility_label: Option<&str>,
) -> AssistantActionResult {
    if name.trim().is_empty() || role.trim().is_empty() {
        return AssistantActionResult {
            action_type: "create_project_agent".to_string(),
            status: "failed".to_string(),
            summary: "创建项目智能体失败: name/role 不能为空".to_string(),
            agent_id: None,
            agent_name: Some(name.trim().to_string()),
            responsibility_kind: None,
            responsibility_label: None,
        };
    }

    if let Err(error) = validate_agent_endpoint_access(&state.db, user_id, endpoint_id).await {
        return AssistantActionResult {
            action_type: "create_project_agent".to_string(),
            status: "failed".to_string(),
            summary: format!("创建项目智能体失败: {}", error),
            agent_id: None,
            agent_name: Some(name.trim().to_string()),
            responsibility_kind: None,
            responsibility_label: None,
        };
    }

    let agent_id = Uuid::new_v4().to_string();
    let prompt = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "你负责当前项目的{}。回答时聚焦该职责的执行、交付和风险。",
                role.trim()
            )
        });

    /*
     * 使用事务包装智能体创建和项目绑定操作，确保数据一致性
     * 如果任一操作失败，整个事务回滚，避免出现数据不一致状态
     */
    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            return AssistantActionResult {
                action_type: "create_project_agent".to_string(),
                status: "failed".to_string(),
                summary: format!("创建项目智能体失败: 事务启动失败 - {}", error),
                agent_id: None,
                agent_name: Some(name.trim().to_string()),
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let created = sqlx::query_as::<_, Agent>(
        "INSERT INTO agents (
             id, user_id, name, role, description, system_prompt, endpoint_id, model,
             temperature, max_tokens, badge
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&agent_id)
    .bind(user_id)
    .bind(name.trim())
    .bind(role.trim())
    .bind(description.unwrap_or("").trim())
    .bind(prompt)
    .bind(endpoint_id.map(str::trim))
    .bind(model.map(str::trim))
    .bind(temperature.unwrap_or(0.7))
    .bind(max_tokens.unwrap_or(4096))
    .bind(badge.unwrap_or("").trim())
    .fetch_one(&mut *tx)
    .await;

    match created {
        Ok(agent) => match upsert_project_agent_assignment_tx(
            &mut tx,
            user_id,
            project_id,
            &agent.id,
            responsibility_kind,
            responsibility_label,
            "created",
        )
        .await
        {
            Ok(()) => {
                if let Err(commit_error) = tx.commit().await {
                    return AssistantActionResult {
                        action_type: "create_project_agent".to_string(),
                        status: "failed".to_string(),
                        summary: format!("创建项目智能体失败: 事务提交失败 - {}", commit_error),
                        agent_id: Some(agent.id.clone()),
                        agent_name: Some(agent.name.clone()),
                        responsibility_kind: None,
                        responsibility_label: None,
                    };
                }
                let agent_name = agent.name.clone();
                let agent_role = agent.role.clone();
                let normalized_kind = normalize_responsibility_kind(
                    responsibility_kind,
                    Some(agent_name.as_str()),
                    Some(agent_role.as_str()),
                )
                .to_string();
                AssistantActionResult {
                    action_type: "create_project_agent".to_string(),
                    status: "applied".to_string(),
                    summary: format!(
                        "已在当前项目新建智能体 {}，职责分类 {}。",
                        agent_name,
                        role_kind_label(Some(normalized_kind.as_str()))
                    ),
                    agent_id: Some(agent.id),
                    agent_name: Some(agent_name),
                    responsibility_kind: Some(normalized_kind),
                    responsibility_label: normalize_optional(
                        responsibility_label.map(str::to_string),
                    ),
                }
            }
            Err(error) => {
                let agent_name = agent.name.clone();
                let agent_role = agent.role.clone();
                let normalized_kind = normalize_responsibility_kind(
                    responsibility_kind,
                    Some(agent_name.as_str()),
                    Some(agent_role.as_str()),
                )
                .to_string();
                AssistantActionResult {
                    action_type: "create_project_agent".to_string(),
                    status: "failed".to_string(),
                    summary: format!("创建项目智能体后绑定失败: {}", error),
                    agent_id: Some(agent.id),
                    agent_name: Some(agent_name),
                    responsibility_kind: Some(normalized_kind.clone()),
                    responsibility_label: normalize_optional(
                        responsibility_label.map(str::to_string),
                    )
                    .or_else(|| Some(role_kind_label(Some(normalized_kind.as_str())).to_string())),
                }
            }
        },
        Err(error) => AssistantActionResult {
            action_type: "create_project_agent".to_string(),
            status: "failed".to_string(),
            summary: format!("创建项目智能体失败: {}", error),
            agent_id: None,
            agent_name: Some(name.trim().to_string()),
            responsibility_kind: None,
            responsibility_label: None,
        },
    }
}

async fn execute_remove_project_agent(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    agent_id: Option<&str>,
    agent_name: Option<&str>,
) -> AssistantActionResult {
    let resolved = resolve_agent_for_project_action(&state.db, user_id, agent_id, agent_name).await;
    match resolved {
        Ok(agent) => {
            let result = sqlx::query(
                "UPDATE project_agent_assignments
                 SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                 WHERE user_id = ? AND project_id = ? AND agent_id = ? AND is_active = 1",
            )
            .bind(user_id)
            .bind(project_id)
            .bind(&agent.id)
            .execute(&state.db)
            .await;

            match result {
                Ok(executed) if executed.rows_affected() > 0 => AssistantActionResult {
                    action_type: "remove_project_agent".to_string(),
                    status: "applied".to_string(),
                    summary: format!("已将 {} 从当前项目移出。", agent.name),
                    agent_id: Some(agent.id),
                    agent_name: Some(agent.name),
                    responsibility_kind: None,
                    responsibility_label: None,
                },
                Ok(_) => AssistantActionResult {
                    action_type: "remove_project_agent".to_string(),
                    status: "skipped".to_string(),
                    summary: format!("{} 当前不在这个项目里，无需移除。", agent.name),
                    agent_id: Some(agent.id),
                    agent_name: Some(agent.name),
                    responsibility_kind: None,
                    responsibility_label: None,
                },
                Err(error) => AssistantActionResult {
                    action_type: "remove_project_agent".to_string(),
                    status: "failed".to_string(),
                    summary: format!("移出项目智能体失败: {}", error),
                    agent_id: Some(agent.id),
                    agent_name: Some(agent.name),
                    responsibility_kind: None,
                    responsibility_label: None,
                },
            }
        }
        Err(error) => AssistantActionResult {
            action_type: "remove_project_agent".to_string(),
            status: "failed".to_string(),
            summary: format!("移出项目智能体失败: {}", error),
            agent_id: agent_id.map(str::to_string),
            agent_name: agent_name.map(str::to_string),
            responsibility_kind: None,
            responsibility_label: None,
        },
    }
}

#[derive(Debug, Clone)]
struct ProjectPathEntry {
    relative_path: String,
    entry_kind: String,
    file_type: String,
    size_bytes: u64,
    created_at: Option<SystemTime>,
}

fn normalize_project_relative_path(raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("path 不能为空".into()));
    }

    if trimmed.len() > MAX_PROJECT_PATH_LENGTH {
        return Err(AppError::Validation(
            format!(
                "path 超出长度限制 ({} > {})",
                trimmed.len(),
                MAX_PROJECT_PATH_LENGTH
            )
            .into(),
        ));
    }

    let path = StdPath::new(trimmed);
    if path.is_absolute() {
        return Err(AppError::Validation("path 不允许使用绝对路径".into()));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::Validation("path 不允许包含越界路径片段".into()));
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err(AppError::Validation("path 无效".into()));
    }

    Ok(normalized)
}

fn resolve_project_target_path(project_root: &StdPath, relative_path: &str) -> AppResult<PathBuf> {
    let normalized = normalize_project_relative_path(relative_path)?;
    Ok(project_root.join(normalized))
}

async fn ensure_project_files_dir(
    state: &AppState,
    user_id: &str,
    project_id: &str,
) -> AppResult<PathBuf> {
    ensure_project_access(&state.db, user_id, project_id).await?;

    fs::create_dir_all(&state.config.project_files_dir)
        .await
        .map_err(|error| AppError::Internal(format!("无法创建项目文件根目录: {}", error)))?;

    let root = fs::canonicalize(&state.config.project_files_dir)
        .await
        .map_err(|error| AppError::Internal(format!("无法定位项目文件根目录: {}", error)))?;

    let project_dir = root.join(project_id);
    fs::create_dir_all(&project_dir)
        .await
        .map_err(|error| AppError::Internal(format!("无法创建项目目录: {}", error)))?;

    let canonical_project_dir = fs::canonicalize(&project_dir)
        .await
        .map_err(|error| AppError::Internal(format!("无法定位项目目录: {}", error)))?;

    if !canonical_project_dir.starts_with(&root) {
        return Err(AppError::Forbidden("项目文件目录越界".into()));
    }

    Ok(canonical_project_dir)
}

fn parse_created_time_filter(value: Option<&str>, field: &str) -> AppResult<Option<SystemTime>> {
    let Some(raw) = value.map(str::trim).filter(|item| !item.is_empty()) else {
        return Ok(None);
    };

    let parsed = chrono::DateTime::parse_from_rfc3339(raw)
        .map_err(|_| AppError::Validation(format!("{} 格式无效，请使用 ISO 8601", field).into()))?;

    Ok(Some(parsed.with_timezone(&chrono::Utc).into()))
}

fn format_bytes(size: u64) -> String {
    if size < 1024 {
        return format!("{} B", size);
    }

    let kb = size as f64 / 1024.0;
    if kb < 1024.0 {
        return format!("{:.1} KB", kb);
    }

    let mb = kb / 1024.0;
    if mb < 1024.0 {
        return format!("{:.1} MB", mb);
    }

    let gb = mb / 1024.0;
    format!("{:.2} GB", gb)
}

fn format_created_time(value: Option<SystemTime>) -> String {
    value
        .map(|time| {
            let dt: chrono::DateTime<chrono::Utc> = time.into();
            dt.to_rfc3339()
        })
        .unwrap_or_else(|| "-".to_string())
}

fn infer_entry_file_type(path: &StdPath, is_dir: bool) -> String {
    if is_dir {
        return "dir".to_string();
    }

    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "file".to_string())
}

fn path_to_relative_display(path: &StdPath, project_root: &StdPath) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn file_type_matches(entry: &ProjectPathEntry, file_type: Option<&str>) -> bool {
    let Some(filter) = file_type.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let normalized = filter.trim_start_matches('.').to_ascii_lowercase();
    if normalized == "dir" {
        return entry.entry_kind == "dir";
    }
    if normalized == "file" {
        return entry.entry_kind == "file";
    }
    entry.file_type.to_ascii_lowercase() == normalized
}

fn query_matches(entry: &ProjectPathEntry, query: Option<&str>) -> bool {
    let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let normalized = query.to_ascii_lowercase();
    entry
        .relative_path
        .to_ascii_lowercase()
        .contains(&normalized)
}

fn created_time_matches(
    entry: &ProjectPathEntry,
    created_after: Option<SystemTime>,
    created_before: Option<SystemTime>,
) -> bool {
    let Some(created_at) = entry.created_at else {
        return created_after.is_none() && created_before.is_none();
    };

    if let Some(after) = created_after {
        if created_at < after {
            return false;
        }
    }

    if let Some(before) = created_before {
        if created_at > before {
            return false;
        }
    }

    true
}

fn size_matches(entry: &ProjectPathEntry, min_size: Option<i64>, max_size: Option<i64>) -> bool {
    let size = entry.size_bytes as i64;
    if let Some(min_value) = min_size {
        if size < min_value {
            return false;
        }
    }
    if let Some(max_value) = max_size {
        if size > max_value {
            return false;
        }
    }
    true
}

async fn collect_project_path_entries(
    project_root: &StdPath,
    cap: usize,
) -> AppResult<Vec<ProjectPathEntry>> {
    let mut entries = Vec::new();
    let mut stack = vec![project_root.to_path_buf()];

    while let Some(current_dir) = stack.pop() {
        let mut dir_stream = fs::read_dir(&current_dir)
            .await
            .map_err(|error| AppError::Internal(format!("读取项目目录失败: {}", error)))?;

        while let Some(item) = dir_stream
            .next_entry()
            .await
            .map_err(|error| AppError::Internal(format!("读取项目目录项失败: {}", error)))?
        {
            let path = item.path();
            let metadata = item
                .metadata()
                .await
                .map_err(|error| AppError::Internal(format!("读取文件元数据失败: {}", error)))?;
            let is_dir = metadata.is_dir();
            let relative_path = path_to_relative_display(&path, project_root);
            let created_at = metadata.created().ok().or_else(|| metadata.modified().ok());
            let entry = ProjectPathEntry {
                relative_path,
                entry_kind: if is_dir {
                    "dir".to_string()
                } else {
                    "file".to_string()
                },
                file_type: infer_entry_file_type(&path, is_dir),
                size_bytes: metadata.len(),
                created_at,
            };
            entries.push(entry);

            if is_dir {
                stack.push(path);
            }

            if entries.len() >= cap {
                return Ok(entries);
            }
        }
    }

    Ok(entries)
}

async fn execute_search_project_files(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    query: Option<&str>,
    file_type: Option<&str>,
    created_after: Option<&str>,
    created_before: Option<&str>,
    min_size: Option<i64>,
    max_size: Option<i64>,
    limit: Option<usize>,
) -> AssistantActionResult {
    let created_after_filter = match parse_created_time_filter(created_after, "created_after") {
        Ok(value) => value,
        Err(error) => {
            return AssistantActionResult {
                action_type: "search_project_files".to_string(),
                status: "failed".to_string(),
                summary: format!("检索项目文件失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let created_before_filter = match parse_created_time_filter(created_before, "created_before") {
        Ok(value) => value,
        Err(error) => {
            return AssistantActionResult {
                action_type: "search_project_files".to_string(),
                status: "failed".to_string(),
                summary: format!("检索项目文件失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let project_root = match ensure_project_files_dir(state, user_id, project_id).await {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "search_project_files".to_string(),
                status: "failed".to_string(),
                summary: format!("检索项目文件失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let requested_limit = limit
        .unwrap_or(50)
        .clamp(1, MAX_PROJECT_FILE_SEARCH_RESULTS);
    let scan_cap = min(
        requested_limit.saturating_mul(6),
        MAX_PROJECT_FILE_SEARCH_RESULTS * 6,
    );
    let collected = match collect_project_path_entries(&project_root, scan_cap).await {
        Ok(entries) => entries,
        Err(error) => {
            return AssistantActionResult {
                action_type: "search_project_files".to_string(),
                status: "failed".to_string(),
                summary: format!("检索项目文件失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let mut filtered = collected
        .into_iter()
        .filter(|entry| query_matches(entry, query))
        .filter(|entry| file_type_matches(entry, file_type))
        .filter(|entry| created_time_matches(entry, created_after_filter, created_before_filter))
        .filter(|entry| size_matches(entry, min_size, max_size))
        .collect::<Vec<_>>();

    filtered.sort_by(|left, right| {
        let created_order = match (left.created_at, right.created_at) {
            (Some(left_time), Some(right_time)) => right_time.cmp(&left_time),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        created_order.then_with(|| left.relative_path.cmp(&right.relative_path))
    });

    if filtered.is_empty() {
        return AssistantActionResult {
            action_type: "search_project_files".to_string(),
            status: "applied".to_string(),
            summary: "已检索当前项目文件，未找到匹配项。".to_string(),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        };
    }

    let total = filtered.len();
    let shown = min(requested_limit, 30);
    let mut lines = vec![format!("已检索当前项目文件，匹配 {} 项。", total)];
    for entry in filtered.into_iter().take(shown) {
        lines.push(format!(
            "- {} | 类型 {} | 大小 {} | 创建时间 {}",
            entry.relative_path,
            entry.file_type,
            format_bytes(entry.size_bytes),
            format_created_time(entry.created_at),
        ));
    }
    if total > shown {
        lines.push(format!("...其余 {} 项已省略。", total - shown));
    }

    AssistantActionResult {
        action_type: "search_project_files".to_string(),
        status: "applied".to_string(),
        summary: lines.join("\n"),
        agent_id: None,
        agent_name: None,
        responsibility_kind: None,
        responsibility_label: None,
    }
}

async fn execute_create_project_directory(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    path: &str,
) -> AssistantActionResult {
    let project_root = match ensure_project_files_dir(state, user_id, project_id).await {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "create_project_directory".to_string(),
                status: "failed".to_string(),
                summary: format!("创建项目目录失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let target = match resolve_project_target_path(&project_root, path) {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "create_project_directory".to_string(),
                status: "failed".to_string(),
                summary: format!("创建项目目录失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    match fs::metadata(&target).await {
        Ok(metadata) => {
            if metadata.is_dir() {
                return AssistantActionResult {
                    action_type: "create_project_directory".to_string(),
                    status: "skipped".to_string(),
                    summary: format!(
                        "目录已存在，无需创建: {}",
                        path_to_relative_display(&target, &project_root)
                    ),
                    agent_id: None,
                    agent_name: None,
                    responsibility_kind: None,
                    responsibility_label: None,
                };
            }
            return AssistantActionResult {
                action_type: "create_project_directory".to_string(),
                status: "failed".to_string(),
                summary: format!(
                    "创建项目目录失败: 目标已存在且不是目录 ({})",
                    path_to_relative_display(&target, &project_root)
                ),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return AssistantActionResult {
                action_type: "create_project_directory".to_string(),
                status: "failed".to_string(),
                summary: format!("创建项目目录失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    }

    match fs::create_dir_all(&target).await {
        Ok(()) => AssistantActionResult {
            action_type: "create_project_directory".to_string(),
            status: "applied".to_string(),
            summary: format!(
                "已创建目录: {}",
                path_to_relative_display(&target, &project_root)
            ),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        },
        Err(error) => AssistantActionResult {
            action_type: "create_project_directory".to_string(),
            status: "failed".to_string(),
            summary: format!("创建项目目录失败: {}", error),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        },
    }
}

async fn execute_create_project_file(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    path: &str,
    content: &str,
    overwrite: bool,
) -> AssistantActionResult {
    let project_root = match ensure_project_files_dir(state, user_id, project_id).await {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "create_project_file".to_string(),
                status: "failed".to_string(),
                summary: format!("写入项目文件失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let target = match resolve_project_target_path(&project_root, path) {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "create_project_file".to_string(),
                status: "failed".to_string(),
                summary: format!("写入项目文件失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    match fs::metadata(&target).await {
        Ok(metadata) => {
            if metadata.is_dir() {
                return AssistantActionResult {
                    action_type: "create_project_file".to_string(),
                    status: "failed".to_string(),
                    summary: format!(
                        "写入项目文件失败: 目标是目录 ({})",
                        path_to_relative_display(&target, &project_root)
                    ),
                    agent_id: None,
                    agent_name: None,
                    responsibility_kind: None,
                    responsibility_label: None,
                };
            }
            if !overwrite {
                return AssistantActionResult {
                    action_type: "create_project_file".to_string(),
                    status: "skipped".to_string(),
                    summary: format!(
                        "文件已存在且未开启覆盖: {}",
                        path_to_relative_display(&target, &project_root)
                    ),
                    agent_id: None,
                    agent_name: None,
                    responsibility_kind: None,
                    responsibility_label: None,
                };
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return AssistantActionResult {
                action_type: "create_project_file".to_string(),
                status: "failed".to_string(),
                summary: format!("写入项目文件失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    }

    if let Some(parent) = target.parent() {
        if let Err(error) = fs::create_dir_all(parent).await {
            return AssistantActionResult {
                action_type: "create_project_file".to_string(),
                status: "failed".to_string(),
                summary: format!("写入项目文件失败: 无法创建父目录 ({})", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    }

    match fs::write(&target, content).await {
        Ok(()) => AssistantActionResult {
            action_type: "create_project_file".to_string(),
            status: "applied".to_string(),
            summary: format!(
                "已写入文件: {}（{}）",
                path_to_relative_display(&target, &project_root),
                format_bytes(content.as_bytes().len() as u64),
            ),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        },
        Err(error) => AssistantActionResult {
            action_type: "create_project_file".to_string(),
            status: "failed".to_string(),
            summary: format!("写入项目文件失败: {}", error),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        },
    }
}

async fn execute_delete_project_path(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    path: &str,
    recursive: bool,
) -> AssistantActionResult {
    let project_root = match ensure_project_files_dir(state, user_id, project_id).await {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "delete_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("删除项目路径失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let target = match resolve_project_target_path(&project_root, path) {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "delete_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("删除项目路径失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let metadata = match fs::metadata(&target).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return AssistantActionResult {
                action_type: "delete_project_path".to_string(),
                status: "skipped".to_string(),
                summary: format!(
                    "目标不存在，无需删除: {}",
                    path_to_relative_display(&target, &project_root)
                ),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
        Err(error) => {
            return AssistantActionResult {
                action_type: "delete_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("删除项目路径失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let result = if metadata.is_dir() {
        if recursive {
            fs::remove_dir_all(&target).await
        } else {
            fs::remove_dir(&target).await
        }
    } else {
        fs::remove_file(&target).await
    };

    match result {
        Ok(()) => AssistantActionResult {
            action_type: "delete_project_path".to_string(),
            status: "applied".to_string(),
            summary: format!(
                "已删除路径: {}",
                path_to_relative_display(&target, &project_root)
            ),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        },
        Err(error) => AssistantActionResult {
            action_type: "delete_project_path".to_string(),
            status: "failed".to_string(),
            summary: if metadata.is_dir() && !recursive {
                format!(
                    "删除项目路径失败: {}。目录可能非空，可在确认后使用 recursive=true。",
                    error
                )
            } else {
                format!("删除项目路径失败: {}", error)
            },
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        },
    }
}

async fn execute_move_project_path(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    from_path: &str,
    to_path: &str,
    overwrite: bool,
) -> AssistantActionResult {
    let project_root = match ensure_project_files_dir(state, user_id, project_id).await {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "move_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("移动项目路径失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let source = match resolve_project_target_path(&project_root, from_path) {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "move_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("移动项目路径失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    let target = match resolve_project_target_path(&project_root, to_path) {
        Ok(path) => path,
        Err(error) => {
            return AssistantActionResult {
                action_type: "move_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("移动项目路径失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    if source == target {
        return AssistantActionResult {
            action_type: "move_project_path".to_string(),
            status: "skipped".to_string(),
            summary: "源路径与目标路径相同，无需移动。".to_string(),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        };
    }

    let source_metadata = match fs::metadata(&source).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return AssistantActionResult {
                action_type: "move_project_path".to_string(),
                status: "skipped".to_string(),
                summary: format!(
                    "源路径不存在，无法移动: {}",
                    path_to_relative_display(&source, &project_root)
                ),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
        Err(error) => {
            return AssistantActionResult {
                action_type: "move_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("移动项目路径失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    };

    match fs::metadata(&target).await {
        Ok(target_metadata) => {
            if !overwrite {
                return AssistantActionResult {
                    action_type: "move_project_path".to_string(),
                    status: "skipped".to_string(),
                    summary: format!(
                        "目标路径已存在且未开启覆盖: {}",
                        path_to_relative_display(&target, &project_root)
                    ),
                    agent_id: None,
                    agent_name: None,
                    responsibility_kind: None,
                    responsibility_label: None,
                };
            }

            let removal = if target_metadata.is_dir() {
                fs::remove_dir_all(&target).await
            } else {
                fs::remove_file(&target).await
            };

            if let Err(error) = removal {
                return AssistantActionResult {
                    action_type: "move_project_path".to_string(),
                    status: "failed".to_string(),
                    summary: format!("移动项目路径失败: 无法覆盖目标路径 ({})", error),
                    agent_id: None,
                    agent_name: None,
                    responsibility_kind: None,
                    responsibility_label: None,
                };
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return AssistantActionResult {
                action_type: "move_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("移动项目路径失败: {}", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    }

    if let Some(parent) = target.parent() {
        if let Err(error) = fs::create_dir_all(parent).await {
            return AssistantActionResult {
                action_type: "move_project_path".to_string(),
                status: "failed".to_string(),
                summary: format!("移动项目路径失败: 无法创建目标父目录 ({})", error),
                agent_id: None,
                agent_name: None,
                responsibility_kind: None,
                responsibility_label: None,
            };
        }
    }

    match fs::rename(&source, &target).await {
        Ok(()) => AssistantActionResult {
            action_type: "move_project_path".to_string(),
            status: "applied".to_string(),
            summary: format!(
                "已移动路径: {} -> {}",
                path_to_relative_display(&source, &project_root),
                path_to_relative_display(&target, &project_root)
            ),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        },
        Err(error) => AssistantActionResult {
            action_type: "move_project_path".to_string(),
            status: "failed".to_string(),
            summary: format!(
                "移动项目路径失败: {}（{}）",
                error,
                if source_metadata.is_dir() {
                    "目录移动"
                } else {
                    "文件移动"
                }
            ),
            agent_id: None,
            agent_name: None,
            responsibility_kind: None,
            responsibility_label: None,
        },
    }
}

async fn resolve_agent_for_project_action(
    pool: &SqlitePool,
    user_id: &str,
    agent_id: Option<&str>,
    agent_name: Option<&str>,
) -> AppResult<Agent> {
    if let Some(agent_id) = agent_id.map(str::trim).filter(|value| !value.is_empty()) {
        return ensure_agent_access(pool, user_id, agent_id).await;
    }

    let agent_name = agent_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Validation("未提供 agentId 或 agentName".into()))?;

    sqlx::query_as::<_, Agent>(
        "SELECT * FROM agents WHERE user_id = ? AND is_active = 1 AND name = ?",
    )
    .bind(user_id)
    .bind(agent_name)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("找不到名为 {} 的智能体", agent_name)))
}
