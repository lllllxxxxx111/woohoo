-- Woohoo Studio - link collaboration sessions to admitted pipeline runs

ALTER TABLE collaboration_sessions ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_collab_sessions_pipeline_run
    ON collaboration_sessions(pipeline_run_id);
