-- 导出审计记录表
-- 记录每次导出的完整元信息，用于团队追踪交付历史

CREATE TABLE IF NOT EXISTS export_audits (
    id TEXT PRIMARY KEY,              -- UUID
    project_id TEXT NOT NULL,         -- 所属项目
    user_id TEXT NOT NULL,            -- 导出者
    export_type TEXT NOT NULL,        -- 'full' | 'core' | 'snapshot'
    export_format TEXT NOT NULL,      -- 'tar' | 'tar.gz' | 'md' | 'json'
    package_name TEXT NOT NULL,       -- 导出包文件名
    package_size_bytes INTEGER,       -- 导出包大小
    package_sha256 TEXT,              -- 导出包整体校验和

    -- 统计信息
    total_assets INTEGER NOT NULL DEFAULT 0,
    included_assets INTEGER NOT NULL DEFAULT 0,
    missing_assets INTEGER NOT NULL DEFAULT 0,
    corrupted_assets INTEGER NOT NULL DEFAULT 0,
    total_size_bytes INTEGER NOT NULL DEFAULT 0,

    -- 项目快照版本信息（用于复现）
    project_name TEXT NOT NULL,
    project_phase TEXT,
    script_version TEXT,              -- script.id + updatedAt
    storyboard_version TEXT,          -- storyboard.id + updatedAt
    keyframe_count INTEGER NOT NULL DEFAULT 0,
    shot_count INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,

    -- 验证结果摘要
    verification_passed INTEGER NOT NULL DEFAULT 1,  -- 布尔值 0/1
    warnings_json TEXT,               -- 警告列表JSON
    sensitive_findings_json TEXT,     -- 敏感信息检测结果JSON

    -- 生成参数摘要（用于复现AI生成结果）
    generation_params_json TEXT,      -- 模型、参数等摘要JSON

    -- 时间戳
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    expires_at TEXT,                  -- 临时导出包过期时间

    -- 元数据
    notes TEXT,                       -- 用户备注
    client_info TEXT,                 -- 客户端信息（浏览器/版本）
    ip_address TEXT,                  -- 请求IP（可选记录）

    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 索引：按项目查询导出历史
CREATE INDEX IF NOT EXISTS idx_export_audits_project ON export_audits(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_audits_user ON export_audits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_audits_created ON export_audits(created_at DESC);

-- 导出资产明细表（记录每个导出包中包含了哪些资产及其校验状态）
CREATE TABLE IF NOT EXISTS export_audit_assets (
    id TEXT PRIMARY KEY,              -- UUID
    export_audit_id TEXT NOT NULL,    -- 关联导出记录
    asset_id TEXT NOT NULL,           -- 资产ID
    asset_name TEXT NOT NULL,
    asset_type TEXT NOT NULL,         -- image/video/audio/document
    asset_url TEXT,
    asset_version_label TEXT,

    -- 在导出包中的路径
    packaged_path TEXT NOT NULL,
    packaged_size_bytes INTEGER,
    sha256 TEXT,                      -- 文件内容校验和

    -- 状态
    status TEXT NOT NULL,             -- 'included' | 'missing' | 'corrupted' | 'external'
    error_reason TEXT,                -- 缺失/损坏原因
    metadata_json TEXT,               -- 资产元数据快照

    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    FOREIGN KEY (export_audit_id) REFERENCES export_audits(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_export_audit_assets_audit ON export_audit_assets(export_audit_id);
CREATE INDEX IF NOT EXISTS idx_export_audit_assets_asset ON export_audit_assets(asset_id);
