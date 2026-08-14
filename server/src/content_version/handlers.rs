use axum::{
    extract::{Extension, Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    project::repo as project_repo,
    script, storyboard, AppState,
};

use super::{
    diff::diff_contents,
    model::{
        CommitInput, ConcurrencyToken, ContentVersion, ContentType, StoryboardSnapshot,
        StoryboardSnapshotLine,
    },
    repo,
};

#[derive(Debug, Deserialize)]
pub struct ListVersionsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    /// 对比基线版本号；缺省为当前最新版本
    pub from: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReq {
    pub note: Option<String>,
    /// 可选：恢复所基于的版本（乐观锁）；缺省不做并发校验
    pub base_version: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionListResponse {
    pub project_id: String,
    pub content_type: String,
    pub current_version: i64,
    pub total: i64,
    pub versions: Vec<ContentVersion>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    pub project_id: String,
    pub content_type: String,
    pub base_version: i64,
    pub target_version: i64,
    #[serde(flatten)]
    pub diff: super::diff::ContentDiff,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResponse {
    pub restored_from_version: i64,
    pub new_version: ContentVersion,
}

async fn ensure_project_access(
    pool: &sqlx::SqlitePool,
    user_id: &str,
    project_id: &str,
) -> AppResult<()> {
    let project = project_repo::find_by_id(pool, project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;

    if project.user_id != user_id {
        return Err(AppError::Forbidden("无权访问".into()));
    }

    Ok(())
}

/// 解析并发令牌：优先显式 baseVersion，其次尝试从 If-Match 头解析版本号。
/// 供剧本 / 分镜保存主链路复用。
pub fn resolve_concurrency_token(
    base_version: Option<i64>,
    headers: &HeaderMap,
) -> ConcurrencyToken {
    if let Some(base) = base_version {
        return ConcurrencyToken::BaseVersion(base.max(0));
    }

    if let Some(if_match) = headers
        .get(axum::http::header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
    {
        let cleaned = if_match.trim().trim_matches('"');
        if let Ok(version) = cleaned.parse::<i64>() {
            return ConcurrencyToken::BaseVersion(version.max(0));
        }
    }

    ConcurrencyToken::None
}

// ─── 内部实现（按内容类型参数化） ──────────────────────────────────────

async fn list_versions_inner(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    content_type: ContentType,
    query: ListVersionsQuery,
) -> AppResult<Json<VersionListResponse>> {
    ensure_project_access(&state.db, user_id, project_id).await?;

    let limit = query.limit.unwrap_or(50);
    let offset = query.offset.unwrap_or(0);

    let rows = repo::list_versions(&state.db, project_id, content_type, limit, offset)
        .await
        .map_err(AppError::Sqlx)?;
    let total = repo::count_versions(&state.db, project_id, content_type)
        .await
        .map_err(AppError::Sqlx)?;
    let current_version = rows.first().map(|row| row.version).unwrap_or(0);

    let versions = rows
        .into_iter()
        .map(|row| ContentVersion::from_row(row, false))
        .collect();

    Ok(Json(VersionListResponse {
        project_id: project_id.to_string(),
        content_type: content_type.as_str().to_string(),
        current_version,
        total,
        versions,
    }))
}

async fn get_version_detail_inner(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    content_type: ContentType,
    version: i64,
) -> AppResult<Json<ContentVersion>> {
    ensure_project_access(&state.db, user_id, project_id).await?;

    let row = repo::get_version(&state.db, project_id, content_type, version)
        .await
        .map_err(AppError::Sqlx)?
        .ok_or_else(|| AppError::NotFound("版本不存在".into()))?;

    Ok(Json(ContentVersion::from_row(row, true)))
}

async fn get_version_diff_inner(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    content_type: ContentType,
    version: i64,
    query: DiffQuery,
) -> AppResult<Json<DiffResponse>> {
    ensure_project_access(&state.db, user_id, project_id).await?;

    let target = repo::get_version(&state.db, project_id, content_type, version)
        .await
        .map_err(AppError::Sqlx)?
        .ok_or_else(|| AppError::NotFound("目标版本不存在".into()))?;

    let base = if let Some(from_version) = query.from {
        repo::get_version(&state.db, project_id, content_type, from_version)
            .await
            .map_err(AppError::Sqlx)?
            .ok_or_else(|| AppError::NotFound("基线版本不存在".into()))?
    } else {
        repo::get_latest_version(&state.db, project_id, content_type)
            .await
            .map_err(AppError::Sqlx)?
            .unwrap_or_else(|| target.clone())
    };

    let diff = diff_contents(content_type, &base.content, &target.content);

    Ok(Json(DiffResponse {
        project_id: project_id.to_string(),
        content_type: content_type.as_str().to_string(),
        base_version: base.version,
        target_version: target.version,
        diff,
    }))
}

async fn restore_version_inner(
    state: &AppState,
    user_id: &str,
    project_id: &str,
    content_type: ContentType,
    version: i64,
    req: RestoreReq,
) -> AppResult<Json<RestoreResponse>> {
    ensure_project_access(&state.db, user_id, project_id).await?;

    // 读取目标历史版本（不可变，绝不改写）
    let target = repo::get_version(&state.db, project_id, content_type, version)
        .await
        .map_err(AppError::Sqlx)?
        .ok_or_else(|| AppError::NotFound("要恢复的版本不存在".into()))?;

    let mut tx = state.db.begin().await?;

    // 若指定 base_version，先做乐观锁校验
    let current_version = repo::current_version_number_tx(&mut tx, project_id, content_type)
        .await
        .map_err(AppError::Sqlx)?;
    if let Some(base) = req.base_version {
        if base != current_version {
            return Err(AppError::VersionConflict {
                message: format!(
                    "恢复失败：当前内容已更新到 v{}，与你提交的基线 v{} 不一致。",
                    current_version, base
                ),
                detail: serde_json::json!({
                    "baseVersion": base,
                    "currentVersion": current_version,
                }),
            });
        }
    }

    // 计算恢复后应写入当前表的有效内容（分镜需剔除已失效资产）
    let (effective_content, note) = match content_type {
        ContentType::Script => (
            target.content.clone(),
            req.note
                .clone()
                .unwrap_or_else(|| format!("恢复到版本 v{}", version)),
        ),
        ContentType::Storyboard => {
            let snapshot: StoryboardSnapshot =
                serde_json::from_str(&target.content).unwrap_or(StoryboardSnapshot {
                    lines: Vec::new(),
                });
            let mut effective_lines = Vec::with_capacity(snapshot.lines.len());
            for line in &snapshot.lines {
                let mut valid_asset_ids = Vec::with_capacity(line.asset_ids.len());
                for asset_id in &line.asset_ids {
                    let owned: Option<(String,)> = sqlx::query_as(
                        "SELECT id FROM assets WHERE id = ? AND project_id = ?",
                    )
                    .bind(asset_id)
                    .bind(project_id)
                    .fetch_optional(&mut *tx)
                    .await?;
                    if owned.is_some() {
                        valid_asset_ids.push(asset_id.clone());
                    }
                }
                effective_lines.push(StoryboardSnapshotLine {
                    id: line.id.clone(),
                    scene_number: line.scene_number,
                    description: line.description.clone(),
                    duration: line.duration,
                    asset_ids: valid_asset_ids,
                });
            }
            let effective_snapshot = StoryboardSnapshot {
                lines: effective_lines,
            };
            let effective_content = serde_json::to_string(&effective_snapshot)
                .unwrap_or_else(|_| target.content.clone());
            (
                effective_content,
                req.note
                    .clone()
                    .unwrap_or_else(|| format!("恢复到版本 v{}", version)),
            )
        }
    };

    // 追加一个新版本（source=restore），绝不删改历史版本
    let commit_input = CommitInput {
        project_id: project_id.to_string(),
        content_type,
        content: effective_content.clone(),
        title: target.title.clone(),
        source: "restore".to_string(),
        created_by: Some(user_id.to_string()),
        note: Some(note),
        expected_base: ConcurrencyToken::None,
    };
    let outcome = repo::commit_version_tx(&mut tx, &commit_input)
        .await
        .map_err(|err| err.into_app_error())?;

    // 将恢复内容写回“当前”表
    match content_type {
        ContentType::Script => {
            let title = target
                .title
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "未命名剧本".to_string());
            script::repo::write_current_tx(&mut tx, project_id, &title, &effective_content)
                .await?;
        }
        ContentType::Storyboard => {
            let snapshot: StoryboardSnapshot =
                serde_json::from_str(&effective_content).unwrap_or(StoryboardSnapshot {
                    lines: Vec::new(),
                });
            let inputs: Vec<storyboard::model::StoryboardLineInput> = snapshot
                .lines
                .into_iter()
                .map(|line| storyboard::model::StoryboardLineInput {
                    id: Some(line.id),
                    scene_number: line.scene_number,
                    description: line.description,
                    duration: line.duration,
                    asset_ids: line.asset_ids,
                })
                .collect();
            storyboard::repo::upsert_storyboard_tx(&mut tx, project_id, &inputs, false).await?;
        }
    }

    tx.commit().await?;

    let new_version_row = outcome.version_row().clone();
    Ok(Json(RestoreResponse {
        restored_from_version: version,
        new_version: ContentVersion::from_row(new_version_row, false),
    }))
}

// ─── 剧本版本路由 handler ────────────────────────────────────────────

pub async fn list_script_versions(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Query(query): Query<ListVersionsQuery>,
) -> AppResult<Json<VersionListResponse>> {
    list_versions_inner(&state, &user_id.0, &project_id, ContentType::Script, query).await
}

pub async fn get_script_version_detail(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, version)): Path<(String, i64)>,
) -> AppResult<Json<ContentVersion>> {
    get_version_detail_inner(&state, &user_id.0, &project_id, ContentType::Script, version).await
}

pub async fn get_script_version_diff(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, version)): Path<(String, i64)>,
    Query(query): Query<DiffQuery>,
) -> AppResult<Json<DiffResponse>> {
    get_version_diff_inner(&state, &user_id.0, &project_id, ContentType::Script, version, query)
        .await
}

