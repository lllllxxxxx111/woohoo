use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::model::{
    CommitError, CommitInput, CommitOutcome, ConcurrencyToken, ContentVersionRow, ContentType,
    VersionConflict,
};
use crate::error::AppError;

impl CommitError {
    /// 将版本提交错误映射为统一 AppError（冲突 → 结构化 409）
    pub fn into_app_error(self) -> AppError {
        match self {
            CommitError::Conflict(conflict) => {
                let message = format!(
                    "内容已被更新到 v{}，你的修改基于旧版本，未写入。请加载最新版本后重试。",
                    conflict.current_version
                );
                let detail = serde_json::to_value(&conflict).unwrap_or_else(|_| {
                    serde_json::json!({ "currentVersion": conflict.current_version })
                });
                AppError::VersionConflict { message, detail }
            }
            CommitError::Database(error) => AppError::Sqlx(error),
        }
    }
}

/// 计算内容哈希（SHA-256 十六进制），用于相同内容去重与一致性校验
pub fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 读取某项目某内容类型的最新版本（不存在返回 None）
pub async fn latest_version_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    content_type: ContentType,
) -> Result<Option<ContentVersionRow>, sqlx::Error> {
    sqlx::query_as::<_, ContentVersionRow>(
        "SELECT id, project_id, content_type, version, content, content_hash, source,
                created_by, note, title, created_at
         FROM content_versions
         WHERE project_id = ? AND content_type = ?
         ORDER BY version DESC
         LIMIT 1",
    )
    .bind(project_id)
    .bind(content_type.as_str())
    .fetch_optional(&mut **tx)
    .await
}

/// 读取当前版本号（无版本时为 0）
pub async fn current_version_number_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    content_type: ContentType,
) -> Result<i64, sqlx::Error> {
    let version = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(version), 0) FROM content_versions
         WHERE project_id = ? AND content_type = ?",
    )
    .bind(project_id)
    .bind(content_type.as_str())
    .fetch_one(&mut **tx)
    .await?;
    Ok(version)
}

/// 读取当前版本号（连接池版本）。列表接口分页时不能拿“当前页首行”当
/// 当前版本：offset>0 时那是页内最新而非全局最新。
pub async fn current_version_number(
    pool: &SqlitePool,
    project_id: &str,
    content_type: ContentType,
) -> Result<i64, sqlx::Error> {
    let version = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(version), 0) FROM content_versions
         WHERE project_id = ? AND content_type = ?",
    )
    .bind(project_id)
    .bind(content_type.as_str())
    .fetch_one(pool)
    .await?;
    Ok(version)
}

/**
 * 在当前事务内提交一个新版本。
 *
 * 并发语义（乐观锁）：
 *   1. 若请求携带 baseVersion（expected_base），且与当前版本不一致 → 返回 Conflict。
 *   2. 若新内容哈希与当前版本一致 → 去重，返回 Duplicate（不新增版本）。
 *   3. 否则写入 version = current + 1。
 *
 * 兜底：依赖 (project_id, content_type, version) 唯一约束。极端竞态下若并发写入
 * 命中唯一约束，转换为 Conflict，避免静默覆盖。
 */
