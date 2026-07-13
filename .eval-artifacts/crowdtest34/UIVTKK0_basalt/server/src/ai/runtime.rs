use std::{
    collections::{HashMap, VecDeque},
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
};

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, OwnedSemaphorePermit, RwLock, Semaphore};

use super::config::{AgentRuntimeState, AiTask, AiTaskEvent, AiTaskFilter, AiTaskStatus};
use super::task_persistence;

const TERMINAL_TASK_RETENTION_MS: i64 = 30 * 60 * 1000;
const MAX_TERMINAL_TASKS_PER_USER: usize = 200;

/// Maximum number of events to retain per user for cursor-based replay.
/// When a client reconnects with Last-Event-ID older than this buffer,
/// the server sends a `resync_required` signal instead of replaying.
const EVENT_BUFFER_PER_USER: usize = 500;

/// Event ID prefix for AI task SSE events
pub const AI_EVENT_ID_PREFIX: &str = "ai-";

#[derive(Debug, Clone)]
struct StoredTask {
    user_id: String,
    task: AiTask,
}

#[derive(Debug, Clone)]
pub struct TaskEventEnvelope {
    pub user_id: String,
    pub event: AiTaskEvent,
    /// Monotonic sequence number assigned at publish time
    pub seq: u64,
}

/// A buffered event for replay after reconnect
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferedEvent {
    pub seq: u64,
    pub event_type: String,
    pub data: serde_json::Value,
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
pub struct AiTaskRuntime {
    max_concurrent_tasks: usize,
    semaphore: Arc<Semaphore>,
    tasks: Arc<RwLock<HashMap<String, StoredTask>>>,
    events: broadcast::Sender<TaskEventEnvelope>,
    db: Option<SqlitePool>,
    /// Monotonic global event sequence counter
    event_seq: Arc<AtomicU64>,
    /// Per-user ring buffer of recent events for cursor-based replay
    event_buffer: Arc<RwLock<HashMap<String, VecDeque<BufferedEvent>>>>,
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
            event_seq: Arc::new(AtomicU64::new(0)),
            event_buffer: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /**
     * 从数据库恢复任务到内存
     * 启动时调用，将运行中/排队中的任务标记为失败并回写数据库
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
                        // If restore_tasks flipped a queued/running task to failed
                        // (process restart), persist that correction so that
                        // subsequent restarts and direct DB readers see it.
                        if matches!(
                            task.status,
                            AiTaskStatus::Failed | AiTaskStatus::Cancelled | AiTaskStatus::Blocked
                        ) {
                            if let Err(e) = task_persistence::persist_task(db, &task, &user_id).await {
                                tracing::warn!("回写恢复任务状态失败 ({}): {}", task.id, e);
                            }
                        }
                        tasks_map.insert(task.id.clone(), StoredTask { user_id, task });
                        restored += 1;
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

        let event = AiTaskEvent {
            event_type: "queued".to_string(),
            task: task.clone(),
            content_delta: None,
        };

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

        self.publish(user_id, event);
        task
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
     * 取消任务（标记为取消状态，附带取消原因）
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
                    task.status = AiTaskStatus::Cancelled;
                    task.finished_at = Some(now_millis());
                    task.error = reason.or_else(|| Some("用户取消".to_string()));
                }
            },
            "cancelled",
        )
        .await
    }

    /**
     * 标记任务被阻塞（预算/防护/依赖等原因）
     */
    pub async fn mark_blocked(&self, user_id: &str, task_id: &str, reason: String) -> Option<AiTask> {
        self.update_task(
            user_id,
            task_id,
            |task| {
                if matches!(task.status, AiTaskStatus::Queued | AiTaskStatus::Running) {
                    task.status = AiTaskStatus::Blocked;
                    task.finished_at = Some(now_millis());
                    task.error = Some(reason);
                }
            },
            "blocked",
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
                AiTaskStatus::Completed
                | AiTaskStatus::Failed
                | AiTaskStatus::Cancelled
                | AiTaskStatus::Blocked => {}
            }
        }

        stats
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TaskEventEnvelope> {
        self.events.subscribe()
    }

    /// Get the most recently assigned event sequence number (for stamping snapshots).
    /// Returns 0 if no events have been published yet.
    pub fn current_event_seq(&self) -> u64 {
        self.event_seq.load(Ordering::SeqCst)
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
                AiTaskStatus::Failed | AiTaskStatus::Cancelled | AiTaskStatus::Blocked => {
                    snapshot.failed_tasks += 1;
                }
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
                AiTaskStatus::Failed | AiTaskStatus::Cancelled | AiTaskStatus::Blocked => {
                    entry.failed += 1;
                }
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
        let task = stored.task.clone();
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

        self.publish(
            user_id.to_string(),
            AiTaskEvent {
                event_type: event_type.to_string(),
                task: task.clone(),
                content_delta: None,
            },
        );
        Some(task)
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

    fn publish(&self, user_id: String, event: AiTaskEvent) {
        let seq = self.event_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let envelope = TaskEventEnvelope {
            user_id: user_id.clone(),
            event,
            seq,
        };

        // Buffer the event for replay support
        let event_type = envelope.event.event_type.clone();
        let data = serde_json::to_value(&envelope.event).unwrap_or(serde_json::Value::Null);
        let buffered = BufferedEvent {
            seq,
            event_type: event_type.clone(),
            data,
        };

        // Best-effort synchronous buffer write: try_write avoids spawn overhead
        // in the common case where no one else holds the lock. If the lock is
        // contended, fall back to async spawn so we never block the broadcast path.
        match self.event_buffer.try_write() {
            Ok(mut buf) => {
                let user_buf = buf.entry(user_id.clone()).or_default();
                user_buf.push_back(buffered);
                while user_buf.len() > EVENT_BUFFER_PER_USER {
                    user_buf.pop_front();
                }
            }
            Err(tokio::sync::TryLockError::WouldBlock) => {
                let buffer = self.event_buffer.clone();
                let uid = user_id.clone();
                tokio::spawn(async move {
                    let mut buf = buffer.write().await;
                    let user_buf = buf.entry(uid).or_default();
                    user_buf.push_back(buffered);
                    while user_buf.len() > EVENT_BUFFER_PER_USER {
                        user_buf.pop_front();
                    }
                });
            }
            Err(tokio::sync::TryLockError::Poisoned(_)) => {
                // Lock poisoned; skip buffering (broadcast still goes through)
            }
        }

        let _ = self.events.send(envelope);
    }

    /// Get events buffered after the given sequence number for replay.
    /// Returns (events, has_gap) where has_gap=true means the cursor is too old
    /// (or the buffer was reset by process restart) and the client must do a
    /// full resync via snapshot/HTTP.
    pub async fn replay_events_after(
        &self,
        user_id: &str,
        after_seq: u64,
    ) -> (Vec<BufferedEvent>, bool) {
        let buf = self.event_buffer.read().await;
        let Some(user_buf) = buf.get(user_id) else {
            // No buffer for this user. If after_seq > 0 the buffer was lost
            // (process restart / cold start after client already had events),
            // so signal a gap and force a snapshot resync.
            return (Vec::new(), after_seq > 0);
        };

        // Empty buffer with after_seq>0 means buffer was drained/reset -> gap.
        if user_buf.is_empty() {
            return (Vec::new(), after_seq > 0);
        }

        // Check if the oldest buffered event is newer than after_seq+1
        // This means we missed some events (gap due to rollover)
        if let Some(oldest) = user_buf.front() {
            if oldest.seq > after_seq + 1 {
                return (Vec::new(), true);
            }
        }

        let events: Vec<BufferedEvent> = user_buf
            .iter()
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect();

        (events, false)
    }

    /// Parse a Last-Event-ID string (format: "ai-{seq}") into a sequence number
    pub fn parse_event_id(event_id: &str) -> Option<u64> {
        event_id
            .strip_prefix(AI_EVENT_ID_PREFIX)
            .and_then(|s| s.parse::<u64>().ok())
    }

    /// Format a sequence number as an SSE event ID
    pub fn format_event_id(seq: u64) -> String {
        format!("{AI_EVENT_ID_PREFIX}{seq}")
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
    matches!(
        task.status,
        AiTaskStatus::Completed | AiTaskStatus::Failed | AiTaskStatus::Cancelled | AiTaskStatus::Blocked
    )
}
