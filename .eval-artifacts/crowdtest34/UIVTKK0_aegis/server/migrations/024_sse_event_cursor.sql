-- Migration 024: SSE event cursor and replay support
-- Adds a monotonically increasing event_seq column to ai_tasks for stable ordering
-- and creates an event log buffer table for replay after reconnect

-- Add event_seq column to ai_tasks if it doesn't exist
-- This tracks the last seen event sequence number per task for ordering/idempotency
ALTER TABLE ai_tasks ADD COLUMN event_seq INTEGER DEFAULT 0;

-- Create an index on event_seq for efficient cursor-based replay
CREATE INDEX IF NOT EXISTS idx_ai_tasks_event_seq ON ai_tasks(user_id, event_seq);

-- Create ai_task_events table for durable event replay buffer
-- This allows clients to reconnect with a Last-Event-ID and replay missed events
CREATE TABLE IF NOT EXISTS ai_task_events (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    task_json TEXT NOT NULL,
    content_delta TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES ai_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_task_events_user_seq ON ai_task_events(user_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_ai_task_events_task ON ai_task_events(task_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_ai_task_events_created ON ai_task_events(created_at);
