-- Budget controls for per-user spend windows and block audit history.

CREATE TABLE IF NOT EXISTS budget_settings (
    id                     TEXT PRIMARY KEY NOT NULL,
    user_id                TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    daily_limit            REAL,
    monthly_limit          REAL,
    warning_threshold      REAL NOT NULL DEFAULT 0.8,
    block_high_cost_only   INTEGER NOT NULL DEFAULT 1,
    high_cost_threshold    REAL NOT NULL DEFAULT 0.5,
    enabled                INTEGER NOT NULL DEFAULT 0,
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    CHECK (daily_limit IS NULL OR daily_limit > 0),
    CHECK (monthly_limit IS NULL OR monthly_limit > 0),
    CHECK (warning_threshold >= 0.5 AND warning_threshold <= 1.0),
    CHECK (high_cost_threshold > 0)
);

CREATE TABLE IF NOT EXISTS budget_block_events (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    window_type     TEXT NOT NULL CHECK (window_type IN ('daily', 'monthly')),
    limit_amount    REAL NOT NULL,
    spent_amount    REAL NOT NULL,
    estimated_cost  REAL NOT NULL,
    task_type       TEXT NOT NULL,
    reason          TEXT NOT NULL,
    model           TEXT,
    project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_settings_user
    ON budget_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_budget_block_events_user
    ON budget_block_events(user_id, created_at DESC);
