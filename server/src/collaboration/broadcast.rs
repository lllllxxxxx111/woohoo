use serde::Serialize;
use tokio::sync::broadcast;

/// 协同事件 SSE 信封
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationEventEnvelope {
    pub session_id: String,
    pub event_type: String,
    pub payload: Option<serde_json::Value>,
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

    /// 广播协同事件
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
        };
        let _ = self.tx.send(envelope);
    }

    /// 订阅协同事件流
    pub fn subscribe(&self) -> broadcast::Receiver<CollaborationEventEnvelope> {
        self.tx.subscribe()
    }
}
