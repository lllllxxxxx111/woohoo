-- Woohoo Studio - link collaboration sessions to admitted pipeline runs
-- Uses safe pattern: only add column if it doesn't exist (handled by migration runner)

-- Note: SQLite doesn't support IF NOT EXISTS for ADD COLUMN, so we rely on the
-- migration runner to skip already-applied migrations via schema_migrations table.
-- If this migration fails due to duplicate column, it means the column already exists
-- from a previous backfill, and the migration can be marked as applied manually.

ALTER TABLE collaboration_sessions ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_collab_sessions_pipeline_run
    ON collaboration_sessions(pipeline_run_id);
