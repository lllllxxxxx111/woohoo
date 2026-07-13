use std::{convert::Infallible, time::Duration};

use axum::{
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::Stream;
use serde_json::json;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    AppState,
};

use super::{
    config::{AiChatReq, AiTask, AiTaskFilter},
    handlers::{
        enqueue_ai_task_for_request, resolve_stream_fallback_mode, task_matches_filter, to_json,
    },
    runtime::BufferedEvent,
    usage::{self, AiUsageOperation, AiUsageQuery},
};

/// Internal row struct for durable event replay queries.
#[derive(Debug, sqlx::FromRow)]
struct PersistedEventRow {
    event_seq: i64,
    event_type: String,
    task_json: String,
    content_delta: Option<String>,
}

/// GET /api/ai/tasks
pub async fn list_tasks(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(filter): Query<AiTaskFilter>,
) -> AppResult<Json<Vec<AiTask>>> {
    let tasks = state.ai_runtime.list_tasks(&user_id.0, &filter).await;
    Ok(Json(tasks))
}

/// GET /api/ai/tasks/:id
pub async fn get_task(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<AiTask>> {
    let task = state
        .ai_runtime
        .get_task(&user_id.0, &id)
        .await
        .ok_or_else(|| AppError::NotFound("任务不存在".into()))?;

    Ok(Json(task))
}

/// DELETE /api/ai/tasks/:id - 取消正在运行或排队的任务
pub async fn cancel_task(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<Json<AiTask>> {
    let task = state.ai_runtime.cancel_task(&user_id.0, &id, None).await;

    match task {
        Some(t) => Ok(Json(t)),
        None => match state.ai_runtime.get_task(&user_id.0, &id).await {
            Some(t) => Err(AppError::Validation(format!(
                "任务无法取消，当前状态: {:?}",
                t.status
            ))),
            None => Err(AppError::NotFound("任务不存在".into())),
        },
    }
}

/// DELETE /api/ai/tasks/:id/remove - 彻底删除已完成的任务
pub async fn remove_task(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let removed = state.ai_runtime.remove_task(&user_id.0, &id).await;

    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("任务不存在或无权删除".into()))
    }
}

/// GET /api/ai/usage/summary
pub async fn usage_summary(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<AiUsageQuery>,
) -> AppResult<Json<usage::AiUsageSummary>> {
    let summary = usage::build_summary(&state.db, &user_id.0, query).await?;
    Ok(Json(summary))
}

/// GET /api/ai/usage/records
pub async fn usage_records(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<AiUsageQuery>,
) -> AppResult<Json<Vec<usage::AiUsageRecord>>> {
    let records = usage::list_records(&state.db, &user_id.0, query).await?;
    Ok(Json(records))
}

/// POST /api/ai/tasks
pub async fn create_task(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    headers: HeaderMap,
    Json(req): Json<AiChatReq>,
) -> AppResult<(StatusCode, Json<AiTask>)> {
    let stream_fallback_mode =
        resolve_stream_fallback_mode(req.force_stream_fallback, Some(&headers));
    let task = enqueue_ai_task_for_request(
        &state,
        &user_id.0,
        req,
        AiUsageOperation::Task,
        stream_fallback_mode,
    )
    .await?;

    Ok((StatusCode::ACCEPTED, Json(task)))
}

/// Parse the Last-Event-ID header or cursor query param into a sequence number.
fn parse_cursor(headers: &HeaderMap, query_cursor: Option<i64>) -> Option<i64> {
    if let Some(c) = query_cursor {
        return Some(c);
    }
    headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
}

/// Build an SSE event with a stable id field for replay.
/// Sets retry to 3000ms so clients reconnect quickly after disconnect.
fn sequenced_event(seq: i64, event_type: &str, data: &str) -> Event {
    Event::default()
        .id(seq.to_string())
        .event(event_type)
        .data(data)
        .retry(std::time::Duration::from_secs(3))
}

