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
    /// 供应商上报的缓存命中 prompt tokens；无上报或估算时为 None。
    pub cached_prompt_tokens: Option<i64>,
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
    /// 唯一关联一次实际调用的账单引用。内容指纹用于分组和分析，不能作为扣费幂等键。
    pub billing_ref_id: String,
    pub attempt_group_key: String,
    /**
     * 触发来源：用于区分正常发送、编辑后发送、撤回后重新发送
     * - None: 正常发送（默认）
     * - Some("edit"): 编辑消息后发送
     * - Some("rewind"): 撤回消息后重新发送
     */
    pub trigger_source: Option<String>,
    pub error_message: Option<String>,
    /// 供应商上报的缓存命中 prompt tokens（无上报时为 None）。
    pub cached_prompt_tokens: Option<i64>,
    /// 与该会话上一次请求的共享前缀字符占比（探针缺失时为 None）。
    pub prompt_prefix_hit_ratio: Option<f64>,
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
    pub by_conversation: Vec<AiUsageBreakdownItem>,
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
    pub cached_prompt_tokens: i64,
    pub cached_token_records: i64,
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
    pub prompt_tokens: i64,
    pub cached_prompt_tokens: i64,
    pub cached_token_records: i64,
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
    /// 缓存命中 prompt tokens 合计（供应商上报时才有值）。
    pub cached_prompt_tokens: i64,
    /// 缓存命中率 = 缓存命中 tokens / prompt tokens；无供应商上报数据时为 None。
    pub cache_hit_ratio: Option<f64>,
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
    pub cached_prompt_tokens: Option<i64>,
    pub prompt_prefix_hit_ratio: Option<f64>,
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
    cached_prompt_tokens: i64,
    cached_token_records: i64,
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
    prompt_tokens: i64,
    cached_prompt_tokens: i64,
    cached_token_records: i64,
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
    prompt_tokens: i64,
    output_items: i64,
    cached_prompt_tokens: i64,
    cached_token_records: i64,
}

/// 缓存命中率 = 缓存命中 tokens / prompt tokens。
/// 仅当窗口内存在供应商上报数据（cached_token_records > 0）且 prompt tokens > 0 时给出比值，
/// 否则返回 None 表示“无数据”而不是“命中率为 0”。
fn cache_hit_ratio(
    cached_prompt_tokens: i64,
    cached_token_records: i64,
    prompt_tokens: i64,
) -> Option<f64> {
    if cached_token_records > 0 && prompt_tokens > 0 {
        Some(cached_prompt_tokens as f64 / prompt_tokens as f64)
    } else {
        None
    }
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
    cached_prompt_tokens: Option<i64>,
    prompt_prefix_hit_ratio: Option<f64>,
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
             attempt_index, is_redo, trigger_source, error_message,
             cached_prompt_tokens, prompt_prefix_hit_ratio
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(input.cached_prompt_tokens)
    .bind(input.prompt_prefix_hit_ratio)
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
        by_conversation,
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
        fetch_breakdown(pool, user_id, &query, BreakdownKind::Conversation),
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
        by_conversation,
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
            cached_prompt_tokens: usage.cached_prompt_tokens,
        },
        None => {
            let prompt_tokens = estimate_prompt_tokens(messages);
            let completion_tokens = estimate_tokens(content);
            UsageNumbers {
                prompt_tokens,
                completion_tokens,
                total_tokens: prompt_tokens + completion_tokens,
                token_source: AiUsageTokenSource::Estimated,
                cached_prompt_tokens: None,
            }
        }
    }
}

