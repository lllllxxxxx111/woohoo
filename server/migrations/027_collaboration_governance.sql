-- Woohoo Studio - 协同会话治理增强
-- 为协同会话/任务卡/消息增加 halt 追踪、恢复审计、语义指纹和循环治理字段
-- 兼容旧数据：所有新增列均有默认值，旧库升级无需回填

-- 1. collaboration_sessions: halt 追踪 + 恢复审计 + 可配置轮次上限
ALTER TABLE collaboration_sessions ADD COLUMN halt_reason TEXT;
ALTER TABLE collaboration_sessions ADD COLUMN halted_by TEXT;
ALTER TABLE collaboration_sessions ADD COLUMN halted_at TEXT;
ALTER TABLE collaboration_sessions ADD COLUMN recovery_audited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collaboration_sessions ADD COLUMN recovery_action TEXT;
ALTER TABLE collaboration_sessions ADD COLUMN recovery_operator_user_id TEXT;
ALTER TABLE collaboration_sessions ADD COLUMN recovery_note TEXT;
ALTER TABLE collaboration_sessions ADD COLUMN max_round_limit INTEGER NOT NULL DEFAULT 20;

-- 2. collaboration_assignments: 失败原因 + 语义指纹
ALTER TABLE collaboration_assignments ADD COLUMN failure_reason TEXT;
ALTER TABLE collaboration_assignments ADD COLUMN semantic_fingerprint TEXT;

-- 3. collaboration_messages: 语义哈希（归一化文本的 hash，用于近似检测）
ALTER TABLE collaboration_messages ADD COLUMN semantic_hash TEXT;

-- 索引：按 halt 状态和恢复审计状态查询
CREATE INDEX IF NOT EXISTS idx_collab_sessions_halt
    ON collaboration_sessions(state, recovery_audited)
    WHERE state = 'halted';

CREATE INDEX IF NOT EXISTS idx_collab_messages_semantic
    ON collaboration_messages(session_id, semantic_hash)
    WHERE semantic_hash IS NOT NULL;
