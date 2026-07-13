-- Woohoo Studio - 预算管理：用户级日/月预算、超限预警与拦截记录

-- 用户预算配置（一行一用户，全量覆盖）
CREATE TABLE IF NOT EXISTS user_budget_settings (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    -- 日预算（以积分计）。0 或 NULL 表示不设置
    daily_limit         REAL,
    -- 月预算（以积分计）。0 或 NULL 表示不设置
    monthly_limit       REAL,
    -- 预警阈值百分比，达到即向用户发送通知/标记，默认 80
    warning_threshold_pct INTEGER NOT NULL DEFAULT 80,
    -- 超限后的行为：block（拦截高成本任务）| warn_only（仅警告）
    overlimit_action    TEXT NOT NULL DEFAULT 'block',
    -- 是否启用预算检查
    enabled             INTEGER NOT NULL DEFAULT 1,
    -- 最近一次发送的预警窗口标记（避免每次请求都触发通知）
    last_warning_at     TEXT,
    last_warning_kind   TEXT,
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_settings_user ON user_budget_settings(user_id);

-- 预算事件流水：预警与拦截都会落库，便于设置页展示"最近拦截原因"
CREATE TABLE IF NOT EXISTS budget_events (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- warning | blocked
    kind            TEXT NOT NULL,
    -- 命中的预算窗口：daily | monthly
    window          TEXT NOT NULL,
    -- 触发检查时已消耗积分
    spent_amount    REAL NOT NULL,
    -- 命中的预算上限
    limit_amount    REAL,
    -- 本次任务预计消耗的积分（若可估算）
    estimated_cost  REAL,
    -- 触发预算检查的资源类型（image / video / chat / task ...）
    resource_kind   TEXT,
    -- 拦截或预警的原因，人类可读
    reason          TEXT,
    -- 关联 ref（例如 image_generation id）
    ref_type        TEXT,
    ref_id          TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_events_user_created ON budget_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_events_kind ON budget_events(kind);
