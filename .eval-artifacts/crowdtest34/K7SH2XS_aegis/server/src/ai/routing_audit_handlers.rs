//! API handlers for querying AI routing audit events.

use axum::{extract::Query, Json};
use serde::Deserialize;

use crate::{
    auth::middleware::UserId,
    error::AppResult,
    AppState,
};

use super::router::{
    list_routing_events, RoutingEventQuery, RoutingEventView, RoutingHealthSummary,
    get_routing_health_summary,
};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutingHealthQuery {
    pub hours: Option<i64>,
}

/// GET /api/ai/routing/events
pub async fn list_events(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Query(query): Query<RoutingEventQuery>,
) -> AppResult<Json<Vec<RoutingEventView>>> {
    let events = list_routing_events(&state.db, &user_id.0, &query).await?;
    Ok(Json(events))
}

/// GET /api/ai/routing/health
pub async fn health_summary(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Extension(user_id): axum::extract::Extension<UserId>,
    Query(query): Query<RoutingHealthQuery>,
) -> AppResult<Json<RoutingHealthSummary>> {
    let summary = get_routing_health_summary(&state.db, &user_id.0, query.hours.unwrap_or(24)).await?;
    Ok(Json(summary))
}
