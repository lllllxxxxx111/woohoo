//! API handlers for routing event queries and endpoint health summaries

use axum::{
    extract::{Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    ai::router::{
        get_endpoint_health, query_routing_events, EndpointHealthSummary, RoutingEventFilter,
        RoutingEventRecord,
    },
    auth::middleware::UserId,
    error::AppResult,
    AppState,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEventsQuery {
    pub endpoint_id: Option<String>,
    pub capability: Option<String>,
    pub status: Option<String>,
    pub operation: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEventsResponse {
    pub events: Vec<RoutingEventRecord>,
    pub total: i64,
}

/// GET /api/ai/routing/events
/// Query recent routing audit events with filters and pagination
pub async fn list_routing_events(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Query(query): Query<RoutingEventsQuery>,
) -> AppResult<Json<RoutingEventsResponse>> {
    let filter = RoutingEventFilter {
        endpoint_id: query.endpoint_id,
        capability: query.capability,
        status: query.status,
        operation: query.operation,
        limit: query.limit,
        offset: query.offset,
    };

    let events = query_routing_events(&state.db, &user_id.0, &filter).await?;

    // Build filtered count query matching the same filters
    let mut count_query = String::from("SELECT COUNT(*) FROM ai_routing_events WHERE user_id = ?");
    let mut count_binds: Vec<String> = vec![user_id.0.clone()];
    if let Some(ref ep) = filter.endpoint_id {
        count_query.push_str(" AND (candidate_endpoint_id = ? OR final_endpoint_id = ?)");
        count_binds.push(ep.clone());
        count_binds.push(ep.clone());
    }
    if let Some(ref cap) = filter.capability {
        count_query.push_str(" AND capability = ?");
        count_binds.push(cap.clone());
    }
    if let Some(ref status) = filter.status {
        count_query.push_str(" AND status = ?");
        count_binds.push(status.clone());
    }
    if let Some(ref op) = filter.operation {
        count_query.push_str(" AND operation = ?");
        count_binds.push(op.clone());
    }
    let mut total_q = sqlx::query_as::<_, (i64,)>(&count_query);
    for b in &count_binds {
        total_q = total_q.bind(b);
    }
    let total = total_q.fetch_one(&state.db).await?;

    Ok(Json(RoutingEventsResponse {
        events,
        total: total.0,
    }))
}

/// GET /api/ai/routing/health
/// Get endpoint health summaries derived from recent routing events
pub async fn endpoint_health_summary(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
) -> AppResult<Json<Vec<EndpointHealthSummary>>> {
    let summaries = get_endpoint_health(&state.db, &user_id.0).await?;
    Ok(Json(summaries))
}
