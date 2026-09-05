-- Woohoo Studio - 放宽 pipeline_runs.trigger_source 约束
-- 版本: 037
-- 目的: 修复 002 遗留的 latent 运行时 bug
--
-- 背景:
--   002 对 pipeline_runs.trigger_source 设了 CHECK 白名单，仅允许
--   ('manual','automation','api','retry')。
--   但前端制作流程的三个视图各自以专属 trigger_source 启动 run：
--     VideoView      → 'video'
--     CharSceneView  → 'char_scene'
--     KeyframeView   → 'keyframe'
--   （pipeline_type 统一用白名单内的 'custom'，靠 triggerSource 区分视图）
--   create_pipeline_run 直接绑定该值，INSERT 违反 CHECK 约束 → 500。
--   即分镜关键帧 / 角色场景 / 视频镜头三类编排自上线起就无法创建 run，
--   只有 OutlineView（'manual'）能正常工作。
--
-- 修复方式:
--   重建 pipeline_runs 表，移除 trigger_source 的 CHECK 约束（改为自由 TEXT）。
--
-- 执行方式（关键）:
--   本文件只包含「新建 pipeline_runs_new」的 DDL。数据复制 / 换表 / 索引
--   由 db.rs 的 apply_migration_037_pipeline_trigger_source_relax 以动态列
--   交集完成：legacy 库的 pipeline_runs 可能缺 002 之后的列（如
--   pipeline_type），静态 INSERT...SELECT 会以 "no such column" 失败，
--   动态只复制新旧两表共有的列，缺失列取新表默认值。
--
-- 原子性与外键:
--   pipeline_runs 是父表（pipeline_run_steps 等子表外键引用它），直接 DROP
--   会触发级联删除丢数据。因此必须先 PRAGMA foreign_keys = OFF（SQLite
--   不允许在事务内切换该开关），重建结束后恢复为 ON，并以
--   PRAGMA foreign_key_check 验证外键完整性。
--
-- 兼容性: 旧库升级时自动应用；schema_migrations 记录版本，幂等不重复执行。

CREATE TABLE pipeline_runs_new (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

    -- 流程类型和配置
    pipeline_type   TEXT NOT NULL DEFAULT 'one_click'
                    CHECK (pipeline_type IN ('one_click', 'outline', 'script', 'storyboard', 'review', 'custom')),
    -- 移除 CHECK 白名单：trigger_source 为自由 TEXT，允许
    -- video / char_scene / keyframe 等前端视图标识
    trigger_source  TEXT NOT NULL DEFAULT 'manual',

    -- 状态机
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),

    -- 幂等键：防止重复提交
    idempotency_key TEXT NOT NULL DEFAULT '',

    -- 进度跟踪
    total_steps     INTEGER NOT NULL DEFAULT 0,
    completed_steps INTEGER NOT NULL DEFAULT 0,
    failed_steps    INTEGER NOT NULL DEFAULT 0,

    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    started_at      TEXT,
    finished_at     TEXT,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- 错误信息
    error_message   TEXT,
    error_code      TEXT
);
