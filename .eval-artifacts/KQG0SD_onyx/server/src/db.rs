use crate::ai::config::DEFAULT_AGENT_SEEDS;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::FromRow;
use sqlx::Row;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct SeedBackfillSummary {
    scanned: usize,
    inserted: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct SchemaBackfillReport {
    applied_migrations: Vec<String>,
    default_agent_seed: SeedBackfillSummary,
    project_assignment_seed: SeedBackfillSummary,
    retained_runtime_backfills: Vec<&'static str>,
    pending_compatibility_issues: Vec<String>,
}

/// 创建 SQLite 连接池并自动运行 migration
pub async fn init_db(database_url: &str, ai_max_concurrent_tasks: usize) -> SqlitePool {
    // 确保 data 目录存在
    if let Some(path) = database_url
        .strip_prefix("sqlite://")
        .and_then(|s| s.split('?').next())
    {
        if let Some(parent) = Path::new(path).parent() {
            std::fs::create_dir_all(parent).ok();
        }
    }

    /*
     * SQLite 连接优化配置
     *
     * 性能改进点：
     * 1. WAL 模式 - 提升并发读写性能，允许读操作不阻塞写操作
     * 2. 忙等待超时 - 防止长时间锁等待导致请求超时
     */
    let options = SqliteConnectOptions::from_str(database_url)
        .expect("Invalid DATABASE_URL")
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    let max_connections = (ai_max_concurrent_tasks.max(10) as u32) + 4;

    /*
     * 数据库连接池优化配置
     *
     * 改进项：
     * - min_connections: 从1提升到2，减少冷启动延迟
     * - acquire_timeout: 连接获取超时3秒，避免无限等待
     * - idle_timeout: 空闲连接10秒后回收，释放资源
     * - max_lifetime: 连接最大存活时间30分钟，防止长连接问题
     */
    let pool = SqlitePoolOptions::new()
        .min_connections(2)
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(3))
        .idle_timeout(Duration::from_secs(10))
        .max_lifetime(Some(Duration::from_secs(1800)))
        .connect_with(options)
        .await
        .expect("Failed to connect to SQLite");

    tracing::info!(min_connections = 2, max_connections, "数据库连接池已初始化");

    let applied_migrations = run_schema_migrations(&pool)
        .await
        .expect("Failed to run schema migrations");
    let default_agent_seed = ensure_default_agents_for_existing_users(&pool)
        .await
        .expect("Failed to seed default agents");
    let project_assignment_seed = ensure_project_agent_assignments_for_existing_projects(&pool)
        .await
        .expect("Failed to seed project agent assignments");
    let backfill_report = build_schema_backfill_report(
        &pool,
        applied_migrations,
        default_agent_seed,
        project_assignment_seed,
    )
    .await
    .expect("Failed to build schema backfill report");

    if backfill_report.pending_compatibility_issues.is_empty() {
        tracing::info!(?backfill_report, "数据库迁移与补数报告");
    } else {
        tracing::warn!(?backfill_report, "数据库迁移后仍存在兼容问题");
    }

    tracing::info!("Database initialized successfully");
    pool
}

async fn run_schema_migrations(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY NOT NULL,
            kind       TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )",
    )
    .execute(pool)
    .await?;

    let mut applied_versions = Vec::new();

    for (version, migration_sql) in [
        ("001_init", include_str!("../migrations/001_init.sql")),
        (
            "002_pipeline_runs",
            include_str!("../migrations/002_pipeline_runs.sql"),
        ),
        (
            "003_pipeline_orchestrator_m1",
            include_str!("../migrations/003_pipeline_orchestrator_m1.sql"),
        ),
        (
            "004_pipeline_prompt_optimizations",
            include_str!("../migrations/004_pipeline_prompt_optimizations.sql"),
        ),
        (
            "008_ai_tasks_persistence",
            include_str!("../migrations/008_ai_tasks_persistence.sql"),
        ),
        (
            "012_collaboration",
            include_str!("../migrations/012_collaboration.sql"),
        ),
        (
            "013_image_studio",
            include_str!("../migrations/013_image_studio.sql"),
        ),
        (
            "014_image_generation_assets",
            include_str!("../migrations/014_image_generation_assets.sql"),
        ),
        (
            "015_ai_endpoint_capabilities",
            include_str!("../migrations/015_ai_endpoint_capabilities.sql"),
        ),
        (
            "017_video_gen",
            include_str!("../migrations/017_video_gen.sql"),
        ),
        (
            "020_user_budget",
            include_str!("../migrations/020_user_budget.sql"),
        ),
    ] {
        if run_sql_migration(pool, version, migration_sql).await? {
            applied_versions.push(version.to_string());
        }
    }

    if let Some(version) = run_pipeline_schema_backfill_migration(pool).await? {
        applied_versions.push(version);
    }
    if let Some(version) = run_legacy_schema_backfill_migration(pool).await? {
        applied_versions.push(version);
    }
    if let Some(version) = run_runtime_compat_backfill_migration_v2(pool).await? {
        applied_versions.push(version);
    }
    if let Some(version) = run_ops_schema_conflict_backfill_migration(pool).await? {
        applied_versions.push(version);
    }
    if let Some(version) = run_agent_scope_backfill_migration(pool).await? {
        applied_versions.push(version);
    }
    if let Some(version) = run_updated_at_column_backfill_migration(pool).await? {
        applied_versions.push(version);
    }
    if let Some(version) = run_collaboration_pipeline_run_id_backfill_migration(pool).await? {
        applied_versions.push(version);
    }
    if let Some(version) = run_image_generation_project_backfill_migration(pool).await? {
        applied_versions.push(version);
    }
    if let Some(version) = run_image_generation_asset_ids_backfill_migration(pool).await? {
        applied_versions.push(version);
    }

    Ok(applied_versions)
}

async fn run_sql_migration(
    pool: &SqlitePool,
    version: &str,
    migration_sql: &str,
) -> Result<bool, sqlx::Error> {
    if has_schema_migration(pool, version).await? {
        return Ok(false);
    }

    tracing::info!(version, "执行 SQL schema migration");
    sqlx::raw_sql(migration_sql).execute(pool).await?;
    record_schema_migration(pool, version, "sql").await?;
    Ok(true)
}

async fn run_legacy_schema_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "006_legacy_schema_backfills";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    tracing::info!(version = VERSION, "执行非 pipeline 历史数据库兼容回填");
    ensure_ai_usage_schema(pool).await?;
    repair_ai_usage_agent_foreign_key(pool).await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn run_pipeline_schema_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "005_pipeline_schema_backfills";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    tracing::info!(version = VERSION, "执行 pipeline 历史数据库兼容回填");
    ensure_pipeline_runs_schema(pool).await?;
    ensure_pipeline_orchestrator_schema(pool).await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn run_runtime_compat_backfill_migration_v2(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "007_runtime_compat_backfills_v2";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    tracing::info!(version = VERSION, "执行消息与 AI usage 兼容回填");
    ensure_message_updated_at_schema(pool).await?;
    ensure_ai_usage_schema(pool).await?;
    repair_ai_usage_agent_foreign_key(pool).await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn run_ops_schema_conflict_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "009_ops_schema_conflict_backfills";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    tracing::info!(version = VERSION, "执行 ops 与 upsert conflict 兼容回填");
    backfill_notification_events_schema(pool).await?;
    backfill_runtime_heartbeat_conflict_target(pool).await?;
    backfill_upsert_conflict_targets(pool).await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn run_agent_scope_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "010_agent_scope_backfills";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    tracing::info!(version = VERSION, "执行 agent user-scope 兼容回填");
    ensure_agents_schema(pool).await?;
    repair_project_agent_assignment_agent_foreign_key(pool).await?;
    ensure_project_agent_assignments_schema(pool).await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn run_updated_at_column_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "011_updated_at_column_backfills";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    tracing::info!(version = VERSION, "执行通用 updated_at 缺列兼容回填");
    backfill_generic_updated_at_columns(pool).await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

/** 安全地为 collaboration_sessions 表添加 pipeline_run_id 列 */
async fn run_collaboration_pipeline_run_id_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "016_collaboration_pipeline_run_id";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    tracing::info!(
        version = VERSION,
        "执行 collaboration_sessions.pipeline_run_id 列回填"
    );
    let columns = list_table_columns(pool, "collaboration_sessions").await?;
    if !columns.is_empty() && !columns.contains("pipeline_run_id") {
        sqlx::query("ALTER TABLE collaboration_sessions ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL")
            .execute(pool)
            .await?;
    }
    // 确保索引存在
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_collab_sessions_pipeline_run ON collaboration_sessions(pipeline_run_id)")
        .execute(pool)
        .await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn run_image_generation_project_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "018_image_generation_project_id";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    ensure_image_generation_project_schema(pool).await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn ensure_image_generation_project_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut columns = list_table_columns(pool, "image_generations").await?;
    if columns.is_empty() {
        return Ok(());
    }

    if !columns.contains("project_id") {
        sqlx::query(
            "ALTER TABLE image_generations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
        )
        .execute(pool)
        .await?;
        columns.insert("project_id".to_string());
    }

    if !columns.contains("asset_ids") {
        sqlx::query("ALTER TABLE image_generations ADD COLUMN asset_ids TEXT")
            .execute(pool)
            .await?;
        columns.insert("asset_ids".to_string());
    }

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_image_gen_project ON image_generations(project_id, created_at DESC)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn run_image_generation_asset_ids_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "019_image_generation_asset_ids";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    ensure_image_generation_asset_ids_schema(pool).await?;
    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn ensure_image_generation_asset_ids_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let columns = list_table_columns(pool, "image_generations").await?;
    if columns.is_empty() || columns.contains("asset_ids") {
        return Ok(());
    }

    sqlx::query("ALTER TABLE image_generations ADD COLUMN asset_ids TEXT")
        .execute(pool)
        .await?;

    Ok(())
}

async fn has_schema_migration(pool: &SqlitePool, version: &str) -> Result<bool, sqlx::Error> {
    let count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE version = ?")
            .bind(version)
            .fetch_one(pool)
            .await?;

    Ok(count > 0)
}

