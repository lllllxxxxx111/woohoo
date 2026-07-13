-- Asset governance support: cross-project search, tags, references, safe delete.
-- Tags and review metadata stay in assets.metadata JSON to match the existing schema.

CREATE INDEX IF NOT EXISTS idx_assets_project_type ON assets(project_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_step_outputs_task ON pipeline_step_outputs(task_id);
