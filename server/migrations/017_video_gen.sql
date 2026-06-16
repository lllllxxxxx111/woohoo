-- 视频生成记录表
CREATE TABLE IF NOT EXISTS video_generations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'wan2.1-t2v-480p',
    duration_seconds REAL,
    aspect_ratio TEXT NOT NULL DEFAULT '16:9',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    result_url TEXT,
    result_b64_json TEXT,
    cost_credits REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_video_generations_user_id ON video_generations(user_id);
CREATE INDEX IF NOT EXISTS idx_video_generations_status ON video_generations(status);
CREATE INDEX IF NOT EXISTS idx_video_generations_project_id ON video_generations(project_id);
