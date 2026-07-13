-- AI Endpoint Routing Audit Events
-- Records every routing decision, attempt, fallback, and failure for traceability

CREATE TABLE IF NOT EXISTS ai_routing_events (
    id                  TEXT PRIMARY KEY NOT NULL,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id          TEXT,             -- x-request-id or generated
    task_id             TEXT,             -- ai_tasks.id for async tasks
    run_id              TEXT,             -- pipeline_runs.id for pipeline steps
    step_id             TEXT,             -- pipeline_run_steps.id
    conversation_id     TEXT,             -- conversations.id
    project_id          TEXT,             -- projects.id
    generation_id       TEXT,             -- image_gen/video_gen generation id
    operation           TEXT NOT NULL,    -- chat, stream, task, test, image_generation, video_generation, pipeline_step
    capability          TEXT NOT NULL,    -- chat, image_generation, video_generation, embedding
    candidate_endpoint_id   TEXT,         -- endpoint that was attempted
    candidate_model         TEXT,         -- model that was attempted
    candidate_provider      TEXT,
    final_endpoint_id       TEXT,         -- endpoint that succeeded (if any)
    final_model             TEXT,         -- model that succeeded (if any)
    final_provider          TEXT,
    explicit_endpoint_id    TEXT,         -- if user specified an endpoint explicitly
    requested_model         TEXT,         -- model requested by caller
    status              TEXT NOT NULL CHECK (status IN ('selected', 'attempt', 'success', 'fallback', 'failed', 'exhausted')),
    attempt_index       INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 1,
    error_classification TEXT,            -- network_error, timeout, rate_limited, server_error, auth_error, validation_error, content_safety, capability_mismatch, unknown
    error_message       TEXT,             -- sanitized error message (no keys/tokens)
    http_status         INTEGER,
    latency_ms          INTEGER NOT NULL DEFAULT 0,
    was_fallback        INTEGER NOT NULL DEFAULT 0,
    fallback_reason     TEXT,
    candidates_json     TEXT,             -- JSON array of considered candidates (endpoint_id, model, score, reason)
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_routing_user_created ON ai_routing_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_routing_request ON ai_routing_events(request_id);
CREATE INDEX IF NOT EXISTS idx_ai_routing_task ON ai_routing_events(task_id);
CREATE INDEX IF NOT EXISTS idx_ai_routing_endpoint ON ai_routing_events(candidate_endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_routing_capability ON ai_routing_events(capability, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_routing_status ON ai_routing_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_routing_operation ON ai_routing_events(operation, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_routing_conversation ON ai_routing_events(conversation_id, created_at DESC);