pub async fn commit_version_tx(
    tx: &mut Transaction<'_, Sqlite>,
    input: &CommitInput,
) -> Result<CommitOutcome, CommitError> {
    let current = latest_version_tx(tx, &input.project_id, input.content_type).await?;
    let current_version = current.as_ref().map(|row| row.version).unwrap_or(0);
    let content_hash = sha256_hex(&input.content);

    // 幂等重试优先：请求内容已经等于当前版本时直接返回已有版本。
    // 这允许客户端在响应丢失后带着旧 baseVersion 安全重试，不会误报并发冲突。
    // 标题也参与去重：仅改标题的保存若不记版本，最新版本将永远停留在旧标题，
    // 事后“恢复到最新版”会把标题一并回退。
    if let Some(current_row) = &current {
        if current_row.content_hash == content_hash && current_row.title == input.title {
            return Ok(CommitOutcome::Duplicate(current_row.clone()));
        }
    }

    if let ConcurrencyToken::BaseVersion(base) = input.expected_base {
        if base != current_version {
            return Err(CommitError::Conflict(VersionConflict {
                base_version: Some(base),
                current_version,
                current_version_id: current.as_ref().map(|row| row.id.clone()),
                current_content_hash: current.as_ref().map(|row| row.content_hash.clone()),
            }));
        }
    }

    let new_version = current_version + 1;
    let id = Uuid::new_v4().to_string();

    let insert_result = sqlx::query(
        "INSERT INTO content_versions
             (id, project_id, content_type, version, content, content_hash, source, created_by, note, title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.project_id)
    .bind(input.content_type.as_str())
    .bind(new_version)
    .bind(&input.content)
    .bind(&content_hash)
    .bind(&input.source)
    .bind(&input.created_by)
    .bind(&input.note)
    .bind(&input.title)
    .execute(&mut **tx)
    .await;

    if let Err(error) = insert_result {
        if is_unique_violation(&error) {
            // 并发写入竞态：其他事务已经推进版本号，重新读取并报告冲突
            let latest = latest_version_tx(tx, &input.project_id, input.content_type).await?;
            let latest_version = latest.as_ref().map(|row| row.version).unwrap_or(new_version);
            return Err(CommitError::Conflict(VersionConflict {
                base_version: match input.expected_base {
                    ConcurrencyToken::BaseVersion(base) => Some(base),
                    ConcurrencyToken::None => None,
                },
                current_version: latest_version,
                current_version_id: latest.as_ref().map(|row| row.id.clone()),
                current_content_hash: latest.as_ref().map(|row| row.content_hash.clone()),
            }));
        }
        return Err(CommitError::Database(error));
    }

    let created = sqlx::query_as::<_, ContentVersionRow>(
        "SELECT id, project_id, content_type, version, content, content_hash, source,
                created_by, note, title, created_at
         FROM content_versions WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&mut **tx)
    .await?;

    // 保留上限：版本快照是全量内容，自动保存类客户端会无限追加。
    // 每次新增版本后在同一事务内裁掉超出上限的最旧版本（当前版本号只增
    // 不减，MAX 与去重判断只看最新行，裁剪不影响任何并发语义）。
    prune_versions_tx(tx, &input.project_id, input.content_type).await?;

    Ok(CommitOutcome::Created(created))
}

/// 每个 (project, content_type) 保留的最大版本数。与列表接口的单页上限
/// （limit 钳制到 200）对齐；超出的最旧版本在每次新增时被裁剪。
pub const MAX_RETAINED_VERSIONS: i64 = 200;

/// 裁剪超出保留上限的最旧版本（必须在写事务内调用，与新增版本原子提交）。
async fn prune_versions_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    content_type: ContentType,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM content_versions
         WHERE project_id = ? AND content_type = ?
           AND version NOT IN (
               SELECT version FROM content_versions
               WHERE project_id = ? AND content_type = ?
               ORDER BY version DESC
               LIMIT ?
           )",
    )
    .bind(project_id)
    .bind(content_type.as_str())
    .bind(project_id)
    .bind(content_type.as_str())
    .bind(MAX_RETAINED_VERSIONS)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 便捷入口：自行开启事务提交版本（用于不需要与其他写操作合并的场景）
#[allow(dead_code)]
pub async fn commit_version(
    pool: &SqlitePool,
    input: &CommitInput,
) -> Result<CommitOutcome, CommitError> {
    let mut tx = pool.begin().await?;
    let outcome = commit_version_tx(&mut tx, input).await?;
    tx.commit().await?;
    Ok(outcome)
}

