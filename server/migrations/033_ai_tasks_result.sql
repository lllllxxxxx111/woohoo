-- Pipeline recovery reads completed task output from ai_tasks. Persist it so the
-- database fallback has the same shape as the in-memory task runtime.
ALTER TABLE ai_tasks ADD COLUMN result TEXT;
