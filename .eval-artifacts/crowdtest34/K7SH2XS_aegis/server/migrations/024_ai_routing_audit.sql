-- 024: AI endpoint routing audit + max_context_tokens capability column

-- Add max_context_tokens to ai_endpoint_capabilities for new installs
-- (For existing databases this is added via Rust backfill migration)
-- ALTER TABLE is done in the Rust backfill for safety across versions.

-- ai_routing_events: persistent audit trail for endpoint routing decisions,
-- attempts, fallbacks, and failures across chat / stream / task / pipeline / image / video
CREATE TABLE IF NOT EXISTS ai_routing_events (
    id                  TEXT PRIMARY KEY NOT NULL,
    user_id             TEXT NOT NULL,
    request_id          TEXT,
    task_id             TEXT,
    pipeline_run_id     TEXT,
    pipeline_step_id    TEXT,
    conversation_id     TEXT,
    project_id          TEXT,
    agent_id            TEXT,
    operation           TEXT NOT NULL,
    capability          TEXT NOT NULL,

    requested_endpoint_id TEXT,
    requested_model       TEXT,
    requires_stream       INTEGER NOT NULL DEFAULT 0,
    requires_tools        INTEGER NOT NULL DEFAULT 0,
    min_context_tokens    INTEGER,

    candidate_endpoint_id TEXT,
    candidate_model       TEXT,
    candidate_priority    INTEGER,
    candidate_index       INTEGER NOT NULL DEFAULT 0,

    final_endpoint_id     TEXT,
    final_model           TEXT,
    status                TEXT NOT NULL,
    error_classification  TEXT,
    error_message         TEXT,
    fallback_from_index   INTEGER,
    attempt_count         INTEGER NOT NULL DEFAULT 1,
    max_attempts          INTEGER NOT NULL DEFAULT 3,

    latency_ms            INTEGER,
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_routing_user_created
    ON ai_routing_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_routing_endpoint
    ON ai_routing_events(candidate_endpoint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_routing_capability_status
    ON ai_routing_events(capability, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_routing_request
    ON ai_routing_events(request_id);

CREATE INDEX IF NOT EXISTS idx_ai_routing_task
    ON ai_routing_events(task_id);

CREATE INDEX IF NOT EXISTS idx_ai_routing_pipeline
    ON ai_routing_events(pipeline_run_id);