/// 版本列表（倒序，最新版本在前），不下发 content
pub async fn list_versions(
    pool: &SqlitePool,
    project_id: &str,
    content_type: ContentType,
    limit: i64,
    offset: i64,
) -> Result<Vec<ContentVersionRow>, sqlx::Error> {
    sqlx::query_as::<_, ContentVersionRow>(
        "SELECT id, project_id, content_type, version, content, content_hash, source,
                created_by, note, title, created_at
         FROM content_versions
         WHERE project_id = ? AND content_type = ?
         ORDER BY version DESC
         LIMIT ? OFFSET ?",
    )
    .bind(project_id)
    .bind(content_type.as_str())
    .bind(limit.max(1).min(200))
    .bind(offset.max(0))
    .fetch_all(pool)
    .await
}

/// 版本总数
pub async fn count_versions(
    pool: &SqlitePool,
    project_id: &str,
    content_type: ContentType,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM content_versions WHERE project_id = ? AND content_type = ?",
    )
    .bind(project_id)
    .bind(content_type.as_str())
    .fetch_one(pool)
    .await
}

/// 读取指定版本（含完整内容）
pub async fn get_version(
    pool: &SqlitePool,
    project_id: &str,
    content_type: ContentType,
    version: i64,
) -> Result<Option<ContentVersionRow>, sqlx::Error> {
    sqlx::query_as::<_, ContentVersionRow>(
        "SELECT id, project_id, content_type, version, content, content_hash, source,
                created_by, note, title, created_at
         FROM content_versions
         WHERE project_id = ? AND content_type = ? AND version = ?",
    )
    .bind(project_id)
    .bind(content_type.as_str())
    .bind(version)
    .fetch_optional(pool)
    .await
}

/// 读取最新版本（含完整内容）
pub async fn get_latest_version(
    pool: &SqlitePool,
    project_id: &str,
    content_type: ContentType,
) -> Result<Option<ContentVersionRow>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row = latest_version_tx(&mut tx, project_id, content_type).await?;
    tx.commit().await?;
    Ok(row)
}

/// 供 workspace bootstrap 使用的轻量最新版本视图（不含 content）
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LatestVersionSummary {
    pub project_id: String,
    pub content_type: String,
    pub version: i64,
    pub id: String,
    pub content_hash: String,
}