async fn record_schema_migration(
    pool: &SqlitePool,
    version: &str,
    kind: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT OR IGNORE INTO schema_migrations (version, kind)
         VALUES (?, ?)",
    )
    .bind(version)
    .bind(kind)
    .execute(pool)
    .await?;

    Ok(())
}

async fn backfill_notification_events_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut columns = list_table_columns(pool, "notification_events").await?;
    if columns.is_empty() {
        return Ok(());
    }

    let additions = [
        (
            "dedupe_key",
            "ALTER TABLE notification_events ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''",
        ),
        (
            "attempt_count",
            "ALTER TABLE notification_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "last_error",
            "ALTER TABLE notification_events ADD COLUMN last_error TEXT",
        ),
        (
            "next_attempt_at",
            "ALTER TABLE notification_events ADD COLUMN next_attempt_at TEXT",
        ),
    ];

    for (column, sql) in additions {
        if !columns.contains(column) {
            sqlx::query(sql).execute(pool).await?;
            columns.insert(column.to_string());
        }
    }

    if !columns.contains("updated_at") {
        sqlx::query("ALTER TABLE notification_events ADD COLUMN updated_at TEXT")
            .execute(pool)
            .await?;
        columns.insert("updated_at".to_string());
    }

    let updated_at_sql = if columns.contains("sent_at") {
        "UPDATE notification_events
         SET updated_at = COALESCE(
             NULLIF(updated_at, ''),
             sent_at,
             created_at,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         )
         WHERE updated_at IS NULL OR updated_at = ''"
    } else {
        "UPDATE notification_events
         SET updated_at = COALESCE(
             NULLIF(updated_at, ''),
             created_at,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         )
         WHERE updated_at IS NULL OR updated_at = ''"
    };
    sqlx::query(updated_at_sql).execute(pool).await?;

    let indexes = [
        "CREATE INDEX IF NOT EXISTS idx_notification_events_user_status ON notification_events(user_id, status, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_notification_events_status_next_attempt ON notification_events(status, next_attempt_at, created_at DESC)",
    ];

    for sql in indexes {
        sqlx::query(sql).execute(pool).await?;
    }

    sqlx::query(
        "DELETE FROM notification_events
         WHERE dedupe_key != ''
           AND rowid NOT IN (
             SELECT MAX(rowid)
             FROM notification_events
             WHERE dedupe_key != ''
             GROUP BY dedupe_key
           )",
    )
    .execute(pool)
    .await?;

    // 统一重建 dedupe 索引，修复历史版本可能残留的非兼容索引定义。
    sqlx::query("DROP INDEX IF EXISTS idx_notification_events_dedupe")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedupe
         ON notification_events(dedupe_key) WHERE dedupe_key != ''",
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn backfill_runtime_heartbeat_conflict_target(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let columns = list_table_columns(pool, "runtime_heartbeats").await?;
    if columns.is_empty() {
        return Ok(());
    }

    if !has_single_column_conflict_target(pool, "runtime_heartbeats", "component_key").await? {
        // 老版本数据库可能缺少 component_key 唯一约束，先按 key 去重再补唯一索引，
        // 避免 ON CONFLICT(component_key) 报 "does not match any PRIMARY KEY or UNIQUE constraint"。
        sqlx::query(
            "DELETE FROM runtime_heartbeats
             WHERE rowid NOT IN (
                SELECT MAX(rowid)
                FROM runtime_heartbeats
                GROUP BY component_key
             )",
        )
        .execute(pool)
        .await?;

        // 统一重建 component_key 冲突目标索引，避免历史库中索引定义不一致导致 ON CONFLICT 失效。
        sqlx::query("DROP INDEX IF EXISTS idx_runtime_heartbeats_component_key")
            .execute(pool)
            .await?;
        sqlx::query(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_heartbeats_component_key
             ON runtime_heartbeats(component_key)",
        )
        .execute(pool)
        .await?;
    }

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_type
         ON runtime_heartbeats(component_type, status, last_seen_at DESC)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

/**
 * 修复历史库中可能缺失的 UPSERT 冲突目标索引，避免：
 * ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint
 */
async fn backfill_upsert_conflict_targets(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    backfill_single_project_conflict_target(pool, "scripts", "idx_scripts_project_unique").await?;
    backfill_single_project_conflict_target(pool, "storyboards", "idx_storyboards_project_unique")
        .await?;
    Ok(())
}

async fn backfill_single_project_conflict_target(
    pool: &SqlitePool,
    table: &str,
    unique_index: &str,
) -> Result<(), sqlx::Error> {
    let columns = list_table_columns(pool, table).await?;
    if columns.is_empty() || !columns.contains("project_id") {
        return Ok(());
    }

    if has_single_column_conflict_target(pool, table, "project_id").await? {
        return Ok(());
    }

    let dedupe_sql = format!(
        "DELETE FROM {table}
         WHERE rowid NOT IN (
             SELECT MAX(rowid)
             FROM {table}
             GROUP BY project_id
         )"
    );
    sqlx::query(&dedupe_sql).execute(pool).await?;

    let drop_sql = format!("DROP INDEX IF EXISTS {unique_index}");
    sqlx::query(&drop_sql).execute(pool).await?;

    let create_sql =
        format!("CREATE UNIQUE INDEX IF NOT EXISTS {unique_index} ON {table}(project_id)");
    sqlx::query(&create_sql).execute(pool).await?;

    Ok(())
}

/**
 * 确保流程运行相关表已创建
 * 包含：pipeline_runs, pipeline_run_steps, pipeline_run_events, assistant_action_audits, user_ai_policies
 */
async fn ensure_pipeline_runs_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let tables: HashSet<String> = list_all_tables(pool).await?.into_iter().collect();

    if !tables.iter().any(|t| t == "pipeline_runs") {
        tracing::info!("创建流程运行表 pipeline_runs");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS pipeline_runs (
                id              TEXT PRIMARY KEY NOT NULL,
                user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                pipeline_type   TEXT NOT NULL DEFAULT 'one_click',
                trigger_source  TEXT NOT NULL DEFAULT 'manual',
                status          TEXT NOT NULL DEFAULT 'queued',
                idempotency_key TEXT NOT NULL DEFAULT '',
                total_steps     INTEGER NOT NULL DEFAULT 0,
                completed_steps INTEGER NOT NULL DEFAULT 0,
                failed_steps    INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                started_at      TEXT,
                finished_at     TEXT,
                updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                error_message   TEXT,
                error_code      TEXT
            )",
        )
        .execute(pool)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user ON pipeline_runs(user_id, created_at DESC)",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON pipeline_runs(project_id, created_at DESC)",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(user_id, status, created_at DESC)",
        )
        .execute(pool)
        .await?;
    }

    if !tables.iter().any(|t| t == "pipeline_run_steps") {
        tracing::info!("创建流程步骤表 pipeline_run_steps");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS pipeline_run_steps (
                id              TEXT PRIMARY KEY NOT NULL,
                run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
                step_key        TEXT NOT NULL,
                step_name       TEXT NOT NULL,
                step_order      INTEGER NOT NULL DEFAULT 0,
                step_type       TEXT NOT NULL DEFAULT 'design',
                depends_on_json TEXT NOT NULL DEFAULT '[]',
                review_policy_json TEXT,
                retry_of_step_id TEXT,
                run_version     INTEGER NOT NULL DEFAULT 1,
                ai_task_id      TEXT,
                status          TEXT NOT NULL DEFAULT 'queued',
                attempt_count   INTEGER NOT NULL DEFAULT 0,
                max_retries     INTEGER NOT NULL DEFAULT 3,
                duration_ms     INTEGER NOT NULL DEFAULT 0,
                input_summary   TEXT,
                output_ref      TEXT,
                error_message   TEXT,
                last_error_at   TEXT,
                started_at      TEXT,
                completed_at    TEXT,
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(pool)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_run ON pipeline_run_steps(run_id, step_order)",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_status ON pipeline_run_steps(run_id, status)",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_type ON pipeline_run_steps(run_id, step_type)",
        )
        .execute(pool)
        .await?;
    }

    if !tables.iter().any(|t| t == "pipeline_run_events") {
        tracing::info!("创建流程事件表 pipeline_run_events");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS pipeline_run_events (
                id              TEXT PRIMARY KEY NOT NULL,
                run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
                step_id         TEXT,
                event_type      TEXT NOT NULL,
                payload_json    TEXT,
                source          TEXT NOT NULL DEFAULT 'system',
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(pool)
        .await?;
    }

    if !tables.iter().any(|t| t == "assistant_action_audits") {
        tracing::info!("创建助理动作审计表 assistant_action_audits");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS assistant_action_audits (
                id              TEXT PRIMARY KEY NOT NULL,
                run_id          TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
                user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                message_id      TEXT NOT NULL,
                action_type     TEXT NOT NULL,
                action_payload  TEXT NOT NULL,
                confirmation_token TEXT UNIQUE,
                confirmation_expires_at TEXT,
                execution_status TEXT NOT NULL DEFAULT 'pending',
                execution_result TEXT,
                error_message   TEXT,
                confirmed_by    TEXT,
                confirmed_at    TEXT,
                executed_at     TEXT,
                envelope_hash   TEXT NOT NULL,
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(pool)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_action_audits_user ON assistant_action_audits(user_id, created_at DESC)",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_action_audits_token ON assistant_action_audits(confirmation_token)",
        )
        .execute(pool)
        .await?;
    }

    let audit_columns = list_table_columns(pool, "assistant_action_audits").await?;
    if !audit_columns.contains("confirmation_expires_at") {
        sqlx::query("ALTER TABLE assistant_action_audits ADD COLUMN confirmation_expires_at TEXT")
            .execute(pool)
            .await?;
    }

    if !tables.iter().any(|t| t == "assistant_action_audit_events") {
        tracing::info!("创建助理动作审计事件表 assistant_action_audit_events");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS assistant_action_audit_events (
                id           TEXT PRIMARY KEY NOT NULL,
                audit_id     TEXT NOT NULL REFERENCES assistant_action_audits(id) ON DELETE CASCADE,
                event_type   TEXT NOT NULL,
                payload_json TEXT,
                source       TEXT NOT NULL DEFAULT 'user',
                created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(pool)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_action_audit_events_audit ON assistant_action_audit_events(audit_id, created_at DESC)",
        )
        .execute(pool)
        .await?;
    }

    if !tables.iter().any(|t| t == "user_ai_policies") {
        tracing::info!("创建用户AI策略表 user_ai_policies");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS user_ai_policies (
                user_id     TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                policy_json TEXT NOT NULL DEFAULT '{}',
                expires_at  TEXT,
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(pool)
        .await?;
    }

    let policy_columns = list_table_columns(pool, "user_ai_policies").await?;
    if !policy_columns.contains("expires_at") {
        sqlx::query("ALTER TABLE user_ai_policies ADD COLUMN expires_at TEXT")
            .execute(pool)
            .await?;
    }

    Ok(())
}

/**
 * 确保流程编排器 M1 旧库列定义被补齐
 * 003/004 的建表与索引统一走 SQL migration，这里只保留历史数据库 ALTER backfill。
 */
async fn ensure_pipeline_orchestrator_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let step_columns = list_table_columns(pool, "pipeline_run_steps").await?;
    if step_columns.is_empty() {
        return Ok(());
    }

    let additions = [
        (
            "step_type",
            "ALTER TABLE pipeline_run_steps ADD COLUMN step_type TEXT NOT NULL DEFAULT 'design'",
        ),
        (
            "depends_on_json",
            "ALTER TABLE pipeline_run_steps ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "review_policy_json",
            "ALTER TABLE pipeline_run_steps ADD COLUMN review_policy_json TEXT",
        ),
        (
            "retry_of_step_id",
            "ALTER TABLE pipeline_run_steps ADD COLUMN retry_of_step_id TEXT",
        ),
        (
            "run_version",
            "ALTER TABLE pipeline_run_steps ADD COLUMN run_version INTEGER NOT NULL DEFAULT 1",
        ),
    ];

    for (column, sql) in additions {
        if !step_columns.contains(column) {
            sqlx::query(sql).execute(pool).await?;
        }
    }

    let indexes = [
        "CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_run ON pipeline_run_steps(run_id, step_order)",
        "CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_status ON pipeline_run_steps(run_id, status)",
        "CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_type ON pipeline_run_steps(run_id, step_type)",
        "CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_retry_of ON pipeline_run_steps(run_id, retry_of_step_id)",
    ];

    for sql in indexes {
        sqlx::query(sql).execute(pool).await?;
    }

    Ok(())
}

