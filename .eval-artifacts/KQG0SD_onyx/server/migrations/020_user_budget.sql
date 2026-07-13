-- 用户预算配置表
-- 每个用户一份预算配置，支持日/月预算、预警比例、启用开关

CREATE TABLE IF NOT EXISTS user_budget_configs (
    id                  TEXT PRIMARY KEY NOT NULL,
    user_id             TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    daily_credit_limit  REAL,                     -- 日预算积分，NULL 表示无限制
    monthly_credit_limit REAL,                    -- 月预算积分，NULL 表示无限制
    warn_ratio          REAL NOT NULL DEFAULT 0.8, -- 预警比例，0-1 之间
    is_enabled          INTEGER NOT NULL DEFAULT 1, -- 是否启用预算控制
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_budget_configs_user ON user_budget_configs(user_id);

-- 预算拦截记录表（可选，用于审计和最近拦截原因展示）
CREATE TABLE IF NOT EXISTS budget_blocks (
    id                  TEXT PRIMARY KEY NOT NULL,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation           TEXT NOT NULL CHECK (operation IN ('chat', 'stream', 'task', 'test')),
    reason              TEXT NOT NULL,              -- daily_exceeded, monthly_exceeded
    current_usage       REAL NOT NULL,              -- 当前消耗积分
    limit_value         REAL NOT NULL,              -- 预算上限积分
    request_details     TEXT,                       -- JSON 格式的请求详情（可选）
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_blocks_user_created ON budget_blocks(user_id, created_at DESC);
