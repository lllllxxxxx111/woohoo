use std::{collections::HashMap, sync::Arc};

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, OwnedSemaphorePermit, RwLock, Semaphore};

use super::config::{AgentRuntimeState, AiTask, AiTaskEvent, AiTaskFilter, AiTaskStatus};
use super::task_persistence;

const TERMINAL_TASK_RETENTION_MS: i64 = 30 * 60 * 1000;
const MAX_TERMINAL_TASKS_PER_USER: usize = 200;

#[derive(Debug, Clone)]
struct StoredTask {
    user_id: String,
    task: AiTask,
}

#[derive(Debug, Clone)]
pub struct TaskEventEnvelope {
    pub user_id: String,
    pub event: AiTaskEvent,
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

    /// Set routing fallback metadata on a task for frontend visibility
    pub async fn set_routing_info(
        &self,
        user_id: &str,
        task_id: &str,
        was_fallback: bool,
        attempt_count: usize,
        reason: Option<String>,
    ) -> Option<AiTask> {
        self.update_task(
            user_id,
            task_id,
            move |task| {
                task.routing_was_fallback = Some(was_fallback);
                task.routing_attempt_count = Some(attempt_count as i64);
                task.routing_fallback_reason = reason.clone();
            },
            "routing_info",
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
        let _ = self.events.send(TaskEventEnvelope { user_id, event });
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
