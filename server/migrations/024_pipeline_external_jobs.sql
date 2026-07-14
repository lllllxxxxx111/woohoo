-- 024: pipeline 步骤外部任务关联表
-- 用于把 pipeline 步骤关联到 image_generations / video_generations 等外部异步任务
-- 让 orchestrator 能在 handle_running_step 中查询外部任务状态并消费产出
CREATE TABLE IF NOT EXISTS pipeline_step_external_jobs (
    id            TEXT PRIMARY KEY NOT NULL,
    run_id        TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id       TEXT NOT NULL REFERENCES pipeline_run_steps(id) ON DELETE CASCADE,
    job_kind      TEXT NOT NULL,                 -- 'image' | 'video'
    job_id        TEXT NOT NULL,                 -- image_generations.id / video_generations.id
    status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | failed
    error_message TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    CHECK (length(trim(job_kind)) > 0),
    CHECK (length(trim(job_id)) > 0),
    CHECK (status IN ('queued', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_step_external_jobs_run_step
    ON pipeline_step_external_jobs(run_id, step_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_step_external_jobs_unique
    ON pipeline_step_external_jobs(run_id, step_id, job_kind);
