CREATE TABLE IF NOT EXISTS ai_endpoint_capabilities (
    id                 TEXT PRIMARY KEY NOT NULL,
    endpoint_id        TEXT NOT NULL REFERENCES ai_endpoints(id) ON DELETE CASCADE,
    capability         TEXT NOT NULL,
    model              TEXT,
    path_override      TEXT,
    request_adapter    TEXT NOT NULL DEFAULT 'openai_compatible',
    response_adapter   TEXT NOT NULL DEFAULT 'openai_compatible',
    supports_stream    INTEGER NOT NULL DEFAULT 0,
    supports_tools     INTEGER NOT NULL DEFAULT 0,
    supports_files     INTEGER NOT NULL DEFAULT 0,
    enabled            INTEGER NOT NULL DEFAULT 1,
    priority           INTEGER NOT NULL DEFAULT 100,
    config_json        TEXT,
    max_context_tokens INTEGER,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(endpoint_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_ai_endpoint_cap_user_capability
    ON ai_endpoint_capabilities(endpoint_id, capability, enabled, priority);