/// GET /api/ai/tasks/stream
///
/// Supports cursor-based replay via:
/// - `Last-Event-ID` header (standard SSE)
/// - `?cursor=<seq>` query parameter
///
/// If the cursor is before the in-memory buffer start, we attempt replay from
/// the durable ai_task_events table. If that also fails (events purged), a
/// `resync` event is emitted telling the client to do a full state refresh.
pub async fn stream_tasks(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(filter): Query<AiTaskFilter>,
    headers: HeaderMap,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let user_id = user_id.0;
    let cursor = parse_cursor(&headers, filter.cursor);
    let mut rx = state.ai_runtime.subscribe();
    let db = state.db.clone();

    let sse_stream = async_stream::stream! {
        // Phase 1: Replay buffered events or send resync signal
        if let Some(after_seq) = cursor {
            let (replay_events, min_seq) = state.ai_runtime.replay_events(&user_id, after_seq).await;

            // Determine if we need DB replay:
            // 1. Cursor before in-memory buffer window (after_seq < min_seq, min_seq > 0)
            // 2. Buffer is empty after restart (min_seq == 0 and after_seq > 0) — must check DB
            let buffer_empty_after_restart = min_seq == 0 && after_seq > 0;
            let cursor_before_buffer = min_seq > 0 && after_seq < min_seq;

            if buffer_empty_after_restart || cursor_before_buffer {
                // Cursor is before the in-memory buffer start or buffer is empty.
                // Fall back to durable DB replay first, then replay remaining buffered events.
                let db_replay = replay_persisted_events(&db, &user_id, after_seq, &filter).await;

                if !db_replay.is_empty() {
                    let mut max_db_seq = after_seq;
                    for (seq, event_type, data_json) in &db_replay {
                        max_db_seq = max_db_seq.max(*seq);
                        yield Ok(sequenced_event(*seq, event_type, data_json));
                    }
                    // After DB replay, also replay any in-memory buffer events newer than DB max
                    for BufferedEvent { seq, event_type, data_json, .. } in &replay_events {
                        if *seq > max_db_seq {
                            if let Ok(evt) = serde_json::from_str::<serde_json::Value>(data_json) {
                                if let Some(task_val) = evt.get("task") {
                                    if let Ok(task) = serde_json::from_value::<AiTask>(task_val.clone()) {
                                        if !task_matches_filter(&task, &filter) {
                                            continue;
                                        }
                                    }
                                }
                            }
                            yield Ok(sequenced_event(*seq, event_type, data_json));
                        }
                    }
                } else {
                    // No events available in DB beyond cursor — compute oldestAvailableSeq
                    // from DB (min event_seq for this user) for a useful resync signal.
                    let oldest_db_seq: Option<i64> = sqlx::query_scalar(
                        "SELECT MIN(event_seq) FROM ai_task_events WHERE user_id = ?"
                    )
                    .bind(&user_id)
                    .fetch_optional(&db)
                    .await
                    .ok()
                    .flatten();
                    let oldest_available = oldest_db_seq.unwrap_or(min_seq);
                    let resync_data = to_json(&json!({
                        "reason": if buffer_empty_after_restart { "server_restart" } else { "cursor_expired" },
                        "oldestAvailableSeq": oldest_available,
                        "requestedSeq": after_seq,
                        "message": "事件游标已过期，请刷新任务状态"
                    }));
                    yield Ok(sequenced_event(
                        state.ai_runtime.current_seq(),
                        "resync",
                        &resync_data,
                    ));
                }
            } else {
                // Replay buffered events (cursor within buffer window)
                for BufferedEvent { seq, event_type, data_json, .. } in replay_events {
                    if let Ok(evt) = serde_json::from_str::<serde_json::Value>(&data_json) {
                        if let Some(task_val) = evt.get("task") {
                            if let Ok(task) = serde_json::from_value::<AiTask>(task_val.clone()) {
                                if !task_matches_filter(&task, &filter) {
                                    continue;
                                }
                            }
                        }
                    }
                    yield Ok(sequenced_event(seq, &event_type, &data_json));
                }
            }
        } else {
            // No cursor: send initial snapshot of current state
            let initial_tasks = state.ai_runtime.list_tasks(&user_id, &filter).await;
            let snapshot_data = to_json(&json!({ "tasks": initial_tasks }));
            yield Ok(sequenced_event(
                state.ai_runtime.current_seq(),
                "snapshot",
                &snapshot_data,
            ));
        }

        // Phase 2: Live events from broadcast channel
        loop {
            match rx.recv().await {
                Ok(envelope) => {
                    if envelope.user_id != user_id || !task_matches_filter(&envelope.event.task, &filter) {
                        continue;
                    }

                    yield Ok(sequenced_event(
                        envelope.seq,
                        &envelope.event.event_type,
                        &to_json(&envelope.event),
                    ));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    // Client fell behind the broadcast channel.
                    // Send lagged event with current seq; client should reconnect
                    // with Last-Event-ID set to this seq to resume via DB replay.
                    let current = state.ai_runtime.current_seq().saturating_sub(1);
                    let lagged_data = to_json(&json!({
                        "skipped": skipped,
                        "lastEventId": current,
                        "hint": "reconnect with Last-Event-ID to replay missed events"
                    }));
                    yield Ok(Event::default()
                        .id(current.to_string())
                        .event("lagged")
                        .retry(std::time::Duration::from_secs(1))
                        .data(lagged_data));
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    // Broadcast channel closed (server shutdown) — send done and close.
                    let current = state.ai_runtime.current_seq().saturating_sub(1);
                    yield Ok(Event::default()
                        .id(current.to_string())
                        .event("done")
                        .retry(std::time::Duration::from_secs(3))
                        .data("{\"reason\":\"server_shutdown\"}"));
                    break;
                }
            }
        }
    };

    Ok(Sse::new(sse_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

/// Replay events from the durable ai_task_events table for a user after a given seq.
/// Returns (seq, event_type, data_json) tuples for events matching the filter.
async fn replay_persisted_events(
    db: &sqlx::SqlitePool,
    user_id: &str,
    after_seq: i64,
    filter: &AiTaskFilter,
) -> Vec<(i64, String, String)> {
    let rows: Vec<PersistedEventRow> = match sqlx::query_as::<_, PersistedEventRow>(
        "SELECT event_seq, event_type, task_json, content_delta \
         FROM ai_task_events \
         WHERE user_id = ? AND event_seq > ? \
         ORDER BY event_seq ASC LIMIT 500"
    )
    .bind(user_id)
    .bind(after_seq)
    .fetch_all(db)
    .await {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    let mut result = Vec::new();
    for row in rows {
        // Apply filter
        if let Ok(task) = serde_json::from_str::<AiTask>(&row.task_json) {
            if !task_matches_filter(&task, filter) {
                continue;
            }
            let event_json = serde_json::json!({
                "eventType": row.event_type,
                "task": task,
                "contentDelta": row.content_delta,
            });
            result.push((row.event_seq, row.event_type, event_json.to_string()));
        }
    }
    result
}
