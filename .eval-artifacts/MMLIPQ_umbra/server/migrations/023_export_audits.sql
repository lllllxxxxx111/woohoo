-- 导出审计表：记录每次导出包的完整元数据，支持交付追踪和复现
CREATE TABLE IF NOT EXISTS export_audits (
    id TEXT PRIMARY KEY,                              -- UUID v4
    project_id TEXT NOT NULL,                         -- 关联项目
    user_id TEXT NOT NULL,                            -- 执行导出的用户
    export_type TEXT NOT NULL,                        -- 'full' | 'core' | 'final_cut'
    export_version TEXT NOT NULL DEFAULT '1.0',       -- 导出格式版本，用于兼容性
    filename TEXT NOT NULL,                           -- 存储文件名（不含路径）
    file_path TEXT NOT NULL,                          -- 相对 exports_dir 的路径
    file_size INTEGER NOT NULL DEFAULT 0,             -- 文件大小（字节）
    file_sha256 TEXT,                                 -- 归档文件 SHA-256
    manifest_sha256 TEXT,                             -- manifest.json 内容 SHA-256（仅需审计记录即可校验清单完整性）
    asset_total INTEGER NOT NULL DEFAULT 0,           -- 项目总资产数
    asset_included INTEGER NOT NULL DEFAULT 0,        -- 成功打包进包的资产数
    asset_missing INTEGER NOT NULL DEFAULT 0,         -- 缺失（磁盘无文件或下载失败）数
    missing_asset_ids TEXT NOT NULL DEFAULT '[]',     -- JSON 数组：缺失资产 ID 及原因
    manifest_json TEXT NOT NULL DEFAULT '{}',         -- 完整 manifest 快照（JSON）
    checksums_json TEXT NOT NULL DEFAULT '{}',        -- 每个资产文件的 SHA-256 映射
    project_snapshot_json TEXT NOT NULL DEFAULT '{}', -- 导出时工作区快照（JSON）
    generation_params_json TEXT NOT NULL DEFAULT '{}',-- 生成参数摘要（模型、prompt 等）
    verification_report_json TEXT NOT NULL DEFAULT '{}', -- 自动完整性校验报告
    status TEXT NOT NULL DEFAULT 'completed',         -- 'completed' | 'partial' | 'failed'
    error_message TEXT,
    created_at TEXT NOT NULL,                         -- RFC3339
    expires_at TEXT,                                  -- 可选：过期清理时间
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_export_audits_project ON export_audits(project_id);
CREATE INDEX IF NOT EXISTS idx_export_audits_user ON export_audits(user_id);
CREATE INDEX IF NOT EXISTS idx_export_audits_created ON export_audits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_audits_status ON export_audits(status);
