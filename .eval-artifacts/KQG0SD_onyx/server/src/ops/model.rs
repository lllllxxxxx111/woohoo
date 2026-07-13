use crate::ai::runtime::RuntimeTaskSnapshot;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpsListQuery {
    pub limit: Option<usize>,
    pub include_resolved: Option<bool>,
}

#[derive(Debug, Clone, FromRow)]
pub struct RuntimeHeartbeatRow {
    pub component_key: String,
    pub component_type: String,
    pub status: String,
    pub summary: String,
    pub metrics_json: Option<String>,
    pub last_seen_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHeartbeat {
    pub component_key: String,
    pub component_type: String,
    pub status: String,
    pub summary: String,
    pub metrics: Option<Value>,
    pub last_seen_at: String,
    pub updated_at: String,
}

impl From<RuntimeHeartbeatRow> for RuntimeHeartbeat {
    fn from(value: RuntimeHeartbeatRow) -> Self {
        Self {
            component_key: value.component_key,
            component_type: value.component_type,
            status: value.status,
            summary: value.summary,
            metrics: parse_json_value(value.metrics_json),
            last_seen_at: value.last_seen_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct InspectionFindingRow {
    pub id: String,
    pub finding_key: String,
    pub user_id: Option<String>,
    pub category: String,
    pub severity: String,
    pub status: String,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub summary: String,
    pub details_json: Option<String>,
    pub occurrence_count: i64,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionFinding {
    pub id: String,
    pub finding_key: String,
    pub user_id: Option<String>,
    pub category: String,
    pub severity: String,
    pub status: String,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub summary: String,
    pub details: Option<Value>,
    pub occurrence_count: i64,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub resolved_at: Option<String>,
}

impl From<InspectionFindingRow> for InspectionFinding {
    fn from(value: InspectionFindingRow) -> Self {
        Self {
            id: value.id,
            finding_key: value.finding_key,
            user_id: value.user_id,
            category: value.category,
            severity: value.severity,
            status: value.status,
            scope_type: value.scope_type,
            scope_id: value.scope_id,
            summary: value.summary,
            details: parse_json_value(value.details_json),
            occurrence_count: value.occurrence_count,
            first_seen_at: value.first_seen_at,
            last_seen_at: value.last_seen_at,
            resolved_at: value.resolved_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureWindowSnapshot {
    pub window_minutes: i64,
    pub request_count: i64,
    pub failure_count: i64,
    pub failure_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSupportSummary {
    pub configured_channels: i64,
    pub enabled_channels: i64,
    pub queued_events: i64,
    pub failed_events: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct NotificationChannelRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub channel_type: String,
    pub target: String,
    pub config_json: Option<String>,
    pub is_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationChannel {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub channel_type: String,
    pub target: String,
    pub config: Option<Value>,
    pub is_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<NotificationChannelRow> for NotificationChannel {
    fn from(value: NotificationChannelRow) -> Self {
        Self {
            id: value.id,
            user_id: value.user_id,
            name: value.name,
            channel_type: value.channel_type,
            target: value.target,
            config: parse_json_value(value.config_json),
            is_enabled: value.is_enabled,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct NotificationEventRow {
    pub id: String,
    pub user_id: Option<String>,
    pub channel_id: Option<String>,
    pub finding_id: Option<String>,
    pub event_type: String,
    pub status: String,
    pub dedupe_key: String,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<String>,
    pub payload_json: Option<String>,
    pub response_body: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub sent_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEvent {
    pub id: String,
    pub user_id: Option<String>,
    pub channel_id: Option<String>,
    pub finding_id: Option<String>,
    pub event_type: String,
    pub status: String,
    pub dedupe_key: String,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<String>,
    pub payload: Option<Value>,
    pub response_body: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub sent_at: Option<String>,
}

impl From<NotificationEventRow> for NotificationEvent {
    fn from(value: NotificationEventRow) -> Self {
        Self {
            id: value.id,
            user_id: value.user_id,
            channel_id: value.channel_id,
            finding_id: value.finding_id,
            event_type: value.event_type,
            status: value.status,
            dedupe_key: value.dedupe_key,
            attempt_count: value.attempt_count,
            last_error: value.last_error,
            next_attempt_at: value.next_attempt_at,
            payload: parse_json_value(value.payload_json),
            response_body: value.response_body,
            created_at: value.created_at,
            updated_at: value.updated_at,
            sent_at: value.sent_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNotificationChannelReq {
    pub name: String,
    pub channel_type: String,
    pub target: String,
    pub config: Option<Value>,
    pub is_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotificationChannelReq {
    pub name: String,
    pub channel_type: String,
    pub target: String,
    pub config: Option<Value>,
    pub is_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestNotificationReq {
    pub channel_type: String,
    pub target: String,
    pub config: Option<Value>,
    pub title: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestNotificationResult {
    pub status: String,
    pub channel_type: String,
    pub response_body: Option<String>,
    pub event: NotificationEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsOverview {
    pub generated_at: String,
    pub heartbeats: Vec<RuntimeHeartbeat>,
    pub active_findings: Vec<InspectionFinding>,
    pub task_snapshot: RuntimeTaskSnapshot,
    pub recent_failures: FailureWindowSnapshot,
    pub notification_summary: NotificationSupportSummary,
}

pub fn parse_json_value(value: Option<String>) -> Option<Value> {
    value.and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}
