use std::{convert::Infallible, time::Duration};

use axum::{
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::Stream;

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
    // 预算检查
    crate::billing::budget::handlers::check_budget_before_ai_call(&state.db, &user_id.0, "task").await?;
    
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
pub async fn stream_tasks(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(filter): Query<AiTaskFilter>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let user_id = user_id.0;
    let initial_tasks = state.ai_runtime.list_tasks(&user_id, &filter).await;
    let mut rx = state.ai_runtime.subscribe();

    let sse_stream = async_stream::stream! {
        yield Ok(Event::default()
            .event("snapshot")
            .data(to_json(&serde_json::json!({ "tasks": initial_tasks }))));

        loop {
            match rx.recv().await {
                Ok(envelope) => {
                    if envelope.user_id != user_id || !task_matches_filter(&envelope.event.task, &filter) {
                        continue;
                    }

                    yield Ok(
                        Event::default()
                            .event(&envelope.event.event_type)
                            .data(to_json(&envelope.event)),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    yield Ok(
                        Event::default()
                            .event("lagged")
                            .data(to_json(&serde_json::json!({ "skipped": skipped }))),
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
