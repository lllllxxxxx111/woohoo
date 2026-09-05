-- 036: 视频生成产物落盘为本地资产
--
-- 此前 video_generations 完成后只保存 provider 的远程 result_url（或把
-- base64 数据整体塞进 result_b64_json），从不下载落盘、从不注册为 asset，
-- 导致资产库没有视频、剪辑时间线与成片合成无从取材。
-- 本迁移为 video_generations 增加 result_asset_id 列，关联 assets 表中
-- 由 run_generation_task 落盘后注册的本地视频文件。
ALTER TABLE video_generations ADD COLUMN result_asset_id TEXT;
