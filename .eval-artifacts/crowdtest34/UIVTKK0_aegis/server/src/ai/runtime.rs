use std::{
    collections::{HashMap, VecDeque},
    sync::atomic::{AtomicI64, Ordering},
    sync::Arc,
};

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, OwnedSemaphorePermit, RwLock, Semaphore};
use uuid::Uuid;

use super::config::{AgentRuntimeState, AiTask, AiTaskEvent, AiTaskFilter, AiTaskStatus};
use super::task_persistence;

const TERMINAL_TASK_RETENTION_MS: i64 = 30 * 60 * 1000;
const MAX_TERMINAL_TASKS_PER_USER: usize = 200;

/// Maximum number of events retained in the per-user in-memory replay buffer.
/// Events older than this are evicted; clients reconnecting with a cursor before
/// the buffer start will receive a `resync` signal.
const EVENT_BUFFER_MAX_PER_USER: usize = 500;

/// A sequenced event envelope carries a global monotonic sequence number so
/// clients can detect gaps, deduplicate replays, and resume from a cursor.
#[derive(Debug, Clone)]
pub struct TaskEventEnvelope {
    pub seq: i64,
    pub user_id: String,
    pub event: AiTaskEvent,
}

/// A buffered event for replay — holds the serialized JSON alongside metadata
/// so we can replay without re-serializing.
#[derive(Debug, Clone)]
pub struct BufferedEvent {
    pub seq: i64,
    pub event_type: String,
    pub task_id: String,
    pub data_json: String,
}

