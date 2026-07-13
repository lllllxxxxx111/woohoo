use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::broadcast;
use uuid::Uuid;

/// 协同事件 SSE 信封
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationEventEnvelope {
    pub session_id: String,
    pub event_type: String,
    pub payload: Option<serde_json::Value>,
    /// Monotonic sequence number (SQLite rowid) for cursor-based replay.
    /// Set after persistence so SSE clients can use it as Last-Event-ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

/// 协同事件广播器
#[derive(Clone)]
pub struct CollaborationBroadcaster {
    tx: broadcast::Sender<CollaborationEventEnvelope>,
}

impl CollaborationBroadcaster {
    /// 创建新的广播器
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    /// 广播协同事件（内存中，不持久化）
    pub fn broadcast(
        &self,
        session_id: String,
        event_type: &str,
        payload: Option<serde_json::Value>,
    ) {
        let envelope = CollaborationEventEnvelope {
            session_id,
            event_type: event_type.to_string(),
            payload,
            seq: None,
        };
        let _ = self.tx.send(envelope);
    }

    /// 广播带有序列号的协同事件
    pub fn broadcast_with_seq(
        &self,
        session_id: String,
        event_type: &str,
        payload: Option<serde_json::Value>,
        seq: i64,
    ) {
        let envelope = CollaborationEventEnvelope {
            session_id,
            event_type: event_type.to_string(),
            payload,
            seq: Some(seq),
        };
        let _ = self.tx.send(envelope);
    }

    /// 订阅协同事件流
    pub fn subscribe(&self) -> broadcast::Receiver<CollaborationEventEnvelope> {
        self.tx.subscribe()
    }
}

/// Persist an event to collaboration_events and then broadcast it with the rowid.
/// This ensures the SSE event always carries the correct cursor for replay.
pub async fn persist_and_broadcast(
    pool: &SqlitePool,
    broadcaster: &CollaborationBroadcaster,
    session_id: &str,
    event_type: &str,
    payload: Option<serde_json::Value>,
) {
    let id = Uuid::new_v4().to_string();
    let payload_str = payload.as_ref().map(|p| p.to_string());

    if let Err(err) = sqlx::query(
        "INSERT INTO collaboration_events (id, session_id, event_type, payload_json)
         VALUES (?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(event_type)
    .bind(payload_str.as_deref())
    .execute(pool)
    .await
    {
        tracing::warn!(error = %err, "failed to persist collaboration event");
        // Still broadcast without seq so clients get the event
        broadcaster.broadcast(session_id.to_string(), event_type, payload);
        return;
    }

    // Retrieve the rowid for the inserted event
    let rowid: Option<i64> = sqlx::query_scalar::<_, i64>(
        "SELECT rowid FROM collaboration_events WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    broadcaster.broadcast_with_seq(
        session_id.to_string(),
        event_type,
        payload,
        rowid.unwrap_or(0),
    );
}
