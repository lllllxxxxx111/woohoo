-- Budget management schema
-- 020_budget.sql

-- 用户预算设置表：每个用户可配置日/月预算额度（以积分为单位）
CREATE TABLE IF NOT EXISTS user_budget_settings (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL UNIQUE,
    daily_limit     REAL,                    -- 日预算额度（积分），NULL 表示不限制
    monthly_limit   REAL,                    -- 月预算额度（积分），NULL 表示不限制
    warning_threshold REAL NOT NULL DEFAULT 0.8,  -- 预警阈值比例，默认 80%
    block_high_cost_over_budget INTEGER NOT NULL DEFAULT 1, -- 超预算后是否拦截高成本任务
    enabled         INTEGER NOT NULL DEFAULT 1, -- 是否启用预算控制
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_settings_user ON user_budget_settings(user_id);

-- 预算拦截事件表：记录因预算超限而被拦截的 AI 任务
CREATE TABLE IF NOT EXISTS budget_block_events (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL,
    period_type     TEXT NOT NULL,           -- 'daily' | 'monthly'
    period_key      TEXT NOT NULL,           -- e.g. '2025-01-15' or '2025-01'
    limit_amount    REAL NOT NULL,
    current_spent   REAL NOT NULL,
    estimated_cost  REAL NOT NULL,           -- 本次预估消耗
    blocked_operation TEXT NOT NULL,         -- 'chat' | 'stream' | 'task' | 'image' | 'video'
    blocked_resource_kind TEXT,              -- 'text' | 'image' | 'video' | 'audio' | 'document'
    reason          TEXT NOT NULL,           -- human-readable reason
    model           TEXT,
    endpoint_id     TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_blocks_user_time ON budget_block_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_blocks_period ON budget_block_events(user_id, period_type, period_key);
