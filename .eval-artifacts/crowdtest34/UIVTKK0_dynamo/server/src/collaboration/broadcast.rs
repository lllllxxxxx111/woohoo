use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;

/// 协同事件 SSE 信封
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationEventEnvelope {
    /// Monotonically increasing sequence number for SSE event ID / replay cursor.
    pub seq: i64,
    pub session_id: String,
    pub event_type: String,
    pub payload: Option<serde_json::Value>,
}

/// 协同事件广播器
#[derive(Clone)]
pub struct CollaborationBroadcaster {
    tx: broadcast::Sender<CollaborationEventEnvelope>,
    seq: Arc<AtomicI64>,
}

impl CollaborationBroadcaster {
    /// 创建新的广播器
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            tx,
            seq: Arc::new(AtomicI64::new(1)),
        }
    }

    /// 广播协同事件
    pub fn broadcast(
        &self,
        session_id: String,
        event_type: &str,
        payload: Option<serde_json::Value>,
    ) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let envelope = CollaborationEventEnvelope {
            seq,
            session_id,
            event_type: event_type.to_string(),
            payload,
        };
        let _ = self.tx.send(envelope);
    }

    /// 订阅协同事件流
    pub fn subscribe(&self) -> broadcast::Receiver<CollaborationEventEnvelope> {
        self.tx.subscribe()
    }

    /// Get the current max sequence number (for initial cursor anchor).
    pub fn current_seq(&self) -> i64 {
        self.seq.load(Ordering::Relaxed) - 1
    }
}
