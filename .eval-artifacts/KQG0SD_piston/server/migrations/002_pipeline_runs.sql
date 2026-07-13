-- Woohoo Studio - 流程运行（Pipeline Runs）模型
-- 解决P0问题：一键启动不是"流程引擎"的问题
-- 提供完整的流程追踪、状态管理和控制能力

-----------------------------------------------------------
-- 流程运行主表：记录每次一键启动的完整生命周期
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_runs (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

    -- 流程类型和配置
    pipeline_type   TEXT NOT NULL DEFAULT 'one_click'
                    CHECK (pipeline_type IN ('one_click', 'outline', 'script', 'storyboard', 'review', 'custom')),
    trigger_source  TEXT NOT NULL DEFAULT 'manual'
                    CHECK (trigger_source IN ('manual', 'automation', 'api', 'retry')),

    -- 状态机
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),

    -- 幂等键：防止重复提交
    idempotency_key TEXT NOT NULL DEFAULT '',

    -- 进度跟踪
    total_steps     INTEGER NOT NULL DEFAULT 0,
    completed_steps INTEGER NOT NULL DEFAULT 0,
    failed_steps    INTEGER NOT NULL DEFAULT 0,

    -- 时间戳
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    started_at      TEXT,
    finished_at     TEXT,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- 错误信息
    error_message   TEXT,
    error_code      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user ON pipeline_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON pipeline_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_idempotency ON pipeline_runs(user_id, idempotency_key);

-----------------------------------------------------------
-- 流程步骤表：记录每个执行步骤的状态
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_run_steps (
    id              TEXT PRIMARY KEY NOT NULL,
    run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,

    -- 步骤定义
    step_key        TEXT NOT NULL,           -- outline_generate, script_split, storyboard_render 等
    step_name       TEXT NOT NULL,           -- 显示名称：大纲生成、剧本分节等
    step_order      INTEGER NOT NULL DEFAULT 0,

    -- 绑定的AI任务
    ai_task_id      TEXT,                    -- 关联到 ai_tasks 表

    -- 状态
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped', 'blocked', 'retrying')),

    -- 执行统计
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    max_retries     INTEGER NOT NULL DEFAULT 3,
    duration_ms     INTEGER NOT NULL DEFAULT 0,

    -- 输入输出
    input_summary   TEXT,                    -- JSON: 步骤输入摘要
    output_ref      TEXT,                    -- 输出资源引用ID

    -- 错误信息
    error_message   TEXT,
    last_error_at   TEXT,

    -- 时间戳
    started_at      TEXT,
    completed_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_run ON pipeline_run_steps(run_id, step_order);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_task ON pipeline_run_steps(ai_task_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_status ON pipeline_run_steps(run_id, status);

-----------------------------------------------------------
-- 流程事件表：记录所有状态变更事件（审计线索）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_run_events (
    id              TEXT PRIMARY KEY NOT NULL,
    run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id         TEXT,                    -- 可选，步骤级事件

    -- 事件类型
    event_type      TEXT NOT NULL
                    CHECK (event_type IN (
                        'created', 'started', 'paused', 'resumed', 'cancelled',
                        'step_queued', 'step_started', 'step_completed', 'step_failed', 'step_retry',
                        'completed', 'failed'
                    )),

    -- 事件数据
    payload_json    TEXT,                    -- JSON: 事件附加数据

    -- 来源
    source          TEXT NOT NULL DEFAULT 'system'
                    CHECK (source IN ('system', 'user', 'scheduler', 'api')),

    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_events_run ON pipeline_run_events(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_events_type ON pipeline_run_events(run_id, event_type, created_at DESC);

-----------------------------------------------------------
-- 助理动作审计日志表：记录所有助理动作的完整审计链
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS assistant_action_audits (
    id              TEXT PRIMARY KEY NOT NULL,
    run_id          TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id      TEXT NOT NULL,

    -- 动作内容（快照）
    action_type     TEXT NOT NULL,
    action_payload  TEXT NOT NULL,            -- JSON: 完整动作内容快照

    -- 确认令牌（一次性）
    confirmation_token TEXT UNIQUE,
    confirmation_expires_at TEXT,

    -- 执行结果
    execution_status TEXT NOT NULL DEFAULT 'pending'
                     CHECK (execution_status IN ('pending', 'confirmed', 'executed', 'rejected', 'expired', 'failed')),
    execution_result TEXT,                   -- JSON: 执行结果
    error_message   TEXT,

    -- 操作者信息
    confirmed_by    TEXT,                    -- 确认者用户ID
    confirmed_at    TEXT,
    executed_at     TEXT,

    -- 安全绑定
    envelope_hash   TEXT NOT NULL,           -- 动作内容的哈希值，防篡改

    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_action_audits_user ON assistant_action_audits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_audits_project ON assistant_action_audits(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_audits_run ON assistant_action_audits(run_id);
CREATE INDEX IF NOT EXISTS idx_action_audits_token ON assistant_action_audits(confirmation_token);
CREATE INDEX IF NOT EXISTS idx_action_audits_status ON assistant_action_audits(execution_status, created_at DESC);

-----------------------------------------------------------
-- 助理动作审计事件表：记录确认令牌与审批过程事件
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS assistant_action_audit_events (
    id           TEXT PRIMARY KEY NOT NULL,
    audit_id     TEXT NOT NULL REFERENCES assistant_action_audits(id) ON DELETE CASCADE,
    event_type   TEXT NOT NULL,
    payload_json TEXT,
    source       TEXT NOT NULL DEFAULT 'user',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_action_audit_events_audit ON assistant_action_audit_events(audit_id, created_at DESC);

-----------------------------------------------------------
-- 用户AI策略配置表（细粒度权限控制）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_ai_policies (
    user_id     TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    policy_json TEXT NOT NULL DEFAULT '{}',  -- JSON: AssistantActionPolicy
    expires_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