/// 批量读取某用户所有项目、所有内容类型的最新版本（用于 bootstrap 下发 baseVersion）
pub async fn latest_versions_by_user(
    pool: &SqlitePool,
    user_id: &str,
) -> Result<Vec<LatestVersionSummary>, sqlx::Error> {
    sqlx::query_as::<_, LatestVersionSummary>(
        "SELECT cv.project_id AS project_id,
                cv.content_type AS content_type,
                cv.version AS version,
                cv.id AS id,
                cv.content_hash AS content_hash
         FROM content_versions cv
         INNER JOIN projects p ON p.id = cv.project_id
         WHERE p.user_id = ?
           AND cv.version = (
               SELECT MAX(cv2.version) FROM content_versions cv2
               WHERE cv2.project_id = cv.project_id
                 AND cv2.content_type = cv.content_type
           )",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db_error) = error {
        if db_error.is_unique_violation() {
            return true;
        }
        let message = db_error.message().to_ascii_lowercase();
        if message.contains("unique") {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content_version::model::{CommitInput, ConcurrencyToken, ContentType};
    use sqlx::sqlite::SqlitePoolOptions;

    /// 创建内存库并初始化 users / projects / content_versions 最小结构
    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory pool");

        sqlx::query("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .expect("create users table");

        sqlx::query(
            "CREATE TABLE projects (
                id          TEXT PRIMARY KEY NOT NULL,
                user_id     TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT '',
                description TEXT DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'draft',
                phase       TEXT NOT NULL DEFAULT 'ideation',
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("create projects table");

        sqlx::raw_sql(include_str!("../../migrations/029_content_versions.sql"))
            .execute(&pool)
            .await
            .expect("apply content_versions migration");

        pool
    }

    async fn seed_project(pool: &SqlitePool, project_id: &str, user_id: &str) {
        sqlx::query("INSERT INTO users (id) VALUES (?) ON CONFLICT DO NOTHING")
            .bind(user_id)
            .execute(pool)
            .await
            .expect("seed user");
        sqlx::query("INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)")
            .bind(project_id)
            .bind(user_id)
            .bind(format!("Project {}", project_id))
            .execute(pool)
            .await
            .expect("seed project");
    }

    fn input(
        project_id: &str,
        content_type: ContentType,
        content: &str,
        expected_base: ConcurrencyToken,
        source: &str,
    ) -> CommitInput {
        CommitInput {
            project_id: project_id.to_string(),
            content_type,
            content: content.to_string(),
            title: Some("标题".to_string()),
            source: source.to_string(),
            created_by: Some("user-1".to_string()),
            note: None,
            expected_base,
        }
    }

    #[tokio::test]
    async fn version_numbers_are_monotonic() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        let first = commit_version(
            &pool,
            &input("p1", ContentType::Script, "A", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit v1");
        assert_eq!(first.version_row().version, 1);

        let second = commit_version(
            &pool,
            &input("p1", ContentType::Script, "B", ConcurrencyToken::BaseVersion(1), "manual"),
        )
        .await
        .expect("commit v2");
        assert_eq!(second.version_row().version, 2);

        let third = commit_version(
            &pool,
            &input("p1", ContentType::Script, "C", ConcurrencyToken::BaseVersion(2), "ai"),
        )
        .await
        .expect("commit v3");
        assert_eq!(third.version_row().version, 3);

        let count = count_versions(&pool, "p1", ContentType::Script)
            .await
            .expect("count versions");
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn stale_base_version_returns_conflict() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        commit_version(
            &pool,
            &input("p1", ContentType::Script, "A", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit v1");

        // 客户端仍基于 v0 提交，但当前已是 v1 → 冲突
        let stale = commit_version(
            &pool,
            &input("p1", ContentType::Script, "X", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await;

        match stale {
            Err(CommitError::Conflict(conflict)) => {
                assert_eq!(conflict.current_version, 1);
                assert_eq!(conflict.base_version, Some(0));
            }
            other => panic!("expected conflict, got {:?}", other.is_ok()),
        }

        // 冲突不应产生新版本
        let count = count_versions(&pool, "p1", ContentType::Script)
            .await
            .expect("count versions");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn identical_retry_with_a_stale_base_version_is_deduplicated() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        commit_version(
            &pool,
            &input("p1", ContentType::Script, "同一内容", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit v1");

        let retry = commit_version(
            &pool,
            &input("p1", ContentType::Script, "同一内容", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("idempotent retry");

        assert!(retry.is_duplicate());
        assert_eq!(retry.version_row().version, 1);
    }

    #[tokio::test]
    async fn identical_content_is_deduplicated() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        let first = commit_version(
            &pool,
            &input("p1", ContentType::Script, "相同内容", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit v1");
        assert!(matches!(first, CommitOutcome::Created(_)));
        assert_eq!(first.version_row().version, 1);

        // 重复保存相同内容 → 去重，不新增版本
        let duplicate = commit_version(
            &pool,
            &input("p1", ContentType::Script, "相同内容", ConcurrencyToken::BaseVersion(1), "manual"),
        )
        .await
        .expect("dedup commit");
        assert!(duplicate.is_duplicate());
        assert_eq!(duplicate.version_row().version, 1);

        let count = count_versions(&pool, "p1", ContentType::Script)
            .await
            .expect("count versions");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn restore_creates_a_new_version_without_rewriting_history() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        // v1 = A, v2 = B
        let v1 = commit_version(
            &pool,
            &input("p1", ContentType::Script, "A", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit v1");
        let v1_hash = v1.version_row().content_hash.clone();

        commit_version(
            &pool,
            &input("p1", ContentType::Script, "B", ConcurrencyToken::BaseVersion(1), "manual"),
        )
        .await
        .expect("commit v2");

        // 恢复 A：追加一个新版本（source=restore），而不是改写 v1
        let restored = commit_version(
            &pool,
            &input("p1", ContentType::Script, "A", ConcurrencyToken::None, "restore"),
        )
        .await
        .expect("restore commit");

        assert!(matches!(restored, CommitOutcome::Created(_)));
        assert_eq!(restored.version_row().version, 3);
        assert_eq!(restored.version_row().source, "restore");
        assert_eq!(restored.version_row().content_hash, v1_hash);

        // 历史版本 v1 保持不变
        let v1_row = get_version(&pool, "p1", ContentType::Script, 1)
            .await
            .expect("get v1")
            .expect("v1 exists");
        assert_eq!(v1_row.content, "A");
        assert_eq!(v1_row.source, "manual");

        let count = count_versions(&pool, "p1", ContentType::Script)
            .await
            .expect("count versions");
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn versions_are_isolated_between_projects() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;
        seed_project(&pool, "p2", "user-2").await;

        commit_version(
            &pool,
            &input("p1", ContentType::Script, "P1 content", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit p1 v1");

        let p1_versions = list_versions(&pool, "p1", ContentType::Script, 50, 0)
            .await
            .expect("list p1 versions");
        assert_eq!(p1_versions.len(), 1);

        // 另一个项目读取不到 p1 的版本（权限隔离的数据基础）
        let p2_versions = list_versions(&pool, "p2", ContentType::Script, 50, 0)
            .await
            .expect("list p2 versions");
        assert!(p2_versions.is_empty());

        let p2_get = get_version(&pool, "p2", ContentType::Script, 1)
            .await
            .expect("get p2 v1");
        assert!(p2_get.is_none());

        // p2 从版本 0 独立递增，不受 p1 影响
        let p2_v1 = commit_version(
            &pool,
            &input("p2", ContentType::Script, "P2 content", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit p2 v1");
        assert_eq!(p2_v1.version_row().version, 1);
    }

    #[tokio::test]
    async fn first_save_and_empty_content_are_handled() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        // 首次保存空内容：base=0，无当前版本 → 成功创建 v1
        let first = commit_version(
            &pool,
            &input("p1", ContentType::Script, "", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("first empty save");
        assert!(matches!(first, CommitOutcome::Created(_)));
        assert_eq!(first.version_row().version, 1);

        // 再次保存空内容 → 去重
        let duplicate = commit_version(
            &pool,
            &input("p1", ContentType::Script, "", ConcurrencyToken::BaseVersion(1), "manual"),
        )
        .await
        .expect("second empty save");
        assert!(duplicate.is_duplicate());
    }

    #[tokio::test]
    async fn no_token_write_is_lenient_for_backward_compatibility() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        // 旧客户端不携带 baseVersion（ConcurrencyToken::None）→ 按当前版本继续写入
        let first = commit_version(
            &pool,
            &input("p1", ContentType::Script, "A", ConcurrencyToken::None, "manual"),
        )
        .await
        .expect("no-token commit v1");
        assert_eq!(first.version_row().version, 1);

        let second = commit_version(
            &pool,
            &input("p1", ContentType::Script, "B", ConcurrencyToken::None, "manual"),
        )
        .await
        .expect("no-token commit v2");
        assert_eq!(second.version_row().version, 2);
    }

    #[tokio::test]
    async fn storyboard_versions_are_independent_from_script() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        commit_version(
            &pool,
            &input("p1", ContentType::Script, "script-A", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit script v1");

        // 分镜独立从版本 1 开始计数
        let storyboard_v1 = commit_version(
            &pool,
            &input(
                "p1",
                ContentType::Storyboard,
                "{\"lines\":[]}",
                ConcurrencyToken::BaseVersion(0),
                "manual",
            ),
        )
        .await
        .expect("commit storyboard v1");
        assert_eq!(storyboard_v1.version_row().version, 1);
        assert_eq!(storyboard_v1.version_row().content_type, "storyboard");

        let script_latest = get_latest_version(&pool, "p1", ContentType::Script)
            .await
            .expect("script latest");
        assert_eq!(script_latest.expect("script latest exists").version, 1);
    }

    /// 提交超过保留上限的版本后，只保留最近 MAX_RETAINED_VERSIONS 个，
    /// 且最新版本（含内容去重的基线）永不被裁剪。
    #[tokio::test]
    async fn commits_beyond_retention_cap_prune_oldest_versions() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;

        let total = MAX_RETAINED_VERSIONS + 20;
        let mut latest_version = 0i64;
        for seq in 0..total {
            let outcome = commit_version(
                &pool,
                &input(
                    "p1",
                    ContentType::Script,
                    &format!("内容-{seq}"),
                    // 内容每次变化，标题保持一致，避免触发去重
                    ConcurrencyToken::None,
                    "manual",
                ),
            )
            .await
            .expect("commit version");
            latest_version = outcome.version_row().version;
        }
        assert_eq!(latest_version, total);

        let count = count_versions(&pool, "p1", ContentType::Script)
            .await
            .expect("count versions");
        assert_eq!(count, MAX_RETAINED_VERSIONS);

        // 保留的一定是最新的一段：MIN(version) = total - cap + 1
        let (min_kept, max_kept): (i64, i64) =
            sqlx::query_as("SELECT MIN(version), MAX(version) FROM content_versions")
                .fetch_one(&pool)
                .await
                .expect("min/max versions");
        assert_eq!(max_kept, total);
        assert_eq!(min_kept, total - MAX_RETAINED_VERSIONS + 1);

        // 版本号不回退：裁剪后再提交，新版本号仍是 max + 1
        let next = commit_version(
            &pool,
            &input(
                "p1",
                ContentType::Script,
                "再保存一次",
                ConcurrencyToken::None,
                "manual",
            ),
        )
        .await
        .expect("commit after prune");
        assert_eq!(next.version_row().version, total + 1);
    }

    /// 保留上限按 (project, content_type) 独立计数，互不影响。
    #[tokio::test]
    async fn retention_cap_is_per_project_and_content_type() {
        let pool = setup_pool().await;
        seed_project(&pool, "p1", "user-1").await;
        seed_project(&pool, "p2", "user-1").await;

        for seq in 0..(MAX_RETAINED_VERSIONS + 5) {
            commit_version(
                &pool,
                &input(
                    "p1",
                    ContentType::Script,
                    &format!("p1-script-{seq}"),
                    ConcurrencyToken::None,
                    "manual",
                ),
            )
            .await
            .expect("commit p1 script");
        }

        let p1_script = count_versions(&pool, "p1", ContentType::Script)
            .await
            .expect("count p1 script");
        assert_eq!(p1_script, MAX_RETAINED_VERSIONS);

        // p1 的 storyboard 与 p2 的 script 未受影响
        commit_version(
            &pool,
            &input(
                "p1",
                ContentType::Storyboard,
                "{\"lines\":[]}",
                ConcurrencyToken::BaseVersion(0),
                "manual",
            ),
        )
        .await
        .expect("commit p1 storyboard");
        let p1_storyboard = count_versions(&pool, "p1", ContentType::Storyboard)
            .await
            .expect("count p1 storyboard");
        assert_eq!(p1_storyboard, 1);

        commit_version(
            &pool,
            &input("p2", ContentType::Script, "A", ConcurrencyToken::BaseVersion(0), "manual"),
        )
        .await
        .expect("commit p2 script");
        let p2_script = count_versions(&pool, "p2", ContentType::Script)
            .await
            .expect("count p2 script");
        assert_eq!(p2_script, 1);
    }
}
