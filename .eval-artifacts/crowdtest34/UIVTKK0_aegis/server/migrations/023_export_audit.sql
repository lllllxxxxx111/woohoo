-- Woohoo Studio - Export audit trail
-- Records every export action for compliance and team delivery tracking

CREATE TABLE IF NOT EXISTS export_audits (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    export_type     TEXT NOT NULL DEFAULT 'full',  -- full | core | final_cut
    bundle_version  TEXT NOT NULL DEFAULT '1.0',
    status          TEXT NOT NULL DEFAULT 'completed', -- completed | partial | failed
    filename        TEXT NOT NULL DEFAULT '',

    -- Counts
    total_assets    INTEGER NOT NULL DEFAULT 0,
    included_assets INTEGER NOT NULL DEFAULT 0,
    missing_assets  INTEGER NOT NULL DEFAULT 0,
    script_sections INTEGER NOT NULL DEFAULT 0,
    chapters        INTEGER NOT NULL DEFAULT 0,
    shots           INTEGER NOT NULL DEFAULT 0,
    conversations   INTEGER NOT NULL DEFAULT 0,
    total_duration  INTEGER NOT NULL DEFAULT 0,
    bundle_size_bytes INTEGER NOT NULL DEFAULT 0,

    -- Verification
    precheck_passed  INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1
    checksums_valid  INTEGER NOT NULL DEFAULT 0,
    has_sensitive_data INTEGER NOT NULL DEFAULT 0,

    -- Snapshot fingerprints (for reproducibility)
    script_sha256    TEXT,
    storyboard_sha256 TEXT,
    manifest_sha256  TEXT,

    -- Client / environment
    client_info      TEXT,    -- JSON: { userAgent, platform }
    error_message    TEXT,
    notes            TEXT,

    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_export_audits_project ON export_audits(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_audits_user ON export_audits(user_id, created_at DESC);