pub fn unavailable_usage() -> UsageNumbers {
    UsageNumbers {
        cached_prompt_tokens: None,
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
             COUNT(DISTINCT conversation_id) AS conversation_count,
             COALESCE(SUM(cached_prompt_tokens), 0) AS cached_prompt_tokens,
             COUNT(cached_prompt_tokens) AS cached_token_records
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
        cached_prompt_tokens: row.cached_prompt_tokens,
        cached_token_records: row.cached_token_records,
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
             COALESCE(SUM(output_items), 0) AS output_items,
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(cached_prompt_tokens), 0) AS cached_prompt_tokens,
             COUNT(cached_prompt_tokens) AS cached_token_records
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
            prompt_tokens: row.prompt_tokens,
            cached_prompt_tokens: row.cached_prompt_tokens,
            cached_token_records: row.cached_token_records,
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
    Conversation,
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
                 COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items,
                 COALESCE(SUM(u.cached_prompt_tokens), 0) AS cached_prompt_tokens,
                 COUNT(u.cached_prompt_tokens) AS cached_token_records
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
                 COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items,
                 COALESCE(SUM(u.cached_prompt_tokens), 0) AS cached_prompt_tokens,
                 COUNT(u.cached_prompt_tokens) AS cached_token_records
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
                 COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items,
                 COALESCE(SUM(u.cached_prompt_tokens), 0) AS cached_prompt_tokens,
                 COUNT(u.cached_prompt_tokens) AS cached_token_records
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
                 COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items,
                 COALESCE(SUM(u.cached_prompt_tokens), 0) AS cached_prompt_tokens,
                 COUNT(u.cached_prompt_tokens) AS cached_token_records
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
                 COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items,
                 COALESCE(SUM(u.cached_prompt_tokens), 0) AS cached_prompt_tokens,
                 COUNT(u.cached_prompt_tokens) AS cached_token_records
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
        BreakdownKind::Conversation => {
            "SELECT
                 COALESCE(u.conversation_id, '') AS key,
                 CASE
                     WHEN u.conversation_id IS NULL THEN '非会话请求'
                     ELSE COALESCE(cv.title, '已删除会话')
                 END AS label,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
                 COALESCE(SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
                 AVG(u.latency_ms) AS avg_latency_ms,
                 COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items,
                 COALESCE(SUM(u.cached_prompt_tokens), 0) AS cached_prompt_tokens,
                 COUNT(u.cached_prompt_tokens) AS cached_token_records
             FROM ai_usage_events u
             LEFT JOIN conversations cv ON cv.id = u.conversation_id AND cv.user_id = u.user_id
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
             GROUP BY u.conversation_id, label
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
                 COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items,
                 COALESCE(SUM(u.cached_prompt_tokens), 0) AS cached_prompt_tokens,
                 COUNT(u.cached_prompt_tokens) AS cached_token_records
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
                 COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                 COALESCE(SUM(u.output_items), 0) AS output_items,
                 COALESCE(SUM(u.cached_prompt_tokens), 0) AS cached_prompt_tokens,
                 COUNT(u.cached_prompt_tokens) AS cached_token_records
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
            cached_prompt_tokens: row.cached_prompt_tokens,
            cache_hit_ratio: cache_hit_ratio(
                row.cached_prompt_tokens,
                row.cached_token_records,
                row.prompt_tokens,
            ),
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
             u.cached_prompt_tokens,
             u.prompt_prefix_hit_ratio,
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
            cached_prompt_tokens: row.cached_prompt_tokens,
            prompt_prefix_hit_ratio: row.prompt_prefix_hit_ratio,
            error_message: row.error_message,
            created_at: row.created_at,
        })
        .collect())
}

#[cfg(test)]
mod cache_metrics_tests {
    use super::cache_hit_ratio;

    #[test]
    fn ratio_needs_reported_records_and_positive_prompt_tokens() {
        let ratio = cache_hit_ratio(800, 3, 1000).expect("ratio");
        assert!((ratio - 0.8).abs() < 1e-9);
    }

    #[test]
    fn ratio_is_none_without_reported_records() {
        // 无供应商上报时 None 表示"无数据"，不能把命中率误报为 0。
        assert_eq!(cache_hit_ratio(0, 0, 1000), None);
    }

    #[test]
    fn ratio_is_none_with_zero_prompt_tokens() {
        assert_eq!(cache_hit_ratio(0, 2, 0), None);
    }
}

#[cfg(test)]
mod series_aggregation_tests {
    use super::{fetch_series, normalize_query, AiUsageQuery, NormalizedUsageQuery};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use std::str::FromStr;

