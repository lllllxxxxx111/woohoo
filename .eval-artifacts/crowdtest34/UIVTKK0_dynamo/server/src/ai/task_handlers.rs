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
    runtime::ReplayResult,
    usage::{self, AiUsageOperation, AiUsageQuery},
};

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
/// SSE endpoint supporting cursor-based replay and resync:
/// - If `Last-Event-ID` header or `cursor` query param is provided, replays missed events.
/// - If cursor is too old (buffer evicted), emits a `resync` event with the oldest available seq.
/// - All live events include `id:` field for browser auto-reconnect with Last-Event-ID.
/// - `lagged` event indicates broadcast overflow; client should reconnect.
pub async fn stream_tasks(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(filter): Query<AiTaskFilter>,
    headers: HeaderMap,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let user_id = user_id.0;

    // Determine cursor from header or query param
    let cursor: Option<i64> = filter
        .cursor
        .or_else(|| {
            headers
                .get("last-event-id")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<i64>().ok())
        });

    // Subscribe FIRST to avoid missing events between snapshot and live stream.
    // Any events arriving after subscribe() but before list_tasks() will be
    // caught by rx and deduplicated against the snapshot via seq numbers.
    let mut rx = state.ai_runtime.subscribe();
    let initial_tasks = state.ai_runtime.list_tasks(&user_id, &filter).await;
    let runtime = state.ai_runtime.clone();
    let uid = user_id.clone();
    let filter_clone = filter.clone();

    let sse_stream = async_stream::stream! {
        // If a cursor is provided, attempt replay first
        if let Some(after_seq) = cursor {
            match runtime.replay_events(&uid, after_seq).await {
                ReplayResult::Events(events) => {
                    for event in &events {
                        if !task_matches_filter(&event.task, &filter_clone) {
                            continue;
                        }
                        let id_str = event.seq.to_string();
                        let data_str = to_json(event);
                        yield Ok(
                            Event::default()
                                .id(id_str)
                                .event(&event.event_type)
                                .data(data_str),
                        );
                    }

                    // Always send a snapshot after replay so the client can
                    // reconcile tasks that may have changed state (e.g., after
                    // server restart when buffer was empty but tasks were
                    // recovered from DB with failed status). The cursor field
                    // tells the client the authoritative current seq.
                    let fresh_tasks = runtime.list_tasks(&uid, &filter_clone).await;
                    let fresh_cursor = runtime.current_seq();
                    yield Ok(
                        Event::default()
                            .id(fresh_cursor.to_string())
                            .event("snapshot")
                            .data(to_json(&json!({ "tasks": fresh_tasks, "cursor": fresh_cursor }))),
                    );
                }
                ReplayResult::ResyncNeeded { oldest_available } => {
                    // Cursor is too old; tell client to resync from snapshot.
                    // Send the fresh cursor as id so client's lastEventId is
                    // updated even if it disconnects before the snapshot arrives.
                    let fresh_tasks = runtime.list_tasks(&uid, &filter_clone).await;
                    let fresh_cursor = runtime.current_seq();
                    yield Ok(
                        Event::default()
                            .id(fresh_cursor.to_string())
                            .event("resync")
                            .data(to_json(&json!({
                                "reason": "cursor_expired",
                                "oldestAvailable": oldest_available,
                                "cursor": fresh_cursor,
                                "message": "事件游标已过期，请从快照重新同步"
                            }))),
                    );
                    // Then send a fresh snapshot with cursor anchor
                    yield Ok(
                        Event::default()
                            .id(fresh_cursor.to_string())
                            .event("snapshot")
                            .data(to_json(&json!({ "tasks": fresh_tasks, "cursor": fresh_cursor }))),
                    );
                    // Fall through to live event loop
                }
            }
        } else {
            // No cursor: send initial snapshot with current seq as cursor anchor
            let current_seq = runtime.current_seq();
            yield Ok(
                Event::default()
                    .id(current_seq.to_string())
                    .event("snapshot")
                    .data(to_json(&json!({ "tasks": initial_tasks, "cursor": current_seq }))),
            );
        }

        loop {
            match rx.recv().await {
                Ok(envelope) => {
                    if envelope.user_id != user_id || !task_matches_filter(&envelope.event.task, &filter) {
                        continue;
                    }

                    let id_str = envelope.event.seq.to_string();
                    yield Ok(
                        Event::default()
                            .id(id_str)
                            .event(&envelope.event.event_type)
                            .data(to_json(&envelope.event)),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    // Client fell behind the broadcast buffer (1024 slots).
                    // Signal resync rather than silently losing events.
                    // Pre-compute cursor so the resync event carries an id.
                    let fresh_tasks = state.ai_runtime.list_tasks(&user_id, &filter).await;
                    let fresh_cursor = state.ai_runtime.current_seq();
                    yield Ok(
                        Event::default()
                            .id(fresh_cursor.to_string())
                            .event("resync")
                            .data(to_json(&json!({
                                "reason": "lagged",
                                "skipped": skipped,
                                "cursor": fresh_cursor,
                                "message": "事件流溢出，请从快照重新同步"
                            }))),
                    );
                    // Send fresh snapshot immediately with cursor anchor
                    yield Ok(
                        Event::default()
                            .id(fresh_cursor.to_string())
                            .event("snapshot")
                            .data(to_json(&json!({ "tasks": fresh_tasks, "cursor": fresh_cursor }))),
                    );
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
