-- Woohoo Studio - 添加 trigger_source 列到 ai_usage_events 表
-- 用于区分正常发送、编辑后发送、撤回后重新发送，修复重做计数问题

ALTER TABLE ai_usage_events ADD COLUMN trigger_source TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_usage_trigger_source
    ON ai_usage_events(trigger_source);
