-- Export audit log table for tracking all export operations
CREATE TABLE IF NOT EXISTS export_audits (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    export_type     TEXT NOT NULL,         -- 'full' | 'core' | 'final_cut' | 'snapshot'
    package_format  TEXT NOT NULL DEFAULT 'tar', -- 'tar' | 'zip' | 'md' | 'json'
    export_version  TEXT NOT NULL DEFAULT '1.0',  -- manifest schema version
    status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'partial' | 'failed'
    manifest_json   TEXT,                  -- full manifest JSON
    verification_json TEXT,               -- verification report JSON
    total_assets    INTEGER NOT NULL DEFAULT 0,
    included_assets INTEGER NOT NULL DEFAULT 0,
    missing_assets  INTEGER NOT NULL DEFAULT 0,
    total_size_bytes INTEGER NOT NULL DEFAULT 0,
    filename        TEXT,
    error_message   TEXT,
    client_info     TEXT,                  -- JSON with user-agent, etc.
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_export_audits_project ON export_audits(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_audits_user ON export_audits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_audits_status ON export_audits(status);
