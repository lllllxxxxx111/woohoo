-- 031: 大文件分片上传会话 + 物理文件内容寻址去重
--
-- 设计要点：
-- 1. upload_sessions 持久化分片上传会话，绑定 user + project，配额预留以
--    active 状态（initiated/uploading）的会话为准计算。
-- 2. upload_session_parts 记录已接收分片，(session_id, part_number) 唯一，
--    重复上传同一分片幂等。
-- 3. asset_blobs 是“逻辑资产 -> 物理文件”的引用计数表：同一用户相同
--    SHA-256 内容只保存一份物理文件，多个 assets 行共享，删除时按引用
--    计数释放，避免一个用户删除资产破坏另一个资产。
-- 4. 本 migration 只建新表，不改动 assets 既有结构，旧库可直接应用。

CREATE TABLE IF NOT EXISTS upload_sessions (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    filename        TEXT NOT NULL,
    file_size       INTEGER NOT NULL CHECK (file_size > 0),
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),
    total_chunks    INTEGER NOT NULL CHECK (total_chunks > 0),
    file_sha256     TEXT NOT NULL DEFAULT '',
    client_token    TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'initiated'
                    CHECK (status IN ('initiated','uploading','completed','aborted','expired','failed')),
    bytes_received  INTEGER NOT NULL DEFAULT 0,
    asset_id        TEXT,
    last_error      TEXT NOT NULL DEFAULT '',
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_status
    ON upload_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_project
    ON upload_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires
    ON upload_sessions(status, expires_at);
-- 幂等初始化：同一 client_token 的重复 init 直接复用会话
CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_sessions_client_token
    ON upload_sessions(user_id, project_id, client_token)
    WHERE client_token <> '' AND status IN ('initiated', 'uploading');

CREATE TABLE IF NOT EXISTS upload_session_parts (
    session_id   TEXT NOT NULL,
    part_number  INTEGER NOT NULL CHECK (part_number >= 1),
    size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256       TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (session_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_upload_session_parts_session
    ON upload_session_parts(session_id);

-- 物理文件引用计数：按 (内容哈希, 用户) 去重，绝不跨用户共享物理文件，
-- 避免通过任何响应向其他用户泄露“某文件已存在”。
CREATE TABLE IF NOT EXISTS asset_blobs (
    sha256          TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    ref_count       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (sha256, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_blobs_filename
    ON asset_blobs(stored_filename);
