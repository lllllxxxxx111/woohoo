-- Woohoo Studio - Pipeline Manual Reviews schema
-- Stores human review decisions for failed/blocked pipeline steps.
-- Separate from pipeline_run_events because reviews are structured domain entities
-- with reviewer identity, decision, and note that need independent querying
-- (e.g., list reviews per step, count pending items, filter by decision).

CREATE TABLE IF NOT EXISTS pipeline_manual_reviews (
    id         TEXT PRIMARY KEY NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_id     TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id    TEXT NOT NULL REFERENCES pipeline_run_steps(id) ON DELETE CASCADE,
    decision   TEXT NOT NULL CHECK (decision IN ('retry', 'cancel', 'acknowledge')),
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    CHECK (length(trim(decision)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_run_step
    ON pipeline_manual_reviews(run_id, step_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_user
    ON pipeline_manual_reviews(user_id, created_at DESC);
