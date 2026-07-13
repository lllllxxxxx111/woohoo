-- Pipeline manual review records
-- Stores human review decisions for failed/blocked pipeline steps.
-- Separate from pipeline_run_events (which is an append-only event log for SSE streaming)
-- because review records need structured queryability (reviewer, decision, note, FKs)
-- while still emitting a manual_review event for audit/SSE.

CREATE TABLE IF NOT EXISTS pipeline_manual_reviews (
    id          TEXT PRIMARY KEY NOT NULL,
    user_id     TEXT NOT NULL,
    run_id      TEXT NOT NULL,
    step_id     TEXT NOT NULL,
    decision    TEXT NOT NULL CHECK (decision IN ('retry', 'cancel', 'acknowledge')),
    note        TEXT,
    created_at  TEXT NOT NULL,

    FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (step_id) REFERENCES pipeline_run_steps(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_run_id
    ON pipeline_manual_reviews(run_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_step_id
    ON pipeline_manual_reviews(step_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_user_id
    ON pipeline_manual_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_created_at
    ON pipeline_manual_reviews(created_at DESC);
