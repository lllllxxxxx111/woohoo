use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::{client::ChatMessage, client::TokenUsage};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiUsageStatus {
    Success,
    Failed,
}

impl AiUsageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiUsageOperation {
    Chat,
    Stream,
    Task,
    Test,
}

impl AiUsageOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Stream => "stream",
            Self::Task => "task",
            Self::Test => "test",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiUsageTokenSource {
    Actual,
    Estimated,
    Unavailable,
}

impl AiUsageTokenSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Actual => "actual",
            Self::Estimated => "estimated",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiUsageResourceKind {
    Text,
    Image,
    Video,
    Audio,
    Document,
    Other,
}

impl AiUsageResourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Document => "document",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageNumbers {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub token_source: AiUsageTokenSource,
}

#[derive(Debug, Clone)]
pub struct RecordAiUsageInput {
    pub user_id: String,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub agent_id: Option<String>,
    pub endpoint_id: Option<String>,
    pub api_key_fingerprint: String,
    pub provider: String,
    pub model: Option<String>,
    pub operation: AiUsageOperation,
    pub status: AiUsageStatus,
    pub resource_kind: AiUsageResourceKind,
    pub output_items: i64,
    pub latency_ms: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub token_source: AiUsageTokenSource,
    pub input_chars: i64,
    pub output_chars: i64,
    pub request_fingerprint: String,
    pub attempt_group_key: String,
    /**
     * 触发来源：用于区分正常发送、编辑后发送、撤回后重新发送
     * - None: 正常发送（默认）
     * - Some("edit"): 编辑消息后发送
     * - Some("rewind"): 撤回消息后重新发送
     */
    pub trigger_source: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageQuery {
    pub days: Option<i64>,
    pub bucket: Option<String>,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub agent_id: Option<String>,
    pub endpoint_id: Option<String>,
    pub api_key_fingerprint: Option<String>,
    pub resource_kind: Option<String>,
    pub model: Option<String>,
    pub operation: Option<String>,
    pub status: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSummary {
    pub window: AiUsageWindow,
    pub totals: AiUsageTotals,
    pub series: Vec<AiUsageSeriesPoint>,
    pub by_endpoint: Vec<AiUsageBreakdownItem>,
    pub by_api_key: Vec<AiUsageBreakdownItem>,
    pub by_model: Vec<AiUsageBreakdownItem>,
    pub by_agent: Vec<AiUsageBreakdownItem>,
    pub by_project: Vec<AiUsageBreakdownItem>,
    pub by_operation: Vec<AiUsageBreakdownItem>,
    pub by_resource_kind: Vec<AiUsageBreakdownItem>,
    pub recent: Vec<AiUsageRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageWindow {
    pub from: Option<String>,
    pub to: String,
    pub days: Option<i64>,
    pub bucket: String,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub agent_id: Option<String>,
    pub endpoint_id: Option<String>,
    pub api_key_fingerprint: Option<String>,
    pub resource_kind: Option<String>,
    pub model: Option<String>,
    pub operation: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageTotals {
    pub request_count: i64,
    pub success_count: i64,
    pub failure_count: i64,
    pub avg_latency_ms: i64,
    pub max_latency_ms: i64,
    pub input_chars: i64,
    pub output_chars: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub actual_token_records: i64,
    pub estimated_token_records: i64,
    pub unavailable_token_records: i64,
    pub output_items: i64,
    pub attempt_group_count: i64,
    pub redo_request_count: i64,
    pub redo_total_tokens: i64,
    pub first_pass_success_count: i64,
    pub first_pass_success_tokens: i64,
    pub retry_success_count: i64,
    pub retry_success_tokens: i64,
    pub project_count: i64,
    pub conversation_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSeriesPoint {
    pub bucket_start: String,
    pub request_count: i64,
    pub success_count: i64,
    pub failure_count: i64,
    pub avg_latency_ms: i64,
    pub total_tokens: i64,
    pub output_items: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageBreakdownItem {
    pub key: String,
    pub label: String,
    pub request_count: i64,
    pub success_count: i64,
    pub failure_count: i64,
    pub avg_latency_ms: i64,
    pub total_tokens: i64,
    pub output_items: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub conversation_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub endpoint_id: Option<String>,
    pub endpoint_name: Option<String>,
    pub api_key_fingerprint: String,
    pub provider: String,
    pub model: Option<String>,
    pub operation: String,
    pub status: String,
    pub resource_kind: String,
    pub output_items: i64,
    pub request_fingerprint: String,
    pub attempt_index: i64,
    pub is_redo: bool,
    pub token_source: String,
    pub latency_ms: i64,
    pub input_chars: i64,
    pub output_chars: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub error_message: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
struct NormalizedUsageQuery {
    pub from_ts: Option<String>,
    pub bucket: UsageBucket,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub agent_id: Option<String>,
    pub endpoint_id: Option<String>,
    pub api_key_fingerprint: Option<String>,
    pub resource_kind: Option<String>,
    pub model: Option<String>,
    pub operation: Option<String>,
    pub status: Option<String>,
    pub limit: i64,
    pub days: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
enum UsageBucket {
    Hour,
    Day,
    Week,
    Month,
}

impl UsageBucket {
    fn as_str(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }

    fn sqlite_group_expr(self) -> &'static str {
        match self {
            Self::Hour => "substr(u.created_at, 1, 13) || ':00:00Z'",
            Self::Day => "substr(u.created_at, 1, 10) || 'T00:00:00Z'",
            Self::Week => "date(u.created_at, '-' || ((cast(strftime('%w', u.created_at) as integer) + 6) % 7) || ' days') || 'T00:00:00Z'",
            Self::Month => "substr(u.created_at, 1, 7) || '-01T00:00:00Z'",
        }
    }
}

#[derive(Debug, FromRow)]
struct TotalsRow {
    request_count: i64,
    success_count: i64,
    failure_count: i64,
    avg_latency_ms: Option<f64>,
    max_latency_ms: i64,
    input_chars: i64,
    output_chars: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    total_tokens: i64,
    actual_token_records: i64,
    estimated_token_records: i64,
    unavailable_token_records: i64,
    output_items: i64,
    attempt_group_count: i64,
    redo_request_count: i64,
    redo_total_tokens: i64,
    first_pass_success_count: i64,
    first_pass_success_tokens: i64,
    retry_success_count: i64,
    retry_success_tokens: i64,
    project_count: i64,
    conversation_count: i64,
}

#[derive(Debug, FromRow)]
struct SeriesRow {
    bucket_start: String,
    request_count: i64,
    success_count: i64,
    failure_count: i64,
    avg_latency_ms: Option<f64>,
    total_tokens: i64,
    output_items: i64,
}

#[derive(Debug, FromRow)]
struct BreakdownRow {
    key: String,
    label: String,
    request_count: i64,
    success_count: i64,
    failure_count: i64,
    avg_latency_ms: Option<f64>,
    total_tokens: i64,
    output_items: i64,
}

#[derive(Debug, FromRow)]
struct UsageRecordRow {
    id: String,
    project_id: Option<String>,
    project_name: Option<String>,
    conversation_id: Option<String>,
    agent_id: Option<String>,
    agent_name: Option<String>,
    endpoint_id: Option<String>,
    endpoint_name: Option<String>,
    api_key_fingerprint: String,
    provider: String,
    model: Option<String>,
    operation: String,
    status: String,
    resource_kind: String,
    output_items: i64,
    request_fingerprint: String,
    attempt_index: i64,
    is_redo: i64,
    token_source: String,
    latency_ms: i64,
    input_chars: i64,
    output_chars: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    total_tokens: i64,
    error_message: Option<String>,
    created_at: String,
}

pub async fn record(pool: &SqlitePool, input: RecordAiUsageInput) -> AppResult<()> {
    let attempt_index = if input.attempt_group_key.trim().is_empty() {
        1
    } else {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM ai_usage_events WHERE user_id = ? AND attempt_group_key = ?",
        )
        .bind(&input.user_id)
        .bind(&input.attempt_group_key)
        .fetch_one(pool)
        .await?
            + 1
    };
    /* 判断是否为重做请求。
    编辑和撤回后重新发送不算重做，只有用户主动重新发送相同/相似内容才算重做。 */
    let is_non_redo_trigger = matches!(
        input.trigger_source.as_deref(),
        Some("edit") | Some("rewind")
    );
    let is_redo = !is_non_redo_trigger && attempt_index > 1;

    sqlx::query(
        "INSERT INTO ai_usage_events (
             id, user_id, project_id, conversation_id, agent_id, endpoint_id,
             api_key_fingerprint, provider, model, operation, status, resource_kind,
             output_items, latency_ms,
             prompt_tokens, completion_tokens, total_tokens, token_source,
             input_chars, output_chars, request_fingerprint, attempt_group_key,
             attempt_index, is_redo, trigger_source, error_message
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(input.user_id)
    .bind(input.project_id)
    .bind(input.conversation_id)
    .bind(input.agent_id)
    .bind(input.endpoint_id)
    .bind(input.api_key_fingerprint)
    .bind(input.provider)
    .bind(input.model)
    .bind(input.operation.as_str())
    .bind(input.status.as_str())
    .bind(input.resource_kind.as_str())
    .bind(input.output_items.max(0))
    .bind(input.latency_ms)
    .bind(input.prompt_tokens)
    .bind(input.completion_tokens)
    .bind(input.total_tokens)
    .bind(input.token_source.as_str())
    .bind(input.input_chars)
    .bind(input.output_chars)
    .bind(input.request_fingerprint)
    .bind(input.attempt_group_key)
    .bind(attempt_index)
    .bind(if is_redo { 1 } else { 0 })
    .bind(input.trigger_source)
    .bind(input.error_message)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn build_summary(
    pool: &SqlitePool,
    user_id: &str,
    query: AiUsageQuery,
) -> AppResult<AiUsageSummary> {
    let query = normalize_query(query)?;
    let (
        totals,
        series,
        by_endpoint,
        by_api_key,
        by_model,
        by_agent,
        by_project,
        by_operation,
        by_resource_kind,
        recent,
    ) = tokio::try_join!(
        fetch_totals(pool, user_id, &query),
        fetch_series(pool, user_id, &query),
        fetch_breakdown(pool, user_id, &query, BreakdownKind::Endpoint),
        fetch_breakdown(pool, user_id, &query, BreakdownKind::ApiKey),
        fetch_breakdown(pool, user_id, &query, BreakdownKind::Model),
        fetch_breakdown(pool, user_id, &query, BreakdownKind::Agent),
        fetch_breakdown(pool, user_id, &query, BreakdownKind::Project),
        fetch_breakdown(pool, user_id, &query, BreakdownKind::Operation),
        fetch_breakdown(pool, user_id, &query, BreakdownKind::ResourceKind),
        list_records_with_query(pool, user_id, &query),
    )?;

    Ok(AiUsageSummary {
        window: AiUsageWindow {
            from: query.from_ts.clone(),
            to: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            days: query.days,
            bucket: query.bucket.as_str().to_string(),
            project_id: query.project_id.clone(),
            conversation_id: query.conversation_id.clone(),
            agent_id: query.agent_id.clone(),
            endpoint_id: query.endpoint_id.clone(),
            api_key_fingerprint: query.api_key_fingerprint.clone(),
            resource_kind: query.resource_kind.clone(),
            model: query.model.clone(),
            operation: query.operation.clone(),
            status: query.status.clone(),
        },
        totals,
        series,
        by_endpoint,
        by_api_key,
        by_model,
        by_agent,
        by_project,
        by_operation,
        by_resource_kind,
        recent,
    })
}

pub async fn list_records(
    pool: &SqlitePool,
    user_id: &str,
    query: AiUsageQuery,
) -> AppResult<Vec<AiUsageRecord>> {
    let query = normalize_query(query)?;
    list_records_with_query(pool, user_id, &query).await
}

pub fn estimate_tokens(content: &str) -> i64 {
    let chars = content.chars().count() as i64;
    ((chars + 3) / 4).max(1)
}

pub fn estimate_prompt_tokens(messages: &[ChatMessage]) -> i64 {
    messages
        .iter()
        .map(|message| estimate_tokens(&message.content))
        .sum::<i64>()
}

pub fn usage_from_response(
    messages: &[ChatMessage],
    content: &str,
    usage: Option<&TokenUsage>,
) -> UsageNumbers {
    match usage {
        Some(usage) => UsageNumbers {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            token_source: AiUsageTokenSource::Actual,
        },
        None => {
            let prompt_tokens = estimate_prompt_tokens(messages);
            let completion_tokens = estimate_tokens(content);
            UsageNumbers {
                prompt_tokens,
                completion_tokens,
                total_tokens: prompt_tokens + completion_tokens,
                token_source: AiUsageTokenSource::Estimated,
            }
        }
    }
}

pub fn unavailable_usage() -> UsageNumbers {
    UsageNumbers {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        token_source: AiUsageTokenSource::Unavailable,
    }
}

pub fn parse_resource_kind(value: Option<&str>) -> AppResult<AiUsageResourceKind> {
    match value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("text")
        .to_ascii_lowercase()
        .as_str()
    {
        "text" => Ok(AiUsageResourceKind::Text),
        "image" => Ok(AiUsageResourceKind::Image),
        "video" => Ok(AiUsageResourceKind::Video),
        "audio" => Ok(AiUsageResourceKind::Audio),
        "document" => Ok(AiUsageResourceKind::Document),
        "other" => Ok(AiUsageResourceKind::Other),
        other => Err(AppError::Validation(format!(
            "不支持的 outputKind/resourceKind: {}",
            other
        ))),
    }
}

pub fn normalize_output_items(value: Option<i64>) -> i64 {
    value.unwrap_or(1).clamp(1, 10_000)
}

pub fn fingerprint_api_key(api_key: &str) -> String {
    if api_key.trim().is_empty() {
        return "no-key".to_string();
    }

    short_hash(api_key.trim())
}

pub fn fingerprint_request(content: &str) -> String {
    short_hash(&normalize_prompt(content))
}

pub fn build_attempt_group_key(
    user_id: &str,
    project_id: Option<&str>,
    conversation_id: Option<&str>,
    agent_id: Option<&str>,
    resource_kind: AiUsageResourceKind,
    operation: AiUsageOperation,
    content: &str,
) -> String {
    let scope = conversation_id.or(project_id).unwrap_or(operation.as_str());
    let material = format!(
        "{}|{}|{}|{}|{}",
        user_id,
        scope,
        agent_id.unwrap_or("no-agent"),
        resource_kind.as_str(),
        normalize_prompt(content)
    );
    short_hash(&material)
}

fn normalize_query(query: AiUsageQuery) -> AppResult<NormalizedUsageQuery> {
    let days = query.days.map(|value| value.clamp(0, 365));
    let from_ts = days.and_then(|value| {
        if value <= 0 {
            None
        } else {
            Some(
                (Utc::now() - Duration::days(value))
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            )
        }
    });

    let bucket = match query
        .bucket
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("day")
        .to_ascii_lowercase()
        .as_str()
    {
        "hour" => UsageBucket::Hour,
        "day" => UsageBucket::Day,
        "week" => UsageBucket::Week,
        "month" => UsageBucket::Month,
        other => {
            return Err(AppError::Validation(format!(
                "不支持的 bucket: {}，仅支持 hour/day/week/month",
                other
            )))
        }
    };

    let operation = normalize_filter(query.operation);
    if let Some(operation) = operation.as_deref() {
        if !matches!(operation, "chat" | "stream" | "task" | "test") {
            return Err(AppError::Validation(format!(
                "不支持的 operation: {}",
                operation
            )));
        }
    }

    let status = normalize_filter(query.status);
    if let Some(status) = status.as_deref() {
        if !matches!(status, "success" | "failed") {
            return Err(AppError::Validation(format!("不支持的 status: {}", status)));
        }
    }

    let resource_kind = normalize_filter(query.resource_kind);
    if let Some(resource_kind) = resource_kind.as_deref() {
        let _ = parse_resource_kind(Some(resource_kind))?;
    }

    Ok(NormalizedUsageQuery {
        from_ts,
        bucket,
        project_id: normalize_filter(query.project_id),
        conversation_id: normalize_filter(query.conversation_id),
        agent_id: normalize_filter(query.agent_id),
        endpoint_id: normalize_filter(query.endpoint_id),
        api_key_fingerprint: normalize_filter(query.api_key_fingerprint),
        resource_kind,
        model: normalize_filter(query.model),
        operation,
        status,
        limit: query.limit.unwrap_or(20).clamp(1, 200) as i64,
        days,
    })
}

fn normalize_filter(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_prompt(value: &str) -> String {
    value
        .split_whitespace()
        .map(|chunk| chunk.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

async fn fetch_totals(
    pool: &SqlitePool,
    user_id: &str,
    query: &NormalizedUsageQuery,
) -> AppResult<AiUsageTotals> {
    let row = sqlx::query_as::<_, TotalsRow>(
        "SELECT
             COUNT(*) AS request_count,
             COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
             AVG(latency_ms) AS avg_latency_ms,
             COALESCE(MAX(latency_ms), 0) AS max_latency_ms,
             COALESCE(SUM(input_chars), 0) AS input_chars,
             COALESCE(SUM(output_chars), 0) AS output_chars,
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(total_tokens), 0) AS total_tokens,
             COALESCE(SUM(CASE WHEN token_source = 'actual' THEN 1 ELSE 0 END), 0) AS actual_token_records,
             COALESCE(SUM(CASE WHEN token_source = 'estimated' THEN 1 ELSE 0 END), 0) AS estimated_token_records,
             COALESCE(SUM(CASE WHEN token_source = 'unavailable' THEN 1 ELSE 0 END), 0) AS unavailable_token_records,
             COALESCE(SUM(output_items), 0) AS output_items,
             COUNT(DISTINCT attempt_group_key) AS attempt_group_count,
             COALESCE(SUM(CASE WHEN is_redo = 1 THEN 1 ELSE 0 END), 0) AS redo_request_count,
             COALESCE(SUM(CASE WHEN is_redo = 1 THEN total_tokens ELSE 0 END), 0) AS redo_total_tokens,
             COALESCE(SUM(CASE WHEN status = 'success' AND attempt_index = 1 THEN 1 ELSE 0 END), 0) AS first_pass_success_count,
             COALESCE(SUM(CASE WHEN status = 'success' AND attempt_index = 1 THEN total_tokens ELSE 0 END), 0) AS first_pass_success_tokens,
             COALESCE(SUM(CASE WHEN status = 'success' AND is_redo = 1 THEN 1 ELSE 0 END), 0) AS retry_success_count,
             COALESCE(SUM(CASE WHEN status = 'success' AND is_redo = 1 THEN total_tokens ELSE 0 END), 0) AS retry_success_tokens,
             COUNT(DISTINCT project_id) AS project_count,
             COUNT(DISTINCT conversation_id) AS conversation_count
         FROM ai_usage_events u
         WHERE u.user_id = ?
           AND (? IS NULL OR u.created_at >= ?)
           AND (? IS NULL OR u.project_id = ?)
           AND (? IS NULL OR u.conversation_id = ?)
           AND (? IS NULL OR u.agent_id = ?)
           AND (? IS NULL OR u.endpoint_id = ?)
           AND (? IS NULL OR u.api_key_fingerprint = ?)
           AND (? IS NULL OR u.resource_kind = ?)
           AND (? IS NULL OR u.model = ?)
           AND (? IS NULL OR u.operation = ?)
           AND (? IS NULL OR u.status = ?)",
    )
    .bind(user_id)
    .bind(query.from_ts.as_deref())
    .bind(query.from_ts.as_deref())
    .bind(query.project_id.as_deref())
    .bind(query.project_id.as_deref())
    .bind(query.conversation_id.as_deref())
    .bind(query.conversation_id.as_deref())
    .bind(query.agent_id.as_deref())
    .bind(query.agent_id.as_deref())
    .bind(query.endpoint_id.as_deref())
    .bind(query.endpoint_id.as_deref())
    .bind(query.api_key_fingerprint.as_deref())
    .bind(query.api_key_fingerprint.as_deref())
    .bind(query.resource_kind.as_deref())
    .bind(query.resource_kind.as_deref())
    .bind(query.model.as_deref())
    .bind(query.model.as_deref())
    .bind(query.operation.as_deref())
    .bind(query.operation.as_deref())
    .bind(query.status.as_deref())
    .bind(query.status.as_deref())
    .fetch_one(pool)
    .await?;

    Ok(AiUsageTotals {
        request_count: row.request_count,
        success_count: row.success_count,
        failure_count: row.failure_count,
        avg_latency_ms: row.avg_latency_ms.unwrap_or_default().round() as i64,
        max_latency_ms: row.max_latency_ms,
        input_chars: row.input_chars,
        output_chars: row.output_chars,
        prompt_tokens: row.prompt_tokens,
        completion_tokens: row.completion_tokens,
        total_tokens: row.total_tokens,
        actual_token_records: row.actual_token_records,
        estimated_token_records: row.estimated_token_records,
        unavailable_token_records: row.unavailable_token_records,
        output_items: row.output_items,
        attempt_group_count: row.attempt_group_count,
        redo_request_count: row.redo_request_count,
        redo_total_tokens: row.redo_total_tokens,
        first_pass_success_count: row.first_pass_success_count,
        first_pass_success_tokens: row.first_pass_success_tokens,
        retry_success_count: row.retry_success_count,
        retry_success_tokens: row.retry_success_tokens,
        project_count: row.project_count,
        conversation_count: row.conversation_count,
    })
}

async fn fetch_series(
    pool: &SqlitePool,
    user_id: &str,
    query: &NormalizedUsageQuery,
) -> AppResult<Vec<AiUsageSeriesPoint>> {
    let sql = format!(
        "SELECT
             {} AS bucket_start,
             COUNT(*) AS request_count,
             COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
             AVG(latency_ms) AS avg_latency_ms,
             COALESCE(SUM(total_tokens), 0) AS total_tokens,
             COALESCE(SUM(output_items), 0) AS output_items
         FROM ai_usage_events u
         WHERE u.user_id = ?
           AND (? IS NULL OR u.created_at >= ?)
           AND (? IS NULL OR u.project_id = ?)
           AND (? IS NULL OR u.conversation_id = ?)
           AND (? IS NULL OR u.agent_id = ?)
           AND (? IS NULL OR u.endpoint_id = ?)
           AND (? IS NULL OR u.api_key_fingerprint = ?)
           AND (? IS NULL OR u.resource_kind = ?)
           AND (? IS NULL OR u.model = ?)
           AND (? IS NULL OR u.operation = ?)
           AND (? IS NULL OR u.status = ?)
         GROUP BY bucket_start
         ORDER BY bucket_start ASC",
        query.bucket.sqlite_group_expr()
    );

    let rows = sqlx::query_as::<_, SeriesRow>(&sql)
        .bind(user_id)
        .bind(query.from_ts.as_deref())
        .bind(query.from_ts.as_deref())
        .bind(query.project_id.as_deref())
        .bind(query.project_id.as_deref())
        .bind(query.conversation_id.as_deref())
        .bind(query.conversation_id.as_deref())
        .bind(query.agent_id.as_deref())
        .bind(query.agent_id.as_deref())
        .bind(query.endpoint_id.as_deref())
        .bind(query.endpoint_id.as_deref())
        .bind(query.api_key_fingerprint.as_deref())
        .bind(query.api_key_fingerprint.as_deref())
        .bind(query.resource_kind.as_deref())
        .bind(query.resource_kind.as_deref())
        .bind(query.model.as_deref())
        .bind(query.model.as_deref())
        .bind(query.operation.as_deref())
        .bind(query.operation.as_deref())
        .bind(query.status.as_deref())
        .bind(query.status.as_deref())
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| AiUsageSeriesPoint {
            bucket_start: row.bucket_start,
            request_count: row.request_count,
            success_count: row.success_count,
            failure_count: row.failure_count,
            avg_latency_ms: row.avg_latency_ms.unwrap_or_default().round() as i64,
            total_tokens: row.total_tokens,
            output_items: row.output_items,
        })
        .collect())
}

#[derive(Debug, Clone, Copy)]
enum BreakdownKind {
    Endpoint,
    ApiKey,
    Model,
    Agent,
    Project,
    Operation,
    ResourceKind,
}

async fn fetch_breakdown(
    pool: &SqlitePool,
    user_id: &str,
    query: &NormalizedUsageQuery,
    kind: BreakdownKind,
) -> AppResult<Vec<AiUsageBreakdownItem>> {
    let sql = match kind {
        BreakdownKind::Endpoint => {
            "SELECT
                 COALESCE(u.endpoint_id, '') AS key,
                 CASE
                     WHEN u.endpoint_id IS NULL THEN '默认端点'
                     ELSE COALESCE(ep.name, '已删除端点')
                 END AS label,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
                 COALESCE(SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
                 AVG(u.latency_ms) AS avg_latency_ms,
                 COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items
             FROM ai_usage_events u
             LEFT JOIN ai_endpoints ep ON ep.id = u.endpoint_id AND ep.user_id = u.user_id
             WHERE u.user_id = ?
               AND (? IS NULL OR u.created_at >= ?)
               AND (? IS NULL OR u.project_id = ?)
               AND (? IS NULL OR u.conversation_id = ?)
               AND (? IS NULL OR u.agent_id = ?)
               AND (? IS NULL OR u.endpoint_id = ?)
               AND (? IS NULL OR u.api_key_fingerprint = ?)
               AND (? IS NULL OR u.resource_kind = ?)
               AND (? IS NULL OR u.model = ?)
               AND (? IS NULL OR u.operation = ?)
               AND (? IS NULL OR u.status = ?)
             GROUP BY u.endpoint_id, label
             ORDER BY total_tokens DESC, request_count DESC
             LIMIT 10"
        }
        BreakdownKind::ApiKey => {
            "SELECT
                 COALESCE(NULLIF(u.api_key_fingerprint, ''), 'no-key') AS key,
                 CASE
                     WHEN COALESCE(NULLIF(u.api_key_fingerprint, ''), 'no-key') = 'no-key' THEN '无密钥'
                     ELSE 'key_' || substr(u.api_key_fingerprint, 1, 8)
                 END AS label,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
                 COALESCE(SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
                 AVG(u.latency_ms) AS avg_latency_ms,
                 COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items
             FROM ai_usage_events u
             WHERE u.user_id = ?
               AND (? IS NULL OR u.created_at >= ?)
               AND (? IS NULL OR u.project_id = ?)
               AND (? IS NULL OR u.conversation_id = ?)
               AND (? IS NULL OR u.agent_id = ?)
               AND (? IS NULL OR u.endpoint_id = ?)
               AND (? IS NULL OR u.api_key_fingerprint = ?)
               AND (? IS NULL OR u.resource_kind = ?)
               AND (? IS NULL OR u.model = ?)
               AND (? IS NULL OR u.operation = ?)
               AND (? IS NULL OR u.status = ?)
             GROUP BY key, label
             ORDER BY total_tokens DESC, request_count DESC
             LIMIT 10"
        }
        BreakdownKind::Model => {
            "SELECT
                 COALESCE(NULLIF(u.model, ''), '(unknown)') AS key,
                 COALESCE(NULLIF(u.model, ''), '(unknown)') AS label,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
                 COALESCE(SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
                 AVG(u.latency_ms) AS avg_latency_ms,
                 COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items
             FROM ai_usage_events u
             WHERE u.user_id = ?
               AND (? IS NULL OR u.created_at >= ?)
               AND (? IS NULL OR u.project_id = ?)
               AND (? IS NULL OR u.conversation_id = ?)
               AND (? IS NULL OR u.agent_id = ?)
               AND (? IS NULL OR u.endpoint_id = ?)
               AND (? IS NULL OR u.api_key_fingerprint = ?)
               AND (? IS NULL OR u.resource_kind = ?)
               AND (? IS NULL OR u.model = ?)
               AND (? IS NULL OR u.operation = ?)
               AND (? IS NULL OR u.status = ?)
             GROUP BY key, label
             ORDER BY total_tokens DESC, request_count DESC
             LIMIT 10"
        }
        BreakdownKind::Agent => {
            "SELECT
                 COALESCE(u.agent_id, '') AS key,
                 CASE
                     WHEN u.agent_id IS NULL THEN '未绑定智能体'
                     ELSE COALESCE(a.name, '已删除智能体')
                 END AS label,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
                 COALESCE(SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
                 AVG(u.latency_ms) AS avg_latency_ms,
                 COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items
             FROM ai_usage_events u
             LEFT JOIN agents a ON a.id = u.agent_id AND a.user_id = u.user_id
             WHERE u.user_id = ?
               AND (? IS NULL OR u.created_at >= ?)
               AND (? IS NULL OR u.project_id = ?)
               AND (? IS NULL OR u.conversation_id = ?)
               AND (? IS NULL OR u.agent_id = ?)
               AND (? IS NULL OR u.endpoint_id = ?)
               AND (? IS NULL OR u.api_key_fingerprint = ?)
               AND (? IS NULL OR u.resource_kind = ?)
               AND (? IS NULL OR u.model = ?)
               AND (? IS NULL OR u.operation = ?)
               AND (? IS NULL OR u.status = ?)
             GROUP BY u.agent_id, label
             ORDER BY total_tokens DESC, request_count DESC
             LIMIT 10"
        }
        BreakdownKind::Project => {
            "SELECT
                 COALESCE(u.project_id, '') AS key,
                 CASE
                     WHEN u.project_id IS NULL THEN '独立请求'
                     ELSE COALESCE(p.name, '已删除项目')
                 END AS label,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
                 COALESCE(SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
                 AVG(u.latency_ms) AS avg_latency_ms,
                 COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items
             FROM ai_usage_events u
             LEFT JOIN projects p ON p.id = u.project_id AND p.user_id = u.user_id
             WHERE u.user_id = ?
               AND (? IS NULL OR u.created_at >= ?)
               AND (? IS NULL OR u.project_id = ?)
               AND (? IS NULL OR u.conversation_id = ?)
               AND (? IS NULL OR u.agent_id = ?)
               AND (? IS NULL OR u.endpoint_id = ?)
               AND (? IS NULL OR u.api_key_fingerprint = ?)
               AND (? IS NULL OR u.resource_kind = ?)
               AND (? IS NULL OR u.model = ?)
               AND (? IS NULL OR u.operation = ?)
               AND (? IS NULL OR u.status = ?)
             GROUP BY u.project_id, label
             ORDER BY total_tokens DESC, request_count DESC
             LIMIT 10"
        }
        BreakdownKind::Operation => {
            "SELECT
                 u.operation AS key,
                 u.operation AS label,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
                 COALESCE(SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
                 AVG(u.latency_ms) AS avg_latency_ms,
                 COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items
             FROM ai_usage_events u
             WHERE u.user_id = ?
               AND (? IS NULL OR u.created_at >= ?)
               AND (? IS NULL OR u.project_id = ?)
               AND (? IS NULL OR u.conversation_id = ?)
               AND (? IS NULL OR u.agent_id = ?)
               AND (? IS NULL OR u.endpoint_id = ?)
               AND (? IS NULL OR u.api_key_fingerprint = ?)
               AND (? IS NULL OR u.resource_kind = ?)
               AND (? IS NULL OR u.model = ?)
               AND (? IS NULL OR u.operation = ?)
               AND (? IS NULL OR u.status = ?)
             GROUP BY u.operation
             ORDER BY total_tokens DESC, request_count DESC
             LIMIT 10"
        }
        BreakdownKind::ResourceKind => {
            "SELECT
                 u.resource_kind AS key,
                 u.resource_kind AS label,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
                 COALESCE(SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
                 AVG(u.latency_ms) AS avg_latency_ms,
                 COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items
             FROM ai_usage_events u
             WHERE u.user_id = ?
               AND (? IS NULL OR u.created_at >= ?)
               AND (? IS NULL OR u.project_id = ?)
               AND (? IS NULL OR u.conversation_id = ?)
               AND (? IS NULL OR u.agent_id = ?)
               AND (? IS NULL OR u.endpoint_id = ?)
               AND (? IS NULL OR u.api_key_fingerprint = ?)
               AND (? IS NULL OR u.resource_kind = ?)
               AND (? IS NULL OR u.model = ?)
               AND (? IS NULL OR u.operation = ?)
               AND (? IS NULL OR u.status = ?)
             GROUP BY u.resource_kind
             ORDER BY total_tokens DESC, request_count DESC
             LIMIT 10"
        }
    };

    let rows = sqlx::query_as::<_, BreakdownRow>(sql)
        .bind(user_id)
        .bind(query.from_ts.as_deref())
        .bind(query.from_ts.as_deref())
        .bind(query.project_id.as_deref())
        .bind(query.project_id.as_deref())
        .bind(query.conversation_id.as_deref())
        .bind(query.conversation_id.as_deref())
        .bind(query.agent_id.as_deref())
        .bind(query.agent_id.as_deref())
        .bind(query.endpoint_id.as_deref())
        .bind(query.endpoint_id.as_deref())
        .bind(query.api_key_fingerprint.as_deref())
        .bind(query.api_key_fingerprint.as_deref())
        .bind(query.resource_kind.as_deref())
        .bind(query.resource_kind.as_deref())
        .bind(query.model.as_deref())
        .bind(query.model.as_deref())
        .bind(query.operation.as_deref())
        .bind(query.operation.as_deref())
        .bind(query.status.as_deref())
        .bind(query.status.as_deref())
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| AiUsageBreakdownItem {
            key: row.key,
            label: row.label,
            request_count: row.request_count,
            success_count: row.success_count,
            failure_count: row.failure_count,
            avg_latency_ms: row.avg_latency_ms.unwrap_or_default().round() as i64,
            total_tokens: row.total_tokens,
            output_items: row.output_items,
        })
        .collect())
}

async fn list_records_with_query(
    pool: &SqlitePool,
    user_id: &str,
    query: &NormalizedUsageQuery,
) -> AppResult<Vec<AiUsageRecord>> {
    let rows = sqlx::query_as::<_, UsageRecordRow>(
        "SELECT
             u.id,
             u.project_id,
             p.name AS project_name,
             u.conversation_id,
             u.agent_id,
             a.name AS agent_name,
             u.endpoint_id,
             ep.name AS endpoint_name,
             u.api_key_fingerprint,
             u.provider,
             u.model,
             u.operation,
             u.status,
             u.resource_kind,
             u.output_items,
             u.request_fingerprint,
             u.attempt_index,
             u.is_redo,
             u.token_source,
             u.latency_ms,
             u.input_chars,
             u.output_chars,
             u.prompt_tokens,
             u.completion_tokens,
             u.total_tokens,
             u.error_message,
             u.created_at
         FROM ai_usage_events u
         LEFT JOIN projects p ON p.id = u.project_id AND p.user_id = u.user_id
         LEFT JOIN agents a ON a.id = u.agent_id AND a.user_id = u.user_id
         LEFT JOIN ai_endpoints ep ON ep.id = u.endpoint_id AND ep.user_id = u.user_id
         WHERE u.user_id = ?
           AND (? IS NULL OR u.created_at >= ?)
           AND (? IS NULL OR u.project_id = ?)
           AND (? IS NULL OR u.conversation_id = ?)
           AND (? IS NULL OR u.agent_id = ?)
           AND (? IS NULL OR u.endpoint_id = ?)
           AND (? IS NULL OR u.api_key_fingerprint = ?)
           AND (? IS NULL OR u.resource_kind = ?)
           AND (? IS NULL OR u.model = ?)
           AND (? IS NULL OR u.operation = ?)
           AND (? IS NULL OR u.status = ?)
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT ?",
    )
    .bind(user_id)
    .bind(query.from_ts.as_deref())
    .bind(query.from_ts.as_deref())
    .bind(query.project_id.as_deref())
    .bind(query.project_id.as_deref())
    .bind(query.conversation_id.as_deref())
    .bind(query.conversation_id.as_deref())
    .bind(query.agent_id.as_deref())
    .bind(query.agent_id.as_deref())
    .bind(query.endpoint_id.as_deref())
    .bind(query.endpoint_id.as_deref())
    .bind(query.api_key_fingerprint.as_deref())
    .bind(query.api_key_fingerprint.as_deref())
    .bind(query.resource_kind.as_deref())
    .bind(query.resource_kind.as_deref())
    .bind(query.model.as_deref())
    .bind(query.model.as_deref())
    .bind(query.operation.as_deref())
    .bind(query.operation.as_deref())
    .bind(query.status.as_deref())
    .bind(query.status.as_deref())
    .bind(query.limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| AiUsageRecord {
            id: row.id,
            project_id: row.project_id,
            project_name: row.project_name,
            conversation_id: row.conversation_id,
            agent_id: row.agent_id,
            agent_name: row.agent_name,
            endpoint_id: row.endpoint_id,
            endpoint_name: row.endpoint_name,
            api_key_fingerprint: row.api_key_fingerprint,
            provider: row.provider,
            model: row.model,
            operation: row.operation,
            status: row.status,
            resource_kind: row.resource_kind,
            output_items: row.output_items,
            request_fingerprint: row.request_fingerprint,
            attempt_index: row.attempt_index,
            is_redo: row.is_redo != 0,
            token_source: row.token_source,
            latency_ms: row.latency_ms,
            input_chars: row.input_chars,
            output_chars: row.output_chars,
            prompt_tokens: row.prompt_tokens,
            completion_tokens: row.completion_tokens,
            total_tokens: row.total_tokens,
            error_message: row.error_message,
            created_at: row.created_at,
        })
        .collect())
}
