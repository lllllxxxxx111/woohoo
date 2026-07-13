-- Woohoo Studio - 完整数据库初始化
-- SQLite WAL 模式，支持高并发读

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-----------------------------------------------------------
-- 用户表
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY NOT NULL,
    username    TEXT NOT NULL UNIQUE,
    email       TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    avatar_url  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-----------------------------------------------------------
-- 项目表
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'draft',   -- draft, active, archived
    phase       TEXT NOT NULL DEFAULT 'ideation', -- ideation, script, storyboard, shooting, post, publish
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects(user_id, updated_at DESC);

-----------------------------------------------------------
-- 对话表（每个项目下多个对话）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY NOT NULL,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '新对话',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(user_id, updated_at DESC);

-----------------------------------------------------------
-- 消息表（对话中的每条消息）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    msg_type        TEXT NOT NULL DEFAULT 'text', -- text, script_gen, storyboard_gen, review_result
    agent_id        TEXT,                          -- 如果是 agent 回复，记录哪个 agent
    model_used      TEXT,                          -- 使用的 AI 模型，如 gpt-4o
    token_usage     TEXT,                          -- JSON: {"prompt": 100, "completion": 200}
    meta            TEXT,                          -- JSON: 扩展字段
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_agent ON messages(agent_id);

