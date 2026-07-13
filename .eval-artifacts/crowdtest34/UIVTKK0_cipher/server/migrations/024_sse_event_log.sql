-- Woohoo Studio - SSE event log for cursor-based replay
-- Provides durable event buffer so reconnecting clients can resume without gap
-- Also enables out-of-process restart recovery (buffer replays from DB then falls to resync)

CREATE TABLE IF NOT EXISTS sse_event_log (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    stream      TEXT NOT NULL,              -- 'ai_task' | 'pipeline_run' | 'collaboration'
    stream_key  TEXT NOT NULL,              -- task_id for ai_task, run_id for pipeline, session_id for collab
    event_type  TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}', -- JSON payload
    created_at  INTEGER NOT NULL            -- epoch millis
);

-- Index for fast cursor-based replay per stream
CREATE INDEX IF NOT EXISTS idx_sse_event_log_user_stream
    ON sse_event_log(user_id, stream, seq);

-- Index for cleanup of old events
CREATE INDEX IF NOT EXISTS idx_sse_event_log_created
    ON sse_event_log(created_at);
