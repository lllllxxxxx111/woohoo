-- Woohoo Studio - Add result column to ai_tasks
-- The AiTask struct has a `result: Option<String>` field that was never
-- persisted to the database. The pipeline orchestrator's load_task_snapshot
-- queries this column when falling back to DB after task eviction from memory.

ALTER TABLE ai_tasks ADD COLUMN result TEXT;
