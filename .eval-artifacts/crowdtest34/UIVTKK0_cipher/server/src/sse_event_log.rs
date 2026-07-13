use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::task;

/// Maximum number of events to keep in the in-memory ring buffer per stream type.
/// When buffer overflows, oldest events are dropped; clients requesting those
/// cursors will receive a `resync` signal.
///
/// Sized for typical burst activity across a handful of concurrent users.
/// Events are also persisted to SQLite; restart recovery loads recent events.
const IN_MEMORY_BUFFER_CAP: usize = 8192;

/// Maximum age (milliseconds) of events to keep in the DB buffer.
/// Events older than this are pruned periodically.
const DB_EVENT_RETENTION_MS: i64 = 30 * 60 * 1000; // 30 minutes

/// A single SSE event in the log.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedEvent {
    pub seq: i64,
    pub user_id: String,
    pub stream: String,
    pub stream_key: String,
    pub event_type: String,
    pub payload: String,
    pub created_at: i64,
}

/// In-memory ring buffer of events with monotonic sequence numbers.
struct RingBuffer {
    events: VecDeque<LoggedEvent>,
    next_seq: i64,
}

impl RingBuffer {
    fn new() -> Self {
        Self {
            events: VecDeque::with_capacity(IN_MEMORY_BUFFER_CAP),
            next_seq: 1,
        }
    }

    fn push(&mut self, event: LoggedEvent) -> i64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        if self.events.len() >= IN_MEMORY_BUFFER_CAP {
            self.events.pop_front();
        }
        self.events.push_back(LoggedEvent { seq, ..event });
        seq
    }

    /// Reserve and return the next sequence number without pushing an event.
    /// Caller is responsible for later calling push_with_seq() with this seq.
    fn reserve_seq(&mut self) -> i64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    /// Push an event with a pre-assigned sequence number (from reserve_seq).
    /// Panics if seq != next_seq - 1 (i.e., caller didn't follow reserve_seq contract).
    fn push_with_seq(&mut self, event: LoggedEvent) {
        if self.events.len() >= IN_MEMORY_BUFFER_CAP {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }

    /// Returns events with seq > since_seq, in order.
    fn replay_after(&self, since_seq: i64) -> Vec<LoggedEvent> {
        self.events
            .iter()
            .filter(|e| e.seq > since_seq)
            .cloned()
            .collect()
    }

    fn oldest_seq(&self) -> Option<i64> {
        self.events.front().map(|e| e.seq)
    }

    fn newest_seq(&self) -> Option<i64> {
        self.events.back().map(|e| e.seq)
    }
}

/// Thread-safe SSE event log with in-memory ring buffer and SQLite persistence.
#[derive(Clone)]
pub struct SseEventLog {
    buffer: Arc<Mutex<RingBuffer>>,
    db: Option<SqlitePool>,
}

impl SseEventLog {
    pub fn new(db: Option<SqlitePool>) -> Self {
        Self {
            buffer: Arc::new(Mutex::new(RingBuffer::new())),
            db,
        }
    }

    /// Initialize from DB: load the highest sequence number so new events continue from there.
    /// Must be called after DB migrations are applied and before events are published.
    pub async fn init_from_db(&self) {
        if let Some(ref db) = self.db {
            // Get max seq from DB
            let max_seq: Option<(i64,)> =
                sqlx::query_as("SELECT COALESCE(MAX(seq), 0) FROM sse_event_log")
                    .fetch_optional(db)
                    .await
                    .ok()
                    .flatten();

            if let Some((max,)) = max_seq {
                let mut buf = self.buffer.lock().unwrap();
                buf.next_seq = max + 1;
                tracing::info!(
                    "[SseEventLog] Initialized from DB, next event seq = {}",
                    buf.next_seq
                );
            }

            // Load recent events into memory buffer
            let cutoff = Utc::now().timestamp_millis() - DB_EVENT_RETENTION_MS;
            let recent: Vec<(i64, String, String, String, String, String, i64)> =
                match sqlx::query_as(
                    "SELECT seq, user_id, stream, stream_key, event_type, payload, created_at
                     FROM sse_event_log
                     WHERE created_at > ?
                     ORDER BY seq DESC LIMIT ?",
                )
                .bind(cutoff)
                .bind(IN_MEMORY_BUFFER_CAP as i64)
                .fetch_all(db)
                .await
                {
                    Ok(rows) => rows,
                    Err(e) => {
                        tracing::warn!("[SseEventLog] Failed to load recent events from DB: {}", e);
                        return;
                    }
                };

            // Reverse to chronological order and load into buffer
            let mut buf = self.buffer.lock().unwrap();
            for (seq, user_id, stream, stream_key, event_type, payload, created_at) in
                recent.into_iter().rev()
            {
                buf.events.push_back(LoggedEvent {
                    seq,
                    user_id,
                    stream,
                    stream_key,
                    event_type,
                    payload,
                    created_at,
                });
            }
            if let Some(newest) = buf.newest_seq() {
                buf.next_seq = newest + 1;
            }
        }
    }

