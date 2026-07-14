-- Woohoo Studio - Pipeline Prompt 优化建议版本化、应用记录与回滚
--
-- 目标：为每条优化建议建立稳定版本和应用记录，关联 projectId/runId/stepId、
-- 原 prompt、优化后 prompt、策略、操作者、时间和 request_id，并支持回滚与效果对比。
--
-- 兼容策略（req #8）：
--   * 仅对 pipeline_prompt_optimizations 增列，不删不改既有列，旧读路径不受影响。
--   * 新表 pipeline_prompt_auto_apply_config 独立存放自动应用开关。
--   * 旧库升级：既有行 version=0、decision 保持 'suggested'，step_key 由 step_id 反查回填。
--   * 新库初始化：migration 004 建表后本迁移补列，可直接执行。

-- 1) 扩展优化建议表：版本、操作者、应用/回滚审计、原/优化 prompt 快照、step_key
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN step_key TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN strategy TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN operator_user_id TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN applied_at TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN applied_request_id TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN original_prompt TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN optimized_prompt TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN previous_version_id TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN rolled_back_at TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN rolled_back_by TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN rolled_back_reason TEXT;
ALTER TABLE pipeline_prompt_optimizations ADD COLUMN rollback_request_id TEXT;

-- 2) 回填 step_key（由 step_id 反查 pipeline_run_steps.step_key）
UPDATE pipeline_prompt_optimizations
SET step_key = (
    SELECT s.step_key FROM pipeline_run_steps s WHERE s.id = pipeline_prompt_optimizations.step_id
)
WHERE step_key IS NULL;

-- 3) 按 (project_id, step_key, created_at) 建索引，支撑"查询当前项目某步骤最新已应用版本"
CREATE INDEX IF NOT EXISTS idx_pipeline_prompt_opt_project_step
    ON pipeline_prompt_optimizations(project_id, step_key, decision, created_at DESC);

-- 4) 自动应用开关表（项目级或步骤级，默认关闭）
CREATE TABLE IF NOT EXISTS pipeline_prompt_auto_apply_config (
    id                  TEXT PRIMARY KEY NOT NULL,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_key            TEXT,
    enabled             INTEGER NOT NULL DEFAULT 0,
    risk_acknowledged   INTEGER NOT NULL DEFAULT 0,
    operator_user_id    TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 项目级开关（step_key IS NULL）每项目至多一条；步骤级开关每 (项目, step_key) 至多一条
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_prompt_auto_apply_project_step
    ON pipeline_prompt_auto_apply_config(project_id, step_key);
