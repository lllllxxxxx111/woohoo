-- Woohoo Studio - AI task persistence schema
-- Moves ai_tasks creation from runtime ensure_* into a versioned SQL migration.

CREATE TABLE IF NOT EXISTS ai_tasks (
    id                TEXT PRIMARY KEY NOT NULL,
    user_id           TEXT NOT NULL,
    content           TEXT NOT NULL DEFAULT '',
    agent_id          TEXT,
    output_kind       TEXT DEFAULT 'text',
    status            TEXT NOT NULL DEFAULT 'queued',
    model             TEXT,
    error             TEXT,
    result            TEXT,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    started_at        INTEGER,
    finished_at       INTEGER,
    attempt_index     INTEGER NOT NULL DEFAULT 0,
    is_redo           INTEGER NOT NULL DEFAULT 0,
    previous_failures INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    token_usage       TEXT,
    active_tasks      INTEGER DEFAULT 0,
    queued_tasks      INTEGER DEFAULT 0,
    project_id        TEXT,
    conversation_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_tasks_user_id ON ai_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks(status);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_project_id ON ai_tasks(project_id);
