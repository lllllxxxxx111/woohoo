use axum::{
    extract::{Extension, Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use uuid::Uuid;

use crate::{
    asset::generated_document::{self, GeneratedMarkdownDocument},
    auth::middleware::UserId,
    content_version::{
        handlers::resolve_concurrency_token,
        model::{
            normalize_source, CommitInput, ContentType, StoryboardSnapshot, StoryboardSnapshotLine,
        },
        repo as version_repo,
    },
    error::{AppError, AppResult},
    project::repo as project_repo,
    AppState,
};

use super::{
    model::{Storyboard, StoryboardLineInput, StoryboardResponse, UpsertStoryboardReq},
    repo,
};

pub async fn get_storyboard(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Option<StoryboardResponse>>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    let storyboard = match repo::find_by_project(&state.db, &project_id).await? {
        Some(storyboard) => storyboard,
        None => return Ok(Json(None)),
    };

    let latest =
        version_repo::get_latest_version(&state.db, &project_id, ContentType::Storyboard)
            .await
            .map_err(AppError::Sqlx)?;

    let response = match latest {
        Some(row) => StoryboardResponse::new(storyboard, &row, false),
        None => {
            let snapshot = build_snapshot_from_storyboard(&storyboard);
            let content = serde_json::to_string(&snapshot).unwrap_or_default();
            StoryboardResponse {
                id: storyboard.id,
                project_id: storyboard.project_id,
                lines: storyboard.lines,
                updated_at: storyboard.updated_at,
                version: 0,
                version_id: String::new(),
                content_hash: version_repo::sha256_hex(&content),
                deduplicated: false,
            }
        }
    };

    Ok(Json(Some(response)))
}

pub async fn upsert_storyboard(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpsertStoryboardReq>,
) -> AppResult<Json<StoryboardResponse>> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;

    for line in &req.lines {
        if line.scene_number <= 0 {
            return Err(AppError::Validation("sceneNumber 必须大于 0".into()));
        }
        if line.duration < 0 {
            return Err(AppError::Validation("duration 不能小于 0".into()));
        }
        if line.description.trim().is_empty() {
            return Err(AppError::Validation("分镜描述不能为空".into()));
        }
    }

    // 提前解析行 ID，保证“版本快照”和“当前分镜表”使用同一组 ID，
    // 从而让相同内容的重复保存可以被内容哈希去重。
    // 缺 ID 的输入行优先继承“同位置且内容一致”的既有行 ID：否则每次保存
    // 都会生成全新 UUID，快照哈希永远不同，自动保存类客户端每次都会追加
    // 一个内容相同的新版本（版本表无限增长，diff 也全是 remove+add）。
    let existing_identities = repo::list_line_identities(&state.db, &project_id).await?;
    let resolved_inputs: Vec<StoryboardLineInput> = req
        .lines
        .iter()
        .enumerate()
        .map(|(index, line)| StoryboardLineInput {
            id: Some(resolve_storyboard_line_id(
                line,
                index,
                &existing_identities,
            )),
            scene_number: line.scene_number,
            description: line.description.trim().to_string(),
            duration: line.duration,
            asset_ids: line.asset_ids.clone(),
        })
        .collect();

    let snapshot = StoryboardSnapshot {
        lines: resolved_inputs
            .iter()
            .map(|line| StoryboardSnapshotLine {
                id: line.id.clone().unwrap_or_default(),
                scene_number: line.scene_number,
                description: line.description.clone(),
                duration: line.duration,
                asset_ids: line.asset_ids.clone(),
            })
            .collect(),
    };
    let snapshot_content = serde_json::to_string(&snapshot)
        .map_err(|err| AppError::Internal(format!("分镜快照序列化失败: {}", err)))?;

    let expected_base = resolve_concurrency_token(req.base_version, &headers)?;
    let source = normalize_source(req.source.as_deref());
    let note = req.note.clone();

    let mut tx = state.db.begin().await?;

    let commit_input = CommitInput {
        project_id: project_id.clone(),
        content_type: ContentType::Storyboard,
        content: snapshot_content,
        title: None,
        source,
        created_by: Some(user_id.0.clone()),
        note,
        expected_base,
    };
    let outcome = version_repo::commit_version_tx(&mut tx, &commit_input)
        .await
        .map_err(|err| err.into_app_error())?;

    repo::upsert_storyboard_tx(&mut tx, &project_id, &resolved_inputs, true).await?;

    // 响应必须在事务内构造：提交后再从连接池重读，并发保存可能已经插队，
    // 会把别人的 lines 与本次的 version_row/content_hash 错配返回，
    // 客户端拿它当下一次保存的基线会引发虚假冲突。
    let storyboard = repo::find_by_project_tx(&mut tx, &project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("分镜不存在".into()))?;

    tx.commit().await?;

    let version_row = outcome.version_row().clone();
    let deduplicated = outcome.is_duplicate();
    let response = StoryboardResponse::new(storyboard.clone(), &version_row, deduplicated);

    persist_storyboard_document_asset(&state, &storyboard).await?;
    Ok(Json(response))
}

pub async fn delete_storyboard(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
) -> AppResult<StatusCode> {
    ensure_project_access(&state, &user_id.0, &project_id).await?;
    repo::delete_by_project(&state.db, &project_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 为输入行确定行 ID：显式提供的 ID 优先；缺失/空白时，若同一位置存在
/// 内容一致的既有行则继承其 ID（保证重复保存快照稳定）；否则生成新 UUID。
fn resolve_storyboard_line_id(
    line: &StoryboardLineInput,
    index: usize,
    existing: &[repo::StoryboardLineIdentity],
) -> String {
    if let Some(provided) = line.id.as_deref() {
        let trimmed = provided.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(existing_line) = existing.get(index) {
        if existing_line.scene_number == line.scene_number
            && existing_line.description == line.description.trim()
            && existing_line.duration == line.duration
        {
            return existing_line.id.clone();
        }
    }
    Uuid::new_v4().to_string()
}

/// 从当前分镜构建快照（用于无版本行时计算内容哈希）
fn build_snapshot_from_storyboard(storyboard: &Storyboard) -> StoryboardSnapshot {    StoryboardSnapshot {
        lines: storyboard
            .lines
            .iter()
            .map(|line| StoryboardSnapshotLine {
                id: line.id.clone(),
                scene_number: line.scene_number,
                description: line.description.clone(),
                duration: line.duration,
                asset_ids: line.assets.iter().map(|asset| asset.id.clone()).collect(),
            })
            .collect(),
    }
}

async fn ensure_project_access(state: &AppState, user_id: &str, project_id: &str) -> AppResult<()> {
    let project = project_repo::find_by_id(&state.db, project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;

    if project.user_id != user_id {
        return Err(AppError::Forbidden("无权访问".into()));
    }

    Ok(())
}

async fn persist_storyboard_document_asset(
    state: &AppState,
    storyboard: &Storyboard,
) -> AppResult<()> {
    if storyboard.lines.is_empty() {
        return Ok(());
    }

    let content = render_storyboard_markdown(storyboard);
    let metadata = serde_json::json!({
        "origin": "storyboard",
        "format": "markdown",
        "storyboardId": storyboard.id,
        "projectId": storyboard.project_id,
        "sceneCount": storyboard.lines.len(),
        "sizeBytes": content.as_bytes().len(),
        "updatedAt": storyboard.updated_at,
    });
    let filename_stem = format!("storyboard-{}", storyboard.project_id);

    if let Err(error) = generated_document::persist_markdown_document(
        state,
        GeneratedMarkdownDocument {
            project_id: &storyboard.project_id,
            name: "storyboard.md",
            filename_stem: &filename_stem,
            content: &content,
            metadata,
        },
    )
    .await
    {
        tracing::warn!(
            project_id = %storyboard.project_id,
            storyboard_id = %storyboard.id,
            "failed to persist storyboard document asset: {}",
            error
        );
    }

    Ok(())
}

fn render_storyboard_markdown(storyboard: &Storyboard) -> String {
    let mut content =
        String::from("# Storyboard\n\n| Scene | Duration | Description |\n| --- | ---: | --- |\n");
    for line in &storyboard.lines {
        content.push_str(&format!(
            "| {} | {}s | {} |\n",
            line.scene_number,
            line.duration,
            escape_markdown_table_cell(&line.description),
        ));
    }
    content
}

fn escape_markdown_table_cell(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace('\n', "<br>")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input_line(id: Option<&str>, scene_number: i64, description: &str, duration: i64) -> StoryboardLineInput {
        StoryboardLineInput {
            id: id.map(str::to_string),
            scene_number,
            description: description.to_string(),
            duration,
            asset_ids: Vec::new(),
        }
    }

    fn identity(id: &str, scene_number: i64, description: &str, duration: i64) -> repo::StoryboardLineIdentity {
        repo::StoryboardLineIdentity {
            id: id.to_string(),
            scene_number,
            description: description.to_string(),
            duration,
        }
    }

    /// 显式提供的 id（含去除空白后仍非空的）必须原样保留。
    #[test]
    fn resolve_line_id_prefers_provided_id() {
        let existing = vec![identity("old-1", 1, "描述", 3)];
        let resolved = resolve_storyboard_line_id(
            &input_line(Some(" client-id "), 1, "描述", 3),
            0,
            &existing,
        );
        assert_eq!(resolved, "client-id");
    }

    /// 缺 id 时，同位置内容一致的既有行 id 被继承：同样的无 id 请求重复
    /// 保存会得到相同 id，快照哈希稳定，内容去重才能命中。
    #[test]
    fn resolve_line_id_adopts_matching_existing_identity() {
        let existing = vec![
            identity("keep-1", 1, "第一镜", 3),
            identity("keep-2", 2, "第二镜", 5),
        ];
        let first = resolve_storyboard_line_id(&input_line(None, 1, " 第一镜 ", 3), 0, &existing);
        let second = resolve_storyboard_line_id(&input_line(None, 2, "第二镜", 5), 1, &existing);
        assert_eq!(first, "keep-1");
        assert_eq!(second, "keep-2");
    }

    /// 同位置但内容已变的行不继承旧 id（避免把“修改”伪装成“未变”），
    /// 也不影响其他位置行的继承。
    #[test]
    fn resolve_line_id_generates_new_id_when_content_changed() {
        let existing = vec![identity("old-1", 1, "旧描述", 3)];
        let resolved =
            resolve_storyboard_line_id(&input_line(None, 1, "新描述", 3), 0, &existing);
        assert_ne!(resolved, "old-1");
        assert!(!resolved.is_empty());
    }

    /// 没有任何既有行（首次创建）时生成新 id；空白 id 视为缺失。
    #[test]
    fn resolve_line_id_generates_new_id_without_existing_rows() {
        let resolved = resolve_storyboard_line_id(&input_line(None, 1, "描述", 3), 0, &[]);
        assert!(!resolved.is_empty());

        let blank = resolve_storyboard_line_id(
            &input_line(Some("   "), 1, "描述", 3),
            0,
            &[identity("old-1", 1, "描述", 3)],
        );
        assert_eq!(blank, "old-1");
    }
}