/**
 * 列出数据库中所有表名
 */
async fn list_all_tables(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String,)>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|(name,)| name).collect())
}

async fn list_table_indexes(
    pool: &SqlitePool,
    table: &str,
) -> Result<HashSet<String>, sqlx::Error> {
    let rows = sqlx::query(&format!("PRAGMA index_list({})", table))
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect())
}

async fn has_single_column_conflict_target(
    pool: &SqlitePool,
    table: &str,
    column: &str,
) -> Result<bool, sqlx::Error> {
    let table_info = sqlx::query(&format!("PRAGMA table_info({})", table))
        .fetch_all(pool)
        .await?;
    let primary_key_columns = table_info
        .iter()
        .filter(|row| row.try_get::<i64, _>("pk").ok().unwrap_or_default() > 0)
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect::<Vec<_>>();
    if primary_key_columns.len() == 1 && primary_key_columns[0] == column {
        return Ok(true);
    }

    let indexes = sqlx::query(&format!("PRAGMA index_list({})", table))
        .fetch_all(pool)
        .await?;
    for row in indexes {
        if row.try_get::<i64, _>("unique").ok().unwrap_or_default() == 0 {
            continue;
        }

        let Some(index_name) = row.try_get::<String, _>("name").ok() else {
            continue;
        };
        let escaped_index_name = index_name.replace('\'', "''");
        let index_columns = sqlx::query(&format!("PRAGMA index_info('{escaped_index_name}')"))
            .fetch_all(pool)
            .await?
            .into_iter()
            .filter_map(|index_row| index_row.try_get::<String, _>("name").ok())
            .collect::<Vec<_>>();

        if index_columns.len() == 1 && index_columns[0] == column {
            return Ok(true);
        }
    }

    Ok(false)
}

async fn ensure_ai_usage_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut columns = list_table_columns(pool, "ai_usage_events").await?;
    if columns.is_empty() {
        return Ok(());
    }

    let additions = [
        (
            "api_key_fingerprint",
            "ALTER TABLE ai_usage_events ADD COLUMN api_key_fingerprint TEXT NOT NULL DEFAULT ''",
        ),
        (
            "resource_kind",
            "ALTER TABLE ai_usage_events ADD COLUMN resource_kind TEXT NOT NULL DEFAULT 'text'",
        ),
        (
            "output_items",
            "ALTER TABLE ai_usage_events ADD COLUMN output_items INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "request_fingerprint",
            "ALTER TABLE ai_usage_events ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''",
        ),
        (
            "attempt_group_key",
            "ALTER TABLE ai_usage_events ADD COLUMN attempt_group_key TEXT NOT NULL DEFAULT ''",
        ),
        (
            "attempt_index",
            "ALTER TABLE ai_usage_events ADD COLUMN attempt_index INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "is_redo",
            "ALTER TABLE ai_usage_events ADD COLUMN is_redo INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "trigger_source",
            "ALTER TABLE ai_usage_events ADD COLUMN trigger_source TEXT",
        ),
    ];

    for (column, sql) in additions {
        if !columns.contains(column) {
            sqlx::query(sql).execute(pool).await?;
            columns.insert(column.to_string());
        }
    }

    let indexes = [
        "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_key_created ON ai_usage_events(user_id, api_key_fingerprint, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_resource_created ON ai_usage_events(user_id, resource_kind, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_attempt_group ON ai_usage_events(user_id, attempt_group_key, created_at DESC)",
    ];

    for sql in indexes {
        sqlx::query(sql).execute(pool).await?;
    }

    Ok(())
}

