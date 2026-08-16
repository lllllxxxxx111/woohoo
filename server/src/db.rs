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

pub(crate) async fn run_schema_migrations(
    pool: &SqlitePool,
) -> Result<Vec<String>, sqlx::Error> {
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
            "020_asset_governance",
            include_str!("../migrations/020_asset_governance.sql"),
        ),
        (
            "021_pipeline_manual_reviews",
            include_str!("../migrations/021_pipeline_manual_reviews.sql"),
        ),
        (
            "022_budget_control",
            include_str!("../migrations/022_budget_control.sql"),
        ),
        (
            "023_export_audit",
            include_str!("../migrations/023_export_audit.sql"),
        ),
        (
            "024_pipeline_external_jobs",
            include_str!("../migrations/024_pipeline_external_jobs.sql"),
        ),
        (
            "025_pipeline_events_constraint_relax",
            include_str!("../migrations/025_pipeline_events_constraint_relax.sql"),
        ),
        (
            "026_pipeline_prompt_optimization_versions",
            include_str!("../migrations/026_pipeline_prompt_optimization_versions.sql"),
        ),
        (
            "027_collaboration_governance",
            include_str!("../migrations/027_collaboration_governance.sql"),
        ),
        (
            "028_billing_ref_id_unique",
            include_str!("../migrations/028_billing_ref_id_unique.sql"),
        ),
        (
            "029_content_versions",
            include_str!("../migrations/029_content_versions.sql"),
        ),
        (
            "031_chunked_uploads",
            include_str!("../migrations/031_chunked_uploads.sql"),
        ),
        (
            "032_upload_parts_cleanup",
            include_str!("../migrations/032_upload_parts_cleanup.sql"),
        ),
    ] {
        if version == "020_asset_governance" {
            let tables = list_all_tables(pool)
                .await?
                .into_iter()
                .collect::<HashSet<_>>();
            if !tables.contains("assets") || !tables.contains("pipeline_step_outputs") {
                tracing::info!(
                    version,
                    "跳过资产治理 migration：前置表尚不存在，后续启动将自动重试"
                );
                continue;
            }
        }
        if version == "025_pipeline_events_constraint_relax" {
            // 025 对 pipeline_run_events 表的存在性有分支处理（重建 vs
            // fresh-create），不能走统一的 run_sql_migration 路径，否则
            // 缺表旧库 / 测试夹具会在 INSERT...SELECT / DROP TABLE 上报错。
            if apply_migration_025_pipeline_events_constraint_relax(pool).await? {
                applied_versions.push(version.to_string());
            }
            continue;
        }
        if version == "026_pipeline_prompt_optimization_versions" {
            // 026 对 pipeline_prompt_optimizations 表的存在性与列状态有分支处理
            // （缺表恢复 + 逐列 ALTER 检查），不能走统一的 run_sql_migration 路径，
            // 否则缺表旧库 / 部分执行后重启会以 "no such table" 或 "duplicate column"
            // 永久失败。
            if apply_migration_026_pipeline_prompt_optimization_versions(pool).await? {
                applied_versions.push(version.to_string());
            }
            continue;
        }
        if version == "028_billing_ref_id_unique" {
            // 028 在 credit_transactions 上建立 (ref_type, ref_id) 唯一索引。
            // 旧版 update_spent_ref_id 竞态可能产生重复 (ref_type, ref_id) 的 spent 记录，
            // 导致 CREATE UNIQUE INDEX 失败。需要先清理重复行（保留最新一条）再建索引。
            if apply_migration_028_billing_ref_id_unique(pool).await? {
                applied_versions.push(version.to_string());
            }
            continue;
        }
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
    if let Some(version) = run_content_version_baseline_backfill_migration(pool).await? {
        applied_versions.push(version);
    }

    // 026 may run before pipeline_run_steps is restored; retry its data backfill
    // on startup so step_key is not permanently left NULL.
    ensure_pipeline_prompt_optimization_step_keys(pool).await?;

    // 跨阶段索引补建：025 的 idx_pipeline_runs_project_type_status 依赖 pipeline_runs
    // 表与 project_id/pipeline_type/status 三列同时存在。025 记录为已应用时这些前置
    // 条件可能尚未具备（缺表 / 缺列），导致索引被跳过且不会重试。
    // 此处在所有 backfill 完成后幂等调用 ensure 函数，确保索引最终一致；缺条件时
    // 仍安全跳过，下次启动继续重试。
    ensure_idx_pipeline_runs_project_type_status(pool).await?;

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

/**
 * 应用 migration 025：放宽 pipeline_run_events.event_type 约束
 *
 * 背景：原 025 SQL 假设 pipeline_run_events 表一定存在（由 002 创建），
 *   直接执行 `INSERT ... FROM pipeline_run_events` 与 `DROP TABLE
 *   pipeline_run_events`。但旧库 / 测试夹具可能记录了 002 已应用却
 *   实际未建表（或 002 尚未执行），导致 025 以 "no such table" 失败。
 *
 * 兼容策略（按表是否存在分支处理，非忽略错误）：
 *   1. 已应用过 025（schema_migrations 有记录）→ 直接返回，幂等。
 *   2. pipeline_run_events 存在 → 执行 025 SQL 文件的重建分支：
 *      事务内 INSERT...SELECT 全量复制 → DROP 旧表 → RENAME → 重建索引，
 *      移除 event_type CHECK，保留 source CHECK 与全部列/FK/默认值。
 *   3. pipeline_run_events 缺失（旧库 / 测试夹具）→ 走 fresh-create 分支：
 *      直接以宽松 schema 建空表（无数据可迁），不触发对缺失表的 INSERT/DROP。
 *
 * 跨阶段依赖索引 idx_pipeline_runs_project_type_status（服务于
 *   is_project_prerequisite_satisfied）依赖 pipeline_runs 表存在，
 *   仅在 pipeline_runs 存在时创建；缺表旧库待 005 backfill 建 pipeline_runs
 *   后由下次启动重试补建。
 *
 * 失败传播：每个分支的 SQL 在其前置条件下必应成功；任何错误直接向上传播，
 *   不通过 catch_unwind / IGNORE 掩盖真实迁移失败。
 */
/**
 * 幂等地确保 idx_pipeline_runs_project_type_status 索引存在。
 *
 * 该索引服务于 is_project_prerequisite_satisfied 查询，原属 025 范畴，
 * 但跨阶段依赖 pipeline_runs 表与 project_id/pipeline_type/status 三列同时存在。
 * 025 记录为已应用时这些前置条件可能尚未具备（旧库 / 测试夹具中 pipeline_runs
 * 缺失或列不全），导致索引永久缺失。
 *
 * 兼容策略（基于 schema 条件分支，非吞没错误）：
 *   1. pipeline_runs 不存在 → 跳过（下次启动重试），返回 Ok。
 *   2. pipeline_runs 缺三列之一 → 跳过并记录缺失列，返回 Ok。
 *   3. 三列齐全 → CREATE INDEX IF NOT EXISTS 幂等建索引。
 *
 * 调用点：
 *   - apply_migration_025 内（首次尝试建索引）
 *   - run_schema_migrations 末尾（所有 backfill 后幂等补建，确保索引最终一致）
 */
async fn ensure_idx_pipeline_runs_project_type_status(
    pool: &SqlitePool,
) -> Result<(), sqlx::Error> {
    let tables: HashSet<String> = list_all_tables(pool).await?.into_iter().collect();
    if !tables.contains("pipeline_runs") {
        tracing::info!(
            "跳过 idx_pipeline_runs_project_type_status：pipeline_runs 尚不存在，待 005 backfill 后下次启动补建"
        );
        return Ok(());
    }
    let columns = list_table_columns(pool, "pipeline_runs").await?;
    let required: [&str; 3] = ["project_id", "pipeline_type", "status"];
    let missing: Vec<&str> = required
        .iter()
        .filter(|c| !columns.contains(**c))
        .copied()
        .collect();
    if !missing.is_empty() {
        tracing::info!(
            ?missing,
            "跳过 idx_pipeline_runs_project_type_status：pipeline_runs 缺少所需列，待列补齐后下次启动补建"
        );
        return Ok(());
    }
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_type_status \
         ON pipeline_runs(project_id, pipeline_type, status)",
    )
    .execute(pool)
    .await?;
    Ok(())
}
/// Retry the 026 data backfill after pipeline_run_steps becomes available.
async fn ensure_pipeline_prompt_optimization_step_keys(
    pool: &SqlitePool,
) -> Result<(), sqlx::Error> {
    let tables: HashSet<String> = list_all_tables(pool).await?.into_iter().collect();
    if !tables.contains("pipeline_prompt_optimizations")
        || !tables.contains("pipeline_run_steps")
    {
        return Ok(());
    }

    let optimization_columns = list_table_columns(pool, "pipeline_prompt_optimizations").await?;
    let step_columns = list_table_columns(pool, "pipeline_run_steps").await?;
    if !optimization_columns.contains("step_key")
        || !optimization_columns.contains("step_id")
        || !step_columns.contains("id")
        || !step_columns.contains("step_key")
    {
        return Ok(());
    }

    sqlx::query(
        "UPDATE pipeline_prompt_optimizations
         SET step_key = (
             SELECT s.step_key
             FROM pipeline_run_steps s
             WHERE s.id = pipeline_prompt_optimizations.step_id
         )
         WHERE step_key IS NULL
           AND EXISTS (
               SELECT 1
               FROM pipeline_run_steps s
               WHERE s.id = pipeline_prompt_optimizations.step_id
           )",
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn apply_migration_025_pipeline_events_constraint_relax(
    pool: &SqlitePool,
) -> Result<bool, sqlx::Error> {
    const VERSION: &str = "025_pipeline_events_constraint_relax";
    const REBUILD_SQL: &str =
        include_str!("../migrations/025_pipeline_events_constraint_relax.sql");

    // fresh-create 分支：旧表缺失时直接以宽松 schema 建空表 + 事件索引。
    // 与 025 重建分支、005 backfill 的 pipeline_run_events 定义保持一致，
    // 不含 event_type CHECK；FK 指向 pipeline_runs（SQLite 在 foreign_keys
    // 关闭时允许引用尚不存在的表，由 005 backfill 后续建表补齐）。
    const FRESH_CREATE_SQL: &str = "-- 025 fresh-create: pipeline_run_events 缺失时以宽松 schema 直接建表
CREATE TABLE IF NOT EXISTS pipeline_run_events (
    id              TEXT PRIMARY KEY NOT NULL,
    run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id         TEXT,
    event_type      TEXT NOT NULL,
    payload_json    TEXT,
    source          TEXT NOT NULL DEFAULT 'system'
                    CHECK (source IN ('system', 'user', 'scheduler', 'api')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_events_run ON pipeline_run_events(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_events_type ON pipeline_run_events(run_id, event_type, created_at DESC);";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(false);
    }

    let tables: HashSet<String> = list_all_tables(pool).await?.into_iter().collect();
    let events_exists = tables.contains("pipeline_run_events");

    if events_exists {
        tracing::info!(
            version = VERSION,
            "重建 pipeline_run_events 表以移除 event_type CHECK 约束（事务保护 + 数据迁移）"
        );
        sqlx::raw_sql(REBUILD_SQL).execute(pool).await?;
    } else {
        tracing::info!(
            version = VERSION,
            "pipeline_run_events 不存在（旧库/测试夹具），走 fresh-create 分支以宽松 schema 直接建表"
        );
        sqlx::raw_sql(FRESH_CREATE_SQL).execute(pool).await?;
    }

    // 跨阶段依赖索引：幂等调用 ensure 函数。
    // 025 记录为已应用时 pipeline_runs 可能尚未存在或缺列，索引会跳过。
    // 后续 005 backfill 建 pipeline_runs 后，run_schema_migrations 末尾会
    // 再次调用 ensure 函数补建，避免索引永久缺失。
    ensure_idx_pipeline_runs_project_type_status(pool).await?;

    record_schema_migration(pool, VERSION, "sql").await?;
    Ok(true)
}

/**
 * 应用 migration 026：pipeline_prompt_optimizations 版本化与应用记录扩展
 *
 * 背景：原 026 SQL 假设 pipeline_prompt_optimizations 表一定存在（由 004 创建），
 *   直接执行 13 个 `ALTER TABLE pipeline_prompt_optimizations ADD COLUMN`。
 *   但旧库 / 测试夹具可能记录了 004 已应用却实际未建表，导致 026 以
 *   "no such table" 失败；若 ALTER 部分执行后中断，下次启动会以
 *   "duplicate column name" 永久失败。
 *
 * 兼容策略（基于 schema 条件分支，非吞没错误）：
 *   1. 已应用过 026 → 直接返回，幂等。
 *   2. pipeline_prompt_optimizations 缺失 → 先执行 004 SQL 的
 *      `CREATE TABLE IF NOT EXISTS` 恢复基础表，再继续后续步骤。
 *   3. 逐列检查：已存在则跳过 ALTER，不存在则执行 ADD COLUMN，
 *      避免 "duplicate column name" 导致部分执行后永久失败。
 *   4. UPDATE step_key 回填、CREATE INDEX、CREATE TABLE auto_apply_config
 *      均为幂等语句，可安全重复执行。
 *
 * 失败传播：每个 ALTER / UPDATE / CREATE 在其前置条件下必应成功；任何错误
 *   直接向上传播，不通过 catch_unwind / IGNORE 掩盖真实迁移失败。
 */
async fn apply_migration_026_pipeline_prompt_optimization_versions(
    pool: &SqlitePool,
) -> Result<bool, sqlx::Error> {
    const VERSION: &str = "026_pipeline_prompt_optimization_versions";
    const BASE_TABLE_SQL: &str =
        include_str!("../migrations/004_pipeline_prompt_optimizations.sql");

    if has_schema_migration(pool, VERSION).await? {
        return Ok(false);
    }

    // 缺表恢复：若 004 已记录但表未真正建立，先执行 004 SQL 的
    // CREATE TABLE IF NOT EXISTS 幂等建表（不重复记录 004 版本）。
    let tables: HashSet<String> = list_all_tables(pool).await?.into_iter().collect();
    if !tables.contains("pipeline_prompt_optimizations") {
        tracing::info!(
            version = VERSION,
            "pipeline_prompt_optimizations 缺失，先执行 004 CREATE TABLE IF NOT EXISTS 恢复基础表"
        );
        sqlx::raw_sql(BASE_TABLE_SQL).execute(pool).await?;
    }

    // 逐列检查 ALTER：已存在则跳过，不存在则 ADD COLUMN。
    // 026 原 SQL 的 13 个 ADD COLUMN 定义（与 026 SQL 完全一致）。
    let existing_columns = list_table_columns(pool, "pipeline_prompt_optimizations").await?;
    // 列名 + 类型定义（与 026 SQL 一致）。列名硬编码，无 SQL 注入风险。
    let alter_columns: [(&str, &str); 13] = [
        ("step_key", "TEXT"),
        ("version", "INTEGER NOT NULL DEFAULT 0"),
        ("strategy", "TEXT NOT NULL DEFAULT 'manual'"),
        ("operator_user_id", "TEXT"),
        ("applied_at", "TEXT"),
        ("applied_request_id", "TEXT"),
        ("original_prompt", "TEXT"),
        ("optimized_prompt", "TEXT"),
        ("previous_version_id", "TEXT"),
        ("rolled_back_at", "TEXT"),
        ("rolled_back_by", "TEXT"),
        ("rolled_back_reason", "TEXT"),
        ("rollback_request_id", "TEXT"),
    ];
    for (col, type_def) in alter_columns {
        if existing_columns.contains(col) {
            tracing::info!(
                version = VERSION,
                col,
                "列已存在，跳过 ALTER TABLE ADD COLUMN"
            );
            continue;
        }
        let sql = format!(
            "ALTER TABLE pipeline_prompt_optimizations ADD COLUMN {} {}",
            col, type_def
        );
        sqlx::query(&sql).execute(pool).await?;
    }

    // 幂等回填 step_key：仅在 step_key IS NULL 且 pipeline_run_steps 存在时反查填充。
    // SQLite 在子查询引用不存在的表时会直接抛 no such table，而非返回 NULL，
    // 因此必须显式检查 pipeline_run_steps 是否存在。
    // 缺表时跳过回填（step_key 保持 NULL，待后续 backfill 建表后下次启动补建），
    // 不记录 026 为已应用之外的其他状态，下次启动会因 026 已记录而跳过本函数，
    // 此时由 run_schema_migrations 末尾的跨阶段补建逻辑兜底（见 ensure_*）。
    if tables.contains("pipeline_run_steps") {
        sqlx::query(
            "UPDATE pipeline_prompt_optimizations
             SET step_key = (
                 SELECT s.step_key FROM pipeline_run_steps s
                 WHERE s.id = pipeline_prompt_optimizations.step_id
             )
             WHERE step_key IS NULL",
        )
        .execute(pool)
        .await?;
    } else {
        tracing::info!(
            version = VERSION,
            "跳过 step_key 回填：pipeline_run_steps 尚不存在，待后续 backfill 后下次启动补建"
        );
    }

    // 幂等索引：CREATE INDEX IF NOT EXISTS
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_pipeline_prompt_opt_project_step \
         ON pipeline_prompt_optimizations(project_id, step_key, decision, created_at DESC)",
    )
    .execute(pool)
    .await?;

    // 幂等独立表：CREATE TABLE IF NOT EXISTS
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pipeline_prompt_auto_apply_config (
            id                  TEXT PRIMARY KEY NOT NULL,
            user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            step_key            TEXT,
            enabled             INTEGER NOT NULL DEFAULT 0,
            risk_acknowledged   INTEGER NOT NULL DEFAULT 0,
            operator_user_id    TEXT NOT NULL,
            created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_prompt_auto_apply_project_step \
         ON pipeline_prompt_auto_apply_config(project_id, step_key)",
    )
    .execute(pool)
    .await?;

    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(true)
}

/**
 * 应用 migration 028：credit_transactions (ref_type, ref_id) 唯一索引
 *
 * 背景：旧版 update_spent_ref_id 通过 "WHERE ref_id IS NULL ORDER BY
 *   created_at DESC LIMIT 1" 子查询绑定消费记录到生成任务，并发下可能：
 *   1. 两个请求选到同一行（互相覆盖，一个生成任务丢失扣费关联）；
 *   2. 两个请求互相绑到对方的扣费行（账单与任务错配）。
 *
 * 修复策略：
 *   1. 删除旧版 update_spent_ref_id 函数（见 billing/repo.rs）；
 *   2. 新版扣费在 check_and_deduct_idempotent 中直接带 ref_id 写入，无需后续 UPDATE；
 *   3. 本 migration 在 credit_transactions 上建立 (ref_type, ref_id) partial unique index，
 *      从 DB 层面保证同一生成任务不会被重复扣费或重复退款。
 *
 * 历史数据清理：
 *   旧版竞态可能留下重复 (ref_type, ref_id) 的 spent 记录（同一 ref_id 被多次 UPDATE）。
 *   CREATE UNIQUE INDEX 在存在重复时会失败。本函数先删除重复行（保留最新一条），
 *   再执行 028 SQL 建索引。refund 记录同理。
 *
 * 删除策略说明：
 *   - 保留最新一条 spent（按 created_at DESC）；
 *   - 被删除的旧重复 spent 记录不补退款：这些记录是 update_spent_ref_id 竞态产物，
 *     其对应的生成任务早已成功或失败，退款状态由 refund_outstanding_for_ref 保证。
 *   - 保留最新一条 refund（按 created_at DESC），删除更早的重复退款。
 *
 * 失败传播：任何 SQL 错误直接向上传播，不吞错。
 *
 * @param pool 数据库连接池
 * @returns true 表示本次执行了迁移；false 表示已应用过（幂等跳过）
 */
async fn apply_migration_028_billing_ref_id_unique(
    pool: &SqlitePool,
) -> Result<bool, sqlx::Error> {
    const VERSION: &str = "028_billing_ref_id_unique";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(false);
    }

    tracing::info!(version = VERSION, "执行 billing ref_id 唯一索引 migration");

    // 兼容性检查：legacy 测试数据库可能跳过 013_image_studio 等基础迁移，
    // 因而没有 credit_transactions 表。此时跳过清理与索引创建，
    // 仅记录 migration 已应用（与 028 的语义一致：不存在表即没有竞态）。
    // 真实生产数据库一定有 credit_transactions（由 013 创建），不会走到此分支。
    let credit_table_exists: bool = sqlx::query_scalar(
        "SELECT COUNT(*) > 0 FROM sqlite_master
         WHERE type = 'table' AND name = 'credit_transactions'",
    )
    .fetch_one(pool)
    .await?;

    if !credit_table_exists {
        tracing::warn!(
            version = VERSION,
            "credit_transactions 表不存在，跳过唯一索引创建（legacy/test 数据库路径）"
        );
        record_schema_migration(pool, VERSION, "rust").await?;
        return Ok(true);
    }

    // 在执行任何 DDL 前，关闭外键约束，避免 SQLite 在 CREATE INDEX / DELETE 时
    // 对 credit_transactions.user_id 触发 FK 校验（legacy 测试库可能没有 users 表）。
    // 完成后再恢复。生产库一定有 users 表，此开关无副作用。
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(pool)
        .await?;

    let result: Result<(), sqlx::Error> = async {
        // Step 1: 清理重复 spent 记录（保留每组 ref_type+ref_id 最新一条）
        // SQLite 不支持 CTE DELETE，用 rowid NOT IN 子查询实现
        sqlx::query(
            "DELETE FROM credit_transactions
             WHERE rowid IN (
                 SELECT ct.rowid
                 FROM credit_transactions ct
                 WHERE ct.kind = 'spent' AND ct.ref_id IS NOT NULL
                 AND ct.rowid NOT IN (
                     SELECT MIN(inner_ct.rowid)
                     FROM credit_transactions inner_ct
                     WHERE inner_ct.kind = 'spent'
                       AND inner_ct.ref_type = ct.ref_type
                       AND inner_ct.ref_id = ct.ref_id
                       AND inner_ct.ref_id IS NOT NULL
                     GROUP BY inner_ct.ref_type, inner_ct.ref_id
                 )
             )",
        )
        .execute(pool)
        .await?;

        // Step 2: 清理重复 refund 记录（保留每组 ref_type+ref_id 最新一条）
        sqlx::query(
            "DELETE FROM credit_transactions
             WHERE rowid IN (
                 SELECT ct.rowid
                 FROM credit_transactions ct
                 WHERE ct.kind = 'refund' AND ct.ref_id IS NOT NULL
                 AND ct.rowid NOT IN (
                     SELECT MIN(inner_ct.rowid)
                     FROM credit_transactions inner_ct
                     WHERE inner_ct.kind = 'refund'
                       AND inner_ct.ref_type = ct.ref_type
                       AND inner_ct.ref_id = ct.ref_id
                       AND inner_ct.ref_id IS NOT NULL
                     GROUP BY inner_ct.ref_type, inner_ct.ref_id
                 )
             )",
        )
        .execute(pool)
        .await?;

        // Step 3: 执行 028 SQL 创建唯一索引（此时已无重复行）
        let migration_sql = include_str!("../migrations/028_billing_ref_id_unique.sql");
        sqlx::raw_sql(migration_sql).execute(pool).await?;
        Ok(())
    }
    .await;

    // 无论成功失败，恢复外键约束（与 sqlx-sqlite 默认 ON 一致）
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await?;
    result?;

    record_schema_migration(pool, VERSION, "rust").await?;
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

/**
 * 内容版本基线回填（migration 030）
 *
 * 旧库在引入 content_versions 之前，剧本/分镜只保存在 scripts/storyboards 表。
 * 升级后需要把既有内容作为“基线版本”（version=1, source='baseline'）写入版本历史，
 * 保证：
 *   1. 旧内容可作为只读基线被版本列表/差异/恢复接口读取；
 *   2. 后续保存拥有正确的 baseVersion（从 1 开始递增）。
 *
 * 幂等：仅对尚无任何版本的 (project_id, content_type) 生成基线。
 */
async fn run_content_version_baseline_backfill_migration(
    pool: &SqlitePool,
) -> Result<Option<String>, sqlx::Error> {
    const VERSION: &str = "030_content_version_baseline";

    if has_schema_migration(pool, VERSION).await? {
        return Ok(None);
    }

    // 029 尚未创建 content_versions 时跳过，等待下次启动重试
    let tables: HashSet<String> = list_all_tables(pool).await?.into_iter().collect();
    if !tables.contains("content_versions") {
        tracing::info!(
            version = VERSION,
            "跳过内容版本基线回填：content_versions 表尚不存在"
        );
        return Ok(None);
    }

    // content_versions.project_id 外键指向 projects；若 projects 尚不存在（缺表旧库 /
    // 测试夹具），此时回填会触发外键错误，跳过并等待下次启动重试。
    if !tables.contains("projects") {
        tracing::info!(
            version = VERSION,
            "跳过内容版本基线回填：projects 表尚不存在"
        );
        return Ok(None);
    }

    let mut tx = pool.begin().await?;

    backfill_script_baselines(&mut tx).await?;
    backfill_storyboard_baselines(&mut tx).await?;

    tx.commit().await?;

    record_schema_migration(pool, VERSION, "rust").await?;
    Ok(Some(VERSION.to_string()))
}

async fn backfill_script_baselines(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), sqlx::Error> {
    if !list_all_tables_in_tx(tx).await?.contains("scripts") {
        return Ok(());
    }

    #[derive(Debug, sqlx::FromRow)]
    struct ScriptRow {
        project_id: String,
        title: String,
        content: String,
        created_at: String,
    }

    let scripts = sqlx::query_as::<_, ScriptRow>(
        "SELECT s.project_id, s.title, s.content, s.created_at
         FROM scripts s
         INNER JOIN projects p ON p.id = s.project_id
         ORDER BY s.created_at ASC",
    )
    .fetch_all(&mut **tx)
    .await?;

    for script in scripts {
        let existing = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM content_versions
             WHERE project_id = ? AND content_type = 'script'",
        )
        .bind(&script.project_id)
        .fetch_one(&mut **tx)
        .await?;
        if existing > 0 {
            continue;
        }

        let content_hash = crate::content_version::repo::sha256_hex(&script.content);
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO content_versions
                 (id, project_id, content_type, version, content, content_hash, source, created_by, note, title, created_at)
             VALUES (?, ?, 'script', 1, ?, ?, 'baseline', NULL, '旧库历史基线', ?, ?)",
        )
        .bind(&id)
        .bind(&script.project_id)
        .bind(&script.content)
        .bind(&content_hash)
        .bind(&script.title)
        .bind(&script.created_at)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

async fn backfill_storyboard_baselines(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), sqlx::Error> {
    if !list_all_tables_in_tx(tx).await?.contains("storyboards") {
        return Ok(());
    }

    #[derive(Debug, sqlx::FromRow)]
    struct StoryboardRow {
        id: String,
        project_id: String,
        created_at: String,
    }

    #[derive(Debug, sqlx::FromRow)]
    struct LineRow {
        id: String,
        storyboard_id: String,
        scene_number: i64,
        description: String,
        duration: i64,
        sort_order: i64,
    }

    #[derive(Debug, sqlx::FromRow)]
    struct LineAssetRow {
        storyboard_line_id: String,
        asset_id: String,
    }

    let storyboards = sqlx::query_as::<_, StoryboardRow>(
        "SELECT s.id, s.project_id, s.created_at
         FROM storyboards s
         INNER JOIN projects p ON p.id = s.project_id
         ORDER BY s.created_at ASC",
    )
    .fetch_all(&mut **tx)
    .await?;

    if storyboards.is_empty() {
        return Ok(());
    }

    for storyboard in storyboards {
        let existing = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM content_versions
             WHERE project_id = ? AND content_type = 'storyboard'",
        )
        .bind(&storyboard.project_id)
        .fetch_one(&mut **tx)
        .await?;
        if existing > 0 {
            continue;
        }

        let lines = sqlx::query_as::<_, LineRow>(
            "SELECT id, storyboard_id, scene_number, description, duration, sort_order
             FROM storyboard_lines WHERE storyboard_id = ?
             ORDER BY sort_order ASC, scene_number ASC, id ASC",
        )
        .bind(&storyboard.id)
        .fetch_all(&mut **tx)
        .await?;

        let line_assets = sqlx::query_as::<_, LineAssetRow>(
            "SELECT storyboard_line_id, asset_id FROM storyboard_line_assets
             WHERE storyboard_line_id IN (SELECT id FROM storyboard_lines WHERE storyboard_id = ?)",
        )
        .bind(&storyboard.id)
        .fetch_all(&mut **tx)
        .await?;

        let mut assets_by_line: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for la in line_assets {
            assets_by_line
                .entry(la.storyboard_line_id)
                .or_default()
                .push(la.asset_id);
        }

        let snapshot_lines: Vec<crate::content_version::model::StoryboardSnapshotLine> = lines
            .into_iter()
            .map(|line| {
                let asset_ids = assets_by_line.remove(&line.id).unwrap_or_default();
                crate::content_version::model::StoryboardSnapshotLine {
                    id: line.id,
                    scene_number: line.scene_number,
                    description: line.description,
                    duration: line.duration,
                    asset_ids,
                }
            })
            .collect();

        let snapshot = crate::content_version::model::StoryboardSnapshot {
            lines: snapshot_lines,
        };
        let content = serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".to_string());
        let content_hash = crate::content_version::repo::sha256_hex(&content);
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO content_versions
                 (id, project_id, content_type, version, content, content_hash, source, created_by, note, title, created_at)
             VALUES (?, ?, 'storyboard', 1, ?, ?, 'baseline', NULL, '旧库历史基线', NULL, ?)",
        )
        .bind(&id)
        .bind(&storyboard.project_id)
        .bind(&content)
        .bind(&content_hash)
        .bind(&storyboard.created_at)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

/// 事务内列出所有表名（用于基线回填的前置检查）
async fn list_all_tables_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<HashSet<String>, sqlx::Error> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().collect())
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
                "012_collaboration".to_string(),
                "013_image_studio".to_string(),
                "014_image_generation_assets".to_string(),
                "015_ai_endpoint_capabilities".to_string(),
                "016_collaboration_pipeline_run_id".to_string(),
                "017_video_gen".to_string(),
                "018_image_generation_project_id".to_string(),
                "019_image_generation_asset_ids".to_string(),
                "020_asset_governance".to_string(),
                "021_pipeline_manual_reviews".to_string(),
                "022_budget_control".to_string(),
                "023_export_audit".to_string(),
                "024_pipeline_external_jobs".to_string(),
                "025_pipeline_events_constraint_relax".to_string(),
                "026_pipeline_prompt_optimization_versions".to_string(),
                "027_collaboration_governance".to_string(),
                "028_billing_ref_id_unique".to_string(),
                "029_content_versions".to_string(),
                "030_content_version_baseline".to_string(),
                "031_chunked_uploads".to_string(),
                "032_upload_parts_cleanup".to_string(),
            ]
        );

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn content_version_baseline_backfill_upgrades_legacy_script_and_storyboard() {
        let (pool, db_path) = create_test_pool("woohoo-content-version-baseline").await;

        // 构造旧库：schema_migrations + 最小项目/剧本/分镜表（无 content_versions）
        sqlx::query(
            "CREATE TABLE schema_migrations (
                version    TEXT PRIMARY KEY NOT NULL,
                kind       TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("create schema_migrations");

        sqlx::query(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT ''
            )",
        )
        .execute(&pool)
        .await
        .expect("create projects");

        sqlx::query(
            "CREATE TABLE scripts (
                id TEXT PRIMARY KEY NOT NULL,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("create scripts");

        sqlx::query(
            "CREATE TABLE storyboards (
                id TEXT PRIMARY KEY NOT NULL,
                project_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("create storyboards");

        sqlx::query(
            "CREATE TABLE storyboard_lines (
                id TEXT PRIMARY KEY NOT NULL,
                storyboard_id TEXT NOT NULL,
                scene_number INTEGER NOT NULL,
                description TEXT NOT NULL,
                duration INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            )",
        )
        .execute(&pool)
        .await
        .expect("create storyboard_lines");

        sqlx::query(
            "CREATE TABLE storyboard_line_assets (
                storyboard_line_id TEXT NOT NULL,
                asset_id TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create storyboard_line_assets");

        // 应用 029，建立 content_versions 表
        sqlx::raw_sql(include_str!("../migrations/029_content_versions.sql"))
            .execute(&pool)
            .await
            .expect("apply content_versions migration");

        // 灌入旧数据
        sqlx::query("INSERT INTO projects (id, user_id, name) VALUES ('p1', 'u1', '旧项目')")
            .execute(&pool)
            .await
            .expect("seed project");
        sqlx::query(
            "INSERT INTO scripts (id, project_id, title, content) VALUES ('s1', 'p1', '旧剧本', '旧剧本内容')",
        )
        .execute(&pool)
        .await
        .expect("seed script");
        sqlx::query("INSERT INTO storyboards (id, project_id) VALUES ('sb1', 'p1')")
            .execute(&pool)
            .await
            .expect("seed storyboard");
        sqlx::query(
            "INSERT INTO storyboard_lines (id, storyboard_id, scene_number, description, duration, sort_order)
             VALUES ('l1', 'sb1', 1, '旧镜头', 3, 0)",
        )
        .execute(&pool)
        .await
        .expect("seed storyboard line");

        // 运行基线回填
        let applied = run_content_version_baseline_backfill_migration(&pool)
            .await
            .expect("run baseline backfill");
        assert_eq!(applied, Some("030_content_version_baseline".to_string()));

        // 剧本基线版本
        let script_baseline = sqlx::query_as::<_, (i64, String, String)>(
            "SELECT version, source, content FROM content_versions
             WHERE project_id = 'p1' AND content_type = 'script' ORDER BY version DESC LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .expect("script baseline exists");
        let (script_version, script_source, script_content) = script_baseline;
        assert_eq!(script_version, 1);
        assert_eq!(script_source, "baseline");
        assert_eq!(script_content, "旧剧本内容");

        // 分镜基线版本（内容为结构化 JSON）
        let storyboard_baseline = sqlx::query_as::<_, (i64, String, String)>(
            "SELECT version, source, content FROM content_versions
             WHERE project_id = 'p1' AND content_type = 'storyboard' ORDER BY version DESC LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .expect("storyboard baseline exists");
        let (storyboard_version, storyboard_source, storyboard_content) = storyboard_baseline;
        assert_eq!(storyboard_version, 1);
        assert_eq!(storyboard_source, "baseline");
        assert!(storyboard_content.contains("旧镜头"));

        // 幂等：再次运行不再产生新版本
        let rerun = run_content_version_baseline_backfill_migration(&pool)
            .await
            .expect("rerun baseline backfill");
        assert_eq!(rerun, None);

        let script_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM content_versions WHERE project_id = 'p1' AND content_type = 'script'",
        )
        .fetch_one(&pool)
        .await
        .expect("count script versions");
        assert_eq!(script_count, 1);

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
    /// 在测试夹具中创建带 CHECK 白名单的旧版 pipeline_run_events 表（模拟 002 原始 schema），
    /// 同时创建最小化的 pipeline_runs 父表以满足 FK 引用与 025 索引创建需求。
    /// 父表含 project_id/pipeline_type/status 三列以触发 025 的跨阶段索引建立。
    /// 注意：调用前需确保 PRAGMA foreign_keys = OFF（001_init 默认开启 FK）。
    async fn seed_legacy_pipeline_run_events_with_check(pool: &SqlitePool) {
        // 最小化父表：含 025 索引所需的 project_id/pipeline_type/status 三列
        sqlx::query(
            "CREATE TABLE pipeline_runs (
                id              TEXT PRIMARY KEY NOT NULL,
                user_id         TEXT NOT NULL,
                project_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                pipeline_type   TEXT NOT NULL DEFAULT 'one_click',
                status          TEXT NOT NULL DEFAULT 'queued',
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(pool)
        .await
        .expect("failed to create legacy pipeline_runs fixture");

        // 旧版事件表：含 event_type CHECK 白名单（与 002 完全一致）
        sqlx::query(
            "CREATE TABLE pipeline_run_events (
                id              TEXT PRIMARY KEY NOT NULL,
                run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
                step_id         TEXT,
                event_type      TEXT NOT NULL
                                CHECK (event_type IN (
                                    'created','started','paused','resumed','cancelled',
                                    'step_queued','step_started','step_completed',
                                    'step_failed','step_retry','completed','failed'
                                )),
                payload_json    TEXT,
                source          TEXT NOT NULL DEFAULT 'system'
                                CHECK (source IN ('system','user','scheduler','api')),
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(pool)
        .await
        .expect("failed to create legacy pipeline_run_events with CHECK");

        sqlx::query(
            "CREATE INDEX idx_pipeline_run_events_run ON pipeline_run_events(run_id, created_at DESC)",
        )
        .execute(pool)
        .await
        .expect("failed to create legacy index");

        // 父表种子行：供事件 FK 引用
        sqlx::query(
            "INSERT INTO pipeline_runs (id, user_id, project_id, conversation_id, pipeline_type, status, created_at)
             VALUES ('run-1','user-1','project-1','conv-1','one_click','completed','2026-04-14T00:00:00Z')",
        )
        .execute(pool)
        .await
        .expect("failed to seed pipeline_runs row");
    }

    /// 尝试插入 event_type='step_blocked'（不在 002 白名单内）的事件。
    /// 返回 true 表示插入成功（CHECK 已被 025 移除）；false 表示违反 CHECK 失败。
    async fn try_insert_non_whitelist_event(pool: &SqlitePool, id: &str) -> bool {
        sqlx::query(
            "INSERT INTO pipeline_run_events (id, run_id, event_type, source, created_at)
             VALUES (?, 'run-1', 'step_blocked', 'system', '2026-04-14T00:00:00Z')",
        )
        .bind(id)
        .execute(pool)
        .await
        .is_ok()
    }

    /// 空库场景：全新数据库运行迁移，025 应通过 fresh-create 分支创建宽松 schema 的事件表，
    /// 移除 event_type CHECK 约束，并建立事件索引与跨阶段索引 idx_pipeline_runs_project_type_status。
    #[tokio::test]
    async fn migration_025_fresh_db_relaxes_check_and_creates_index() {
        let (pool, db_path) = create_test_pool("woohoo-mig025-fresh").await;

        run_schema_migrations(&pool)
            .await
            .expect("fresh db migrations should succeed");

        // 025 已记录到 schema_migrations
        assert!(
            has_schema_migration(&pool, "025_pipeline_events_constraint_relax")
                .await
                .expect("failed to query 025")
        );

        // pipeline_run_events 表存在（由 fresh-create 分支建立）
        let tables: HashSet<String> = list_all_tables(&pool)
            .await
            .expect("failed to list tables")
            .into_iter()
            .collect();
        assert!(
            tables.contains("pipeline_run_events"),
            "fresh-create 后 pipeline_run_events 应存在"
        );

        // 关闭 FK 检查以便插入最小化父表行（001_init 默认开启 foreign_keys）
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 插入父表行后，应能插入白名单外的 step_blocked 事件
        sqlx::query(
            "INSERT INTO pipeline_runs (id, user_id, project_id, conversation_id)
             VALUES ('run-1','user-1','project-1','conv-1')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed pipeline_runs");

        assert!(
            try_insert_non_whitelist_event(&pool, "evt-fresh-1").await,
            "fresh-create 后应允许插入 step_blocked 事件（CHECK 已移除）"
        );

        // 事件索引存在
        let indexes = list_table_indexes(&pool, "pipeline_run_events")
            .await
            .expect("failed to list indexes");
        assert!(indexes.contains("idx_pipeline_run_events_run"));
        assert!(indexes.contains("idx_pipeline_run_events_type"));

        // 跨阶段索引：fresh 库的 pipeline_runs 由 002 建表含三列，应建 idx_pipeline_runs_project_type_status
        let runs_indexes = list_table_indexes(&pool, "pipeline_runs")
            .await
            .expect("failed to list pipeline_runs indexes");
        assert!(
            runs_indexes.contains("idx_pipeline_runs_project_type_status"),
            "fresh 库应建立 idx_pipeline_runs_project_type_status 索引"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 旧库场景：002 已建带 CHECK 白名单的 pipeline_run_events，025 应通过 rebuild 分支
    /// 重建表移除 CHECK 约束，保留 source CHECK、FK、索引等其余 schema。
    /// 直接调用 apply_migration_025 而非 run_schema_migrations，避开 027 等其他迁移的副作用，
    /// 聚焦验证 025 的 rebuild 分支逻辑。
    #[tokio::test]
    async fn migration_025_old_db_with_check_rebuilds_and_preserves_schema() {
        let (pool, db_path) = create_test_pool("woohoo-mig025-old").await;

        // 创建 schema_migrations 表（apply_migration_025 内部 has_schema_migration 依赖）
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

        // 关闭 FK 以便夹具建表 + 插入（001_init 默认开启 foreign_keys）
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 建旧版事件表（含 CHECK 白名单）+ 父表
        seed_legacy_pipeline_run_events_with_check(&pool).await;

        // 迁移前：白名单外事件应被 CHECK 拒绝
        assert!(
            !try_insert_non_whitelist_event(&pool, "evt-pre-1").await,
            "迁移前 CHECK 应拒绝 step_blocked 事件"
        );

        // 直接调用 025 的专用迁移函数（rebuild 分支）
        let applied = apply_migration_025_pipeline_events_constraint_relax(&pool)
            .await
            .expect("failed to apply migration 025");
        assert!(applied, "025 应实际执行 rebuild 分支");

        // 025 已记录
        assert!(
            has_schema_migration(&pool, "025_pipeline_events_constraint_relax")
                .await
                .expect("failed to query 025")
        );

        // CHECK 已移除：能插入白名单外事件
        assert!(
            try_insert_non_whitelist_event(&pool, "evt-post-1").await,
            "迁移后应允许插入 step_blocked 事件"
        );

        // source CHECK 仍生效：尝试插 source='invalid' 应失败
        let invalid_source_result = sqlx::query(
            "INSERT INTO pipeline_run_events (id, run_id, event_type, source, created_at)
             VALUES ('evt-bad-source','run-1','created','invalid','2026-04-14T00:00:00Z')",
        )
        .execute(&pool)
        .await;
        assert!(
            invalid_source_result.is_err(),
            "source CHECK 应保留，'invalid' 应被拒绝"
        );

        // 事件索引存在
        let indexes = list_table_indexes(&pool, "pipeline_run_events")
            .await
            .expect("failed to list indexes");
        assert!(indexes.contains("idx_pipeline_run_events_run"));
        assert!(indexes.contains("idx_pipeline_run_events_type"));

        // 跨阶段索引：夹具 pipeline_runs 含三列，应建 idx_pipeline_runs_project_type_status
        let runs_indexes = list_table_indexes(&pool, "pipeline_runs")
            .await
            .expect("failed to list pipeline_runs indexes");
        assert!(
            runs_indexes.contains("idx_pipeline_runs_project_type_status"),
            "rebuild 后应建立 idx_pipeline_runs_project_type_status 索引"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 缺表场景：夹具记录 002 已应用但未实际建 pipeline_run_events 表，
    /// 025 应走 fresh-create 分支以宽松 schema 直接建表，不报 "no such table" 错误。
    /// 同时验证 026 在 pipeline_prompt_optimizations 缺失时被 guard 跳过。
    #[tokio::test]
    async fn migration_025_missing_old_table_fresh_creates_relaxed() {
        let (pool, db_path) = create_test_pool("woohoo-mig025-missing").await;

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

        // 记录 001-007 已应用（含 002）但不实际建任何表
        // 模拟旧库 / 测试夹具中 "002 已记录但表未真正建立" 的破损状态
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
            .expect("missing-table migrations should succeed via fresh-create");

        // 025 已记录
        assert!(
            has_schema_migration(&pool, "025_pipeline_events_constraint_relax")
                .await
                .expect("failed to query 025")
        );

        // pipeline_run_events 表存在（fresh-create 分支建立）
        let tables: HashSet<String> = list_all_tables(&pool)
            .await
            .expect("failed to list tables")
            .into_iter()
            .collect();
        assert!(
            tables.contains("pipeline_run_events"),
            "fresh-create 分支应建立 pipeline_run_events 表"
        );

        // 026 应通过缺表恢复逻辑建立 pipeline_prompt_optimizations 并记录为已应用
        // （修复后：缺表不再永久跳过 026，而是先执行 004 CREATE TABLE IF NOT EXISTS
        // 再继续 026 的 ALTER / INDEX / CREATE TABLE 流程）
        assert!(
            has_schema_migration(&pool, "026_pipeline_prompt_optimization_versions")
                .await
                .expect("failed to query 026"),
            "026 应在 pipeline_prompt_optimizations 缺失时通过缺表恢复逻辑被应用"
        );
        assert!(
            tables.contains("pipeline_prompt_optimizations"),
            "026 缺表恢复应建立 pipeline_prompt_optimizations 表"
        );
        assert!(
            tables.contains("pipeline_prompt_auto_apply_config"),
            "026 应建立 pipeline_prompt_auto_apply_config 表"
        );

        // 关闭 FK 以便手动建父表 + 插入
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 手动建父表（夹具不依赖 002 实际执行）以验证 025 fresh-create 的 FK 引用
        sqlx::query(
            "CREATE TABLE pipeline_runs (
                id              TEXT PRIMARY KEY NOT NULL,
                user_id         TEXT NOT NULL,
                project_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                pipeline_type   TEXT NOT NULL DEFAULT 'one_click',
                status          TEXT NOT NULL DEFAULT 'queued',
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create pipeline_runs for FK target");

        sqlx::query(
            "INSERT INTO pipeline_runs (id, user_id, project_id, conversation_id)
             VALUES ('run-1','user-1','project-1','conv-1')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed pipeline_runs");

        assert!(
            try_insert_non_whitelist_event(&pool, "evt-missing-1").await,
            "fresh-create 后应允许插入 step_blocked 事件"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 重复执行场景：连续调用 run_schema_migrations 两次，第二次应跳过 025（已记录），
    /// 不重复执行 rebuild / fresh-create，不产生重复 schema_migrations 记录，已有数据不丢失。
    #[tokio::test]
    async fn migration_025_repeated_execution_is_idempotent() {
        let (pool, db_path) = create_test_pool("woohoo-mig025-idempotent").await;

        run_schema_migrations(&pool)
            .await
            .expect("first run should succeed");

        // 关闭 FK 以便插入最小化父表行（001_init 默认开启 foreign_keys）
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 第一次后插入父表行与一条非白名单事件，作为 "数据已存在" 标记
        sqlx::query(
            "INSERT INTO pipeline_runs (id, user_id, project_id, conversation_id)
             VALUES ('run-1','user-1','project-1','conv-1')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed pipeline_runs");
        assert!(
            try_insert_non_whitelist_event(&pool, "evt-idem-1").await,
            "首次迁移后应允许插入 step_blocked"
        );

        // 第二次运行：应跳过 025（幂等）
        run_schema_migrations(&pool)
            .await
            .expect("second run should succeed (idempotent)");

        // 025 在 schema_migrations 中仅有一条记录
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = '025_pipeline_events_constraint_relax'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to count 025 records");
        assert_eq!(count, 1, "025 应仅记录一次");

        // 第二次后仍能插入非白名单事件（schema 未被破坏）
        assert!(
            try_insert_non_whitelist_event(&pool, "evt-idem-2").await,
            "第二次运行后应仍允许插入 step_blocked"
        );

        // 原有事件保留
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM pipeline_run_events WHERE id LIKE 'evt-idem-%' ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .expect("failed to fetch events");
        assert_eq!(
            rows,
            vec!["evt-idem-1".to_string(), "evt-idem-2".to_string()]
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 数据保留场景：旧表中已有若干白名单事件，025 rebuild 后应通过 INSERT...SELECT
    /// 全量复制到新表，行数与全部字段（id/run_id/step_id/event_type/payload_json/source/created_at）保持不变。
    /// 直接调用 apply_migration_025 而非 run_schema_migrations，避开 027 等其他迁移的副作用。
    #[tokio::test]
    async fn migration_025_preserves_existing_event_rows() {
        let (pool, db_path) = create_test_pool("woohoo-mig025-preserve").await;

        // 创建 schema_migrations 表（apply_migration_025 内部 has_schema_migration 依赖）
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

        // 关闭 FK 以便夹具建表 + 插入（001_init 默认开启 foreign_keys）
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 建旧版事件表 + 父表（含种子 run-1 行）
        seed_legacy_pipeline_run_events_with_check(&pool).await;

        // 迁移前插入 3 条白名单事件
        let before_rows: Vec<(&str, &str, &str, &str, &str, &str, &str)> = vec![
            ("evt-1", "run-1", "step-1", "step_started", r#"{"k":1}"#, "system", "2026-04-14T00:01:00Z"),
            ("evt-2", "run-1", "step-1", "step_completed", r#"{"k":2}"#, "scheduler", "2026-04-14T00:02:00Z"),
            ("evt-3", "run-1", "step-2", "step_failed", r#"{"k":3}"#, "api", "2026-04-14T00:03:00Z"),
        ];
        for (id, run_id, step_id, event_type, payload, source, created_at) in &before_rows {
            sqlx::query(
                "INSERT INTO pipeline_run_events (id, run_id, step_id, event_type, payload_json, source, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(run_id)
            .bind(step_id)
            .bind(event_type)
            .bind(payload)
            .bind(source)
            .bind(created_at)
            .execute(&pool)
            .await
            .expect("failed to seed legacy event row");
        }

        // 直接调用 025 的专用迁移函数（rebuild 分支）
        let applied = apply_migration_025_pipeline_events_constraint_relax(&pool)
            .await
            .expect("failed to apply migration 025");
        assert!(applied, "025 应实际执行 rebuild 分支");

        // 行数保留
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pipeline_run_events WHERE id IN ('evt-1','evt-2','evt-3')",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to count preserved events");
        assert_eq!(count, 3, "应保留全部 3 条原始事件");

        // 字段值保留
        let rows = sqlx::query(
            "SELECT id, run_id, step_id, event_type, payload_json, source, created_at
             FROM pipeline_run_events WHERE id IN ('evt-1','evt-2','evt-3') ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .expect("failed to fetch preserved events");

        assert_eq!(rows.len(), 3, "应查询到 3 条保留事件");
        for (i, row) in rows.iter().enumerate() {
            let expected = &before_rows[i];
            let id: String = row.try_get("id").expect("id");
            let run_id: String = row.try_get("run_id").expect("run_id");
            let step_id: Option<String> = row.try_get("step_id").expect("step_id");
            let event_type: String = row.try_get("event_type").expect("event_type");
            let payload_json: Option<String> = row.try_get("payload_json").expect("payload_json");
            let source: String = row.try_get("source").expect("source");
            let created_at: String = row.try_get("created_at").expect("created_at");
            assert_eq!(id, expected.0, "id 不匹配");
            assert_eq!(run_id, expected.1, "run_id 不匹配");
            assert_eq!(step_id.as_deref(), Some(expected.2), "step_id 不匹配");
            assert_eq!(event_type, expected.3, "event_type 不匹配");
            assert_eq!(payload_json.as_deref(), Some(expected.4), "payload_json 不匹配");
            assert_eq!(source, expected.5, "source 不匹配");
            assert_eq!(created_at, expected.6, "created_at 不匹配");
        }

        // 迁移后能插入非白名单事件（CHECK 移除）
        assert!(
            try_insert_non_whitelist_event(&pool, "evt-new-blocked").await,
            "迁移后应允许插入 step_blocked 事件"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 索引补建场景 1：025 执行时 pipeline_runs 不存在，
    /// idx_pipeline_runs_project_type_status 应被跳过（不报错），025 仍记录为已应用。
    /// 此场景模拟旧库 / 测试夹具中 pipeline_runs 缺失但 025 已运行的破损状态。
    #[tokio::test]
    async fn migration_025_index_skipped_when_pipeline_runs_missing() {
        let (pool, db_path) = create_test_pool("woohoo-mig025-idx-no-runs").await;

        // 创建 schema_migrations（apply_migration_025 内部依赖）
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

        // 关闭 FK 以便 fresh-create 引用尚不存在的 pipeline_runs
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 直接调用 025（fresh-create 分支建空事件表，pipeline_runs 不存在）
        let applied = apply_migration_025_pipeline_events_constraint_relax(&pool)
            .await
            .expect("025 应在 pipeline_runs 缺失时通过 fresh-create 成功");
        assert!(applied, "025 应实际执行");

        // 025 已记录
        assert!(
            has_schema_migration(&pool, "025_pipeline_events_constraint_relax")
                .await
                .expect("failed to query 025"),
            "025 应被记录为已应用"
        );

        // pipeline_run_events 表存在
        let tables: HashSet<String> = list_all_tables(&pool)
            .await
            .expect("failed to list tables")
            .into_iter()
            .collect();
        assert!(
            tables.contains("pipeline_run_events"),
            "fresh-create 应建立 pipeline_run_events"
        );

        // pipeline_runs 不存在
        assert!(
            !tables.contains("pipeline_runs"),
            "夹具不应建立 pipeline_runs"
        );

        // 索引被跳过：pipeline_runs 不存在，无法建索引
        let indexes = list_table_indexes(&pool, "pipeline_run_events")
            .await
            .expect("failed to list event indexes");
        // 仅应包含事件表自身的索引，跨阶段索引不存在
        assert!(
            !indexes.contains("idx_pipeline_runs_project_type_status"),
            "pipeline_runs 缺失时跨阶段索引应被跳过（不报错）"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 索引补建场景 2：pipeline_runs 存在但缺 project_id/pipeline_type/status 之一，
    /// idx_pipeline_runs_project_type_status 应被跳过（不报错），025 仍记录为已应用。
    #[tokio::test]
    async fn migration_025_index_skipped_when_columns_missing() {
        let (pool, db_path) = create_test_pool("woohoo-mig025-idx-no-cols").await;

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

        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 建 pipeline_runs 但缺 status 列（仅 project_id/pipeline_type，不满足三列齐全）
        sqlx::query(
            "CREATE TABLE pipeline_runs (
                id              TEXT PRIMARY KEY NOT NULL,
                user_id         TEXT NOT NULL,
                project_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                pipeline_type   TEXT NOT NULL DEFAULT 'one_click',
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create pipeline_runs without status column");

        let applied = apply_migration_025_pipeline_events_constraint_relax(&pool)
            .await
            .expect("025 应在 pipeline_runs 缺列时通过 fresh-create 成功");
        assert!(applied, "025 应实际执行");

        assert!(
            has_schema_migration(&pool, "025_pipeline_events_constraint_relax")
                .await
                .expect("failed to query 025"),
            "025 应被记录为已应用"
        );

        // 跨阶段索引不存在（status 缺失）
        let indexes = list_table_indexes(&pool, "pipeline_runs")
            .await
            .expect("failed to list pipeline_runs indexes");
        assert!(
            !indexes.contains("idx_pipeline_runs_project_type_status"),
            "pipeline_runs 缺 status 列时跨阶段索引应被跳过"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 索引补建场景 3：025 首次运行时跳过索引（pipeline_runs 缺失），
    /// 下次启动（pipeline_runs 由 backfill 建好后）调用 ensure 函数应补建索引。
    /// 模拟 run_schema_migrations 末尾的跨阶段补建调用。
    #[tokio::test]
    async fn migration_025_index_recovered_on_next_startup() {
        let (pool, db_path) = create_test_pool("woohoo-mig025-idx-recover").await;

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

        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 首次运行 025：pipeline_runs 不存在，索引被跳过
        let applied = apply_migration_025_pipeline_events_constraint_relax(&pool)
            .await
            .expect("first 025 run should succeed");
        assert!(applied);

        let indexes_before = list_table_indexes(&pool, "pipeline_runs")
            .await
            .expect("failed to list indexes before recovery");
        // pipeline_runs 不存在时返回空集合
        assert!(
            !indexes_before.contains("idx_pipeline_runs_project_type_status"),
            "首次运行后跨阶段索引不应存在"
        );

        // 模拟 005 backfill 建立 pipeline_runs（三列齐全）
        sqlx::query(
            "CREATE TABLE pipeline_runs (
                id              TEXT PRIMARY KEY NOT NULL,
                user_id         TEXT NOT NULL,
                project_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                pipeline_type   TEXT NOT NULL DEFAULT 'one_click',
                status          TEXT NOT NULL DEFAULT 'queued',
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create pipeline_runs with all required columns");

        // 模拟 run_schema_migrations 末尾的 ensure 调用（跨阶段补建）
        ensure_idx_pipeline_runs_project_type_status(&pool)
            .await
            .expect("ensure function should succeed after pipeline_runs is created");

        // 索引被补建
        let indexes_after = list_table_indexes(&pool, "pipeline_runs")
            .await
            .expect("failed to list indexes after recovery");
        assert!(
            indexes_after.contains("idx_pipeline_runs_project_type_status"),
            "ensure 函数应在 pipeline_runs 三列齐全后补建跨阶段索引"
        );

        // 再次调用 ensure 应幂等（不报错、不重复创建）
        ensure_idx_pipeline_runs_project_type_status(&pool)
            .await
            .expect("ensure function should be idempotent");

        // 通过 sqlite_master 直接校验索引仅存在一个（CREATE INDEX IF NOT EXISTS 幂等）
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_pipeline_runs_project_type_status'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to count index");
        assert_eq!(
            count, 1,
            "重复调用 ensure 不应产生重复索引（CREATE INDEX IF NOT EXISTS 幂等）"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 026 缺表恢复场景：schema_migrations 已记录 004，但 pipeline_prompt_optimizations
    /// 表实际未建立。026 应通过缺表恢复逻辑（执行 004 SQL 的 CREATE TABLE IF NOT EXISTS）
    /// 建立基础表，然后继续执行 13 个 ALTER / 索引 / 新表，并记录为已应用。
    #[tokio::test]
    async fn migration_026_recovers_missing_base_table() {
        let (pool, db_path) = create_test_pool("woohoo-mig026-missing-base").await;

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

        // 记录 004 已应用但实际不建表（模拟破损状态）
        record_schema_migration(&pool, "004_pipeline_prompt_optimizations", "test")
            .await
            .expect("failed to seed 004");

        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 调用 026：缺表恢复 + 完整 ALTER / 索引 / 新表
        let applied = apply_migration_026_pipeline_prompt_optimization_versions(&pool)
            .await
            .expect("026 should recover missing base table and continue");
        assert!(applied, "026 应实际执行（缺表恢复 + ALTER）");

        // 026 已记录
        assert!(
            has_schema_migration(&pool, "026_pipeline_prompt_optimization_versions")
                .await
                .expect("failed to query 026"),
            "026 应被记录为已应用"
        );

        // 基础表已建立
        let tables: HashSet<String> = list_all_tables(&pool)
            .await
            .expect("failed to list tables")
            .into_iter()
            .collect();
        assert!(
            tables.contains("pipeline_prompt_optimizations"),
            "缺表恢复应建立 pipeline_prompt_optimizations"
        );
        assert!(
            tables.contains("pipeline_prompt_auto_apply_config"),
            "026 应建立 pipeline_prompt_auto_apply_config 表"
        );

        // 13 个新列全部存在
        let columns = list_table_columns(&pool, "pipeline_prompt_optimizations")
            .await
            .expect("failed to list columns");
        for col in [
            "step_key",
            "version",
            "strategy",
            "operator_user_id",
            "applied_at",
            "applied_request_id",
            "original_prompt",
            "optimized_prompt",
            "previous_version_id",
            "rolled_back_at",
            "rolled_back_by",
            "rolled_back_reason",
            "rollback_request_id",
        ] {
            assert!(
                columns.contains(col),
                "缺表恢复后列 {} 应存在（由 026 ALTER 添加）",
                col
            );
        }

        // 索引存在
        let indexes = list_table_indexes(&pool, "pipeline_prompt_optimizations")
            .await
            .expect("failed to list indexes");
        assert!(
            indexes.contains("idx_pipeline_prompt_opt_project_step"),
            "026 应建立 idx_pipeline_prompt_opt_project_step 索引"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 026 部分 ALTER 场景：上次启动已部分执行 ALTER（添加了 step_key、version 两列），
    /// 然后中断未记录 026。本次启动应跳过已存在列，继续添加剩余 11 列，避免
    /// "duplicate column name" 错误使迁移永久失败。
    #[tokio::test]
    async fn migration_026_partial_alter_continues_on_restart() {
        let (pool, db_path) = create_test_pool("woohoo-mig026-partial-alter").await;

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

        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 手动建立基础表（含 004 列）+ 部分模拟上次 ALTER 已执行（step_key、version）
        sqlx::query(
            "CREATE TABLE pipeline_prompt_optimizations (
                id                   TEXT PRIMARY KEY NOT NULL,
                run_id               TEXT NOT NULL,
                step_id              TEXT NOT NULL,
                project_id           TEXT NOT NULL,
                conversation_id      TEXT NOT NULL,
                decision             TEXT NOT NULL DEFAULT 'suggested',
                design_prompt_patch  TEXT,
                review_prompt_patch  TEXT,
                rationale_json       TEXT,
                source               TEXT NOT NULL DEFAULT 'assistant',
                created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                step_key             TEXT,
                version              INTEGER NOT NULL DEFAULT 0
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create table with partial 026 columns");

        // 026 未记录（模拟上次中断）
        assert!(
            !has_schema_migration(&pool, "026_pipeline_prompt_optimization_versions")
                .await
                .unwrap(),
            "测试前置：026 未记录"
        );

        // 调用 026：应跳过 step_key、version，添加剩余 11 列，不报 duplicate column
        let applied = apply_migration_026_pipeline_prompt_optimization_versions(&pool)
            .await
            .expect("026 should continue after partial ALTER without duplicate column error");
        assert!(applied, "026 应实际执行（补齐剩余列）");

        // 13 列全部存在
        let columns = list_table_columns(&pool, "pipeline_prompt_optimizations")
            .await
            .expect("failed to list columns");
        for col in [
            "step_key",
            "version",
            "strategy",
            "operator_user_id",
            "applied_at",
            "applied_request_id",
            "original_prompt",
            "optimized_prompt",
            "previous_version_id",
            "rolled_back_at",
            "rolled_back_by",
            "rolled_back_reason",
            "rollback_request_id",
        ] {
            assert!(
                columns.contains(col),
                "部分 ALTER 后再次启动，列 {} 应存在",
                col
            );
        }

        // 026 已记录
        assert!(
            has_schema_migration(&pool, "026_pipeline_prompt_optimization_versions")
                .await
                .unwrap(),
            "026 应被记录为已应用"
        );

        cleanup_test_pool(pool, db_path).await;
    }

    /// 026 两次启动幂等场景：第一次完整执行 026，第二次启动应直接返回（不重复执行），
    /// 不产生重复 schema_migrations 记录，不报 duplicate column 错误。
    #[tokio::test]
    async fn migration_026_idempotent_on_second_startup() {
        let (pool, db_path) = create_test_pool("woohoo-mig026-twice").await;

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

        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 第一次：缺表恢复 + 完整 ALTER
        let applied1 = apply_migration_026_pipeline_prompt_optimization_versions(&pool)
            .await
            .expect("first 026 run should succeed");
        assert!(applied1, "首次应实际执行");

        // 第二次：应直接返回（幂等）
        let applied2 = apply_migration_026_pipeline_prompt_optimization_versions(&pool)
            .await
            .expect("second 026 run should be idempotent");
        assert!(
            !applied2,
            "第二次启动应返回 false（已应用，不重复执行）"
        );

        // schema_migrations 中 026 仅一条记录
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = '026_pipeline_prompt_optimization_versions'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to count 026 records");
        assert_eq!(count, 1, "026 应仅记录一次");

        cleanup_test_pool(pool, db_path).await;
    }

    /// 026 完整升级场景：旧库已有 pipeline_prompt_optimizations 表（004 建立），
    /// 且 pipeline_run_steps 表已有 step_key 数据。026 应：
    /// 1. 跳过 CREATE TABLE（表已存在）
    /// 2. 添加 13 个新列
    /// 3. 回填 step_key：从 pipeline_run_steps 反查填充到 step_key IS NULL 的行
    /// 4. 建立索引与新表
    /// 5. 记录 026 为已应用
    #[tokio::test]
    async fn migration_026_deferred_step_key_backfill_retries_after_steps_restore() {
        let (pool, db_path) = create_test_pool("woohoo-mig026-deferred-step-key").await;

        sqlx::query(
            "CREATE TABLE pipeline_prompt_optimizations (
                id TEXT PRIMARY KEY NOT NULL,
                step_id TEXT NOT NULL,
                step_key TEXT,
                created_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create optimization table");
        sqlx::query(
            "INSERT INTO pipeline_prompt_optimizations (id, step_id, step_key, created_at)
             VALUES ('opt-1', 'step-1', NULL, '2026-04-14T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed optimization row");

        // 026 may complete before the step table is available.
        ensure_pipeline_prompt_optimization_step_keys(&pool)
            .await
            .expect("missing step table should be safe");

        sqlx::query(
            "CREATE TABLE pipeline_run_steps (
                id TEXT PRIMARY KEY NOT NULL,
                step_key TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create step table");
        sqlx::query(
            "INSERT INTO pipeline_run_steps (id, step_key)
             VALUES ('step-1', 'outline_generate')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed step row");

        ensure_pipeline_prompt_optimization_step_keys(&pool)
            .await
            .expect("deferred step_key backfill should succeed");

        let step_key: Option<String> = sqlx::query_scalar(
            "SELECT step_key FROM pipeline_prompt_optimizations WHERE id = 'opt-1'",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to read backfilled step_key");
        assert_eq!(step_key.as_deref(), Some("outline_generate"));

        cleanup_test_pool(pool, db_path).await;
    }

    #[tokio::test]
    async fn migration_026_complete_upgrade_from_legacy() {
        let (pool, db_path) = create_test_pool("woohoo-mig026-full-upgrade").await;

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

        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("failed to disable foreign_keys");

        // 建 pipeline_run_steps（含 step_key 数据，供回填反查）
        sqlx::query(
            "CREATE TABLE pipeline_run_steps (
                id           TEXT PRIMARY KEY NOT NULL,
                run_id       TEXT NOT NULL,
                step_key     TEXT NOT NULL,
                step_name    TEXT NOT NULL,
                step_order   INTEGER NOT NULL DEFAULT 0,
                status       TEXT NOT NULL DEFAULT 'queued',
                created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create pipeline_run_steps");

        sqlx::query(
            "INSERT INTO pipeline_run_steps (id, run_id, step_key, step_name)
             VALUES ('step-1','run-1','outline_generate','大纲生成')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed pipeline_run_steps");

        // 建 004 基础表（旧库已有，缺 026 的 13 列）
        sqlx::query(
            "CREATE TABLE pipeline_prompt_optimizations (
                id                   TEXT PRIMARY KEY NOT NULL,
                run_id               TEXT NOT NULL,
                step_id              TEXT NOT NULL,
                project_id           TEXT NOT NULL,
                conversation_id      TEXT NOT NULL,
                decision             TEXT NOT NULL DEFAULT 'suggested',
                design_prompt_patch  TEXT,
                review_prompt_patch  TEXT,
                rationale_json       TEXT,
                source               TEXT NOT NULL DEFAULT 'assistant',
                created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("failed to create legacy pipeline_prompt_optimizations");

        // 插入 2 行待回填的 prompt 优化记录（step_id 指向 pipeline_run_steps）
        sqlx::query(
            "INSERT INTO pipeline_prompt_optimizations (id, run_id, step_id, project_id, conversation_id)
             VALUES ('opt-1','run-1','step-1','project-1','conv-1')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed opt-1");
        sqlx::query(
            "INSERT INTO pipeline_prompt_optimizations (id, run_id, step_id, project_id, conversation_id)
             VALUES ('opt-2','run-1','step-1','project-1','conv-1')",
        )
        .execute(&pool)
        .await
        .expect("failed to seed opt-2");

        // 调用 026：完整升级
        let applied = apply_migration_026_pipeline_prompt_optimization_versions(&pool)
            .await
            .expect("026 should complete full upgrade from legacy table");
        assert!(applied, "026 应实际执行完整升级");

        // 验证 step_key 已被回填（从 pipeline_run_steps.step_key='outline_generate' 反查）
        let backfilled: Vec<String> = sqlx::query_scalar(
            "SELECT step_key FROM pipeline_prompt_optimizations WHERE id IN ('opt-1','opt-2') ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .expect("failed to fetch backfilled step_key");
        assert_eq!(
            backfilled,
            vec!["outline_generate".to_string(), "outline_generate".to_string()],
            "step_key 应被回填为 pipeline_run_steps.step_key 的值"
        );

        // 验证 026 已记录
        assert!(
            has_schema_migration(&pool, "026_pipeline_prompt_optimization_versions")
                .await
                .unwrap(),
            "026 应被记录为已应用"
        );

        // 验证新表已建立
        let tables: HashSet<String> = list_all_tables(&pool)
            .await
            .expect("failed to list tables")
            .into_iter()
            .collect();
        assert!(
            tables.contains("pipeline_prompt_auto_apply_config"),
            "026 应建立 pipeline_prompt_auto_apply_config 表"
        );

        cleanup_test_pool(pool, db_path).await;
    }
}