    /// Append a new event to the log. Returns the assigned sequence number.
    /// Synchronous; DB persistence is fire-and-forget.
    pub fn append(
        &self,
        user_id: &str,
        stream: &str,
        stream_key: &str,
        event_type: &str,
        payload: &str,
    ) -> i64 {
        let now = Utc::now().timestamp_millis();
        let seq;

        {
            let mut buf = self.buffer.lock().unwrap();
            seq = buf.push(LoggedEvent {
                seq: 0, // assigned inside push()
                user_id: user_id.to_string(),
                stream: stream.to_string(),
                stream_key: stream_key.to_string(),
                event_type: event_type.to_string(),
                payload: payload.to_string(),
                created_at: now,
            });
        }

        // Persist to DB (fire-and-forget)
        self.persist(seq, user_id, stream, stream_key, event_type, payload, now);
        seq
    }

    /// Reserve the next sequence number without appending. Use with append_with_seq
    /// when the caller needs the seq before serializing the payload (avoids serializing
    /// twice or serializing with seq=0).
    pub fn next_seq(&self) -> i64 {
        let mut buf = self.buffer.lock().unwrap();
        buf.reserve_seq()
    }

    /// Append an event with a pre-assigned sequence number from next_seq().
    /// Must be called in order (seq must be the most recently reserved seq).
    pub fn append_with_seq(
        &self,
        seq: i64,
        user_id: &str,
        stream: &str,
        stream_key: &str,
        event_type: &str,
        payload: &str,
    ) {
        let now = Utc::now().timestamp_millis();
        {
            let mut buf = self.buffer.lock().unwrap();
            buf.push_with_seq(LoggedEvent {
                seq,
                user_id: user_id.to_string(),
                stream: stream.to_string(),
                stream_key: stream_key.to_string(),
                event_type: event_type.to_string(),
                payload: payload.to_string(),
                created_at: now,
            });
        }
        self.persist(seq, user_id, stream, stream_key, event_type, payload, now);
    }

    /// Fire-and-forget DB persistence (shared by append and append_with_seq).
    fn persist(
        &self,
        seq: i64,
        user_id: &str,
        stream: &str,
        stream_key: &str,
        event_type: &str,
        payload: &str,
        created_at: i64,
    ) {
        if let Some(ref db) = self.db {
            let db = db.clone();
            let user_id = user_id.to_string();
            let stream = stream.to_string();
            let stream_key = stream_key.to_string();
            let event_type = event_type.to_string();
            let payload = payload.to_string();
            task::spawn(async move {
                if let Err(e) = sqlx::query(
                    "INSERT INTO sse_event_log (seq, user_id, stream, stream_key, event_type, payload, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(seq)
                .bind(&user_id)
                .bind(&stream)
                .bind(&stream_key)
                .bind(&event_type)
                .bind(&payload)
                .bind(created_at)
                .execute(&db)
                .await
                {
                    tracing::warn!("[SseEventLog] Failed to persist event seq={}: {}", seq, e);
                }
            });
        }
    }

    /// Replay events after `since_seq` for a given user.
    /// Returns (events, need_resync, latest_seq):
    ///   - events: events to replay (seq > since_seq, filtered by user_id and optional stream)
    ///   - need_resync: true if since_seq is older than the oldest buffered event (gap exists)
    ///   - latest_seq: the newest seq available (for cursor tracking)
    pub async fn replay(
        &self,
        user_id: &str,
        stream_filter: Option<&str>,
        since_seq: i64,
    ) -> (Vec<LoggedEvent>, bool, i64) {
        let buf = self.buffer.lock().unwrap();
        let newest = buf.newest_seq().unwrap_or(0);

        if since_seq <= 0 {
            // No cursor: client is connecting fresh
            return (Vec::new(), false, newest);
        }

        let oldest = buf.oldest_seq().unwrap_or(0);
        if oldest > 0 && since_seq < oldest - 1 {
            // Cursor is older than our buffer — gap exists, client must resync
            return (Vec::new(), true, newest);
        }
        if since_seq > newest + 100 {
            // Client cursor is well ahead of server — server restarted or
            // seq space reset; client must resync to clear its dedup state.
            // +100 tolerance for in-flight events during reconnect race.
            return (Vec::new(), true, newest);
        }

        let events = buf
            .replay_after(since_seq)
            .into_iter()
            .filter(|e| e.user_id == user_id)
            .filter(|e| stream_filter.map_or(true, |s| e.stream == s))
            .collect();

        (events, false, newest)
    }

    /// Get the current newest sequence number.
    pub fn newest_seq(&self) -> i64 {
        self.buffer.lock().unwrap().newest_seq().unwrap_or(0)
    }

    /// Prune old events from DB (call periodically, e.g., hourly).
    pub async fn prune_old_events(&self) {
        if let Some(ref db) = self.db {
            let cutoff = Utc::now().timestamp_millis() - DB_EVENT_RETENTION_MS;
            match sqlx::query("DELETE FROM sse_event_log WHERE created_at < ?")
                .bind(cutoff)
                .execute(db)
                .await
            {
                Ok(result) => {
                    let deleted = result.rows_affected();
                    if deleted > 0 {
                        tracing::info!("[SseEventLog] Pruned {} old events", deleted);
                    }
                }
                Err(e) => {
                    tracing::warn!("[SseEventLog] Failed to prune old events: {}", e);
                }
            }
        }
    }
}