async fn ensure_message_updated_at_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let columns = list_table_columns(pool, "messages").await?;
    if columns.is_empty() || columns.contains("updated_at") {
        return Ok(());
    }

    sqlx::query("ALTER TABLE messages ADD COLUMN updated_at TEXT")
        .execute(pool)
        .await?;

    sqlx::query(
        "UPDATE messages
         SET updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn repair_ai_usage_agent_foreign_key(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let rows = sqlx::query("PRAGMA foreign_key_list(ai_usage_events)")
        .fetch_all(pool)
        .await?;

    let needs_rebuild = rows.into_iter().any(|row| {
        row.try_get::<String, _>("from").ok().as_deref() == Some("agent_id")
            && row.try_get::<String, _>("table").ok().as_deref() == Some("agents_legacy")
    });

    if !needs_rebuild {
        return Ok(());
    }

    let mut conn = pool.acquire().await?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await?;

    let rebuild_result = async {
        sqlx::query("ALTER TABLE ai_usage_events RENAME TO ai_usage_events_legacy")
            .execute(&mut *conn)
            .await?;
        sqlx::query(
            "CREATE TABLE ai_usage_events (
                id                  TEXT PRIMARY KEY NOT NULL,
                user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
                conversation_id     TEXT REFERENCES conversations(id) ON DELETE SET NULL,
                agent_id            TEXT REFERENCES agents(id) ON DELETE SET NULL,
                endpoint_id         TEXT REFERENCES ai_endpoints(id) ON DELETE SET NULL,
                api_key_fingerprint TEXT NOT NULL DEFAULT '',
                provider            TEXT NOT NULL,
                model               TEXT,
                operation           TEXT NOT NULL CHECK (operation IN ('chat', 'stream', 'task', 'test')),
                status              TEXT NOT NULL CHECK (status IN ('success', 'failed')),
                resource_kind       TEXT NOT NULL DEFAULT 'text'
                                    CHECK (resource_kind IN ('text', 'image', 'video', 'audio', 'document', 'other')),
                output_items        INTEGER NOT NULL DEFAULT 0,
                latency_ms          INTEGER NOT NULL DEFAULT 0,
                prompt_tokens       INTEGER NOT NULL DEFAULT 0,
                completion_tokens   INTEGER NOT NULL DEFAULT 0,
                total_tokens        INTEGER NOT NULL DEFAULT 0,
                token_source        TEXT NOT NULL DEFAULT 'unavailable'
                                    CHECK (token_source IN ('actual', 'estimated', 'unavailable')),
                input_chars         INTEGER NOT NULL DEFAULT 0,
                output_chars        INTEGER NOT NULL DEFAULT 0,
                request_fingerprint TEXT NOT NULL DEFAULT '',
                attempt_group_key   TEXT NOT NULL DEFAULT '',
                attempt_index       INTEGER NOT NULL DEFAULT 1,
                is_redo             INTEGER NOT NULL DEFAULT 0,
                trigger_source      TEXT,
                error_message       TEXT,
                created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "INSERT INTO ai_usage_events (
                id, user_id, project_id, conversation_id, agent_id, endpoint_id,
                api_key_fingerprint, provider, model, operation, status, resource_kind,
                output_items, latency_ms, prompt_tokens, completion_tokens, total_tokens,
                token_source, input_chars, output_chars, request_fingerprint,
                attempt_group_key, attempt_index, is_redo, trigger_source, error_message, created_at
            )
            SELECT
                id, user_id, project_id, conversation_id, agent_id, endpoint_id,
                api_key_fingerprint, provider, model, operation, status, resource_kind,
                output_items, latency_ms, prompt_tokens, completion_tokens, total_tokens,
                token_source, input_chars, output_chars, request_fingerprint,
                attempt_group_key, attempt_index, is_redo, trigger_source, error_message, created_at
            FROM ai_usage_events_legacy",
        )
        .execute(&mut *conn)
        .await?;
        sqlx::query("DROP TABLE ai_usage_events_legacy")
            .execute(&mut *conn)
            .await?;

        let indexes = [
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON ai_usage_events(user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_project_created ON ai_usage_events(user_id, project_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_conv_created ON ai_usage_events(user_id, conversation_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_agent_created ON ai_usage_events(user_id, agent_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_ep_created ON ai_usage_events(user_id, endpoint_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_key_created ON ai_usage_events(user_id, api_key_fingerprint, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_resource_created ON ai_usage_events(user_id, resource_kind, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_model_created ON ai_usage_events(user_id, model, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_status_created ON ai_usage_events(user_id, status, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_ai_usage_user_attempt_group ON ai_usage_events(user_id, attempt_group_key, created_at DESC)",
        ];

        for sql in indexes {
            sqlx::query(sql).execute(&mut *conn).await?;
        }

        Ok::<(), sqlx::Error>(())
    }
    .await;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await?;
    rebuild_result
}

pub async fn ensure_default_agents_for_user(
    pool: &SqlitePool,
    user_id: &str,
) -> Result<u64, sqlx::Error> {
    let mut inserted = 0_u64;

    for seed in DEFAULT_AGENT_SEEDS {
        inserted += sqlx::query(
            "INSERT OR IGNORE INTO agents (
                 id, user_id, name, role, description, system_prompt, endpoint_id, model,
                 temperature, max_tokens, badge, is_active
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(user_id)
        .bind(seed.name)
        .bind(seed.role)
        .bind(seed.description)
        .bind(seed.system_prompt)
        .bind(seed.temperature)
        .bind(seed.max_tokens)
        .bind(seed.badge)
        .execute(pool)
        .await?
        .rows_affected();
    }

    Ok(inserted)
}

pub async fn ensure_project_agent_assignments_for_project(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
) -> Result<u64, sqlx::Error> {
    let existing_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)
         FROM project_agent_assignments
         WHERE user_id = ? AND project_id = ? AND is_active = 1",
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_one(pool)
    .await?;

    if existing_count > 0 {
        return Ok(0);
    }

    let agents = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, name, role
         FROM agents
         WHERE user_id = ? AND is_active = 1
         ORDER BY created_at ASC, name ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut inserted = 0_u64;
    for (agent_id, name, role) in agents {
        let responsibility_kind = infer_responsibility_kind(&name, &role);
        inserted += sqlx::query(
            "INSERT OR IGNORE INTO project_agent_assignments (
                 id, user_id, project_id, agent_id, responsibility_kind, responsibility_label,
                 assignment_source, is_active
             ) VALUES (?, ?, ?, ?, ?, ?, 'seed', 1)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(user_id)
        .bind(project_id)
        .bind(&agent_id)
        .bind(responsibility_kind)
        .bind(default_responsibility_label(responsibility_kind, &role))
        .execute(pool)
        .await?
        .rows_affected();
    }

    Ok(inserted)
}

async fn ensure_default_agents_for_existing_users(
    pool: &SqlitePool,
) -> Result<SeedBackfillSummary, sqlx::Error> {
    let users = sqlx::query_scalar::<_, String>("SELECT id FROM users")
        .fetch_all(pool)
        .await?;

    let mut summary = SeedBackfillSummary {
        scanned: users.len(),
        inserted: 0,
    };

    for user_id in users {
        summary.inserted += ensure_default_agents_for_user(pool, &user_id).await?;
    }

    Ok(summary)
}

async fn ensure_project_agent_assignments_for_existing_projects(
    pool: &SqlitePool,
) -> Result<SeedBackfillSummary, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT id, user_id
         FROM projects",
    )
    .fetch_all(pool)
    .await?;

    let mut summary = SeedBackfillSummary {
        scanned: rows.len(),
        inserted: 0,
    };

    for (project_id, user_id) in rows {
        summary.inserted +=
            ensure_project_agent_assignments_for_project(pool, &user_id, &project_id).await?;
    }

    Ok(summary)
}

async fn ensure_agents_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let columns = list_table_columns(pool, "agents").await?;
    if columns.is_empty() {
        return Ok(());
    }

    if !columns.contains("user_id") {
        migrate_agents_to_user_scope(pool).await?;
    }

    let indexes = [
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_name ON agents(user_id, name)",
        "CREATE INDEX IF NOT EXISTS idx_agents_user_active_name ON agents(user_id, is_active, name)",
        "CREATE INDEX IF NOT EXISTS idx_agents_user_endpoint ON agents(user_id, endpoint_id)",
    ];

    for sql in indexes {
        sqlx::query(sql).execute(pool).await?;
    }

    Ok(())
}

async fn ensure_project_agent_assignments_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut columns = list_table_columns(pool, "project_agent_assignments").await?;
    if columns.is_empty() {
        return Ok(());
    }

    if !columns.contains("updated_at") {
        sqlx::query("ALTER TABLE project_agent_assignments ADD COLUMN updated_at TEXT")
            .execute(pool)
            .await?;
        sqlx::query(
            "UPDATE project_agent_assignments
             SET updated_at = COALESCE(
                 NULLIF(created_at, ''),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
             )
             WHERE updated_at IS NULL OR updated_at = ''",
        )
        .execute(pool)
        .await?;
        columns.insert("updated_at".to_string());
    }

    let indexes = [
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_assignment_unique ON project_agent_assignments(project_id, agent_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_agent_assignment_project ON project_agent_assignments(user_id, project_id, is_active, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_project_agent_assignment_agent ON project_agent_assignments(user_id, agent_id, is_active)",
    ];

    for sql in indexes {
        sqlx::query(sql).execute(pool).await?;
    }

    Ok(())
}

async fn repair_project_agent_assignment_agent_foreign_key(
    pool: &SqlitePool,
) -> Result<(), sqlx::Error> {
    let columns = list_table_columns(pool, "project_agent_assignments").await?;
    if columns.is_empty() {
        return Ok(());
    }

    let foreign_keys = sqlx::query("PRAGMA foreign_key_list(project_agent_assignments)")
        .fetch_all(pool)
        .await?;
    let agent_fk_target = foreign_keys.into_iter().find_map(|row| {
        if row.try_get::<String, _>("from").ok().as_deref() == Some("agent_id") {
            row.try_get::<String, _>("table").ok()
        } else {
            None
        }
    });

    if agent_fk_target.as_deref() == Some("agents") {
        return Ok(());
    }

    let mut conn = pool.acquire().await?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await?;

    let repair_result = async {
        sqlx::query("ALTER TABLE project_agent_assignments RENAME TO project_agent_assignments_legacy")
            .execute(&mut *conn)
            .await?;
        sqlx::query(
            "CREATE TABLE project_agent_assignments (
                id                   TEXT PRIMARY KEY NOT NULL,
                user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                agent_id             TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                responsibility_kind  TEXT NOT NULL DEFAULT 'custom'
                                     CHECK (responsibility_kind IN ('design', 'review', 'editor', 'manager', 'custom')),
                responsibility_label TEXT NOT NULL DEFAULT '',
                assignment_source    TEXT NOT NULL DEFAULT 'existing'
                                     CHECK (assignment_source IN ('seed', 'existing', 'created')),
                is_active            INTEGER NOT NULL DEFAULT 1,
                created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&mut *conn)
        .await?;

        sqlx::query(
            "INSERT INTO project_agent_assignments (
                 id, user_id, project_id, agent_id, responsibility_kind, responsibility_label,
                 assignment_source, is_active, created_at, updated_at
             )
             SELECT
                 id,
                 user_id,
                 project_id,
                 agent_id,
                 responsibility_kind,
                 responsibility_label,
                 assignment_source,
                 is_active,
                 COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                 COALESCE(updated_at, created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
             FROM project_agent_assignments_legacy",
        )
        .execute(&mut *conn)
        .await?;

        sqlx::query("DROP TABLE project_agent_assignments_legacy")
            .execute(&mut *conn)
            .await?;

        Ok::<(), sqlx::Error>(())
    }
    .await;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await?;

    repair_result
}

fn infer_responsibility_kind(name: &str, role: &str) -> &'static str {
    let lowered = format!("{} {}", name, role).to_ascii_lowercase();
    if lowered.contains("审核")
        || lowered.contains("review")
        || lowered.contains("风控")
        || lowered.contains("合规")
    {
        "review"
    } else if lowered.contains("主编")
        || lowered.contains("编辑")
        || lowered.contains("大纲")
        || lowered.contains("writer")
        || lowered.contains("editor")
    {
        "editor"
    } else if lowered.contains("管理")
        || lowered.contains("经理")
        || lowered.contains("统筹")
        || lowered.contains("manager")
        || lowered.contains("pm")
    {
        "manager"
    } else if lowered.contains("设计")
        || lowered.contains("视觉")
        || lowered.contains("分镜")
        || lowered.contains("人物")
        || lowered.contains("render")
        || lowered.contains("design")
    {
        "design"
    } else {
        "custom"
    }
}

fn default_responsibility_label(kind: &str, fallback_role: &str) -> String {
    match kind {
        "design" => "设计".to_string(),
        "review" => "审核".to_string(),
        "editor" => "主编".to_string(),
        "manager" => "管理".to_string(),
        _ => fallback_role.trim().to_string(),
    }
}

#[derive(Debug, Clone, FromRow)]
struct LegacyAgentRow {
    id: String,
    name: String,
    role: String,
    description: String,
    system_prompt: String,
    endpoint_id: Option<String>,
    model: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<i64>,
    badge: String,
    is_active: bool,
    created_at: String,
}

async fn migrate_agents_to_user_scope(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    let legacy_agents = sqlx::query_as::<_, LegacyAgentRow>(
        "SELECT id, name, role, description, system_prompt, endpoint_id, model, temperature,
                max_tokens, badge, is_active, created_at
         FROM agents",
    )
    .fetch_all(&mut *conn)
    .await?;
    let users = sqlx::query_scalar::<_, String>("SELECT id FROM users")
        .fetch_all(&mut *conn)
        .await?;
    let all_users: BTreeSet<String> = users.iter().cloned().collect();

    let endpoint_rows = sqlx::query("SELECT id, user_id FROM ai_endpoints")
        .fetch_all(&mut *conn)
        .await?;
    let endpoint_owners = endpoint_rows
        .into_iter()
        .filter_map(|row| {
            Some((
                row.try_get::<String, _>("id").ok()?,
                row.try_get::<String, _>("user_id").ok()?,
            ))
        })
        .collect::<HashMap<_, _>>();

    let message_rows = sqlx::query(
        "SELECT DISTINCT m.agent_id AS agent_id, c.user_id AS user_id
         FROM messages m
         INNER JOIN conversations c ON c.id = m.conversation_id
         WHERE m.agent_id IS NOT NULL",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut message_users: HashMap<String, BTreeSet<String>> = HashMap::new();
    for row in message_rows {
        if let (Ok(agent_id), Ok(user_id)) = (
            row.try_get::<String, _>("agent_id"),
            row.try_get::<String, _>("user_id"),
        ) {
            message_users.entry(agent_id).or_default().insert(user_id);
        }
    }

    let usage_rows = sqlx::query(
        "SELECT DISTINCT agent_id, user_id
         FROM ai_usage_events
         WHERE agent_id IS NOT NULL",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut usage_users: HashMap<String, BTreeSet<String>> = HashMap::new();
    for row in usage_rows {
        if let (Ok(agent_id), Ok(user_id)) = (
            row.try_get::<String, _>("agent_id"),
            row.try_get::<String, _>("user_id"),
        ) {
            usage_users.entry(agent_id).or_default().insert(user_id);
        }
    }

    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await?;

    let migration_result = async {
        sqlx::query("ALTER TABLE agents RENAME TO agents_legacy")
            .execute(&mut *conn)
            .await?;
        sqlx::query(
            "CREATE TABLE agents (
                id            TEXT PRIMARY KEY NOT NULL,
                user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name          TEXT NOT NULL,
                role          TEXT NOT NULL,
                description   TEXT DEFAULT '',
                system_prompt TEXT NOT NULL,
                endpoint_id   TEXT REFERENCES ai_endpoints(id) ON DELETE SET NULL,
                model         TEXT,
                temperature   REAL DEFAULT 0.7,
                max_tokens    INTEGER DEFAULT 4096,
                badge         TEXT DEFAULT '',
                is_active     INTEGER NOT NULL DEFAULT 1,
                created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&mut *conn)
        .await?;

        let mut agent_id_map: HashMap<(String, String), String> = HashMap::new();

        for agent in &legacy_agents {
            let assigned_users = resolve_legacy_agent_users(
                agent,
                &all_users,
                &endpoint_owners,
                &message_users,
                &usage_users,
            );

            for user_id in assigned_users {
                let new_id = Uuid::new_v4().to_string();
                let next_endpoint_id = agent
                    .endpoint_id
                    .as_deref()
                    .filter(|endpoint_id| endpoint_owners.get(*endpoint_id) == Some(&user_id))
                    .map(str::to_string);
                sqlx::query(
                    "INSERT INTO agents (
                         id, user_id, name, role, description, system_prompt, endpoint_id, model,
                         temperature, max_tokens, badge, is_active, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&new_id)
                .bind(&user_id)
                .bind(&agent.name)
                .bind(&agent.role)
                .bind(&agent.description)
                .bind(&agent.system_prompt)
                .bind(next_endpoint_id.as_deref())
                .bind(agent.model.as_deref())
                .bind(agent.temperature.unwrap_or(0.7))
                .bind(agent.max_tokens.unwrap_or(4096))
                .bind(&agent.badge)
                .bind(agent.is_active)
                .bind(&agent.created_at)
                .execute(&mut *conn)
                .await?;

                agent_id_map.insert((agent.id.clone(), user_id), new_id);
            }
        }

        for ((old_agent_id, user_id), new_agent_id) in agent_id_map {
            sqlx::query(
                "UPDATE messages
                 SET agent_id = ?
                 WHERE agent_id = ?
                   AND conversation_id IN (
                       SELECT id FROM conversations WHERE user_id = ?
                   )",
            )
            .bind(&new_agent_id)
            .bind(&old_agent_id)
            .bind(&user_id)
            .execute(&mut *conn)
            .await?;

            sqlx::query(
                "UPDATE ai_usage_events
                 SET agent_id = ?
                 WHERE agent_id = ? AND user_id = ?",
            )
            .bind(&new_agent_id)
            .bind(&old_agent_id)
            .bind(&user_id)
            .execute(&mut *conn)
            .await?;

            sqlx::query(
                "UPDATE project_agent_assignments
                 SET agent_id = ?
                 WHERE agent_id = ? AND user_id = ?",
            )
            .bind(&new_agent_id)
            .bind(&old_agent_id)
            .bind(&user_id)
            .execute(&mut *conn)
            .await?;
        }

        sqlx::query("DROP TABLE agents_legacy")
            .execute(&mut *conn)
            .await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await?;
    migration_result
}

fn resolve_legacy_agent_users(
    agent: &LegacyAgentRow,
    all_users: &BTreeSet<String>,
    endpoint_owners: &HashMap<String, String>,
    message_users: &HashMap<String, BTreeSet<String>>,
    usage_users: &HashMap<String, BTreeSet<String>>,
) -> BTreeSet<String> {
    let mut owners = BTreeSet::new();

    if let Some(endpoint_id) = agent.endpoint_id.as_deref() {
        if let Some(user_id) = endpoint_owners.get(endpoint_id) {
            owners.insert(user_id.clone());
        }
    }

    if let Some(users) = message_users.get(&agent.id) {
        owners.extend(users.iter().cloned());
    }

    if let Some(users) = usage_users.get(&agent.id) {
        owners.extend(users.iter().cloned());
    }

    let is_default_agent = DEFAULT_AGENT_SEEDS
        .iter()
        .any(|seed| seed.legacy_id == agent.id || seed.name == agent.name);

    if is_default_agent {
        owners.extend(all_users.iter().cloned());
    }

    if owners.is_empty() {
        if all_users.len() == 1 {
            owners.extend(all_users.iter().cloned());
        } else if !all_users.is_empty() {
            tracing::warn!(
                "Ambiguous legacy agent '{}' detected during migration; cloning to all users",
                agent.name
            );
            owners.extend(all_users.iter().cloned());
        }
    }

    owners
}

async fn list_table_columns(
    pool: &SqlitePool,
    table: &str,
) -> Result<HashSet<String>, sqlx::Error> {
    let rows = sqlx::query(&format!("PRAGMA table_info({})", table))
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect())
}

async fn ensure_table_updated_at_column(
    pool: &SqlitePool,
    table: &str,
    fallback_columns: &[&str],
) -> Result<(), sqlx::Error> {
    let columns = list_table_columns(pool, table).await?;
    if columns.is_empty() || columns.contains("updated_at") {
        return Ok(());
    }

    sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN updated_at TEXT"))
        .execute(pool)
        .await?;

    let mut expressions = vec!["NULLIF(updated_at, '')".to_string()];
    expressions.extend(
        fallback_columns
            .iter()
            .filter(|column| columns.contains(**column))
            .map(|column| format!("NULLIF({column}, '')")),
    );
    expressions.push("strftime('%Y-%m-%dT%H:%M:%SZ', 'now')".to_string());

    let update_sql = format!(
        "UPDATE {table}
         SET updated_at = COALESCE(
             {}
         )
         WHERE updated_at IS NULL OR updated_at = ''",
        expressions.join(",\n             ")
    );
    sqlx::query(&update_sql).execute(pool).await?;

    Ok(())
}

async fn backfill_generic_updated_at_columns(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    for (table, fallback_columns) in [
        ("users", &["created_at"][..]),
        ("projects", &["created_at"]),
        ("conversations", &["created_at"]),
        ("assets", &["created_at"]),
        ("scripts", &["created_at"]),
        ("storyboards", &["created_at"]),
        ("storyboard_lines", &["created_at"]),
        ("ai_endpoints", &["created_at"]),
        ("notification_channels", &["created_at"]),
        ("runtime_heartbeats", &["last_seen_at"]),
        ("project_agent_assignments", &["created_at"]),
        (
            "pipeline_runs",
            &["finished_at", "started_at", "created_at"],
        ),
        (
            "pipeline_run_steps",
            &["completed_at", "started_at", "last_error_at", "created_at"],
        ),
        (
            "assistant_action_audits",
            &["executed_at", "confirmed_at", "created_at"],
        ),
        ("user_ai_policies", &["expires_at", "created_at"]),
        ("pipeline_step_outputs", &["created_at"]),
        ("pipeline_prompt_optimizations", &["created_at"]),
    ] {
        ensure_table_updated_at_column(pool, table, fallback_columns).await?;
    }

    Ok(())
}

async fn build_schema_backfill_report(
    pool: &SqlitePool,
    applied_migrations: Vec<String>,
    default_agent_seed: SeedBackfillSummary,
    project_assignment_seed: SeedBackfillSummary,
) -> Result<SchemaBackfillReport, sqlx::Error> {
    Ok(SchemaBackfillReport {
        applied_migrations,
        default_agent_seed,
        project_assignment_seed,
        retained_runtime_backfills: retained_runtime_backfills(),
        pending_compatibility_issues: collect_pending_schema_compatibility_issues(pool).await?,
    })
}

fn retained_runtime_backfills() -> Vec<&'static str> {
    vec![
        "ensure_pipeline_runs_schema",
        "ensure_pipeline_orchestrator_schema",
        "ensure_ai_usage_schema",
        "ensure_message_updated_at_schema",
        "ensure_agents_schema",
        "ensure_project_agent_assignments_schema",
    ]
}

async fn collect_pending_schema_compatibility_issues(
    pool: &SqlitePool,
) -> Result<Vec<String>, sqlx::Error> {
    let tables: HashSet<String> = list_all_tables(pool).await?.into_iter().collect();
    let mut issues = Vec::new();

    if tables.contains("messages") {
        let columns = list_table_columns(pool, "messages").await?;
        if !columns.contains("updated_at") {
            issues.push("messages.updated_at 缺失".to_string());
        }
    }

    if tables.contains("ai_usage_events") {
        let columns = list_table_columns(pool, "ai_usage_events").await?;
        for column in [
            "api_key_fingerprint",
            "resource_kind",
            "output_items",
            "request_fingerprint",
            "attempt_group_key",
            "attempt_index",
            "is_redo",
            "trigger_source",
        ] {
            if !columns.contains(column) {
                issues.push(format!("ai_usage_events.{} 缺失", column));
            }
        }

        let foreign_keys = sqlx::query("PRAGMA foreign_key_list(ai_usage_events)")
            .fetch_all(pool)
            .await?;
        if foreign_keys.into_iter().any(|row| {
            row.try_get::<String, _>("from").ok().as_deref() == Some("agent_id")
                && row.try_get::<String, _>("table").ok().as_deref() == Some("agents_legacy")
        }) {
            issues.push("ai_usage_events.agent_id 仍指向 agents_legacy".to_string());
        }
    }

    if tables.contains("agents") {
        let columns = list_table_columns(pool, "agents").await?;
        if !columns.contains("user_id") {
            issues.push("agents.user_id 缺失".to_string());
        }
    }

    for table in [
        "users",
        "projects",
        "conversations",
        "assets",
        "scripts",
        "storyboards",
        "storyboard_lines",
        "ai_endpoints",
        "notification_channels",
        "runtime_heartbeats",
        "project_agent_assignments",
        "pipeline_runs",
        "pipeline_run_steps",
        "assistant_action_audits",
        "user_ai_policies",
        "pipeline_step_outputs",
        "pipeline_prompt_optimizations",
    ] {
        if tables.contains(table) {
            let columns = list_table_columns(pool, table).await?;
            if !columns.contains("updated_at") {
                issues.push(format!("{table}.updated_at 缺失"));
            }
        }
    }

    if tables.contains("notification_events") {
        let columns = list_table_columns(pool, "notification_events").await?;
        if !columns.contains("updated_at") {
            issues.push("notification_events.updated_at 缺失".to_string());
        }
        let indexes = list_table_indexes(pool, "notification_events").await?;
        if !indexes.contains("idx_notification_events_dedupe") {
            issues.push("notification_events dedupe 索引缺失".to_string());
        }
    }

    if tables.contains("runtime_heartbeats") {
        if !has_single_column_conflict_target(pool, "runtime_heartbeats", "component_key").await? {
            issues.push("runtime_heartbeats component_key 唯一索引缺失".to_string());
        }
    }

    if tables.contains("project_agent_assignments") {
        let columns = list_table_columns(pool, "project_agent_assignments").await?;
        if !columns.contains("user_id") {
            issues.push("project_agent_assignments.user_id 缺失".to_string());
        }

        let foreign_keys = sqlx::query("PRAGMA foreign_key_list(project_agent_assignments)")
            .fetch_all(pool)
            .await?;
        if foreign_keys.into_iter().any(|row| {
            row.try_get::<String, _>("from").ok().as_deref() == Some("agent_id")
                && row.try_get::<String, _>("table").ok().as_deref() != Some("agents")
        }) {
            issues.push("project_agent_assignments.agent_id 外键未指向 agents".to_string());
        }
    }

    if tables.contains("scripts") {
        if !has_single_column_conflict_target(pool, "scripts", "project_id").await? {
            issues.push("scripts.project_id 唯一索引缺失".to_string());
        }
    }

    if tables.contains("storyboards") {
        if !has_single_column_conflict_target(pool, "storyboards", "project_id").await? {
            issues.push("storyboards.project_id 唯一索引缺失".to_string());
        }
    }

    if !tables.contains("ai_tasks") {
        issues.push("ai_tasks 表缺失".to_string());
    }

    Ok(issues)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn create_test_pool(prefix: &str) -> (SqlitePool, std::path::PathBuf) {
        let db_path = std::env::temp_dir().join(format!("{}-{}.sqlite", prefix, Uuid::new_v4()));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));

        let options = SqliteConnectOptions::from_str(&database_url)
            .expect("invalid sqlite url for test")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("failed to connect test sqlite");

        (pool, db_path)
    }

    async fn cleanup_test_pool(pool: SqlitePool, db_path: std::path::PathBuf) {
        pool.close().await;
        std::fs::remove_file(&db_path).ok();
    }

    #[tokio::test]
    async fn schema_migrations_are_recorded_once() {
        let (pool, db_path) = create_test_pool("woohoo-schema-migrations").await;

        run_schema_migrations(&pool)
            .await
            .expect("failed to run schema migrations");
        run_schema_migrations(&pool)
            .await
            .expect("failed to rerun schema migrations");

        let versions = sqlx::query_scalar::<_, String>(
            "SELECT version FROM schema_migrations ORDER BY version ASC",
        )
        .fetch_all(&pool)
        .await
        .expect("failed to query schema migrations");

        assert_eq!(
            versions,
            vec![
                "001_init".to_string(),
                "002_pipeline_runs".to_string(),
                "003_pipeline_orchestrator_m1".to_string(),
                "004_pipeline_prompt_optimizations".to_string(),
                "005_pipeline_schema_backfills".to_string(),
                "006_legacy_schema_backfills".to_string(),
                "007_runtime_compat_backfills_v2".to_string(),
                "008_ai_tasks_persistence".to_string(),
                "009_ops_schema_conflict_backfills".to_string(),
                "010_agent_scope_backfills".to_string(),
                "011_updated_at_column_backfills".to_string(),
            ]
        );

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn runtime_compat_backfill_upgrades_legacy_message_and_ai_usage_tables() {
        let (pool, db_path) = create_test_pool("woohoo-runtime-compat").await;

        sqlx::query(
            "CREATE TABLE schema_migrations (
                version    TEXT PRIMARY KEY NOT NULL,
                kind       TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create schema_migrations");

        for version in [
            "001_init",
            "002_pipeline_runs",
            "003_pipeline_orchestrator_m1",
            "004_pipeline_prompt_optimizations",
            "008_ai_tasks_persistence",
            "005_pipeline_schema_backfills",
            "006_legacy_schema_backfills",
        ] {
            record_schema_migration(&pool, version, "test")
                .await
                .expect("failed to seed schema migration");
        }

        sqlx::query(
            "CREATE TABLE messages (
                id              TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                role            TEXT NOT NULL,
                content         TEXT NOT NULL,
                msg_type        TEXT NOT NULL DEFAULT 'text',
                agent_id        TEXT,
                model_used      TEXT,
                token_usage     TEXT,
                meta            TEXT,
                created_at      TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create legacy messages");

        sqlx::query(
            "INSERT INTO messages (
                id, conversation_id, role, content, msg_type, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("msg-1")
        .bind("conv-1")
        .bind("assistant")
        .bind("partial content")
        .bind("text")
        .bind("2026-04-12T16:25:28Z")
        .execute(&pool)
        .await
        .expect("failed to seed legacy message");

        sqlx::query(
            "CREATE TABLE ai_usage_events (
                id                  TEXT PRIMARY KEY NOT NULL,
                user_id             TEXT NOT NULL,
                project_id          TEXT,
                conversation_id     TEXT,
                agent_id            TEXT,
                endpoint_id         TEXT,
                api_key_fingerprint TEXT NOT NULL DEFAULT '',
                provider            TEXT NOT NULL,
                model               TEXT,
                operation           TEXT NOT NULL,
                status              TEXT NOT NULL,
                resource_kind       TEXT NOT NULL DEFAULT 'text',
                output_items        INTEGER NOT NULL DEFAULT 0,
                latency_ms          INTEGER NOT NULL DEFAULT 0,
                prompt_tokens       INTEGER NOT NULL DEFAULT 0,
                completion_tokens   INTEGER NOT NULL DEFAULT 0,
                total_tokens        INTEGER NOT NULL DEFAULT 0,
                token_source        TEXT NOT NULL DEFAULT 'unavailable',
                input_chars         INTEGER NOT NULL DEFAULT 0,
                output_chars        INTEGER NOT NULL DEFAULT 0,
                request_fingerprint TEXT NOT NULL DEFAULT '',
                attempt_group_key   TEXT NOT NULL DEFAULT '',
                attempt_index       INTEGER NOT NULL DEFAULT 1,
                is_redo             INTEGER NOT NULL DEFAULT 0,
                error_message       TEXT,
                created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create legacy ai_usage_events");

        run_schema_migrations(&pool)
            .await
            .expect("failed to run runtime compat migration");

        let message_columns = list_table_columns(&pool, "messages")
            .await
            .expect("failed to list message columns");
        assert!(message_columns.contains("updated_at"));

        let updated_at =
            sqlx::query_scalar::<_, String>("SELECT updated_at FROM messages WHERE id = 'msg-1'")
                .fetch_one(&pool)
                .await
                .expect("failed to fetch backfilled updated_at");
        assert_eq!(updated_at, "2026-04-12T16:25:28Z");

        let ai_usage_columns = list_table_columns(&pool, "ai_usage_events")
            .await
            .expect("failed to list ai_usage_events columns");
        assert!(ai_usage_columns.contains("trigger_source"));
        assert!(
            has_schema_migration(&pool, "007_runtime_compat_backfills_v2")
                .await
                .expect("failed to query 007 migration")
        );

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn ai_tasks_sql_migration_creates_table_for_legacy_databases() {
        let (pool, db_path) = create_test_pool("woohoo-ai-tasks-migration").await;

        sqlx::query(
            "CREATE TABLE schema_migrations (
                version    TEXT PRIMARY KEY NOT NULL,
                kind       TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create schema_migrations");

        for version in [
            "001_init",
            "002_pipeline_runs",
            "003_pipeline_orchestrator_m1",
            "004_pipeline_prompt_optimizations",
            "005_pipeline_schema_backfills",
            "006_legacy_schema_backfills",
            "007_runtime_compat_backfills_v2",
        ] {
            record_schema_migration(&pool, version, "test")
                .await
                .expect("failed to seed schema migration");
        }

        run_schema_migrations(&pool)
            .await
            .expect("failed to apply ai_tasks sql migration");

        let tables: HashSet<String> = list_all_tables(&pool)
            .await
            .expect("failed to list tables")
            .into_iter()
            .collect();
        assert!(tables.contains("ai_tasks"));
        assert!(has_schema_migration(&pool, "008_ai_tasks_persistence")
            .await
            .expect("failed to query 008 migration"));

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn ops_schema_backfill_repairs_legacy_conflict_targets() {
        let (pool, db_path) = create_test_pool("woohoo-ops-schema-backfill").await;

        sqlx::query(
            "CREATE TABLE schema_migrations (
                version    TEXT PRIMARY KEY NOT NULL,
                kind       TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create schema_migrations");

        for version in [
            "001_init",
            "002_pipeline_runs",
            "003_pipeline_orchestrator_m1",
            "004_pipeline_prompt_optimizations",
            "005_pipeline_schema_backfills",
            "006_legacy_schema_backfills",
            "007_runtime_compat_backfills_v2",
            "008_ai_tasks_persistence",
        ] {
            record_schema_migration(&pool, version, "test")
                .await
                .expect("failed to seed schema migration");
        }

        sqlx::query(
            "CREATE TABLE notification_events (
                id          TEXT PRIMARY KEY NOT NULL,
                user_id     TEXT,
                event_type  TEXT NOT NULL,
                status      TEXT NOT NULL,
                dedupe_key  TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL,
                sent_at     TEXT
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create legacy notification_events");
        for event_id in ["evt-1", "evt-2"] {
            sqlx::query(
                "INSERT INTO notification_events (
                    id, user_id, event_type, status, dedupe_key, created_at, sent_at
                ) VALUES (?, 'user-1', 'finding', 'queued', 'dedupe-1', '2026-04-13T00:00:00Z', NULL)",
            )
            .bind(event_id)
            .execute(&pool)
            .await
            .expect("failed to seed legacy notification_events");
        }

        sqlx::query(
            "CREATE TABLE runtime_heartbeats (
                component_key  TEXT NOT NULL,
                component_type TEXT NOT NULL,
                status         TEXT NOT NULL,
                last_seen_at   TEXT NOT NULL,
                updated_at     TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create legacy runtime_heartbeats");
        for updated_at in ["2026-04-13T00:00:00Z", "2026-04-13T00:05:00Z"] {
            sqlx::query(
                "INSERT INTO runtime_heartbeats (
                    component_key, component_type, status, last_seen_at, updated_at
                ) VALUES ('ops-monitor', 'ops', 'healthy', ?, ?)",
            )
            .bind(updated_at)
            .bind(updated_at)
            .execute(&pool)
            .await
            .expect("failed to seed legacy runtime_heartbeats");
        }

        sqlx::query(
            "CREATE TABLE scripts (
                id         TEXT PRIMARY KEY NOT NULL,
                project_id TEXT NOT NULL,
                title      TEXT NOT NULL,
                content    TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create legacy scripts");
        for script_id in ["script-1", "script-2"] {
            sqlx::query(
                "INSERT INTO scripts (
                    id, project_id, title, content, created_at, updated_at
                ) VALUES (?, 'project-1', 'Title', '', '2026-04-13T00:00:00Z', '2026-04-13T00:00:00Z')",
            )
            .bind(script_id)
            .execute(&pool)
            .await
            .expect("failed to seed legacy scripts");
        }

        sqlx::query(
            "CREATE TABLE storyboards (
                id         TEXT PRIMARY KEY NOT NULL,
                project_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create legacy storyboards");
        for storyboard_id in ["sb-1", "sb-2"] {
            sqlx::query(
                "INSERT INTO storyboards (
                    id, project_id, created_at, updated_at
                ) VALUES (?, 'project-1', '2026-04-13T00:00:00Z', '2026-04-13T00:00:00Z')",
            )
            .bind(storyboard_id)
            .execute(&pool)
            .await
            .expect("failed to seed legacy storyboards");
        }

        run_schema_migrations(&pool)
            .await
            .expect("failed to apply ops schema backfill migration");

        let notification_columns = list_table_columns(&pool, "notification_events")
            .await
            .expect("failed to inspect notification_events");
        assert!(notification_columns.contains("updated_at"));
        let notification_indexes = list_table_indexes(&pool, "notification_events")
            .await
            .expect("failed to inspect notification_events indexes");
        assert!(notification_indexes.contains("idx_notification_events_dedupe"));

        let notification_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM notification_events WHERE dedupe_key = 'dedupe-1'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to count notification_events");
        assert_eq!(notification_count, 1);

        let runtime_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM runtime_heartbeats WHERE component_key = 'ops-monitor'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to count runtime_heartbeats");
        assert_eq!(runtime_count, 1);
        assert!(
            has_single_column_conflict_target(&pool, "runtime_heartbeats", "component_key")
                .await
                .expect("failed to inspect runtime_heartbeats conflict target")
        );

        let script_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM scripts WHERE project_id = 'project-1'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to count scripts");
        assert_eq!(script_count, 1);
        assert!(
            has_single_column_conflict_target(&pool, "scripts", "project_id")
                .await
                .expect("failed to inspect scripts conflict target")
        );

        let storyboard_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM storyboards WHERE project_id = 'project-1'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to count storyboards");
        assert_eq!(storyboard_count, 1);
        assert!(
            has_single_column_conflict_target(&pool, "storyboards", "project_id")
                .await
                .expect("failed to inspect storyboards conflict target")
        );

        assert!(
            has_schema_migration(&pool, "009_ops_schema_conflict_backfills")
                .await
                .expect("failed to query 009 migration")
        );

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn agent_scope_backfill_migrates_legacy_agents_and_repairs_project_assignments() {
        let (pool, db_path) = create_test_pool("woohoo-agent-scope-backfill").await;

        sqlx::query(
            "CREATE TABLE schema_migrations (
                version    TEXT PRIMARY KEY NOT NULL,
                kind       TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create schema_migrations");

        for version in [
            "001_init",
            "002_pipeline_runs",
            "003_pipeline_orchestrator_m1",
            "004_pipeline_prompt_optimizations",
            "005_pipeline_schema_backfills",
            "006_legacy_schema_backfills",
            "007_runtime_compat_backfills_v2",
            "008_ai_tasks_persistence",
            "009_ops_schema_conflict_backfills",
        ] {
            record_schema_migration(&pool, version, "test")
                .await
                .expect("failed to seed schema migration");
        }

        for table_sql in [
            "CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)",
            "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL)",
            "CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL)",
            "CREATE TABLE ai_endpoints (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL)",
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                msg_type TEXT NOT NULL DEFAULT 'text',
                agent_id TEXT,
                model_used TEXT,
                token_usage TEXT,
                meta TEXT,
                created_at TEXT NOT NULL
            )",
            "CREATE TABLE ai_usage_events (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                project_id TEXT,
                conversation_id TEXT,
                agent_id TEXT,
                endpoint_id TEXT,
                provider TEXT NOT NULL,
                model TEXT,
                operation TEXT NOT NULL,
                status TEXT NOT NULL,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                token_source TEXT NOT NULL DEFAULT 'unavailable',
                input_chars INTEGER NOT NULL DEFAULT 0,
                output_chars INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
            "CREATE TABLE agents (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                description TEXT DEFAULT '',
                system_prompt TEXT NOT NULL,
                endpoint_id TEXT,
                model TEXT,
                temperature REAL DEFAULT 0.7,
                max_tokens INTEGER DEFAULT 4096,
                badge TEXT DEFAULT '',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )",
            "CREATE TABLE project_agent_assignments (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                responsibility_kind TEXT NOT NULL DEFAULT 'custom',
                responsibility_label TEXT NOT NULL DEFAULT '',
                assignment_source TEXT NOT NULL DEFAULT 'existing',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
        ] {
            sqlx::query(table_sql)
                .execute(&pool)
                .await
                .expect("failed to create legacy schema");
        }

        sqlx::query("INSERT INTO users (id) VALUES ('user-1')")
            .execute(&pool)
            .await
            .expect("failed to seed user");
        sqlx::query("INSERT INTO projects (id, user_id) VALUES ('project-1', 'user-1')")
            .execute(&pool)
            .await
            .expect("failed to seed project");
        sqlx::query("INSERT INTO conversations (id, user_id) VALUES ('conv-1', 'user-1')")
            .execute(&pool)
            .await
            .expect("failed to seed conversation");
        sqlx::query("INSERT INTO ai_endpoints (id, user_id) VALUES ('ep-1', 'user-1')")
            .execute(&pool)
            .await
            .expect("failed to seed endpoint");
        sqlx::query(
            "INSERT INTO agents (
                id, name, role, description, system_prompt, endpoint_id, model, temperature,
                max_tokens, badge, is_active, created_at
            ) VALUES (
                'legacy-agent', 'Legacy Agent', 'writer', '', 'prompt', 'ep-1', 'gpt-4o', 0.7,
                4096, '', 1, '2026-04-13T00:00:00Z'
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to seed legacy agent");
        sqlx::query(
            "INSERT INTO messages (
                id, conversation_id, role, content, msg_type, agent_id, created_at
            ) VALUES ('msg-1', 'conv-1', 'assistant', 'content', 'text', 'legacy-agent', '2026-04-13T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed message");
        sqlx::query(
            "INSERT INTO ai_usage_events (
                id, user_id, project_id, conversation_id, agent_id, endpoint_id, provider, model,
                operation, status
            ) VALUES (
                'usage-1', 'user-1', 'project-1', 'conv-1', 'legacy-agent', 'ep-1', 'openai',
                'gpt-4o', 'chat', 'success'
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to seed ai_usage_events");
        sqlx::query(
            "INSERT INTO project_agent_assignments (
                id, user_id, project_id, agent_id, responsibility_kind, responsibility_label,
                assignment_source, is_active, created_at, updated_at
            ) VALUES (
                'assign-1', 'user-1', 'project-1', 'legacy-agent', 'editor', '主编',
                'existing', 1, '2026-04-13T00:00:00Z', '2026-04-13T00:00:00Z'
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to seed project_agent_assignments");

        run_schema_migrations(&pool)
            .await
            .expect("failed to apply agent scope backfill migration");

        let agent_columns = list_table_columns(&pool, "agents")
            .await
            .expect("failed to inspect agents");
        assert!(agent_columns.contains("user_id"));

        let new_agent_id = sqlx::query_scalar::<_, String>(
            "SELECT id FROM agents WHERE user_id = 'user-1' AND name = 'Legacy Agent'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to fetch migrated agent");
        assert_ne!(new_agent_id, "legacy-agent");

        let message_agent_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT agent_id FROM messages WHERE id = 'msg-1'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to fetch migrated message");
        assert_eq!(message_agent_id.as_deref(), Some(new_agent_id.as_str()));

        let usage_agent_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT agent_id FROM ai_usage_events WHERE id = 'usage-1'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to fetch migrated ai_usage");
        assert_eq!(usage_agent_id.as_deref(), Some(new_agent_id.as_str()));

        let assignment_agent_id = sqlx::query_scalar::<_, String>(
            "SELECT agent_id FROM project_agent_assignments WHERE id = 'assign-1'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to fetch migrated assignment");
        assert_eq!(assignment_agent_id, new_agent_id);

        let foreign_key_targets = sqlx::query("PRAGMA foreign_key_list(project_agent_assignments)")
            .fetch_all(&pool)
            .await
            .expect("failed to inspect assignment foreign keys")
            .into_iter()
            .filter_map(|row| {
                let from = row.try_get::<String, _>("from").ok()?;
                let table = row.try_get::<String, _>("table").ok()?;
                Some((from, table))
            })
            .collect::<Vec<_>>();
        assert!(foreign_key_targets
            .iter()
            .any(|(from, table)| from == "agent_id" && table == "agents"));
        assert!(!foreign_key_targets
            .iter()
            .any(|(from, table)| from == "agent_id" && table == "agents_legacy"));
        assert!(has_schema_migration(&pool, "010_agent_scope_backfills")
            .await
            .expect("failed to query 010 migration"));

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn updated_at_backfill_repairs_legacy_core_tables() {
        let (pool, db_path) = create_test_pool("woohoo-updated-at-backfill").await;

        sqlx::query(
            "CREATE TABLE schema_migrations (
                version    TEXT PRIMARY KEY NOT NULL,
                kind       TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create schema_migrations");

        for version in [
            "001_init",
            "002_pipeline_runs",
            "003_pipeline_orchestrator_m1",
            "004_pipeline_prompt_optimizations",
            "005_pipeline_schema_backfills",
            "006_legacy_schema_backfills",
            "007_runtime_compat_backfills_v2",
            "008_ai_tasks_persistence",
            "009_ops_schema_conflict_backfills",
            "010_agent_scope_backfills",
        ] {
            record_schema_migration(&pool, version, "test")
                .await
                .expect("failed to seed schema migration");
        }

        for table_sql in [
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'draft',
                phase TEXT DEFAULT 'concept',
                created_at TEXT NOT NULL
            )",
            "CREATE TABLE conversations (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                project_id TEXT,
                title TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )",
            "CREATE TABLE scripts (
                id TEXT PRIMARY KEY NOT NULL,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )",
            "CREATE TABLE runtime_heartbeats (
                component_key TEXT PRIMARY KEY NOT NULL,
                component_type TEXT NOT NULL,
                status TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                metrics_json TEXT,
                last_seen_at TEXT NOT NULL
            )",
            "CREATE TABLE pipeline_runs (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            )",
        ] {
            sqlx::query(table_sql)
                .execute(&pool)
                .await
                .expect("failed to create legacy table");
        }

        sqlx::query(
            "INSERT INTO projects (id, user_id, name, created_at)
             VALUES ('project-1', 'user-1', 'Legacy Project', '2026-04-14T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed projects");
        sqlx::query(
            "INSERT INTO conversations (id, user_id, project_id, title, created_at)
             VALUES ('conv-1', 'user-1', 'project-1', 'Legacy Conversation', '2026-04-14T00:01:00Z')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed conversations");
        sqlx::query(
            "INSERT INTO scripts (id, project_id, title, content, created_at)
             VALUES ('script-1', 'project-1', 'Legacy Script', '', '2026-04-14T00:02:00Z')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed scripts");
        sqlx::query(
            "INSERT INTO runtime_heartbeats (component_key, component_type, status, last_seen_at)
             VALUES ('runtime', 'server', 'healthy', '2026-04-14T00:03:00Z')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed runtime_heartbeats");
        sqlx::query(
            "INSERT INTO pipeline_runs (
                id, user_id, project_id, conversation_id, status, created_at, started_at, finished_at
             ) VALUES (
                'run-1', 'user-1', 'project-1', 'conv-1', 'completed',
                '2026-04-14T00:04:00Z', '2026-04-14T00:05:00Z', '2026-04-14T00:06:00Z'
             )",
        )
        .execute(&pool)
        .await
        .expect("failed to seed pipeline_runs");

        run_schema_migrations(&pool)
            .await
            .expect("failed to apply 011 updated_at backfill migration");

        for (table, expected_value) in [
            ("projects", "2026-04-14T00:00:00Z"),
            ("conversations", "2026-04-14T00:01:00Z"),
            ("scripts", "2026-04-14T00:02:00Z"),
            ("runtime_heartbeats", "2026-04-14T00:03:00Z"),
            ("pipeline_runs", "2026-04-14T00:06:00Z"),
        ] {
            let columns = list_table_columns(&pool, table)
                .await
                .expect("failed to inspect backfilled columns");
            assert!(
                columns.contains("updated_at"),
                "{table} should contain updated_at"
            );

            let sql = format!("SELECT updated_at FROM {table} LIMIT 1");
            let value = sqlx::query_scalar::<_, String>(&sql)
                .fetch_one(&pool)
                .await
                .expect("failed to fetch backfilled updated_at value");
            assert_eq!(value, expected_value, "{table} should backfill updated_at");
        }

        assert!(
            has_schema_migration(&pool, "011_updated_at_column_backfills")
                .await
                .expect("failed to query 011 migration")
        );

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn ai_usage_repair_rebuilds_legacy_agent_foreign_key_with_trigger_source() {
        let (pool, db_path) = create_test_pool("woohoo-ai-usage-repair").await;

        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("failed to enable foreign keys");

        for table_sql in [
            "CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)",
            "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL)",
            "CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL)",
            "CREATE TABLE ai_endpoints (id TEXT PRIMARY KEY NOT NULL)",
            "CREATE TABLE agents (id TEXT PRIMARY KEY NOT NULL)",
            "CREATE TABLE agents_legacy (id TEXT PRIMARY KEY NOT NULL)",
        ] {
            sqlx::query(table_sql)
                .execute(&pool)
                .await
                .expect("failed to create referenced table");
        }

        sqlx::query("INSERT INTO users (id) VALUES ('user-1')")
            .execute(&pool)
            .await
            .expect("failed to seed user");
        sqlx::query("INSERT INTO agents (id) VALUES ('agent-1')")
            .execute(&pool)
            .await
            .expect("failed to seed agent");
        sqlx::query("INSERT INTO agents_legacy (id) VALUES ('agent-1')")
            .execute(&pool)
            .await
            .expect("failed to seed legacy agent");

        sqlx::query(
            "CREATE TABLE ai_usage_events (
                id                  TEXT PRIMARY KEY NOT NULL,
                user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
                conversation_id     TEXT REFERENCES conversations(id) ON DELETE SET NULL,
                agent_id            TEXT REFERENCES agents_legacy(id) ON DELETE SET NULL,
                endpoint_id         TEXT REFERENCES ai_endpoints(id) ON DELETE SET NULL,
                provider            TEXT NOT NULL,
                model               TEXT,
                operation           TEXT NOT NULL,
                status              TEXT NOT NULL,
                latency_ms          INTEGER NOT NULL DEFAULT 0,
                prompt_tokens       INTEGER NOT NULL DEFAULT 0,
                completion_tokens   INTEGER NOT NULL DEFAULT 0,
                total_tokens        INTEGER NOT NULL DEFAULT 0,
                token_source        TEXT NOT NULL DEFAULT 'unavailable',
                input_chars         INTEGER NOT NULL DEFAULT 0,
                output_chars        INTEGER NOT NULL DEFAULT 0,
                error_message       TEXT,
                created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create legacy ai_usage_events with agents_legacy fk");

        sqlx::query(
            "INSERT INTO ai_usage_events (
                id, user_id, agent_id, provider, operation, status
            ) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("usage-1")
        .bind("user-1")
        .bind("agent-1")
        .bind("openai")
        .bind("task")
        .bind("failed")
        .execute(&pool)
        .await
        .expect("failed to seed ai_usage_events");

        ensure_ai_usage_schema(&pool)
            .await
            .expect("failed to backfill ai_usage columns");
        repair_ai_usage_agent_foreign_key(&pool)
            .await
            .expect("failed to repair ai_usage agent foreign key");

        let ai_usage_columns = list_table_columns(&pool, "ai_usage_events")
            .await
            .expect("failed to list ai_usage_events columns after repair");
        assert!(ai_usage_columns.contains("trigger_source"));

        let foreign_key_targets = sqlx::query("PRAGMA foreign_key_list(ai_usage_events)")
            .fetch_all(&pool)
            .await
            .expect("failed to inspect ai_usage foreign keys")
            .into_iter()
            .filter_map(|row| {
                let from = row.try_get::<String, _>("from").ok()?;
                let table = row.try_get::<String, _>("table").ok()?;
                Some((from, table))
            })
            .collect::<Vec<_>>();

        assert!(foreign_key_targets
            .iter()
            .any(|(from, table)| from == "agent_id" && table == "agents"));
        assert!(!foreign_key_targets
            .iter()
            .any(|(from, table)| from == "agent_id" && table == "agents_legacy"));

        let stored_agent_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT agent_id FROM ai_usage_events WHERE id = 'usage-1'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to fetch repaired ai_usage row");
        assert_eq!(stored_agent_id.as_deref(), Some("agent-1"));

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn schema_backfill_report_is_clean_after_fresh_init() {
        let (pool, db_path) = create_test_pool("woohoo-backfill-report").await;

        let applied_migrations = run_schema_migrations(&pool)
            .await
            .expect("failed to run schema migrations");
        let default_agent_seed = ensure_default_agents_for_existing_users(&pool)
            .await
            .expect("failed to seed default agents");
        let project_assignment_seed = ensure_project_agent_assignments_for_existing_projects(&pool)
            .await
            .expect("failed to seed project agent assignments");
        let report = build_schema_backfill_report(
            &pool,
            applied_migrations,
            default_agent_seed,
            project_assignment_seed,
        )
        .await
        .expect("failed to build schema backfill report");

        assert!(report.pending_compatibility_issues.is_empty());
        assert!(report
            .applied_migrations
            .contains(&"008_ai_tasks_persistence".to_string()));
        assert!(report
            .applied_migrations
            .contains(&"009_ops_schema_conflict_backfills".to_string()));
        assert!(report
            .applied_migrations
            .contains(&"010_agent_scope_backfills".to_string()));
        assert!(report
            .applied_migrations
            .contains(&"011_updated_at_column_backfills".to_string()));

        cleanup_test_pool(pool, db_path).await;
    }
}