-----------------------------------------------------------
-- 用户消息资源快照（用于撤回/编辑重发时回滚项目资源）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_user_message_snapshots (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id      TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    checkpoint_json TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_msg_snapshot_conv
    ON conversation_user_message_snapshots(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_msg_snapshot_message
    ON conversation_user_message_snapshots(message_id);

-----------------------------------------------------------
-- AI 端点配置（用户配置的 AI 服务）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_endpoints (
    id          TEXT PRIMARY KEY NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,                    -- "我的OpenAI", "公司DeepSeek"
    provider    TEXT NOT NULL,                    -- openai, claude, deepseek, ollama, custom
    base_url    TEXT NOT NULL,                    -- https://api.openai.com/v1
    api_key     TEXT NOT NULL,                    -- 加密存储
    default_model TEXT,                           -- gpt-4o
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_ep_user ON ai_endpoints(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_ep_user_active_created ON ai_endpoints(user_id, is_active, created_at);

-----------------------------------------------------------
-- AI 用量事件表（完整 API 调用统计）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage_events (
    id                TEXT PRIMARY KEY NOT NULL,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
    conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    agent_id          TEXT REFERENCES agents(id) ON DELETE SET NULL,
    endpoint_id       TEXT REFERENCES ai_endpoints(id) ON DELETE SET NULL,
    api_key_fingerprint TEXT NOT NULL DEFAULT '',
    provider          TEXT NOT NULL,
    model             TEXT,
    operation         TEXT NOT NULL CHECK (operation IN ('chat', 'stream', 'task', 'test')),
    status            TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    resource_kind     TEXT NOT NULL DEFAULT 'text'
                      CHECK (resource_kind IN ('text', 'image', 'video', 'audio', 'document', 'other')),
    output_items      INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER NOT NULL DEFAULT 0,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    token_source      TEXT NOT NULL DEFAULT 'unavailable'
                      CHECK (token_source IN ('actual', 'estimated', 'unavailable')),
    input_chars       INTEGER NOT NULL DEFAULT 0,
    output_chars      INTEGER NOT NULL DEFAULT 0,
    request_fingerprint TEXT NOT NULL DEFAULT '',
    attempt_group_key TEXT NOT NULL DEFAULT '',
    attempt_index     INTEGER NOT NULL DEFAULT 1,
    is_redo           INTEGER NOT NULL DEFAULT 0,
    trigger_source    TEXT,
    error_message     TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON ai_usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_project_created ON ai_usage_events(user_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_conv_created ON ai_usage_events(user_id, conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_agent_created ON ai_usage_events(user_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_ep_created ON ai_usage_events(user_id, endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_key_created ON ai_usage_events(user_id, api_key_fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_resource_created ON ai_usage_events(user_id, resource_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_model_created ON ai_usage_events(user_id, model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_status_created ON ai_usage_events(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_attempt_group ON ai_usage_events(user_id, attempt_group_key, created_at DESC);

-----------------------------------------------------------
-- 智能体定义（大纲架构师、分镜渲染师等）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY NOT NULL,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,                    -- 大纲架构师
    role          TEXT NOT NULL,                    -- 剧情大纲
    description   TEXT DEFAULT '',
    system_prompt TEXT NOT NULL,                    -- 系统提示词
    endpoint_id   TEXT REFERENCES ai_endpoints(id) ON DELETE SET NULL, -- 绑定的 AI 端点（NULL=用默认）
    model         TEXT,                             -- 绑定的模型（NULL=用端点默认）
    temperature   REAL DEFAULT 0.7,
    max_tokens    INTEGER DEFAULT 4096,
    badge         TEXT DEFAULT '',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_name ON agents(user_id, name);
CREATE INDEX IF NOT EXISTS idx_agents_user_active_name ON agents(user_id, is_active, name);
CREATE INDEX IF NOT EXISTS idx_agents_user_endpoint ON agents(user_id, endpoint_id);

-----------------------------------------------------------
-- 项目智能体绑定（项目级成员/职责，不影响全局智能体定义）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_agent_assignments (
    id                  TEXT PRIMARY KEY NOT NULL,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    responsibility_kind TEXT NOT NULL DEFAULT 'custom'
                        CHECK (responsibility_kind IN ('design', 'review', 'editor', 'manager', 'custom')),
    responsibility_label TEXT NOT NULL DEFAULT '',
    assignment_source   TEXT NOT NULL DEFAULT 'existing'
                        CHECK (assignment_source IN ('seed', 'existing', 'created')),
    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_assignment_unique
    ON project_agent_assignments(project_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_project_agent_assignment_project
    ON project_agent_assignments(user_id, project_id, is_active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_agent_assignment_agent
    ON project_agent_assignments(user_id, agent_id, is_active);

-----------------------------------------------------------
-- 资产表
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
    id          TEXT PRIMARY KEY NOT NULL,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    asset_type  TEXT NOT NULL CHECK (asset_type IN ('image', 'video', 'audio', 'document')),
    url         TEXT NOT NULL,
    metadata    TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);

-----------------------------------------------------------
-- 剧本表（每个项目一份主剧本，可覆盖更新）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS scripts (
    id          TEXT PRIMARY KEY NOT NULL,
    project_id  TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_scripts_project ON scripts(project_id);

-----------------------------------------------------------
-- 分镜表（每个项目一份主分镜）
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS storyboards (
    id          TEXT PRIMARY KEY NOT NULL,
    project_id  TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_storyboards_project ON storyboards(project_id);

CREATE TABLE IF NOT EXISTS storyboard_lines (
    id            TEXT PRIMARY KEY NOT NULL,
    storyboard_id TEXT NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
    scene_number  INTEGER NOT NULL,
    description   TEXT NOT NULL,
    duration      INTEGER NOT NULL DEFAULT 0,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_storyboard_lines_storyboard ON storyboard_lines(storyboard_id);
CREATE INDEX IF NOT EXISTS idx_storyboard_lines_sort ON storyboard_lines(storyboard_id, sort_order, scene_number);

CREATE TABLE IF NOT EXISTS storyboard_line_assets (
    storyboard_line_id TEXT NOT NULL REFERENCES storyboard_lines(id) ON DELETE CASCADE,
    asset_id           TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    PRIMARY KEY (storyboard_line_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_storyboard_line_assets_line ON storyboard_line_assets(storyboard_line_id);
CREATE INDEX IF NOT EXISTS idx_storyboard_line_assets_asset ON storyboard_line_assets(asset_id);

-----------------------------------------------------------
-- 运行时心跳 / 巡检 / 通知骨架
-----------------------------------------------------------
CREATE TABLE IF NOT EXISTS runtime_heartbeats (
    component_key   TEXT PRIMARY KEY NOT NULL,
    component_type  TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('healthy', 'warning', 'critical')),
    summary         TEXT NOT NULL DEFAULT '',
    metrics_json    TEXT,
    last_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_type ON runtime_heartbeats(component_type, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS inspection_findings (
    id               TEXT PRIMARY KEY NOT NULL,
    finding_key      TEXT NOT NULL UNIQUE,
    user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
    category         TEXT NOT NULL,
    severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    status           TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    scope_type       TEXT NOT NULL DEFAULT 'service',
    scope_id         TEXT,
    summary          TEXT NOT NULL,
    details_json     TEXT,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    resolved_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_inspection_findings_status ON inspection_findings(status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspection_findings_user_status ON inspection_findings(user_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS notification_channels (
    id            TEXT PRIMARY KEY NOT NULL,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    channel_type  TEXT NOT NULL CHECK (channel_type IN ('email', 'webhook', 'feishu', 'dingtalk', 'wecom', 'slack', 'telegram', 'other')),
    target        TEXT NOT NULL,
    config_json   TEXT,
    is_enabled    INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_notification_channels_user ON notification_channels(user_id, is_enabled, channel_type);

CREATE TABLE IF NOT EXISTS notification_events (
    id            TEXT PRIMARY KEY NOT NULL,
    user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
    channel_id    TEXT REFERENCES notification_channels(id) ON DELETE SET NULL,
    finding_id    TEXT REFERENCES inspection_findings(id) ON DELETE SET NULL,
    event_type    TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
    dedupe_key    TEXT NOT NULL DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    next_attempt_at TEXT,
    payload_json  TEXT,
    response_body TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_events_user_status ON notification_events(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_status_next_attempt
    ON notification_events(status, next_attempt_at, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedupe
    ON notification_events(dedupe_key) WHERE dedupe_key != '';
