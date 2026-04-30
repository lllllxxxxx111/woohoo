-- Woohoo Studio - Pipeline Orchestrator M1 schema extension
-- This migration is intentionally idempotent (CREATE IF NOT EXISTS only).
-- Existing databases are backfilled in the versioned runner step 005_pipeline_schema_backfills.

-----------------------------------------------------------
-- 流程步骤输出表：持久化结构化产物与审核结论
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_step_outputs (
    id                 TEXT PRIMARY KEY NOT NULL,
    run_id             TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id            TEXT NOT NULL REFERENCES pipeline_run_steps(id) ON DELETE CASCADE,
    task_id            TEXT,
    output_type        TEXT NOT NULL DEFAULT 'json',
    output_json        TEXT,
    raw_content        TEXT,
    review_decision    TEXT,
    review_score       REAL,
    review_issues_json TEXT,
    retry_hints_json   TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_step_outputs_run_step
    ON pipeline_step_outputs(run_id, step_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_outputs_task
    ON pipeline_step_outputs(task_id);
