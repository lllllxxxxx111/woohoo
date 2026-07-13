use std::{
    collections::{HashMap, VecDeque},
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, RwLock},
};

use serde::Serialize;
use tokio::sync::broadcast;

/// Event ID prefix for collaboration SSE events
pub const COLLAB_EVENT_ID_PREFIX: &str = "collab-";

/// Maximum buffered events for replay
const COLLAB_EVENT_BUFFER_SIZE: usize = 500;

/// 协同事件 SSE 信封
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationEventEnvelope {
    pub session_id: String,
    pub event_type: String,
    pub payload: Option<serde_json::Value>,
    /// Monotonic sequence number assigned at broadcast time
    #[serde(skip_serializing)]
    pub seq: u64,
}

/// A buffered collaboration event for replay
#[derive(Debug, Clone)]
pub struct BufferedCollabEvent {
    pub seq: u64,
    pub session_id: String,
    pub event_type: String,
    pub payload: Option<serde_json::Value>,
}

/// 协同事件广播器
#[derive(Clone)]
pub struct CollaborationBroadcaster {
    tx: broadcast::Sender<CollaborationEventEnvelope>,
    seq: Arc<AtomicU64>,
    buffer: Arc<RwLock<VecDeque<BufferedCollabEvent>>>,
}

impl CollaborationBroadcaster {
    /// 创建新的广播器
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            tx,
            seq: Arc::new(AtomicU64::new(0)),
            buffer: Arc::new(RwLock::new(VecDeque::with_capacity(COLLAB_EVENT_BUFFER_SIZE))),
        }
    }

    /// 广播协同事件
    pub fn broadcast(
        &self,
        session_id: String,
        event_type: &str,
        payload: Option<serde_json::Value>,
    ) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let envelope = CollaborationEventEnvelope {
            session_id: session_id.clone(),
            event_type: event_type.to_string(),
            payload: payload.clone(),
            seq,
        };

        // Buffer for replay
        if let Ok(mut buf) = self.buffer.write() {
            buf.push_back(BufferedCollabEvent {
                seq,
                session_id: session_id.clone(),
                event_type: event_type.to_string(),
                payload: payload.clone(),
            });
            while buf.len() > COLLAB_EVENT_BUFFER_SIZE {
                buf.pop_front();
            }
        }

        let _ = self.tx.send(envelope);
    }

    /// 订阅协同事件流
    pub fn subscribe(&self) -> broadcast::Receiver<CollaborationEventEnvelope> {
        self.tx.subscribe()
    }

    /// Get the most recently assigned sequence number (for stamping snapshots).
    pub fn current_event_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    /// Get events buffered after the given sequence for replay.
    /// Returns events and a has_gap flag. `has_gap=true` means:
    /// - oldest buffered seq is newer than after_seq+1 (rollover), or
    /// - the buffer is empty/poisoned but after_seq>0 (process restart / cold start).
    /// In either case the client must do a full resync via snapshot/HTTP.
    pub fn replay_events_after(&self, after_seq: u64) -> (Vec<BufferedCollabEvent>, bool) {
        let buf = match self.buffer.read() {
            Ok(b) => b,
            Err(_) => {
                // Buffer poisoned - cannot trust contents. If we had a cursor,
                // signal gap so client resyncs.
                return (Vec::new(), after_seq > 0);
            }
        };

        if buf.is_empty() {
            // Fresh buffer; if after_seq > 0 events were lost (restart).
            return (Vec::new(), after_seq > 0);
        }

        if let Some(oldest) = buf.front() {
            if oldest.seq > after_seq + 1 {
                return (Vec::new(), true);
            }
        }

        let events: Vec<BufferedCollabEvent> = buf
            .iter()
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect();

        (events, false)
    }

    /// Parse a Last-Event-ID string
    pub fn parse_event_id(event_id: &str) -> Option<u64> {
        event_id
            .strip_prefix(COLLAB_EVENT_ID_PREFIX)
            .and_then(|s| s.parse::<u64>().ok())
    }

    /// Format a sequence as an SSE event ID
    pub fn format_event_id(seq: u64) -> String {
        format!("{COLLAB_EVENT_ID_PREFIX}{seq}")
    }
}

impl Default for CollaborationBroadcaster {
    fn default() -> Self {
        Self::new()
    }
}

// Include a HashMap type alias for potential future per-user buffering
#[allow(dead_code)]
type PerUserBuffer = HashMap<String, VecDeque<BufferedCollabEvent>>;
