use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::repo;

/// 回复队列条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub agent_id: String,
    pub agent_name: Option<String>,
    pub intent: String,
}

/// 回复队列管理器
pub struct ReplyQueueManager;

impl ReplyQueueManager {
    /// 从数据库加载当前回复队列
    pub async fn load_queue(pool: &SqlitePool, session_id: &str) -> Result<Vec<QueueEntry>> {
        let session = repo::get_session(pool, session_id).await?;

        if let Some(queue_json) = session.reply_queue_json {
            let queue: Vec<QueueEntry> = serde_json::from_str(&queue_json).unwrap_or_default();
            return Ok(queue);
        }

        Ok(vec![])
    }

    /// 持久化回复队列到数据库
    pub async fn save_queue(
        pool: &SqlitePool,
        session_id: &str,
        queue: &[QueueEntry],
    ) -> Result<()> {
        let queue_json = serde_json::to_string(queue)?;
        repo::update_reply_queue(pool, session_id, &queue_json).await?;
        Ok(())
    }

    /// 将智能体加入队列尾部
    pub async fn enqueue(
        pool: &SqlitePool,
        session_id: &str,
        agent_id: &str,
        intent: &str,
    ) -> Result<Vec<QueueEntry>> {
        let mut queue = Self::load_queue(pool, session_id).await?;

        let already_queued = queue.iter().any(|e| e.agent_id == agent_id);
        if !already_queued {
            queue.push(QueueEntry {
                agent_id: agent_id.to_string(),
                agent_name: None,
                intent: intent.to_string(),
            });
            Self::save_queue(pool, session_id, &queue).await?;
        }

        Ok(queue)
    }

    /// 获取当前发言者（队列头部）
    pub async fn current_speaker(
        pool: &SqlitePool,
        session_id: &str,
    ) -> Result<Option<QueueEntry>> {
        let queue = Self::load_queue(pool, session_id).await?;
        Ok(queue.first().cloned())
    }

    /// 移除队列头部（当前发言者完成发言）
    pub async fn dequeue(pool: &SqlitePool, session_id: &str) -> Result<Option<QueueEntry>> {
        let mut queue = Self::load_queue(pool, session_id).await?;

        if queue.is_empty() {
            return Ok(None);
        }

        let entry = queue.remove(0);
        Self::save_queue(pool, session_id, &queue).await?;
        Ok(Some(entry))
    }

    /// 根据分派结果初始化回复队列
    pub async fn initialize_from_assignments(
        pool: &SqlitePool,
        session_id: &str,
    ) -> Result<Vec<QueueEntry>> {
        let assignments = repo::list_assignments(pool, session_id).await?;

        let mut queue = Vec::new();
        for assignment in &assignments {
            if assignment.status == "assigned" || assignment.status == "ready" {
                let depends_on: Vec<String> = assignment
                    .depends_on_json
                    .as_ref()
                    .and_then(|json| serde_json::from_str(json).ok())
                    .unwrap_or_default();

                if depends_on.is_empty() {
                    queue.push(QueueEntry {
                        agent_id: assignment.agent_id.clone(),
                        agent_name: None,
                        intent: "design".to_string(),
                    });
                }
            }
        }

        Self::save_queue(pool, session_id, &queue).await?;
        Ok(queue)
    }
}