    /// 与 001_init + 035 一致的 ai_usage_events 最小建表（无外键，聚合测试够用）。
    const SERIES_SCHEMA: &str = "
        CREATE TABLE ai_usage_events (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            project_id TEXT,
            conversation_id TEXT,
            agent_id TEXT,
            endpoint_id TEXT,
            api_key_fingerprint TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL,
            model TEXT,
            operation TEXT NOT NULL,
            status TEXT NOT NULL,
            resource_kind TEXT NOT NULL DEFAULT 'text',
            output_items INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER NOT NULL DEFAULT 0,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            token_source TEXT NOT NULL DEFAULT 'unavailable',
            input_chars INTEGER NOT NULL DEFAULT 0,
            output_chars INTEGER NOT NULL DEFAULT 0,
            request_fingerprint TEXT NOT NULL DEFAULT '',
            attempt_group_key TEXT NOT NULL DEFAULT '',
            attempt_index INTEGER NOT NULL DEFAULT 1,
            is_redo INTEGER NOT NULL DEFAULT 0,
            trigger_source TEXT,
            error_message TEXT,
            cached_prompt_tokens INTEGER,
            prompt_prefix_hit_ratio REAL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )";

    async fn create_series_pool(prefix: &str) -> (SqlitePool, PathBuf) {
        let db_path =
            std::env::temp_dir().join(format!("{}-{}.sqlite", prefix, uuid::Uuid::new_v4()));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
        let options = SqliteConnectOptions::from_str(&database_url)
            .expect("invalid sqlite url")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect test sqlite");
        sqlx::query(SERIES_SCHEMA)
            .execute(&pool)
            .await
            .expect("create ai_usage_events");
        (pool, db_path)
    }

