-- Woohoo Studio - Collaboration session schema
-- 对话驱动多智能体协同编排所需的 4 张表

CREATE TABLE IF NOT EXISTS collaboration_sessions (
    id                      TEXT PRIMARY KEY NOT NULL,
    user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id         TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    entry_message_id        TEXT,
    state                   TEXT NOT NULL DEFAULT 'discovery',
    orchestrator_agent_id   TEXT,
    admission_decision_json TEXT,
    loop_status_json        TEXT,
    reply_queue_json        TEXT,
    round_count             INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_collab_sessions_project ON collaboration_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_conversation ON collaboration_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_state ON collaboration_sessions(state);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_user ON collaboration_sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_assignments (
    id                          TEXT PRIMARY KEY NOT NULL,
    session_id                  TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
    agent_id                    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_type                   TEXT NOT NULL,
    goal                        TEXT NOT NULL,
    input_json                  TEXT,
    depends_on_json             TEXT,
    status                      TEXT NOT NULL DEFAULT 'idle',
    blocking_question_count     INTEGER NOT NULL DEFAULT 0,
    last_question_fingerprint   TEXT,
    ai_task_id                  TEXT,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_collab_assignments_session ON collaboration_assignments(session_id);
CREATE INDEX IF NOT EXISTS idx_collab_assignments_status ON collaboration_assignments(session_id, status);
CREATE INDEX IF NOT EXISTS idx_collab_assignments_agent ON collaboration_assignments(agent_id);

CREATE TABLE IF NOT EXISTS collaboration_messages (
    id                      TEXT PRIMARY KEY NOT NULL,
    session_id              TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
    source_agent_id         TEXT,
    target_agent_id         TEXT,
    message_kind            TEXT NOT NULL,
    content                 TEXT NOT NULL,
    question_fingerprint    TEXT,
    reply_to_message_id     TEXT,
    queue_order             INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_collab_messages_session ON collaboration_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_collab_messages_kind ON collaboration_messages(message_kind);
CREATE INDEX IF NOT EXISTS idx_collab_messages_source ON collaboration_messages(source_agent_id);

CREATE TABLE IF NOT EXISTS collaboration_events (
    id              TEXT PRIMARY KEY NOT NULL,
    session_id      TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    payload_json    TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_collab_events_session ON collaboration_events(session_id);
CREATE INDEX IF NOT EXISTS idx_collab_events_type ON collaboration_events(event_type);
