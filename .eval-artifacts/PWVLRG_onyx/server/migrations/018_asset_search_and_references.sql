-- Woohoo Studio - 跨项目素材搜索索引与引用关系支持
-- 迁移 018: 为跨项目素材搜索、标签治理、引用关系查询添加索引

-- 为 assets 表的 name 和 created_at 添加复合索引（跨项目搜索常用排序）
CREATE INDEX IF NOT EXISTS idx_assets_user_created
    ON assets(project_id, created_at DESC);

-- 为 assets 表的 asset_type 添加索引（类型筛选）
CREATE INDEX IF NOT EXISTS idx_assets_type_project
    ON assets(asset_type, project_id);

-- 为 storyboard_line_assets 的 asset_id 添加索引（引用关系反查）
-- 已有 idx_storyboard_line_assets_asset，但确认存在
CREATE INDEX IF NOT EXISTS idx_sla_asset_lookup
    ON storyboard_line_assets(asset_id);

-- 为 pipeline_step_outputs 的 step_id 和 run_id 添加索引
CREATE INDEX IF NOT EXISTS idx_pipeline_step_outputs_run
    ON pipeline_step_outputs(run_id, created_at DESC);

-- 注意: 标签使用 assets.metadata.tags 字段 (JSON array)，无需新表
-- SQLite 支持 json_extract 查询，兼容已有 metadata 字段