#[derive(Debug, Clone, Default)]
pub struct AgentRuntimeStats {
    pub active_tasks: i64,
    pub queued_tasks: i64,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RuntimeProjectTaskCounts {
    pub queued: i64,
    pub running: i64,
    pub completed: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTaskSnapshot {
    pub max_concurrent_tasks: i64,
    pub total_tasks: i64,
    pub queued_tasks: i64,
    pub running_tasks: i64,
    pub completed_tasks: i64,
    pub failed_tasks: i64,
    pub oldest_queued_age_ms: Option<i64>,
    pub oldest_running_age_ms: Option<i64>,
}

#[derive(Clone)]
struct StoredTask {
    user_id: String,
    task: AiTask,
}

#[derive(Clone)]
pub struct AiTaskRuntime {
    max_concurrent_tasks: usize,
    semaphore: Arc<Semaphore>,
    tasks: Arc<RwLock<HashMap<String, StoredTask>>>,
    events: broadcast::Sender<TaskEventEnvelope>,
    db: Option<SqlitePool>,
    /// Global monotonic event sequence counter.
    next_seq: Arc<AtomicI64>,
    /// Per-user ring buffer of recent events for cursor-based replay.
    event_buffers: Arc<RwLock<HashMap<String, VecDeque<BufferedEvent>>>>,
}

impl AiTaskRuntime {
    pub fn new(max_concurrent_tasks: usize, db: Option<SqlitePool>) -> Self {
        let (events, _) = broadcast::channel(1024);

        Self {
            max_concurrent_tasks: max_concurrent_tasks.max(1),
            semaphore: Arc::new(Semaphore::new(max_concurrent_tasks.max(1))),
            tasks: Arc::new(RwLock::new(HashMap::new())),
            events,
            db,
            next_seq: Arc::new(AtomicI64::new(1)),
            event_buffers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /**
     * 从数据库恢复任务到内存
     * 启动时调用，将运行中/排队中的任务标记为失败
     */
    pub async fn restore_from_db(&self) -> Result<u64, String> {
        if let Some(ref db) = self.db {
            if let Err(error) = task_persistence::cleanup_old_tasks(db).await {
                tracing::warn!("清理历史任务失败: {}", error);
            }
            match task_persistence::restore_tasks(db).await {
                Ok(tasks_with_users) => {
                    let mut tasks_map = self.tasks.write().await;
                    let mut restored = 0u64;

                    for (task, user_id) in tasks_with_users {
                        tasks_map.insert(task.id.clone(), StoredTask { user_id, task });
                        restored += 1;
                    }

                    // After restore, advance the sequence counter past any
                    // persisted event_seq values so new events don't collide.
                    // Check BOTH ai_tasks (last known task state) and ai_task_events
                    // (durable event log) — the latter can be ahead if the server
                    // crashed between publishing an event and updating ai_tasks.
                    let max_tasks_seq: Option<i64> =
                        sqlx::query_scalar("SELECT MAX(event_seq) FROM ai_tasks")
                            .fetch_optional(db)
                            .await
                            .ok()
                            .flatten();
                    let max_events_seq: Option<i64> =
                        sqlx::query_scalar("SELECT MAX(event_seq) FROM ai_task_events")
                            .fetch_optional(db)
                            .await
                            .ok()
                            .flatten();
                    let max_seq = max_tasks_seq.unwrap_or(0).max(max_events_seq.unwrap_or(0));
                    if max_seq > 0 {
                        let current = self.next_seq.load(Ordering::Relaxed);
                        if max_seq >= current {
                            self.next_seq.store(max_seq + 1, Ordering::Relaxed);
                            tracing::info!(
                                "Advancing event sequence counter to {} after DB restore (tasks_max={:?}, events_max={:?})",
                                max_seq + 1,
                                max_tasks_seq,
                                max_events_seq
                            );
                        }
                    }

                    tracing::info!("从数据库恢复了 {} 个任务（含用户归属）", restored);
                    Ok(restored)
                }
                Err(e) => Err(format!("恢复任务失败: {}", e)),
            }
        } else {
            Ok(0)
        }
    }

    pub async fn create_task(&self, user_id: String, mut task: AiTask) -> AiTask {
        task.status = AiTaskStatus::Queued;
        task.created_at = now_millis();

        let mut tasks = self.tasks.write().await;
        tasks.insert(
            task.id.clone(),
            StoredTask {
                user_id: user_id.clone(),
                task: task.clone(),
            },
        );
        cleanup_tasks_locked(&mut tasks, None);
        drop(tasks);

        /*
         * 持久化任务到数据库
         */
        if let Some(ref db) = self.db {
            if let Err(e) = task_persistence::persist_task(db, &task, &user_id).await {
                tracing::warn!("任务持久化失败 ({}): {}", task.id, e);
            }
        }

        let (published_task, _seq) = self.publish_with_return(
            user_id,
            AiTaskEvent {
                event_type: "queued".to_string(),
                task,
                content_delta: None,
            },
        );

        // Update in-memory stored task with event_seq
        if let Some(mut tasks) = self.tasks.try_write().ok() {
            if let Some(stored) = tasks.get_mut(&published_task.id) {
                stored.task.event_seq = published_task.event_seq;
            }
        }

        published_task
    }

    pub async fn acquire_slot(&self) -> Result<OwnedSemaphorePermit, tokio::sync::AcquireError> {
        self.semaphore.clone().acquire_owned().await
    }

    pub async fn mark_running(&self, user_id: &str, task_id: &str) -> Option<AiTask> {
        self.update_task(
            user_id,
            task_id,
            |task| {
                if matches!(task.status, AiTaskStatus::Queued) {
                    task.status = AiTaskStatus::Running;
                    task.started_at = Some(now_millis());
                    task.error = None;
                }
            },
            "running",
        )
        .await
    }

    pub async fn mark_completed(
        &self,
        user_id: &str,
        task_id: &str,
        model: Option<String>,
        result: String,
    ) -> Option<AiTask> {
        self.update_task(
            user_id,
            task_id,
            |task| {
                if matches!(task.status, AiTaskStatus::Running) {
                    task.status = AiTaskStatus::Completed;
                    task.finished_at = Some(now_millis());
                    task.model = model;
                    task.result = Some(result);
                    task.error = None;
                }
            },
            "completed",
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn update_task_context(
        &self,
        user_id: &str,
        task_id: &str,
        attempt_index: i64,
        previous_attempts: i64,
        previous_failures: i64,
        previous_successes: i64,
        is_redo: bool,
        last_error: Option<String>,
        agent_status: AgentRuntimeState,
        active_tasks: i64,
        queued_tasks: i64,
    ) -> Option<AiTask> {
        self.update_task(
            user_id,
            task_id,
            |task| {
                task.attempt_index = attempt_index;
                task.previous_attempts = previous_attempts;
                task.previous_failures = previous_failures;
                task.previous_successes = previous_successes;
                task.is_redo = is_redo;
                task.last_error = last_error;
                task.agent_status = agent_status;
                task.active_tasks = active_tasks;
                task.queued_tasks = queued_tasks;
            },
            "context",
        )
        .await
    }

    pub async fn mark_failed(&self, user_id: &str, task_id: &str, error: String) -> Option<AiTask> {
        self.update_task(
            user_id,
            task_id,
            |task| {
                if matches!(task.status, AiTaskStatus::Queued | AiTaskStatus::Running) {
                    task.status = AiTaskStatus::Failed;
                    task.finished_at = Some(now_millis());
                    task.error = Some(error);
                }
            },
            "failed",
        )
        .await
    }

    /**
     * 取消任务（标记为失败状态，附带取消原因）
     */
    pub async fn cancel_task(
        &self,
        user_id: &str,
        task_id: &str,
        reason: Option<String>,
    ) -> Option<AiTask> {
        self.update_task(
            user_id,
            task_id,
            |task| {
                if matches!(task.status, AiTaskStatus::Queued | AiTaskStatus::Running) {
                    task.status = AiTaskStatus::Failed;
                    task.finished_at = Some(now_millis());
                    task.error = reason.or_else(|| Some("用户取消".to_string()));
                }
            },
            "cancelled",
        )
        .await
    }

    /**
     * 移除任务（从内存中彻底删除）
     */
    pub async fn remove_task(&self, user_id: &str, task_id: &str) -> bool {
        let mut tasks = self.tasks.write().await;
        if let Some(stored) = tasks.get(task_id) {
            if stored.user_id == user_id {
                tasks.remove(task_id);

                /*
                 * 从数据库删除任务
                 */
                if let Some(ref db) = self.db {
                    if let Err(e) = task_persistence::delete_persisted_task(db, task_id).await {
                        tracing::warn!("删除持久化任务失败 ({}): {}", task_id, e);
                    }
                }

                return true;
            }
        }
        false
    }

    pub async fn get_task(&self, user_id: &str, task_id: &str) -> Option<AiTask> {
        self.tasks
            .read()
            .await
            .get(task_id)
            .filter(|stored| stored.user_id == user_id)
            .map(|stored| stored.task.clone())
    }

    pub async fn list_tasks(&self, user_id: &str, filter: &AiTaskFilter) -> Vec<AiTask> {
        let limit = filter.limit.unwrap_or(50).clamp(1, 200);
        let mut tasks = self
            .tasks
            .read()
            .await
            .values()
            .filter(|stored| stored.user_id == user_id)
            .map(|stored| stored.task.clone())
            .filter(|task| matches_filter(task, filter))
            .collect::<Vec<_>>();

        tasks.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        tasks.truncate(limit);
        tasks
    }

    pub async fn agent_runtime_stats(&self, user_id: &str) -> HashMap<String, AgentRuntimeStats> {
        let mut stats = HashMap::new();
        let tasks = self.tasks.read().await;

        for stored in tasks.values().filter(|stored| stored.user_id == user_id) {
            let Some(agent_id) = stored.task.agent_id.as_ref() else {
                continue;
            };

            let entry = stats
                .entry(agent_id.clone())
                .or_insert_with(AgentRuntimeStats::default);
            match stored.task.status {
                AiTaskStatus::Queued => entry.queued_tasks += 1,
                AiTaskStatus::Running => entry.active_tasks += 1,
                AiTaskStatus::Completed | AiTaskStatus::Failed => {}
            }
        }

        stats
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TaskEventEnvelope> {
        self.events.subscribe()
    }

    /// Replay buffered events for a user starting after the given sequence number.
    /// Returns (events, min_available_seq) where min_available_seq is the oldest
    /// sequence in the buffer (0 if buffer is empty). If after_seq < min_available_seq,
    /// the caller should send a resync signal because the buffer has been truncated.
    pub async fn replay_events(
        &self,
        user_id: &str,
        after_seq: i64,
    ) -> (Vec<BufferedEvent>, i64) {
        let buffers = self.event_buffers.read().await;
        let Some(buf) = buffers.get(user_id) else {
            return (Vec::new(), 0);
        };

        let min_seq = buf.front().map(|e| e.seq).unwrap_or(0);

        // If the requested cursor is before our buffer start, caller must resync
        if after_seq > 0 && after_seq < min_seq {
            return (Vec::new(), min_seq);
        }

        let events: Vec<BufferedEvent> = buf
            .iter()
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect();

        (events, min_seq)
    }

    /// Returns the current next sequence number (the seq the next event will get).
    pub fn current_seq(&self) -> i64 {
        self.next_seq.load(Ordering::Relaxed)
    }

    pub async fn global_snapshot(&self) -> RuntimeTaskSnapshot {
        let now = now_millis();
        let tasks = self.tasks.read().await;
        let mut snapshot = RuntimeTaskSnapshot {
            max_concurrent_tasks: self.max_concurrent_tasks as i64,
            total_tasks: tasks.len() as i64,
            queued_tasks: 0,
            running_tasks: 0,
            completed_tasks: 0,
            failed_tasks: 0,
            oldest_queued_age_ms: None,
            oldest_running_age_ms: None,
        };

        for stored in tasks.values() {
            match stored.task.status {
                AiTaskStatus::Queued => {
                    snapshot.queued_tasks += 1;
                    let age_ms = now.saturating_sub(stored.task.created_at);
                    snapshot.oldest_queued_age_ms = Some(
                        snapshot
                            .oldest_queued_age_ms
                            .map(|current| current.max(age_ms))
                            .unwrap_or(age_ms),
                    );
                }
                AiTaskStatus::Running => {
                    snapshot.running_tasks += 1;
                    let started_at = stored.task.started_at.unwrap_or(stored.task.created_at);
                    let age_ms = now.saturating_sub(started_at);
                    snapshot.oldest_running_age_ms = Some(
                        snapshot
                            .oldest_running_age_ms
                            .map(|current| current.max(age_ms))
                            .unwrap_or(age_ms),
                    );
                }
                AiTaskStatus::Completed => snapshot.completed_tasks += 1,
                AiTaskStatus::Failed => snapshot.failed_tasks += 1,
            }
        }

        snapshot
    }

    pub async fn project_task_counts(
        &self,
        user_id: &str,
    ) -> HashMap<String, RuntimeProjectTaskCounts> {
        let mut stats = HashMap::new();
        let tasks = self.tasks.read().await;

        for stored in tasks.values().filter(|stored| stored.user_id == user_id) {
            let entry = stats
                .entry(stored.task.project_id.clone())
                .or_insert_with(RuntimeProjectTaskCounts::default);
            match stored.task.status {
                AiTaskStatus::Queued => entry.queued += 1,
                AiTaskStatus::Running => entry.running += 1,
                AiTaskStatus::Completed => entry.completed += 1,
                AiTaskStatus::Failed => entry.failed += 1,
            }
        }

        stats
    }

    pub fn derive_state(stats: &AgentRuntimeStats) -> AgentRuntimeState {
        if stats.active_tasks > 0 {
            AgentRuntimeState::Busy
        } else if stats.queued_tasks > 0 {
            AgentRuntimeState::Queued
        } else {
            AgentRuntimeState::Idle
        }
    }

    async fn update_task<F>(
        &self,
        user_id: &str,
        task_id: &str,
        updater: F,
        event_type: &str,
    ) -> Option<AiTask>
    where
        F: FnOnce(&mut AiTask),
    {
        let mut tasks = self.tasks.write().await;
        let stored = tasks.get_mut(task_id)?;
        if stored.user_id != user_id {
            return None;
        }

        updater(&mut stored.task);
        let mut task = stored.task.clone();
        cleanup_tasks_locked(&mut tasks, Some(task_id));
        drop(tasks);

        /*
         * 持久化任务状态更新到数据库
         */
        if let Some(ref db) = self.db {
            if let Err(e) = task_persistence::persist_task(db, &task, user_id).await {
                tracing::warn!("任务状态持久化失败 ({}): {}", task_id, e);
            }
        }

        let (published_task, _seq) = self.publish_with_return(
            user_id.to_string(),
            AiTaskEvent {
                event_type: event_type.to_string(),
                task,
                content_delta: None,
            },
        );

        // Update in-memory stored task with the event_seq for subsequent get/list calls
        if let Some(mut tasks) = self.tasks.try_write().ok() {
            if let Some(stored) = tasks.get_mut(task_id) {
                stored.task.event_seq = published_task.event_seq;
            }
        }

        Some(published_task)
    }

    /**
     * 发送流式内容增量事件
     * 在 AI 流式响应过程中调用，将增量内容推送给前端
     */
    pub async fn emit_content_delta(
        &self,
        user_id: &str,
        task_id: &str,
        delta: String,
    ) -> Option<()> {
        let tasks = self.tasks.read().await;
        let stored = tasks.get(task_id)?;
        if stored.user_id != user_id {
            return None;
        }
        let task = stored.task.clone();
        drop(tasks);

        self.publish(
            user_id.to_string(),
            AiTaskEvent {
                event_type: "content_delta".to_string(),
                task,
                content_delta: Some(delta),
            },
        );
        Some(())
    }

    fn publish(&self, user_id: String, mut event: AiTaskEvent) {
        let _ = self.publish_with_return(user_id, event);
    }

    fn publish_with_return(&self, user_id: String, mut event: AiTaskEvent) -> (AiTask, i64) {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        // Stamp the task with the current event sequence so API responses carry
        // the seq for out-of-order detection against SSE events.
        event.task.event_seq = seq;
        let task_id = event.task.id.clone();
        let event_type = event.event_type.clone();
        let task_status = event.task.status;
        let content_delta = event.content_delta.clone();

        // Serialize for the replay buffer
        let data_json = serde_json::to_string(&event).unwrap_or_default();

        // Buffer the event for replay
        let buffered = BufferedEvent {
            seq,
            event_type: event_type.clone(),
            task_id: task_id.clone(),
            data_json: data_json.clone(),
        };

        let buffers = self.event_buffers.clone();
        let uid = user_id.clone();
        // Spawn a task to buffer so we don't block the publish path
        tokio::spawn(async move {
            let mut bufs = buffers.write().await;
            let buf = bufs.entry(uid).or_default();
            buf.push_back(buffered);
            while buf.len() > EVENT_BUFFER_MAX_PER_USER {
                buf.pop_front();
            }
        });

        // Update the event_seq on the task in DB (best-effort)
        if let Some(ref db) = self.db {
            let db = db.clone();
            let tid = task_id.clone();
            tokio::spawn(async move {
                let _ = sqlx::query("UPDATE ai_tasks SET event_seq = ? WHERE id = ?")
                    .bind(seq)
                    .bind(&tid)
                    .execute(&db)
                    .await;
            });
        }

        // Persist the event to ai_task_events for durable replay across restarts.
        // Skip content_delta events from DB persistence — they are high-frequency,
        // ephemeral, and replaying them after restart would be wasteful; clients
        // get a fresh full result via the completed/failed event instead.
        if let Some(ref db) = self.db {
            if event_type != "content_delta" {
                let db = db.clone();
                let event_id = Uuid::new_v4().to_string();
                let task_json = serde_json::to_string(&event.task).unwrap_or_default();
                let created_at = now_millis();
                let persist_user_id = user_id.clone();
                let persist_task_id = task_id.clone();
                let persist_event_type = event_type.clone();
                tokio::spawn(async move {
                    let _ = sqlx::query(
                        "INSERT OR IGNORE INTO ai_task_events \
                         (id, user_id, task_id, event_seq, event_type, task_json, content_delta, created_at) \
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                    )
                    .bind(&event_id)
                    .bind(&persist_user_id)
                    .bind(&persist_task_id)
                    .bind(seq)
                    .bind(&persist_event_type)
                    .bind(&task_json)
                    .bind(&content_delta)
                    .bind(created_at)
                    .execute(&db)
                    .await;
                });
            }
        }

        // Terminal-state monotonicity guard: never send a non-terminal event after
        // the task has already reached Completed or Failed. This prevents late
        // content_delta or context events from arriving after completion.
        if matches!(task_status, AiTaskStatus::Completed | AiTaskStatus::Failed) {
            // Still publish terminal state changes (completed/failed/cancelled) but
            // suppress any stale queued/running/context/content_delta that arrives late.
            if !matches!(event_type.as_str(), "completed" | "failed" | "cancelled") {
                tracing::debug!(
                    task_id = %task_id,
                    event_type = %event_type,
                    "suppressing late non-terminal event after task reached terminal state"
                );
                // Don't send to broadcast — still return the task so callers see it
                return (event.task, seq);
            }
        }

        let _ = self.events.send(TaskEventEnvelope {
            seq,
            user_id,
            event: event.clone(),
        });

        (event.task, seq)
    }

    /// Clean up old persisted events from ai_task_events to prevent unbounded growth.
    /// Retains events from the last 7 days.
    pub async fn cleanup_old_persisted_events(db: &SqlitePool) -> Result<u64, sqlx::Error> {
        let cutoff = now_millis() - (7 * 24 * 60 * 60 * 1000);
        let result = sqlx::query("DELETE FROM ai_task_events WHERE created_at < ?")
            .bind(cutoff)
            .execute(db)
            .await?;
        Ok(result.rows_affected())
    }
}

fn matches_filter(task: &AiTask, filter: &AiTaskFilter) -> bool {
    if let Some(project_id) = filter.project_id.as_deref() {
        if task.project_id != project_id {
            return false;
        }
    }

    if let Some(conversation_id) = filter.conversation_id.as_deref() {
        if task.conversation_id != conversation_id {
            return false;
        }
    }

    true
}

fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn cleanup_tasks_locked(tasks: &mut HashMap<String, StoredTask>, preserve_task_id: Option<&str>) {
    let now = now_millis();
    let stale_before = now.saturating_sub(TERMINAL_TASK_RETENTION_MS);
    let mut remove_ids = Vec::new();
    let mut terminal_tasks_by_user: HashMap<String, Vec<(String, i64)>> = HashMap::new();

    for (task_id, stored) in tasks.iter() {
        if preserve_task_id == Some(task_id.as_str()) || !is_terminal_task(&stored.task) {
            continue;
        }

        let terminal_ts = stored
            .task
            .finished_at
            .or(stored.task.started_at)
            .unwrap_or(stored.task.created_at);

        if terminal_ts <= stale_before {
            remove_ids.push(task_id.clone());
            continue;
        }

        terminal_tasks_by_user
            .entry(stored.user_id.clone())
            .or_default()
            .push((task_id.clone(), terminal_ts));
    }

    for terminal_tasks in terminal_tasks_by_user.values_mut() {
        terminal_tasks.sort_by(|left, right| right.1.cmp(&left.1));
        if terminal_tasks.len() > MAX_TERMINAL_TASKS_PER_USER {
            remove_ids.extend(
                terminal_tasks
                    .iter()
                    .skip(MAX_TERMINAL_TASKS_PER_USER)
                    .map(|(task_id, _)| task_id.clone()),
            );
        }
    }

    remove_ids.sort();
    remove_ids.dedup();
    for task_id in remove_ids {
        tasks.remove(&task_id);
    }
}

fn is_terminal_task(task: &AiTask) -> bool {
    matches!(task.status, AiTaskStatus::Completed | AiTaskStatus::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::config::{AiTask, AiTaskStatus};

    fn make_task(id: &str, status: AiTaskStatus) -> AiTask {
        AiTask {
            id: id.to_string(),
            project_id: "project-1".to_string(),
            conversation_id: "conv-1".to_string(),
            user_message_id: None,
            assistant_message_id: None,
            agent_id: Some("agent-1".to_string()),
            content: "test prompt".to_string(),
            endpoint_id: None,
            model: None,
            output_kind: None,
            output_items: None,
            status,
            result: None,
            error: None,
            attempt_index: 0,
            previous_attempts: 0,
            previous_failures: 0,
            previous_successes: 0,
            is_redo: false,
            last_error: None,
            agent_status: AgentRuntimeState::Idle,
            active_tasks: 0,
            queued_tasks: 0,
            created_at: 0,
            started_at: None,
            finished_at: None,
            event_seq: 0,
        }
    }

    #[tokio::test]
    async fn test_event_seq_is_monotonic() {
        let rt = AiTaskRuntime::new(1, None);
        let mut rx = rt.subscribe();

        let task = make_task("t1", AiTaskStatus::Queued);
        rt.create_task("user1".to_string(), task).await;

        // First event gets seq 1
        let e1 = rx.recv().await.unwrap();
        assert_eq!(e1.seq, 1, "first event should have seq=1");
        assert_eq!(e1.event.event_type, "queued");

        // Mark running — seq 2
        rt.mark_running("user1", "t1").await;
        let e2 = rx.recv().await.unwrap();
        assert_eq!(e2.seq, 2);
        assert_eq!(e2.event.event_type, "running");

        // Mark completed — seq 3
        rt.mark_completed("user1", "t1", None, "done".to_string()).await;
        let e3 = rx.recv().await.unwrap();
        assert_eq!(e3.seq, 3);
        assert_eq!(e3.event.event_type, "completed");
    }

    #[tokio::test]
    async fn test_replay_events_basic() {
        let rt = AiTaskRuntime::new(1, None);

        let task = make_task("t1", AiTaskStatus::Queued);
        rt.create_task("user1".to_string(), task).await;
        rt.mark_running("user1", "t1").await;
        rt.mark_completed("user1", "t1", None, "result".to_string()).await;

        // Give the spawned buffer tasks time to complete
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Replay from seq 0 should return all events
        let (events, min_seq) = rt.replay_events("user1", 0).await;
        assert_eq!(events.len(), 3);
        assert_eq!(min_seq, 1);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[1].seq, 2);
        assert_eq!(events[2].seq, 3);

        // Replay from seq 1 should return events with seq > 1
        let (events, _) = rt.replay_events("user1", 1).await;
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 2);

        // Replay from seq 3 should return no events
        let (events, _) = rt.replay_events("user1", 3).await;
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn test_replay_events_resync_signal_when_cursor_before_buffer() {
        let rt = AiTaskRuntime::new(1, None);

        // Create more events than buffer capacity to force eviction
        for i in 0..(EVENT_BUFFER_MAX_PER_USER + 50) {
            let task = make_task(&format!("t{}", i), AiTaskStatus::Queued);
            rt.create_task("user1".to_string(), task).await;
        }

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Requesting replay from seq=1 should trigger resync (cursor before buffer start)
        let (events, min_seq) = rt.replay_events("user1", 1).await;
        assert!(min_seq > 1, "oldest event in buffer should be > 1 due to eviction");
        assert!(events.is_empty(), "should return empty when cursor before buffer start");
    }

    #[tokio::test]
    async fn test_terminal_state_monotonicity() {
        let rt = AiTaskRuntime::new(1, None);
        let mut rx = rt.subscribe();

        let task = make_task("t1", AiTaskStatus::Queued);
        rt.create_task("user1".to_string(), task).await;

        // Consume queued event
        let _ = rx.recv().await.unwrap();

        rt.mark_running("user1", "t1").await;
        let _ = rx.recv().await.unwrap();

        // Mark completed
        rt.mark_completed("user1", "t1", None, "result".to_string()).await;
        let completed = rx.recv().await.unwrap();
        assert_eq!(completed.event.event_type, "completed");
        assert_eq!(completed.event.task.status, AiTaskStatus::Completed);

        // Subsequent calls to update_task for non-terminal events should be suppressed
        // (they would go through update_task which calls publish, but since the task
        // is already Completed, a mark_running on a completed task would no-op in
        // update_task because the closure guard doesn't match).
        // Let's test by emitting a content_delta on a completed task:
        rt.emit_content_delta("user1", "t1", "late delta".to_string()).await;

        // The emit_content_delta publishes directly — the terminal-state guard in publish
        // should suppress it since the task status is Completed
        match tokio::time::timeout(std::time::Duration::from_millis(100), rx.recv()).await {
            Ok(Ok(_)) => panic!("late content_delta after completion should be suppressed"),
            _ => {} // timeout or channel closed = success
        }
    }

    #[tokio::test]
    async fn test_replay_events_filtered_by_user() {
        let rt = AiTaskRuntime::new(1, None);

        let task1 = make_task("t1", AiTaskStatus::Queued);
        let task2 = make_task("t2", AiTaskStatus::Queued);
        rt.create_task("user1".to_string(), task1).await;
        rt.create_task("user2".to_string(), task2).await;

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // user1 should only see their events
        let (events, _) = rt.replay_events("user1", 0).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].task_id, "t1");

        let (events, _) = rt.replay_events("user2", 0).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].task_id, "t2");
    }

    #[tokio::test]
    async fn test_current_seq_advances() {
        let rt = AiTaskRuntime::new(1, None);
        assert_eq!(rt.current_seq(), 1, "initial seq should be 1");

        let task = make_task("t1", AiTaskStatus::Queued);
        rt.create_task("user1".to_string(), task).await;

        // After one publish, next seq is 2
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(rt.current_seq(), 2);
    }

    #[test]
    fn test_is_terminal_task() {
        assert!(is_terminal_task(&make_task("a", AiTaskStatus::Completed)));
        assert!(is_terminal_task(&make_task("b", AiTaskStatus::Failed)));
        assert!(!is_terminal_task(&make_task("c", AiTaskStatus::Queued)));
        assert!(!is_terminal_task(&make_task("d", AiTaskStatus::Running)));
    }
}
