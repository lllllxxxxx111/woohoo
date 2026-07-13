-- Woohoo Studio - Pipeline Prompt Optimizer beta schema
-- Stores optimization suggestions generated after design/review phases.

CREATE TABLE IF NOT EXISTS pipeline_prompt_optimizations (
    id                   TEXT PRIMARY KEY NOT NULL,
    run_id               TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id              TEXT NOT NULL REFERENCES pipeline_run_steps(id) ON DELETE CASCADE,
    project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    decision             TEXT NOT NULL DEFAULT 'suggested',
    design_prompt_patch  TEXT,
    review_prompt_patch  TEXT,
    rationale_json       TEXT,
    source               TEXT NOT NULL DEFAULT 'assistant',
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_prompt_opt_run_step
    ON pipeline_prompt_optimizations(run_id, step_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_prompt_opt_project
    ON pipeline_prompt_optimizations(project_id, created_at DESC);
