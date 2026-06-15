-- Woohoo Image Studio - 图片生成与计费相关表

-- 图片生成记录
CREATE TABLE IF NOT EXISTS image_generations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
    prompt          TEXT NOT NULL,
    model           TEXT NOT NULL DEFAULT 'dall-e-3',
    size            TEXT NOT NULL DEFAULT '1024x1024',
    n               INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'pending',
    error_message   TEXT,
    result_urls     TEXT,
    result_b64_json TEXT,
    asset_ids       TEXT,
    revised_prompt  TEXT,
    cost_credits   REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    completed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_image_gen_user ON image_generations(user_id);
CREATE INDEX IF NOT EXISTS idx_image_gen_project ON image_generations(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_gen_status ON image_generations(status);
CREATE INDEX IF NOT EXISTS idx_image_gen_created ON image_generations(created_at DESC);

-- 用户积分余额
CREATE TABLE IF NOT EXISTS user_credits (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance         REAL NOT NULL DEFAULT 100,
    total_earned    REAL NOT NULL DEFAULT 0,
    total_spent     REAL NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 积分变动流水
CREATE TABLE IF NOT EXISTS credit_transactions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount          REAL NOT NULL,
    balance_after   REAL NOT NULL,
    kind            TEXT NOT NULL,
    reason           TEXT,
    ref_type        TEXT,
    ref_id          TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_credit_txn_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_txn_created ON credit_transactions(created_at DESC);