pub async fn restore_script_version(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, version)): Path<(String, i64)>,
    Json(req): Json<RestoreReq>,
) -> AppResult<Json<RestoreResponse>> {
    restore_version_inner(&state, &user_id.0, &project_id, ContentType::Script, version, req)
        .await
}

// ─── 分镜版本路由 handler ────────────────────────────────────────────

pub async fn list_storyboard_versions(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    Query(query): Query<ListVersionsQuery>,
) -> AppResult<Json<VersionListResponse>> {
    list_versions_inner(&state, &user_id.0, &project_id, ContentType::Storyboard, query).await
}

pub async fn get_storyboard_version_detail(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, version)): Path<(String, i64)>,
) -> AppResult<Json<ContentVersion>> {
    get_version_detail_inner(&state, &user_id.0, &project_id, ContentType::Storyboard, version)
        .await
}

pub async fn get_storyboard_version_diff(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, version)): Path<(String, i64)>,
    Query(query): Query<DiffQuery>,
) -> AppResult<Json<DiffResponse>> {
    get_version_diff_inner(
        &state,
        &user_id.0,
        &project_id,
        ContentType::Storyboard,
        version,
        query,
    )
    .await
}

pub async fn restore_storyboard_version(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((project_id, version)): Path<(String, i64)>,
    Json(req): Json<RestoreReq>,
) -> AppResult<Json<RestoreResponse>> {
    restore_version_inner(
        &state,
        &user_id.0,
        &project_id,
        ContentType::Storyboard,
        version,
        req,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use uuid::Uuid;

    /// 构造带完整 schema 的测试库（init_db 自动运行所有迁移，含 content_versions）
    async fn create_test_pool() -> sqlx::SqlitePool {
        let db_path = std::env::temp_dir().join(format!(
            "woohoo-content-version-perm-{}.sqlite",
            Uuid::new_v4()
        ));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
        init_db(&database_url, 10).await
    }

    async fn seed_user(pool: &sqlx::SqlitePool, user_id: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (?, ?, ?, '')",
        )
        .bind(user_id)
        .bind(format!("user-{}", user_id))
        .bind(format!("{}@test.local", user_id))
        .execute(pool)
        .await
        .expect("failed to seed user");
    }

    async fn seed_project(pool: &sqlx::SqlitePool, project_id: &str, owner_user_id: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO projects (id, user_id, name, created_at, updated_at) \
             VALUES (?, ?, 'Test Project', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(project_id)
        .bind(owner_user_id)
        .execute(pool)
        .await
        .expect("failed to seed project");
    }

    /// 所有者访问自己的项目版本 → 放行
    #[tokio::test]
    async fn version_access_allows_owner() {
        let pool = create_test_pool().await;
        seed_user(&pool, "user-1").await;
        seed_project(&pool, "project-1", "user-1").await;

        let result = ensure_project_access(&pool, "user-1", "project-1").await;
        assert!(result.is_ok(), "项目所有者应通过权限校验, got: {:?}", result);
        pool.close().await;
    }

    /// 跨用户访问：user-2 试图读取 user-1 项目的版本 → Forbidden。
    /// 这是“不能跨用户读取版本”的核心保证：不能信任前端传入的 project_id。
    #[tokio::test]
    async fn version_access_rejects_cross_user() {
        let pool = create_test_pool().await;
        seed_user(&pool, "user-1").await;
        seed_user(&pool, "user-2").await;
        seed_project(&pool, "project-1", "user-1").await;

        let result = ensure_project_access(&pool, "user-2", "project-1").await;
        assert!(
            matches!(result, Err(AppError::Forbidden(_))),
            "跨用户访问版本应返回 Forbidden（403）, got: {:?}",
            result
        );
        pool.close().await;
    }

    /// 无效项目 → NotFound（不泄露项目存在性）
    #[tokio::test]
    async fn version_access_returns_not_found_for_invalid_project() {
        let pool = create_test_pool().await;
        seed_user(&pool, "user-1").await;

        let result = ensure_project_access(&pool, "user-1", "nonexistent-project").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "无效项目应返回 NotFound（404）, got: {:?}",
            result
        );
        pool.close().await;
    }

    /// 版本数据的项目隔离：即使攻击者直接调用 repo::list_versions，
    /// 也只能拿到其查询 project_id 的版本，无法越权读取他人项目的版本内容。
    #[tokio::test]
    async fn versions_do_not_leak_across_projects_via_repo() {
        let pool = create_test_pool().await;
        seed_user(&pool, "user-1").await;
        seed_user(&pool, "user-2").await;
        seed_project(&pool, "project-a", "user-1").await;
        seed_project(&pool, "project-b", "user-2").await;

        // 给 project-a 写入一个版本
        let input = crate::content_version::model::CommitInput {
            project_id: "project-a".to_string(),
            content_type: ContentType::Script,
            content: "user-1 的剧本内容".to_string(),
            title: Some("A".to_string()),
            source: "manual".to_string(),
            created_by: Some("user-1".to_string()),
            note: None,
            expected_base: ConcurrencyToken::BaseVersion(0),
        };
        repo::commit_version(&pool, &input)
            .await
            .expect("commit version for project-a");

        // 以 project-b 视角查询，绝不应看到 project-a 的版本
        let leaked = repo::list_versions(&pool, "project-b", ContentType::Script, 50, 0)
            .await
            .expect("list project-b versions");
        assert!(
            leaked.is_empty(),
            "project-b 不应读取到 project-a 的版本, got: {:?}",
            leaked
        );

        // project-b 也无法通过 get_version 拿到 project-a 的 v1
        let single = repo::get_version(&pool, "project-b", ContentType::Script, 1)
            .await
            .expect("get project-b v1");
        assert!(single.is_none(), "project-b 不应读取到 project-a 的 v1");

        pool.close().await;
    }
}
