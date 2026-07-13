-- Woohoo Studio - Pipeline Manual Review
-- 持久化人工复核记录：每次用户在“人工复核工作台”对失败/阻塞步骤做出的判断
-- 与 pipeline_run_events 互补：events 用于状态变更审计，本表用于结构化的复核留痕，便于后续按 decision/reviewer 查询和聚合。

CREATE TABLE IF NOT EXISTS pipeline_manual_reviews (
    id              TEXT PRIMARY KEY NOT NULL,
    run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id         TEXT NOT NULL REFERENCES pipeline_run_steps(id) ON DELETE CASCADE,
    reviewer_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 决策类型：retry / cancel / acknowledge
    -- 不提供 skip：当前 pipeline 状态机仅在“依赖失败”时由 orchestrator 自动标记 skipped，
    -- 人工跳过会破坏依赖完整性，避免制造假功能。
    decision        TEXT NOT NULL
                    CHECK (decision IN ('retry', 'cancel', 'acknowledge')),

    -- 复核备注/结论（自由文本）
    note            TEXT,

    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_run_step
    ON pipeline_manual_reviews(run_id, step_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_reviewer
    ON pipeline_manual_reviews(reviewer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_manual_reviews_decision
    ON pipeline_manual_reviews(decision, created_at DESC);
