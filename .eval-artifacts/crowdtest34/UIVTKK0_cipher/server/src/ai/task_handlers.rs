use std::{convert::Infallible, time::Duration};

use axum::{
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::Stream;
use serde::Deserialize;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    sse_event_log::LoggedEvent,
    AppState,
};

use super::{
    config::{AiChatReq, AiTask, AiTaskEvent, AiTaskFilter},
    handlers::{
        enqueue_ai_task_for_request, resolve_stream_fallback_mode, task_matches_filter, to_json,
    },
    usage::{self, AiUsageOperation, AiUsageQuery},
};

/// Query params for the task SSE stream
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskStreamQuery {
    #[serde(flatten)]
    pub filter: AiTaskFilter,
    /// Client's last seen event sequence number. If provided, server replays
    /// events after this cursor before switching to live broadcast.
    pub cursor: Option<i64>,
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

/// GET /api/ai/tasks/stream
///
/// SSE endpoint with cursor-based replay. Clients send Last-Event-ID header or
/// `cursor` query param to resume from a specific event. If the cursor is too
/// old (buffer expired), a `resync` event is sent telling the client to do a
/// full refresh via snapshot.
pub async fn stream_tasks(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    headers: HeaderMap,
    Query(query): Query<TaskStreamQuery>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let user_id = user_id.0;

    // Determine cursor from Last-Event-ID header or query param
    let cursor = query.cursor.or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok())
    });

    // Subscribe to broadcast FIRST to avoid missing events between snapshot and live stream.
    // Any events that arrive between subscription and snapshot will be in the broadcast buffer
    // AND in the event log; replay from the event log covers this gap (client dedupes by eventSeq).
    let mut rx = state.ai_runtime.subscribe();
    let filter = query.filter.clone();

    // Check if we can replay from cursor (after subscribing, so any events that arrived
    // between subscription start and here are in the buffer)
    let (replay_events, need_resync, replay_newest_seq) = state
        .sse_event_log
        .replay(&user_id, Some("ai_task"), cursor.unwrap_or(0))
        .await;

    // Now take snapshot (authoritative task state after subscribe + replay position)
    let initial_tasks = state
        .ai_runtime
        .list_tasks(&user_id, &filter)
        .await;

    let sse_stream = async_stream::stream! {
        // Recommended reconnect interval (ms) for clients
        yield Ok(Event::default().retry(Duration::from_millis(2000)));

        if need_resync {
            // Cursor is too old — tell client to resync via snapshot
            yield Ok(Event::default()
                .event("resync")
                .id("0")
                .data(to_json(&serde_json::json!({
                    "reason": "cursor_expired",
                    "message": "事件游标已过期，请通过 snapshot 重新同步"
                }))));
        }

        // Send initial snapshot (authoritative state)
        let snapshot_seq = state.sse_event_log.newest_seq();
        let snapshot_data = serde_json::json!({
            "tasks": initial_tasks,
            "cursor": snapshot_seq,
        });
        yield Ok(Event::default()
            .event("snapshot")
            .id(snapshot_seq.to_string())
            .data(to_json(&snapshot_data)));

        // Replay events that occurred after the client's cursor but before snapshot
        // (dedup: client should have seen events up to cursor, so only send newer ones)
        for logged in &replay_events {
            // Only replay if event matches filter
            if let Ok(event) = serde_json::from_str::<AiTaskEvent>(&logged.payload) {
                if !task_matches_filter(&event.task, &filter) {
                    continue;
                }
                // Skip snapshot-level events; snapshot already reflects latest state
                if logged.event_type == "snapshot" {
                    continue;
                }
                yield Ok(Event::default()
                    .event(&logged.event_type)
                    .id(logged.seq.to_string())
                    .data(logged.payload.clone()));
            }
        }

        // Forward live events from broadcast
        loop {
            match rx.recv().await {
                Ok(envelope) => {
                    if envelope.user_id != user_id || !task_matches_filter(&envelope.event.task, &filter) {
                        continue;
                    }

                    let event_id = if envelope.event.event_seq > 0 {
                        envelope.event.event_seq.to_string()
                    } else {
                        // Fallback: assign a fresh seq if the event wasn't tagged
                        let seq = state.sse_event_log.append(
                            &envelope.user_id,
                            "ai_task",
                            &envelope.event.task.id,
                            &envelope.event.event_type,
                            &to_json(&envelope.event),
                        );
                        seq.to_string()
                    };

                    yield Ok(
                        Event::default()
                            .event(&envelope.event.event_type)
                            .id(event_id)
                            .data(to_json(&envelope.event)),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    // Client fell behind the broadcast buffer. The event log
                    // likely still has events (larger buffer), so send a lagged
                    // event suggesting reconnect with cursor for replay.
                    let seq = state.sse_event_log.newest_seq();
                    yield Ok(
                        Event::default()
                            .event("lagged")
                            .id(seq.to_string())
                            .data(to_json(&serde_json::json!({
                                "skipped": skipped,
                                "cursor": seq,
                                "message": "检测到事件丢失，请使用 cursor 重连以获取错过的事件"
                            }))),
                    );
                    // Break to let the client reconnect with the new cursor
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(sse_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}