    async fn insert_event(
        pool: &SqlitePool,
        id: &str,
        created_at: &str,
        prompt_tokens: i64,
        cached_prompt_tokens: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO ai_usage_events
                (id, user_id, provider, operation, status, prompt_tokens, total_tokens, cached_prompt_tokens, created_at)
             VALUES (?, 'user-1', 'openai', 'chat', 'success', ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(prompt_tokens)
        .bind(prompt_tokens)
        .bind(cached_prompt_tokens)
        .bind(created_at)
        .execute(pool)
        .await
        .expect("insert event");
    }

    fn day_query() -> NormalizedUsageQuery {
        normalize_query(AiUsageQuery {
            days: Some(0),
            bucket: Some("day".into()),
            ..Default::default()
        })
        .expect("normalize query")
    }

    #[tokio::test]
    async fn fetch_series_aggregates_prompt_tokens_per_bucket() {
        let (pool, db_path) = create_series_pool("woohoo-series-test").await;

        insert_event(&pool, "e1", "2026-09-01T10:00:00Z", 100, Some(80)).await;
        insert_event(&pool, "e2", "2026-09-01T11:00:00Z", 100, None).await;
        insert_event(&pool, "e3", "2026-09-02T10:00:00Z", 200, None).await;

        let points = fetch_series(&pool, "user-1", &day_query())
            .await
            .expect("fetch series");

        assert_eq!(points.len(), 2);

        let day1 = points
            .iter()
            .find(|point| point.bucket_start.starts_with("2026-09-01"))
            .expect("day1 bucket");
        assert_eq!(
            day1.prompt_tokens, 200,
            "分母应包含未上报请求的 prompt tokens"
        );
        assert_eq!(day1.cached_prompt_tokens, 80);
        assert_eq!(day1.cached_token_records, 1);

        let day2 = points
            .iter()
            .find(|point| point.bucket_start.starts_with("2026-09-02"))
            .expect("day2 bucket");
        assert_eq!(day2.prompt_tokens, 200);
        assert_eq!(day2.cached_prompt_tokens, 0);
        assert_eq!(day2.cached_token_records, 0, "无上报记录 ≠ 命中率为 0");

        pool.close().await;
        std::fs::remove_file(&db_path).ok();
    }
}

#[cfg(test)]
mod totals_breakdown_tests {
    use super::{
        fetch_breakdown, fetch_totals, normalize_query, AiUsageQuery, BreakdownKind,
        NormalizedUsageQuery,
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use std::str::FromStr;

    /// 与 001_init + 035 一致的 ai_usage_events 最小建表，
    /// 另加 breakdown LEFT JOIN 用到的关联表壳（仅 id/user_id/name|title 列）。
    const EVENTS_SCHEMA: &str = "
        CREATE TABLE ai_usage_events (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            project_id TEXT,
            conversation_id TEXT,
            agent_id TEXT,
            endpoint_id TEXT,
            api_key_fingerprint TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL,
            model TEXT,
            operation TEXT NOT NULL,
            status TEXT NOT NULL,
            resource_kind TEXT NOT NULL DEFAULT 'text',
            output_items INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER NOT NULL DEFAULT 0,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            token_source TEXT NOT NULL DEFAULT 'unavailable',
            input_chars INTEGER NOT NULL DEFAULT 0,
            output_chars INTEGER NOT NULL DEFAULT 0,
            request_fingerprint TEXT NOT NULL DEFAULT '',
            attempt_group_key TEXT NOT NULL DEFAULT '',
            attempt_index INTEGER NOT NULL DEFAULT 1,
            is_redo INTEGER NOT NULL DEFAULT 0,
            trigger_source TEXT,
            error_message TEXT,
            cached_prompt_tokens INTEGER,
            prompt_prefix_hit_ratio REAL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )";
    const ENDPOINTS_SCHEMA: &str =
        "CREATE TABLE ai_endpoints (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, name TEXT)";
    const CONVERSATIONS_SCHEMA: &str =
        "CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, title TEXT)";

    async fn create_pool(prefix: &str) -> (SqlitePool, PathBuf) {
        let db_path =
            std::env::temp_dir().join(format!("{}-{}.sqlite", prefix, uuid::Uuid::new_v4()));
        let database_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
        let options = SqliteConnectOptions::from_str(&database_url)
            .expect("invalid sqlite url")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect test sqlite");
        for statement in [EVENTS_SCHEMA, ENDPOINTS_SCHEMA, CONVERSATIONS_SCHEMA] {
            sqlx::query(statement)
                .execute(&pool)
                .await
                .expect("create schema");
        }
        (pool, db_path)
    }

    /// 可定制列的事件行，未覆盖的字段取 Default（success / chat / ep-1 / c1 / actual）。
    struct EventRow {
        id: &'static str,
        created_at: &'static str,
        project_id: Option<&'static str>,
        conversation_id: Option<&'static str>,
        agent_id: Option<&'static str>,
        endpoint_id: Option<&'static str>,
        api_key_fingerprint: &'static str,
        model: Option<&'static str>,
        operation: &'static str,
        status: &'static str,
        latency_ms: i64,
        prompt_tokens: i64,
        completion_tokens: i64,
        total_tokens: i64,
        token_source: &'static str,
        attempt_group_key: &'static str,
        attempt_index: i64,
        is_redo: i64,
        cached_prompt_tokens: Option<i64>,
    }

    impl Default for EventRow {
        fn default() -> Self {
            Self {
                id: "",
                created_at: "2026-09-01T10:00:00Z",
                project_id: Some("p1"),
                conversation_id: Some("c1"),
                agent_id: None,
                endpoint_id: Some("ep-1"),
                api_key_fingerprint: "",
                model: Some("gpt-test"),
                operation: "chat",
                status: "success",
                latency_ms: 100,
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                token_source: "actual",
                attempt_group_key: "",
                attempt_index: 1,
                is_redo: 0,
                cached_prompt_tokens: None,
            }
        }
    }

    async fn insert_event(pool: &SqlitePool, row: EventRow) {
        sqlx::query(
            "INSERT INTO ai_usage_events
                (id, user_id, project_id, conversation_id, agent_id, endpoint_id,
                 api_key_fingerprint, provider, model, operation, status,
                 latency_ms, prompt_tokens, completion_tokens, total_tokens, token_source,
                 attempt_group_key, attempt_index, is_redo, cached_prompt_tokens, created_at)
             VALUES (?, 'user-1', ?, ?, ?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(row.id)
        .bind(row.project_id)
        .bind(row.conversation_id)
        .bind(row.agent_id)
        .bind(row.endpoint_id)
        .bind(row.api_key_fingerprint)
        .bind(row.model)
        .bind(row.operation)
        .bind(row.status)
        .bind(row.latency_ms)
        .bind(row.prompt_tokens)
        .bind(row.completion_tokens)
        .bind(row.total_tokens)
        .bind(row.token_source)
        .bind(row.attempt_group_key)
        .bind(row.attempt_index)
        .bind(row.is_redo)
        .bind(row.cached_prompt_tokens)
        .bind(row.created_at)
        .execute(pool)
        .await
        .expect("insert event");
    }

    async fn seed_join_tables(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO ai_endpoints (id, user_id, name) VALUES ('ep-1', 'user-1', '主力通道')",
        )
        .execute(pool)
        .await
        .expect("seed endpoint");
        sqlx::query(
            "INSERT INTO conversations (id, user_id, title) VALUES ('c1', 'user-1', '会话一')",
        )
        .execute(pool)
        .await
        .expect("seed conversation");
    }

    fn all_time_query() -> NormalizedUsageQuery {
        normalize_query(AiUsageQuery {
            days: Some(0),
            ..Default::default()
        })
        .expect("normalize query")
    }

    #[tokio::test]
    async fn fetch_totals_sums_outcome_tokens_and_cache_columns() {
        let (pool, db_path) = create_pool("woohoo-usage-totals").await;
        seed_join_tables(&pool).await;

        insert_event(
            &pool,
            EventRow {
                id: "e1",
                attempt_group_key: "g1",
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
                latency_ms: 100,
                cached_prompt_tokens: Some(80),
                ..Default::default()
            },
        )
        .await;
        insert_event(
            &pool,
            EventRow {
                id: "e2",
                status: "failed",
                attempt_group_key: "g1",
                attempt_index: 2,
                is_redo: 1,
                token_source: "unavailable",
                prompt_tokens: 50,
                latency_ms: 300,
                ..Default::default()
            },
        )
        .await;
        insert_event(
            &pool,
            EventRow {
                id: "e3",
                attempt_group_key: "g2",
                attempt_index: 2,
                is_redo: 1,
                prompt_tokens: 100,
                completion_tokens: 300,
                total_tokens: 400,
                cached_prompt_tokens: Some(100),
                ..Default::default()
            },
        )
        .await;

        let totals = fetch_totals(&pool, "user-1", &all_time_query())
            .await
            .expect("fetch totals");

        assert_eq!(totals.request_count, 3);
        assert_eq!(totals.success_count, 2);
        assert_eq!(totals.failure_count, 1);
        assert_eq!(totals.avg_latency_ms, 167, "(100+300+100)/3 应四舍五入");
        assert_eq!(totals.max_latency_ms, 300);
        assert_eq!(totals.prompt_tokens, 250);
        assert_eq!(totals.completion_tokens, 350);
        assert_eq!(totals.total_tokens, 550);
        assert_eq!(totals.actual_token_records, 2);
        assert_eq!(totals.estimated_token_records, 0);
        assert_eq!(totals.unavailable_token_records, 1);
        assert_eq!(totals.cached_prompt_tokens, 180);
        assert_eq!(totals.cached_token_records, 2);
        assert_eq!(totals.attempt_group_count, 2);
        assert_eq!(totals.redo_request_count, 2);
        assert_eq!(totals.redo_total_tokens, 400);
        assert_eq!(totals.first_pass_success_count, 1);
        assert_eq!(totals.first_pass_success_tokens, 150);
        assert_eq!(totals.retry_success_count, 1);
        assert_eq!(totals.retry_success_tokens, 400);
        assert_eq!(totals.project_count, 1);
        assert_eq!(totals.conversation_count, 1);

        pool.close().await;
        std::fs::remove_file(&db_path).ok();
    }

    #[tokio::test]
    async fn fetch_totals_respects_optional_operation_and_status_filters() {
        let (pool, db_path) = create_pool("woohoo-usage-totals-filter").await;

        insert_event(
            &pool,
            EventRow {
                id: "e1",
                total_tokens: 150,
                ..Default::default()
            },
        )
        .await;
        insert_event(
            &pool,
            EventRow {
                id: "e2",
                operation: "image_gen",
                status: "failed",
                total_tokens: 900,
                ..Default::default()
            },
        )
        .await;

        let operation_query = normalize_query(AiUsageQuery {
            days: Some(0),
            operation: Some("chat".into()),
            ..Default::default()
        })
        .expect("normalize query");
        let totals = fetch_totals(&pool, "user-1", &operation_query)
            .await
            .expect("fetch totals");
        assert_eq!(totals.request_count, 1);
        assert_eq!(totals.total_tokens, 150);

        let status_query = normalize_query(AiUsageQuery {
            days: Some(0),
            status: Some("failed".into()),
            ..Default::default()
        })
        .expect("normalize query");
        let totals = fetch_totals(&pool, "user-1", &status_query)
            .await
            .expect("fetch totals");
        assert_eq!(totals.request_count, 1);
        assert_eq!(totals.total_tokens, 900);

        pool.close().await;
        std::fs::remove_file(&db_path).ok();
    }

    #[tokio::test]
    async fn fetch_breakdown_endpoint_resolves_join_labels_and_orders_by_tokens() {
        let (pool, db_path) = create_pool("woohoo-usage-breakdown-endpoint").await;
        seed_join_tables(&pool).await;

        insert_event(
            &pool,
            EventRow {
                id: "a",
                prompt_tokens: 300,
                total_tokens: 300,
                cached_prompt_tokens: Some(150),
                ..Default::default()
            },
        )
        .await;
        insert_event(
            &pool,
            EventRow {
                id: "b",
                status: "failed",
                endpoint_id: Some("ep-1"),
                total_tokens: 100,
                ..Default::default()
            },
        )
        .await;
        insert_event(
            &pool,
            EventRow {
                id: "c",
                endpoint_id: None,
                conversation_id: None,
                prompt_tokens: 200,
                total_tokens: 200,
                ..Default::default()
            },
        )
        .await;
        insert_event(
            &pool,
            EventRow {
                id: "d",
                endpoint_id: Some("ep-gone"),
                total_tokens: 50,
                ..Default::default()
            },
        )
        .await;

        let items = fetch_breakdown(&pool, "user-1", &all_time_query(), BreakdownKind::Endpoint)
            .await
            .expect("fetch breakdown");

        assert_eq!(items.len(), 3);
        assert_eq!(items[0].key, "ep-1");
        assert_eq!(items[0].label, "主力通道");
        assert_eq!(items[0].request_count, 2);
        assert_eq!(items[0].success_count, 1);
        assert_eq!(items[0].failure_count, 1);
        assert_eq!(items[0].total_tokens, 400);
        assert_eq!(items[0].cached_prompt_tokens, 150);
        assert!(
            (items[0].cache_hit_ratio.unwrap() - 0.5).abs() < 1e-9,
            "命中率 = 150/300"
        );

        assert_eq!(items[1].key, "");
        assert_eq!(items[1].label, "默认端点");
        assert_eq!(items[1].total_tokens, 200);
        assert_eq!(items[1].cache_hit_ratio, None);

        assert_eq!(items[2].key, "ep-gone");
        assert_eq!(items[2].label, "已删除端点");

        pool.close().await;
        std::fs::remove_file(&db_path).ok();
    }

    #[tokio::test]
    async fn fetch_breakdown_conversation_uses_titles_and_marks_non_conversation() {
        let (pool, db_path) = create_pool("woohoo-usage-breakdown-conversation").await;
        seed_join_tables(&pool).await;

        insert_event(
            &pool,
            EventRow {
                id: "a",
                prompt_tokens: 100,
                total_tokens: 100,
                cached_prompt_tokens: Some(50),
                ..Default::default()
            },
        )
        .await;
        insert_event(
            &pool,
            EventRow {
                id: "b",
                conversation_id: None,
                total_tokens: 70,
                ..Default::default()
            },
        )
        .await;
        insert_event(
            &pool,
            EventRow {
                id: "c",
                conversation_id: Some("c-gone"),
                total_tokens: 30,
                ..Default::default()
            },
        )
        .await;

        let items = fetch_breakdown(
            &pool,
            "user-1",
            &all_time_query(),
            BreakdownKind::Conversation,
        )
        .await
        .expect("fetch breakdown");

        assert_eq!(items.len(), 3);
        let known = items
            .iter()
            .find(|item| item.key == "c1")
            .expect("conversation group");
        assert_eq!(known.label, "会话一");
        assert_eq!(known.request_count, 1);
        assert!(
            (known.cache_hit_ratio.unwrap() - 0.5).abs() < 1e-9,
            "命中率 = 50/100"
        );

        let orphan = items
            .iter()
            .find(|item| item.key.is_empty())
            .expect("non-conversation group");
        assert_eq!(orphan.label, "非会话请求");

        let deleted = items
            .iter()
            .find(|item| item.key == "c-gone")
            .expect("deleted conversation group");
        assert_eq!(deleted.label, "已删除会话");

        pool.close().await;
        std::fs::remove_file(&db_path).ok();
    }
}
