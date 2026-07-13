-- Budget control: per-user daily/monthly spending limits and block events
-- Part of the budget-control feature: warn before limit, block high-cost tasks after limit

CREATE TABLE IF NOT EXISTS budget_settings (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL UNIQUE,
    daily_limit     REAL NOT NULL DEFAULT 0,         -- 0 means no daily limit
    monthly_limit   REAL NOT NULL DEFAULT 0,         -- 0 means no monthly limit
    warn_threshold  REAL NOT NULL DEFAULT 0.8,       -- 0.0-1.0, warn when usage ratio >= this
    block_high_cost_only INTEGER NOT NULL DEFAULT 1, -- 1 = only block high-cost tasks when over limit; 0 = block all
    high_cost_threshold REAL NOT NULL DEFAULT 0.5,   -- estimated credits >= this counts as "high cost"
    enabled         INTEGER NOT NULL DEFAULT 1,      -- master switch
    updated_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_budget_settings_user_id ON budget_settings(user_id);

CREATE TABLE IF NOT EXISTS budget_block_events (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL,
    window_type     TEXT NOT NULL,                    -- 'daily' | 'monthly'
    limit_amount    REAL NOT NULL,
    current_spent   REAL NOT NULL,
    estimated_cost  REAL NOT NULL,
    task_type       TEXT NOT NULL,                    -- 'chat' | 'stream' | 'task' | 'image_generation' | 'video_generation'
    reason          TEXT NOT NULL,                    -- human-readable reason
    model           TEXT,
    project_id      TEXT,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_budget_blocks_user_time ON budget_block_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_blocks_user_recent ON budget_block_events(user_id, created_at);
