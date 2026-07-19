-- Woohoo Studio - 放宽 pipeline_run_events.event_type 约束
-- 版本: 025
-- 目的: 修复 002 遗留的 latent 运行时 bug
--
-- 背景:
--   002 对 pipeline_run_events.event_type 设了 CHECK 白名单，仅允许
--   ('created','started','paused','resumed','cancelled','step_queued',
--    'step_started','step_completed','step_failed','step_retry',
--    'completed','failed')。
--   但 orchestrator 实际写入的事件类型 step_blocked / step_dispatched /
--   assistant_step_summary / pipeline_asset_created / prompt_optimization_suggested
--   / manual_review_required 等均不在白名单内，导致 append_pipeline_event 的
--   INSERT 违反 CHECK、`?` 传播中断 advance_run_once，依赖门控路径在写
--   step_blocked 事件时崩溃。
--
-- 修复方式:
--   重建 pipeline_run_events 表，移除 event_type 的 CHECK 约束（改为自由 TEXT），
--   允许 orchestrator 写入当前与未来所有事件类型。source 的 CHECK 保留。
--   保留全部列、FK、默认值与索引，并用 INSERT...SELECT 全量复制旧数据。
--   pipeline_run_events 是叶子表（无入向外键引用），重建安全。
--
-- 分支策略（关键）:
--   本文件为「旧表存在」分支的重建 SQL，由 db.rs 中的
--   apply_migration_025_pipeline_events_constraint_relax 在确认
--   pipeline_run_events 存在时调用。
--   若旧表不存在（旧库 / 测试夹具缺表），走 Rust 内联的 fresh-create 分支，
--   直接以宽松 schema 建空表，不执行本文件，避免 INSERT...SELECT / DROP TABLE
--   对缺失表报错。
--   跨阶段依赖索引 idx_pipeline_runs_project_type_status 因依赖 pipeline_runs
--   表存在，统一由 Rust 侧条件创建，不放在本文件，以保证缺表旧库不报错。
--
-- 原子性:
--   整段重建包裹在 BEGIN IMMEDIATE / COMMIT 事务中，避免中途崩溃留下
--   pipeline_run_events_new 残表或丢失既有事件数据。开头的
--   DROP TABLE IF EXISTS pipeline_run_events_new 清理上次崩溃可能残留的临时表。
--
-- 兼容性: 旧库升级时自动应用；schema_migrations 记录版本，幂等不重复执行。

BEGIN IMMEDIATE;

-- 0. 清理可能因上次崩溃残留的 _new 临时表
DROP TABLE IF EXISTS pipeline_run_events_new;

-- 1. 创建新表（结构与 002 完全一致，仅移除 event_type CHECK）
CREATE TABLE pipeline_run_events_new (
    id              TEXT PRIMARY KEY NOT NULL,
    run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id         TEXT,

    -- 移除 CHECK 白名单：event_type 为自由 TEXT，允许 orchestrator 写入
    -- step_blocked / step_dispatched / assistant_step_summary /
    -- pipeline_asset_created / prompt_optimization_suggested /
    -- manual_review_required 等所有事件类型
    event_type      TEXT NOT NULL,

    payload_json    TEXT,

    source          TEXT NOT NULL DEFAULT 'system'
                    CHECK (source IN ('system', 'user', 'scheduler', 'api')),

    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 2. 全量复制既有事件数据（旧表存在，由 Rust 侧保证）
INSERT INTO pipeline_run_events_new (id, run_id, step_id, event_type, payload_json, source, created_at)
SELECT id, run_id, step_id, event_type, payload_json, source, created_at
FROM pipeline_run_events;

-- 3. 删除旧表并重命名新表
DROP TABLE pipeline_run_events;
ALTER TABLE pipeline_run_events_new RENAME TO pipeline_run_events;

-- 4. 重建既有索引
CREATE INDEX IF NOT EXISTS idx_pipeline_run_events_run ON pipeline_run_events(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_events_type ON pipeline_run_events(run_id, event_type, created_at DESC);

COMMIT;
