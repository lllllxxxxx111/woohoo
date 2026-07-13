-- Woohoo Studio - Asset Governance: cross-project search, tags, references, safe delete
-- Adds indexes and helper constructs for asset governance features.
-- Tags are stored in assets.metadata JSON field (key "tags"), consistent with existing
-- metadata approach (prompt, favorite, rating, review, sizeBytes all live in metadata).

-- Index for asset name search (case-insensitive via LIKE in queries)
CREATE INDEX IF NOT EXISTS idx_assets_project_type ON assets(project_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);

-- Ensure pipeline_step_outputs index for reference lookups
CREATE INDEX IF NOT EXISTS idx_pipeline_step_outputs_task ON pipeline_step_outputs(task_id);
