------------------------------------------------------------
-- 内容版本历史（剧本 / 分镜）
--
-- 设计目标：
--   1. 以不可变快照方式持久化剧本与分镜的每一次有效内容。
--   2. 为并发写入提供乐观锁基础（version 单调递增 + content_hash 去重）。
--   3. 兼容旧库：老数据由 Rust backfill 生成基线版本（source='baseline'）。
--
-- 说明：
--   - 每个 (project_id, content_type) 组合下 version 单调递增，从 1 开始。
--   - content 为完整快照：剧本是纯文本，分镜是结构化 JSON（lines 数组）。
--   - content_hash 用于相同内容去重（重复保存不新增版本）。
--   - source 标记来源：manual / ai / pipeline / restore / baseline 等。
--   - 历史版本永不删除、永不改写；“恢复”总是追加一个新版本。
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_versions (
    id           TEXT PRIMARY KEY NOT NULL,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL CHECK (content_type IN ('script', 'storyboard')),
    version      INTEGER NOT NULL,
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'manual',
    created_by   TEXT,
    note         TEXT,
    title        TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (project_id, content_type, version)
);

CREATE INDEX IF NOT EXISTS idx_content_versions_lookup
    ON content_versions (project_id, content_type, version DESC);

CREATE INDEX IF NOT EXISTS idx_content_versions_project_type_created
    ON content_versions (project_id, content_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_versions_hash
    ON content_versions (project_id, content_type, content_hash);
