-- 024: 补充导出审计字段
-- manifest 自身校验和、完成时间、脱敏计数、状态字段
ALTER TABLE export_audits ADD COLUMN IF NOT EXISTS manifest_sha256 TEXT;
ALTER TABLE export_audits ADD COLUMN IF NOT EXISTS completed_at TEXT;
ALTER TABLE export_audits ADD COLUMN IF NOT EXISTS sanitization_findings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE export_audits ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';  -- 'completed' | 'failed' | 'partial'
ALTER TABLE export_audits ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE export_audits ADD COLUMN IF NOT EXISTS manifest_path TEXT;  -- manifest在包内路径（固定manifest.json）
ALTER TABLE export_audits ADD COLUMN IF NOT EXISTS duration_ms INTEGER;  -- 导出耗时
