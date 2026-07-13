//! Multi-AI Endpoint Intelligent Router
//!
//! Provides candidate selection, scoring, controlled fallback, and audit logging
//! for all AI operations (chat, stream, task, image/video generation, pipeline steps).

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::collections::HashSet;
use uuid::Uuid;

use crate::{
    ai::config::{AiEndpoint, AiEndpointCapability},
    error::{AppError, AppResult},
};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Maximum number of endpoint attempts per request (prevents infinite fallback loops)
pub const MAX_ROUTING_ATTEMPTS: usize = 3;
/// Default max context tokens when capability does not specify one
const DEFAULT_MAX_CONTEXT_TOKENS: i64 = 128_000;

// ─── Types ───────────────────────────────────────────────────────────────────

/// Capability/operation kinds supported by the router
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingCapability {
    Chat,
    ImageGeneration,
    VideoGeneration,
    Embedding,
}

impl RoutingCapability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::ImageGeneration => "image_generation",
            Self::VideoGeneration => "video_generation",
            Self::Embedding => "embedding",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "image_generation" => Self::ImageGeneration,
            "video_generation" => Self::VideoGeneration,
            "embedding" => Self::Embedding,
            _ => Self::Chat,
        }
    }
}

impl std::fmt::Display for RoutingCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Operation type for audit and usage tracking
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingOperation {
    Chat,
    Stream,
    Task,
    Test,
    ImageGeneration,
    VideoGeneration,
    PipelineStep,
}

impl RoutingOperation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Stream => "stream",
            Self::Task => "task",
            Self::Test => "test",
            Self::ImageGeneration => "image_generation",
            Self::VideoGeneration => "video_generation",
            Self::PipelineStep => "pipeline_step",
        }
    }
}

/// Classification of errors for fallback decisions
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClassification {
    /// Network errors: connection refused, DNS failure, TLS, timeout, disconnect
    NetworkError,
    /// Request timeout (408)
    Timeout,
    /// Rate limited (429)
    RateLimited,
    /// Server-side errors (5xx)
    ServerError,
    /// Authentication/authorization errors (401/403) — NOT retryable
    AuthError,
    /// Request validation errors (400) — NOT retryable
    ValidationError,
    /// Content safety / policy rejection — NOT retryable
    ContentSafety,
    /// Capability mismatch (endpoint doesn't support requested feature) — may try next
    CapabilityMismatch,
    /// Unknown/unclassified error
    Unknown,
}

impl ErrorClassification {
    /// Whether this error class allows trying the next candidate endpoint
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::NetworkError
                | Self::Timeout
                | Self::RateLimited
                | Self::ServerError
                | Self::CapabilityMismatch
        )
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NetworkError => "network_error",
            Self::Timeout => "timeout",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::AuthError => "auth_error",
            Self::ValidationError => "validation_error",
            Self::ContentSafety => "content_safety",
            Self::CapabilityMismatch => "capability_mismatch",
            Self::Unknown => "unknown",
        }
    }
}

/// Routing event status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingStatus {
    Selected,
    Attempt,
    Success,
    Fallback,
    Failed,
    Exhausted,
}

impl RoutingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Selected => "selected",
            Self::Attempt => "attempt",
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Fallback => "fallback",
            Self::Exhausted => "exhausted",
        }
    }
}

/// Input parameters for routing a request
#[derive(Debug, Clone)]
pub struct RoutingRequest {
    pub user_id: String,
    pub capability: RoutingCapability,
    pub operation: RoutingOperation,
    pub explicit_endpoint_id: Option<String>,
    pub requested_model: Option<String>,
    pub context_tokens: Option<i64>,
    pub requires_streaming: bool,
    pub requires_tools: bool,
    pub request_id: Option<String>,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub step_id: Option<String>,
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub generation_id: Option<String>,
}

/// A scored candidate endpoint for routing
#[derive(Debug, Clone, Serialize)]
pub struct RoutingCandidate {
    pub endpoint: AiEndpoint,
    pub capability: Option<AiEndpointCapability>,
    pub model: String,
    pub score: i64,
    pub supports_streaming: bool,
    pub supports_tools: bool,
    pub max_context_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
}

/// Result of resolving the routing decision
#[derive(Debug, Clone)]
pub struct RoutingDecision {
    pub candidates: Vec<RoutingCandidate>,
    pub attempt_order: Vec<String>, // endpoint IDs in priority order
}

/// Result of executing a single attempt
#[derive(Debug, Clone, Serialize)]
pub struct AttemptResult<T> {
    pub endpoint_id: String,
    pub model: String,
    pub provider: String,
    pub attempt_index: usize,
    pub result: Option<T>,
    pub error_classification: Option<ErrorClassification>,
    pub error_message: Option<String>,
    pub http_status: Option<u16>,
    pub latency_ms: i64,
}

/// Final outcome of the routing + fallback chain
#[derive(Debug, Clone)]
pub struct RoutingOutcome<T> {
    pub result: Option<T>,
    pub final_endpoint_id: Option<String>,
    pub final_model: Option<String>,
    pub final_provider: Option<String>,
    pub attempts: Vec<AttemptResult<T>>,
    pub was_fallback: bool,
    pub fallback_reason: Option<String>,
    pub total_latency_ms: i64,
    pub exhausted: bool,
}

// ─── DB Row Types ────────────────────────────────────────────────────────────

#[derive(Debug, FromRow)]
struct EndpointWithCapabilityRow {
    endpoint_id: String,
    user_id: String,
    name: String,
    provider: String,
    base_url: String,
    api_key: String,
    default_model: Option<String>,
    is_active: bool,
    endpoint_created_at: String,
    endpoint_updated_at: String,
    capability_id: Option<String>,
    cap_capability: Option<String>,
    cap_model: Option<String>,
    cap_path_override: Option<String>,
    cap_request_adapter: Option<String>,
    cap_response_adapter: Option<String>,
    cap_supports_stream: Option<bool>,
    cap_supports_tools: Option<bool>,
    cap_supports_files: Option<bool>,
    cap_enabled: Option<bool>,
    cap_priority: Option<i64>,
    cap_config_json: Option<String>,
    cap_created_at: Option<String>,
    cap_updated_at: Option<String>,
}

/// Persisted routing audit event
#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEventRecord {
    pub id: String,
    pub user_id: String,
    pub request_id: Option<String>,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub step_id: Option<String>,
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub generation_id: Option<String>,
    pub operation: String,
    pub capability: String,
    pub candidate_endpoint_id: Option<String>,
    pub candidate_model: Option<String>,
    pub candidate_provider: Option<String>,
    pub final_endpoint_id: Option<String>,
    pub final_model: Option<String>,
    pub final_provider: Option<String>,
    pub explicit_endpoint_id: Option<String>,
    pub requested_model: Option<String>,
    pub status: String,
    pub attempt_index: i64,
    pub max_attempts: i64,
    pub error_classification: Option<String>,
    pub error_message: Option<String>,
    pub http_status: Option<i64>,
    pub latency_ms: i64,
    pub was_fallback: bool,
    pub fallback_reason: Option<String>,
    pub candidates_json: Option<String>,
    pub created_at: String,
}

/// Filter for querying routing events
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEventFilter {
    pub endpoint_id: Option<String>,
    pub capability: Option<String>,
    pub status: Option<String>,
    pub operation: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Health summary for an endpoint
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndpointHealthSummary {
    pub endpoint_id: String,
    pub total_requests: i64,
    pub success_count: i64,
    pub fallback_count: i64,
    pub failed_count: i64,
    pub avg_latency_ms: i64,
    pub recent_errors_24h: i64,
    pub last_error_at: Option<String>,
    pub last_success_at: Option<String>,
}

// ─── Core Routing Functions ──────────────────────────────────────────────────

/// Classify an error from HTTP status code and error message.
/// This determines whether fallback to the next candidate is allowed.
pub fn classify_error(http_status: Option<u16>, error_message: &str) -> ErrorClassification {
    if let Some(status) = http_status {
        return match status {
            401 | 403 => ErrorClassification::AuthError,
            400 => ErrorClassification::ValidationError,
            408 => ErrorClassification::Timeout,
            429 => ErrorClassification::RateLimited,
            500..=599 => ErrorClassification::ServerError,
            _ => ErrorClassification::Unknown,
        };
    }

    let msg_lower = error_message.to_ascii_lowercase();

    if msg_lower.contains("content policy")
        || msg_lower.contains("content filtered")
        || msg_lower.contains("content safety")
        || msg_lower.contains("safety")
        || msg_lower.contains("moderation")
        || msg_lower.contains("inappropriate")
        || msg_lower.contains("policy violation")
        || msg_lower.contains("敏感")
        || msg_lower.contains("合规")
        || msg_lower.contains("内容安全")
    {
        return ErrorClassification::ContentSafety;
    }

    if msg_lower.contains("invalid request")
        || msg_lower.contains("validation error")
        || msg_lower.contains("invalid model")
        || msg_lower.contains("model not found")
        || msg_lower.contains("bad request")
        || msg_lower.contains("参数错误")
    {
        return ErrorClassification::ValidationError;
    }

    if msg_lower.contains("unauthorized")
        || msg_lower.contains("forbidden")
        || msg_lower.contains("invalid api key")
        || msg_lower.contains("authentication")
        || (msg_lower.contains("api key") && msg_lower.contains("invalid"))
    {
        return ErrorClassification::AuthError;
    }

    if msg_lower.contains("timeout")
        || msg_lower.contains("timed out")
        || msg_lower.contains("deadline exceeded")
        || msg_lower.contains("连接超时")
    {
        return ErrorClassification::Timeout;
    }

    if msg_lower.contains("rate limit")
        || msg_lower.contains("too many requests")
        || msg_lower.contains("rate_limit")
    {
        return ErrorClassification::RateLimited;
    }

    if msg_lower.contains("500")
        || msg_lower.contains("502")
        || msg_lower.contains("503")
        || msg_lower.contains("internal server error")
        || msg_lower.contains("bad gateway")
        || msg_lower.contains("service unavailable")
    {
        return ErrorClassification::ServerError;
    }

    if msg_lower.contains("connection")
        || msg_lower.contains("dns")
        || msg_lower.contains("tls")
        || msg_lower.contains("certificate")
        || msg_lower.contains("proxy")
        || msg_lower.contains("refused")
        || msg_lower.contains("reset")
        || msg_lower.contains("broken pipe")
        || msg_lower.contains("network")
        || msg_lower.contains("连接失败")
        || msg_lower.contains("连接中断")
    {
        return ErrorClassification::NetworkError;
    }

    ErrorClassification::Unknown
}

/// Load and score all candidate endpoints for a routing request.
pub async fn resolve_candidates(
    pool: &SqlitePool,
    req: &RoutingRequest,
) -> AppResult<RoutingDecision> {
    let cap_str = req.capability.as_str();

    let rows = sqlx::query_as::<_, EndpointWithCapabilityRow>(
        "SELECT
            e.id AS endpoint_id,
            e.user_id,
            e.name,
            e.provider,
            e.base_url,
            e.api_key,
            e.default_model,
            e.is_active,
            e.created_at AS endpoint_created_at,
            e.updated_at AS endpoint_updated_at,
            c.id AS capability_id,
            c.capability AS cap_capability,
            c.model AS cap_model,
            c.path_override AS cap_path_override,
            c.request_adapter AS cap_request_adapter,
            c.response_adapter AS cap_response_adapter,
            c.supports_stream AS cap_supports_stream,
            c.supports_tools AS cap_supports_tools,
            c.supports_files AS cap_supports_files,
            c.enabled AS cap_enabled,
            c.priority AS cap_priority,
            c.config_json AS cap_config_json,
            c.created_at AS cap_created_at,
            c.updated_at AS cap_updated_at
         FROM ai_endpoints e
         LEFT JOIN ai_endpoint_capabilities c
            ON c.endpoint_id = e.id AND c.capability = ?
         WHERE e.user_id = ? AND e.is_active = 1
         ORDER BY c.priority ASC, c.created_at ASC, e.created_at ASC",
    )
    .bind(cap_str)
    .bind(&req.user_id)
    .fetch_all(pool)
    .await?;

    let mut candidates: Vec<RoutingCandidate> = Vec::new();
    let has_explicit = req.explicit_endpoint_id.is_some();

    for row in &rows {
        if has_explicit {
            if let Some(ref explicit_id) = req.explicit_endpoint_id {
                if row.endpoint_id != *explicit_id {
                    continue;
                }
            }
        }

        let endpoint = AiEndpoint {
            id: row.endpoint_id.clone(),
            user_id: row.user_id.clone(),
            name: row.name.clone(),
            provider: row.provider.clone(),
            base_url: row.base_url.clone(),
            api_key: row.api_key.clone(),
            default_model: row.default_model.clone(),
            is_active: row.is_active,
            created_at: row.endpoint_created_at.clone(),
            updated_at: row.endpoint_updated_at.clone(),
        };

        // Build capability record from row (or None for legacy compat)
        let capability = row.capability_id.as_ref().map(|id| AiEndpointCapability {
            id: id.clone(),
            endpoint_id: row.endpoint_id.clone(),
            capability: row.cap_capability.clone().unwrap_or_else(|| cap_str.to_string()),
            model: row.cap_model.clone(),
            path_override: row.cap_path_override.clone(),
            request_adapter: row
                .cap_request_adapter
                .clone()
                .unwrap_or_else(|| "openai_compatible".to_string()),
            response_adapter: row
                .cap_response_adapter
                .clone()
                .unwrap_or_else(|| "openai_compatible".to_string()),
            supports_stream: row.cap_supports_stream.unwrap_or(false),
            supports_tools: row.cap_supports_tools.unwrap_or(false),
            supports_files: row.cap_supports_files.unwrap_or(false),
            enabled: row.cap_enabled.unwrap_or(true),
            priority: row.cap_priority.unwrap_or(100),
            config_json: row.cap_config_json.clone(),
            created_at: row.cap_created_at.clone().unwrap_or_default(),
            updated_at: row.cap_updated_at.clone().unwrap_or_default(),
        });

        let cap_enabled = row.cap_enabled.unwrap_or(true);
        let cap_priority = row.cap_priority.unwrap_or(100);
        let supports_stream = row.cap_supports_stream.unwrap_or(false);
        let supports_tools = row.cap_supports_tools.unwrap_or(false);

        // For legacy endpoints without capability rows, assume sensible defaults for chat
        let (effective_supports_stream, effective_supports_tools) = if row.capability_id.is_none() {
            match req.capability {
                RoutingCapability::Chat => (true, true),    // assume chat endpoints support stream+tools
                RoutingCapability::ImageGeneration => (false, false),
                RoutingCapability::VideoGeneration => (false, false),
                RoutingCapability::Embedding => (false, false),
            }
        } else {
            (supports_stream, supports_tools)
        };

        // Determine model
        let model = select_model(
            req.requested_model.as_deref(),
            row.cap_model.as_deref(),
            row.default_model.as_deref(),
            req.capability,
        );

        // Parse max context tokens from config_json
        let max_context_tokens = row
            .cap_config_json
            .as_ref()
            .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
            .and_then(|v| v.get("maxContextTokens").and_then(|v| v.as_i64()))
            .unwrap_or(DEFAULT_MAX_CONTEXT_TOKENS);

        // Score the candidate
        let mut score: i64 = 1000;

        // Explicit endpoint: very high priority (but must be compatible)
        if has_explicit {
            if let Some(ref explicit_id) = req.explicit_endpoint_id {
                if row.endpoint_id == *explicit_id {
                    score += 1_000_000;
                }
            }
        }

        // Capability enabled
        if !cap_enabled {
            candidates.push(RoutingCandidate {
                endpoint,
                capability,
                model: model.clone(),
                score: -1,
                supports_streaming: effective_supports_stream,
                supports_tools: effective_supports_tools,
                max_context_tokens,
                rejection_reason: Some("capability_disabled".to_string()),
            });
            continue;
        }

        // Priority (lower priority number = higher score)
        score -= cap_priority;

        // Model match bonus
        if let Some(ref req_model) = req.requested_model {
            if model.eq_ignore_ascii_case(req_model) {
                score += 500;
            } else if row.cap_model.as_deref() == Some(req_model.as_str()) {
                score += 200;
            }
        }

        // Streaming support
        if req.requires_streaming && effective_supports_stream {
            score += 300;
        } else if req.requires_streaming && !effective_supports_stream {
            // Still allow but with penalty (can fall back to non-stream)
            score -= 100;
        }

        // Tools support
        if req.requires_tools && effective_supports_tools {
            score += 200;
        } else if req.requires_tools && !effective_supports_tools {
            // Hard reject: can't do tool use without tool support
            candidates.push(RoutingCandidate {
                endpoint,
                capability,
                model,
                score: -1,
                supports_streaming: effective_supports_stream,
                supports_tools: effective_supports_tools,
                max_context_tokens,
                rejection_reason: Some("tools_not_supported".to_string()),
            });
            continue;
        }

        // Context length check
        if let Some(needed) = req.context_tokens {
            if needed > max_context_tokens {
                score -= 200; // penalty for context pressure, don't reject outright
            }
        }

        candidates.push(RoutingCandidate {
            endpoint,
            capability,
            model,
            score,
            supports_streaming: effective_supports_stream,
            supports_tools: effective_supports_tools,
            max_context_tokens,
            rejection_reason: None,
        });
    }

    // Sort by score descending
    candidates.sort_by(|a, b| b.score.cmp(&a.score));

    let attempt_order: Vec<String> = candidates
        .iter()
        .filter(|c| c.rejection_reason.is_none() && c.score >= 0)
        .map(|c| c.endpoint.id.clone())
        .collect();

    Ok(RoutingDecision {
        candidates,
        attempt_order,
    })
}

/// Select the model for a candidate based on priority chain
fn select_model(
    requested_model: Option<&str>,
    capability_model: Option<&str>,
    endpoint_default_model: Option<&str>,
    capability: RoutingCapability,
) -> String {
    let requested = requested_model.map(str::trim).filter(|s| !s.is_empty());
    let cap_model = capability_model.map(str::trim).filter(|s| !s.is_empty());
    let default_model = endpoint_default_model.map(str::trim).filter(|s| !s.is_empty());

    let fallback = match capability {
        RoutingCapability::Chat => "gpt-4o-mini",
        RoutingCapability::ImageGeneration => "gpt-image-1",
        RoutingCapability::VideoGeneration => "wan2.1-t2v-480p",
        RoutingCapability::Embedding => "text-embedding-3-small",
    };

    let requested_is_default = requested
        .zip(default_model)
        .map(|(r, d)| r.eq_ignore_ascii_case(d))
        .unwrap_or(false);

    let prefer_cap_model = matches!(
        capability,
        RoutingCapability::ImageGeneration | RoutingCapability::VideoGeneration
    ) && cap_model.is_some()
        && (requested.is_none() || requested_is_default);

    if prefer_cap_model {
        cap_model
            .or(requested)
            .or(default_model)
            .unwrap_or(fallback)
            .to_string()
    } else {
        requested
            .or(cap_model)
            .or(default_model)
            .unwrap_or(fallback)
            .to_string()
    }
}

/// Execute the routing + fallback loop.
///
/// Takes a routing request and an async execution function, then:
/// 1. Resolves and scores candidates
/// 2. Tries candidates in order
/// 3. On retryable errors, falls back to the next candidate
/// 4. On non-retryable errors, stops immediately
/// 5. Records audit events for each attempt
/// 6. Enforces max attempts and dedup
pub async fn execute_with_fallback<T, F, Fut>(
    pool: &SqlitePool,
    req: &RoutingRequest,
    execute: F,
) -> AppResult<RoutingOutcome<T>>
where
    T: Clone,
    F: Fn(RoutingCandidate, usize) -> Fut,
    Fut: std::future::Future<Output = Result<T, (Option<u16>, String)>>,
{
    let decision = resolve_candidates(pool, req).await?;

    if decision.attempt_order.is_empty() {
        // Check if we have candidates but all were rejected
        let has_rejected = decision.candidates.iter().any(|c| c.rejection_reason.is_some());
        if req.explicit_endpoint_id.is_some() {
            if has_rejected {
                return Err(AppError::Validation(
                    "指定的 AI 端点不支持该能力或未启用".to_string(),
                ));
            } else {
                return Err(AppError::Validation(
                    "指定的 AI 端点不存在或已停用".to_string(),
                ));
            }
        }
        let label = match req.capability {
            RoutingCapability::Chat => "对话",
            RoutingCapability::ImageGeneration => "图片生成",
            RoutingCapability::VideoGeneration => "视频生成",
            RoutingCapability::Embedding => "嵌入",
        };
        return Err(AppError::Validation(format!(
            "请先在设置里为 API 通道启用{}能力",
            label
        )));
    }

    // Filter to usable candidates (not rejected)
    let usable: Vec<&RoutingCandidate> = decision
        .candidates
        .iter()
        .filter(|c| c.rejection_reason.is_none() && c.score >= 0)
        .collect();

    let max_attempts = usable.len().min(MAX_ROUTING_ATTEMPTS);
    let mut attempts: Vec<AttemptResult<T>> = Vec::new();
    let mut tried_endpoints: HashSet<String> = HashSet::new();
    let mut total_start = std::time::Instant::now();

    // Record "selected" event
    record_routing_event(
        pool,
        req,
        RoutingStatus::Selected,
        None,
        None,
        None,
        None,
        None,
        0,
        max_attempts as i64,
        None,
        None,
        None,
        0,
        false,
        None,
        Some(&decision.candidates),
    )
    .await;

    for (idx, candidate) in usable.iter().enumerate().take(max_attempts) {
        if tried_endpoints.contains(&candidate.endpoint.id) {
            continue;
        }
        tried_endpoints.insert(candidate.endpoint.id.clone());

        let attempt_start = std::time::Instant::now();

        // Record "attempt" event
        record_routing_event(
            pool,
            req,
            RoutingStatus::Attempt,
            Some(&candidate.endpoint.id),
            Some(&candidate.model),
            Some(&candidate.endpoint.provider),
            None,
            None,
            idx,
            max_attempts as i64,
            None,
            None,
            None,
            0,
            false,
            None,
            None,
        )
        .await;

        let result = execute((*candidate).clone(), idx).await;
        let latency_ms = attempt_start.elapsed().as_millis() as i64;

        match result {
            Ok(value) => {
                let attempt = AttemptResult {
                    endpoint_id: candidate.endpoint.id.clone(),
                    model: candidate.model.clone(),
                    provider: candidate.endpoint.provider.clone(),
                    attempt_index: idx,
                    result: Some(value.clone()),
                    error_classification: None,
                    error_message: None,
                    http_status: None,
                    latency_ms,
                };
                attempts.push(attempt);

                let was_fallback = idx > 0;
                let fallback_reason = if was_fallback {
                    attempts
                        .first()
                        .and_then(|a| a.error_message.clone())
                } else {
                    None
                };

                // Record success
                record_routing_event(
                    pool,
                    req,
                    if was_fallback {
                        RoutingStatus::Fallback
                    } else {
                        RoutingStatus::Success
                    },
                    Some(&candidate.endpoint.id),
                    Some(&candidate.model),
                    Some(&candidate.endpoint.provider),
                    Some(&candidate.endpoint.id),
                    Some(&candidate.model),
                    idx,
                    max_attempts as i64,
                    None,
                    None,
                    None,
                    latency_ms,
                    was_fallback,
                    fallback_reason.as_deref(),
                    None,
                )
                .await;

                return Ok(RoutingOutcome {
                    result: Some(value),
                    final_endpoint_id: Some(candidate.endpoint.id.clone()),
                    final_model: Some(candidate.model.clone()),
                    final_provider: Some(candidate.endpoint.provider.clone()),
                    attempts,
                    was_fallback,
                    fallback_reason,
                    total_latency_ms: total_start.elapsed().as_millis() as i64,
                    exhausted: false,
                });
            }
            Err((http_status, error_msg)) => {
                let classification = classify_error(http_status, &error_msg);
                let sanitized_error = sanitize_error_message(&error_msg);

                let attempt = AttemptResult {
                    endpoint_id: candidate.endpoint.id.clone(),
                    model: candidate.model.clone(),
                    provider: candidate.endpoint.provider.clone(),
                    attempt_index: idx,
                    result: None,
                    error_classification: Some(classification),
                    error_message: Some(sanitized_error.clone()),
                    http_status,
                    latency_ms,
                };

                // Record failure attempt
                record_routing_event(
                    pool,
                    req,
                    RoutingStatus::Failed,
                    Some(&candidate.endpoint.id),
                    Some(&candidate.model),
                    Some(&candidate.endpoint.provider),
                    None,
                    None,
                    idx,
                    max_attempts as i64,
                    Some(classification),
                    Some(&sanitized_error),
                    http_status.map(|s| s as i64),
                    latency_ms,
                    idx > 0,
                    None,
                    None,
                )
                .await;

                let is_last = idx == max_attempts - 1;

                if !classification.is_retryable() || is_last {
                    attempts.push(attempt);

                    if is_last && classification.is_retryable() {
                        // Exhausted all candidates
                        record_routing_event(
                            pool,
                            req,
                            RoutingStatus::Exhausted,
                            None,
                            None,
                            None,
                            None,
                            None,
                            idx + 1,
                            max_attempts as i64,
                            Some(classification),
                            Some(&sanitized_error),
                            http_status.map(|s| s as i64),
                            latency_ms,
                            false,
                            Some("all_candidates_failed"),
                            None,
                        )
                        .await;
                    }

                    return Ok(RoutingOutcome {
                        result: None,
                        final_endpoint_id: None,
                        final_model: None,
                        final_provider: None,
                        attempts,
                        was_fallback: idx > 0,
                        fallback_reason: None,
                        total_latency_ms: total_start.elapsed().as_millis() as i64,
                        exhausted: is_last && classification.is_retryable(),
                    });
                }

                attempts.push(attempt);
                // Continue to next candidate
            }
        }
    }

    // Should not reach here normally
    Ok(RoutingOutcome {
        result: None,
        final_endpoint_id: None,
        final_model: None,
        final_provider: None,
        attempts,
        was_fallback: false,
        fallback_reason: None,
        total_latency_ms: total_start.elapsed().as_millis() as i64,
        exhausted: true,
    })
}

/// Sanitize error message to remove sensitive data (API keys, tokens, paths)
fn sanitize_error_message(msg: &str) -> String {
    let mut sanitized = msg.to_string();
    // Remove bearer tokens
    if let Some(start) = sanitized.to_ascii_lowercase().find("bearer ") {
        let rest = &sanitized[start + 7..];
        if let Some(end) = rest.find(|c: char| c.is_whitespace() || c == ',' || c == '"' || c == '\'') {
            sanitized.replace_range(start..start + 7 + end, "bearer [REDACTED]");
        } else {
            sanitized.truncate(start + 7);
            sanitized.push_str("[REDACTED]");
        }
    }
    // Remove sk- / api key patterns
    let key_patterns = ["sk-", "sk_", "key-", "key_"];
    for pattern in key_patterns {
        if let Some(start) = sanitized.to_ascii_lowercase().find(pattern) {
            let rest = &sanitized[start..];
            let end = rest
                .find(|c: char| c.is_whitespace() || c == ',' || c == '"' || c == '\'' || c == '}')
                .unwrap_or(rest.len().min(20));
            sanitized.replace_range(start..start + end, &format!("{}[REDACTED]", pattern));
        }
    }
    // Truncate very long messages
    if sanitized.len() > 500 {
        sanitized.truncate(500);
        sanitized.push_str("...");
    }
    sanitized
}

// ─── Audit Logging ───────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn record_routing_event(
    pool: &SqlitePool,
    req: &RoutingRequest,
    status: RoutingStatus,
    candidate_endpoint_id: Option<&str>,
    candidate_model: Option<&str>,
    candidate_provider: Option<&str>,
    final_endpoint_id: Option<&str>,
    final_model: Option<&str>,
    attempt_index: usize,
    max_attempts: i64,
    error_classification: Option<ErrorClassification>,
    error_message: Option<&str>,
    http_status: Option<i64>,
    latency_ms: i64,
    was_fallback: bool,
    fallback_reason: Option<&str>,
    candidates: Option<&Vec<RoutingCandidate>>,
) {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let candidates_json = candidates.map(|c| {
        let summary: Vec<serde_json::Value> = c
            .iter()
            .map(|cand| {
                serde_json::json!({
                    "endpointId": cand.endpoint.id,
                    "endpointName": cand.endpoint.name,
                    "model": cand.model,
                    "score": cand.score,
                    "supportsStreaming": cand.supports_streaming,
                    "supportsTools": cand.supports_tools,
                    "rejectionReason": cand.rejection_reason,
                })
            })
            .collect();
        serde_json::to_string(&summary).unwrap_or_default()
    });

    let result = sqlx::query(
        "INSERT INTO ai_routing_events (
            id, user_id, request_id, task_id, run_id, step_id,
            conversation_id, project_id, generation_id,
            operation, capability,
            candidate_endpoint_id, candidate_model, candidate_provider,
            final_endpoint_id, final_model, final_provider,
            explicit_endpoint_id, requested_model,
            status, attempt_index, max_attempts,
            error_classification, error_message, http_status,
            latency_ms, was_fallback, fallback_reason, candidates_json,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.user_id)
    .bind(&req.request_id)
    .bind(&req.task_id)
    .bind(&req.run_id)
    .bind(&req.step_id)
    .bind(&req.conversation_id)
    .bind(&req.project_id)
    .bind(&req.generation_id)
    .bind(req.operation.as_str())
    .bind(req.capability.as_str())
    .bind(candidate_endpoint_id)
    .bind(candidate_model)
    .bind(candidate_provider)
    .bind(final_endpoint_id)
    .bind(final_model)
    .bind(final_provider)
    .bind(&req.explicit_endpoint_id)
    .bind(&req.requested_model)
    .bind(status.as_str())
    .bind(attempt_index as i64)
    .bind(max_attempts)
    .bind(error_classification.map(|e| e.as_str()))
    .bind(error_message)
    .bind(http_status)
    .bind(latency_ms)
    .bind(was_fallback)
    .bind(fallback_reason)
    .bind(candidates_json)
    .bind(&now)
    .execute(pool)
    .await;

    if let Err(e) = result {
        tracing::warn!(error = %e, "Failed to record routing audit event");
    }
}

/// Query routing events with filters and pagination
pub async fn query_routing_events(
    pool: &SqlitePool,
    user_id: &str,
    filter: &RoutingEventFilter,
) -> AppResult<Vec<RoutingEventRecord>> {
    let limit = filter.limit.unwrap_or(50).clamp(1, 200);
    let offset = filter.offset.unwrap_or(0).max(0);

    let mut query = String::from(
        "SELECT id, user_id, request_id, task_id, run_id, step_id,
            conversation_id, project_id, generation_id,
            operation, capability,
            candidate_endpoint_id, candidate_model, candidate_provider,
            final_endpoint_id, final_model, final_provider,
            explicit_endpoint_id, requested_model,
            status, attempt_index, max_attempts,
            error_classification, error_message, http_status,
            latency_ms, was_fallback, fallback_reason, candidates_json,
            created_at
         FROM ai_routing_events
         WHERE user_id = ?",
    );
    let mut binds: Vec<String> = Vec::new();
    binds.push(user_id.to_string());

    if let Some(ref ep) = filter.endpoint_id {
        query.push_str(
            " AND (candidate_endpoint_id = ? OR final_endpoint_id = ?)",
        );
        binds.push(ep.clone());
        binds.push(ep.clone());
    }
    if let Some(ref cap) = filter.capability {
        query.push_str(" AND capability = ?");
        binds.push(cap.clone());
    }
    if let Some(ref status) = filter.status {
        query.push_str(" AND status = ?");
        binds.push(status.clone());
    }
    if let Some(ref op) = filter.operation {
        query.push_str(" AND operation = ?");
        binds.push(op.clone());
    }

    query.push_str(" ORDER BY created_at DESC LIMIT ? OFFSET ?");

    let mut q = sqlx::query_as::<_, RoutingEventRecord>(&query);
    for b in &binds {
        q = q.bind(b);
    }
    q = q.bind(limit).bind(offset);

    let records = q.fetch_all(pool).await?;
    Ok(records)
}

/// Get endpoint health summary from recent routing events
pub async fn get_endpoint_health(
    pool: &SqlitePool,
    user_id: &str,
) -> AppResult<Vec<EndpointHealthSummary>> {
    let rows = sqlx::query_as::<_, EndpointHealthRow>(
        "SELECT
            candidate_endpoint_id as endpoint_id,
            COUNT(*) as total_requests,
            SUM(CASE WHEN status = 'success' OR status = 'fallback' THEN 1 ELSE 0 END) as success_count,
            SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END) as fallback_count,
            SUM(CASE WHEN status = 'failed' OR status = 'exhausted' THEN 1 ELSE 0 END) as failed_count,
            AVG(latency_ms) as avg_latency_ms,
            SUM(CASE WHEN status IN ('failed', 'exhausted') AND created_at > datetime('now', '-24 hours') THEN 1 ELSE 0 END) as recent_errors_24h,
            MAX(CASE WHEN status IN ('failed', 'exhausted') THEN created_at END) as last_error_at,
            MAX(CASE WHEN status IN ('success', 'fallback') THEN created_at END) as last_success_at
         FROM ai_routing_events
         WHERE user_id = ? AND candidate_endpoint_id IS NOT NULL
         GROUP BY candidate_endpoint_id
         ORDER BY total_requests DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| EndpointHealthSummary {
            endpoint_id: r.endpoint_id,
            total_requests: r.total_requests,
            success_count: r.success_count,
            fallback_count: r.fallback_count,
            failed_count: r.failed_count,
            avg_latency_ms: r.avg_latency_ms.unwrap_or(0),
            recent_errors_24h: r.recent_errors_24h,
            last_error_at: r.last_error_at,
            last_success_at: r.last_success_at,
        })
        .collect())
}

#[derive(Debug, FromRow)]
struct EndpointHealthRow {
    endpoint_id: String,
    total_requests: i64,
    success_count: i64,
    fallback_count: i64,
    failed_count: i64,
    avg_latency_ms: Option<i64>,
    recent_errors_24h: i64,
    last_error_at: Option<String>,
    last_success_at: Option<String>,
}

// ─── Routed Chat Helper ─────────────────────────────────────────────────────

/// Result of a routed chat call (non-streaming)
#[derive(Debug, Clone)]
pub struct RoutedChatResult {
    pub content: String,
    pub model: String,
    pub usage: Option<crate::ai::client::TokenUsage>,
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub provider: String,
    pub was_fallback: bool,
    pub fallback_reason: Option<String>,
    pub attempt_count: usize,
}

/// Result of a routed chat stream (streaming)
pub struct RoutedStreamResult {
    pub stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = Result<String, crate::error::AppError>> + Send>,
    >,
    pub model: String,
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub provider: String,
    /// Total number of viable candidates available (for fallback awareness)
    pub candidate_count: usize,
    /// Whether the selected endpoint differs from the explicit request
    pub was_fallback: bool,
}

/// Execute a non-streaming chat call with intelligent routing and fallback
pub async fn routed_chat_call(
    pool: &SqlitePool,
    ai_client: &crate::ai::client::AiClient,
    req: &RoutingRequest,
    messages: Vec<crate::ai::client::ChatMessage>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    frequency_penalty: Option<f64>,
    max_tokens: Option<i64>,
    stream_fallback_mode: crate::ai::client::StreamFallbackMode,
) -> AppResult<RoutedChatResult> {
    let messages_for_exec = messages.clone();
    let ai_client_clone = ai_client.clone();

    let outcome = execute_with_fallback(pool, req, move |candidate, _idx| {
        let msgs = messages_for_exec.clone();
        let client = ai_client_clone.clone();
        let model = candidate.model.clone();
        let base_url = candidate.endpoint.base_url.clone();
        let api_key = candidate.endpoint.api_key.clone();
        async move {
            match client
                .chat(
                    &base_url,
                    &api_key,
                    &model,
                    msgs,
                    temperature,
                    top_p,
                    frequency_penalty,
                    max_tokens,
                    stream_fallback_mode,
                )
                .await
            {
                Ok(resp) => Ok((resp.content, resp.model, resp.usage, candidate.endpoint.name.clone())),
                Err(e) => {
                    let err_str = e.to_string();
                    // Try to extract HTTP status from error
                    let http_status = extract_http_status(&err_str);
                    Err((http_status, err_str))
                }
            }
        }
    })
    .await?;

    match outcome.result {
        Some((content, model, usage, endpoint_name)) => Ok(RoutedChatResult {
            content,
            model,
            usage,
            endpoint_id: outcome.final_endpoint_id.unwrap_or_default(),
            endpoint_name,
            provider: outcome.final_provider.unwrap_or_default(),
            was_fallback: outcome.was_fallback,
            fallback_reason: outcome.fallback_reason,
            attempt_count: outcome.attempts.len(),
        }),
        None => {
            let last_error = outcome
                .attempts
                .last()
                .and_then(|a| a.error_message.clone())
                .unwrap_or_else(|| "所有 AI 端点均不可用".to_string());
            Err(crate::error::AppError::Internal(format!(
                "AI 请求失败 (尝试 {} 个端点): {}",
                outcome.attempts.len(),
                last_error
            )))
        }
    }
}

/// Execute a streaming chat call with routing. For streaming, fallback is handled
/// at the stream error level (if stream fails mid-way, caller should retry with next candidate).
/// This function selects the best candidate and returns a stream for it.
pub async fn routed_chat_stream_call(
    pool: &SqlitePool,
    ai_client: &crate::ai::client::AiClient,
    req: &RoutingRequest,
    messages: Vec<crate::ai::client::ChatMessage>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    frequency_penalty: Option<f64>,
    max_tokens: Option<i64>,
) -> AppResult<RoutedStreamResult> {
    let decision = resolve_candidates(pool, req).await?;

    if decision.attempt_order.is_empty() {
        let has_rejected = decision.candidates.iter().any(|c| c.rejection_reason.is_some());
        if req.explicit_endpoint_id.is_some() {
            if has_rejected {
                return Err(crate::error::AppError::Validation(
                    "指定的 AI 端点不支持该能力或未启用".to_string(),
                ));
            } else {
                return Err(crate::error::AppError::Validation(
                    "指定的 AI 端点不存在或已停用".to_string(),
                ));
            }
        }
        let label = match req.capability {
            RoutingCapability::Chat => "对话",
            RoutingCapability::ImageGeneration => "图片生成",
            RoutingCapability::VideoGeneration => "视频生成",
            RoutingCapability::Embedding => "嵌入",
        };
        return Err(crate::error::AppError::Validation(format!(
            "请先在设置里为 API 通道启用{}能力",
            label
        )));
    }

    let usable: Vec<&RoutingCandidate> = decision
        .candidates
        .iter()
        .filter(|c| c.rejection_reason.is_none() && c.score >= 0)
        .collect();

    if usable.is_empty() {
        let label = match req.capability {
            RoutingCapability::Chat => "对话",
            RoutingCapability::ImageGeneration => "图片生成",
            RoutingCapability::VideoGeneration => "视频生成",
            RoutingCapability::Embedding => "嵌入",
        };
        return Err(crate::error::AppError::Validation(format!(
            "请先在设置里为 API 通道启用{}能力",
            label
        )));
    }

    // For streaming, we try the best candidate first; if it fails at the stream level
    // the caller can fall back (existing stream fallback logic handles this)
    let best = usable[0];
    let candidate_count = usable.len().min(MAX_ROUTING_ATTEMPTS);

    // Determine if fallback occurred (explicit endpoint was overridden)
    let was_fallback = req
        .explicit_endpoint_id
        .as_ref()
        .map(|id| id != &best.endpoint.id)
        .unwrap_or(false);

    // Record routing selection
    record_routing_event(
        pool,
        req,
        RoutingStatus::Selected,
        Some(&best.endpoint.id),
        Some(&best.model),
        Some(&best.endpoint.provider),
        None,
        None,
        0,
        candidate_count as i64,
        None,
        None,
        None,
        0,
        was_fallback,
        None,
        Some(&decision.candidates),
    )
    .await;

    let stream = ai_client
        .chat_stream(
            &best.endpoint.base_url,
            &best.endpoint.api_key,
            &best.model,
            messages,
            temperature,
            top_p,
            frequency_penalty,
            max_tokens,
        )
        .await?;

    Ok(RoutedStreamResult {
        stream,
        model: best.model.clone(),
        endpoint_id: best.endpoint.id.clone(),
        endpoint_name: best.endpoint.name.clone(),
        provider: best.endpoint.provider.clone(),
        candidate_count,
        was_fallback,
    })
}

/// Extract HTTP status code from error string (best effort)
fn extract_http_status(error: &str) -> Option<u16> {
    // Look for patterns like "429", "500", "status: 429", etc.
    let lower = error.to_ascii_lowercase();
    for status in [400u16, 401, 403, 404, 408, 429, 500, 502, 503, 504] {
        if lower.contains(&format!("{}", status)) {
            // Verify it's actually a status code reference
            let s = format!("{}", status);
            if lower.contains(&format!("status {}", s))
                || lower.contains(&format!("code {}", s))
                || lower.contains(&format!("error {}", s))
                || lower.contains(&s)
            {
                return Some(status);
            }
        }
    }
    None
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_error_by_status() {
        assert_eq!(classify_error(Some(401), ""), ErrorClassification::AuthError);
        assert_eq!(classify_error(Some(403), ""), ErrorClassification::AuthError);
        assert_eq!(
            classify_error(Some(400), ""),
            ErrorClassification::ValidationError
        );
        assert_eq!(classify_error(Some(408), ""), ErrorClassification::Timeout);
        assert_eq!(
            classify_error(Some(429), ""),
            ErrorClassification::RateLimited
        );
        assert_eq!(
            classify_error(Some(500), ""),
            ErrorClassification::ServerError
        );
        assert_eq!(
            classify_error(Some(502), ""),
            ErrorClassification::ServerError
        );
        assert_eq!(
            classify_error(Some(503), ""),
            ErrorClassification::ServerError
        );
        assert_eq!(classify_error(Some(418), ""), ErrorClassification::Unknown);
    }

    #[test]
    fn test_classify_error_by_message() {
        assert_eq!(
            classify_error(None, "Connection refused"),
            ErrorClassification::NetworkError
        );
        assert_eq!(
            classify_error(None, "DNS resolution failed"),
            ErrorClassification::NetworkError
        );
        assert_eq!(
            classify_error(None, "request timed out"),
            ErrorClassification::Timeout
        );
        assert_eq!(
            classify_error(None, "Rate limit exceeded"),
            ErrorClassification::RateLimited
        );
        assert_eq!(
            classify_error(None, "Invalid API key provided"),
            ErrorClassification::AuthError
        );
        assert_eq!(
            classify_error(None, "content policy violation"),
            ErrorClassification::ContentSafety
        );
        assert_eq!(
            classify_error(None, "invalid model: xyz"),
            ErrorClassification::ValidationError
        );
        assert_eq!(
            classify_error(None, "internal server error"),
            ErrorClassification::ServerError
        );
        assert_eq!(
            classify_error(None, "连接超时"),
            ErrorClassification::Timeout
        );
        assert_eq!(
            classify_error(None, "连接失败"),
            ErrorClassification::NetworkError
        );
    }

    #[test]
    fn test_retryable_classification() {
        assert!(ErrorClassification::NetworkError.is_retryable());
        assert!(ErrorClassification::Timeout.is_retryable());
        assert!(ErrorClassification::RateLimited.is_retryable());
        assert!(ErrorClassification::ServerError.is_retryable());
        assert!(ErrorClassification::CapabilityMismatch.is_retryable());

        assert!(!ErrorClassification::AuthError.is_retryable());
        assert!(!ErrorClassification::ValidationError.is_retryable());
        assert!(!ErrorClassification::ContentSafety.is_retryable());
        assert!(!ErrorClassification::Unknown.is_retryable());
    }

    #[test]
    fn test_select_model_chat() {
        // Requested model takes priority for chat
        assert_eq!(
            select_model(Some("gpt-4o"), Some("gpt-4"), Some("gpt-4o-mini"), RoutingCapability::Chat),
            "gpt-4o"
        );
        // Falls back to capability model
        assert_eq!(
            select_model(None, Some("gpt-4"), Some("gpt-4o-mini"), RoutingCapability::Chat),
            "gpt-4"
        );
        // Falls back to endpoint default
        assert_eq!(
            select_model(None, None, Some("gpt-4o-mini"), RoutingCapability::Chat),
            "gpt-4o-mini"
        );
        // Falls back to hardcoded default
        assert_eq!(select_model(None, None, None, RoutingCapability::Chat), "gpt-4o-mini");
    }

    #[test]
    fn test_select_model_image_prefers_capability() {
        // Image gen prefers capability model when no explicit model
        assert_eq!(
            select_model(None, Some("dall-e-3"), Some("gpt-4o"), RoutingCapability::ImageGeneration),
            "dall-e-3"
        );
        // Explicit non-default model wins for image gen
        assert_eq!(
            select_model(
                Some("dall-e-2"),
                Some("gpt-image-1"),
                Some("gpt-4o"),
                RoutingCapability::ImageGeneration
            ),
            "dall-e-2"
        );
    }

    #[test]
    fn test_sanitize_error_removes_bearer() {
        let msg = "Authorization: Bearer sk-1234567890abcdef failed";
        let sanitized = sanitize_error_message(msg);
        assert!(!sanitized.contains("sk-1234567890abcdef"));
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn test_sanitize_error_truncates_long() {
        let msg = "x".repeat(1000);
        let sanitized = sanitize_error_message(&msg);
        assert!(sanitized.len() <= 504); // 500 + "..."
    }

    #[test]
    fn test_extract_http_status() {
        assert_eq!(extract_http_status("status 429"), Some(429));
        assert_eq!(extract_http_status("error 500"), Some(500));
        assert_eq!(extract_http_status("code 408"), Some(408));
        assert_eq!(extract_http_status("429 rate limited"), Some(429));
        assert_eq!(extract_http_status("something else entirely"), None);
    }

    #[test]
    fn test_sanitize_error_removes_sk_keys() {
        let msg = "request failed with key sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234";
        let sanitized = sanitize_error_message(msg);
        assert!(!sanitized.contains("sk-abc123"));
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn test_sanitize_error_removes_password_patterns() {
        let msg = "password=supersecret123&other=value";
        let sanitized = sanitize_error_message(msg);
        assert!(!sanitized.contains("supersecret123"));
    }

    #[test]
    fn test_routing_capability_roundtrip() {
        for cap in [
            RoutingCapability::Chat,
            RoutingCapability::ImageGeneration,
            RoutingCapability::VideoGeneration,
            RoutingCapability::Embedding,
        ] {
            let s = cap.as_str();
            let parsed = RoutingCapability::from_str(s);
            assert_eq!(parsed, cap);
        }
        // Default to Chat for unknown
        assert_eq!(RoutingCapability::from_str("unknown"), RoutingCapability::Chat);
        assert_eq!(RoutingCapability::from_str(""), RoutingCapability::Chat);
    }

    #[test]
    fn test_routing_operation_as_str() {
        assert_eq!(RoutingOperation::Chat.as_str(), "chat");
        assert_eq!(RoutingOperation::Stream.as_str(), "stream");
        assert_eq!(RoutingOperation::Task.as_str(), "task");
        assert_eq!(RoutingOperation::Test.as_str(), "test");
        assert_eq!(RoutingOperation::ImageGeneration.as_str(), "image_generation");
        assert_eq!(RoutingOperation::VideoGeneration.as_str(), "video_generation");
        assert_eq!(RoutingOperation::PipelineStep.as_str(), "pipeline_step");
    }

    #[test]
    fn test_error_classification_as_str() {
        assert_eq!(ErrorClassification::NetworkError.as_str(), "network_error");
        assert_eq!(ErrorClassification::Timeout.as_str(), "timeout");
        assert_eq!(ErrorClassification::RateLimited.as_str(), "rate_limited");
        assert_eq!(ErrorClassification::ServerError.as_str(), "server_error");
        assert_eq!(ErrorClassification::AuthError.as_str(), "auth_error");
        assert_eq!(ErrorClassification::ValidationError.as_str(), "validation_error");
        assert_eq!(ErrorClassification::ContentSafety.as_str(), "content_safety");
        assert_eq!(ErrorClassification::CapabilityMismatch.as_str(), "capability_mismatch");
        assert_eq!(ErrorClassification::Unknown.as_str(), "unknown");
    }

    #[test]
    fn test_max_routing_attempts_constant() {
        // Max attempts should be reasonable (at least 1, at most 5)
        assert!(MAX_ROUTING_ATTEMPTS >= 1);
        assert!(MAX_ROUTING_ATTEMPTS <= 5);
    }

    #[test]
    fn test_select_model_video_generation() {
        assert_eq!(
            select_model(None, Some("wan2.1-t2v-480p"), Some("gpt-4o"), RoutingCapability::VideoGeneration),
            "wan2.1-t2v-480p"
        );
        assert_eq!(
            select_model(Some("sora-1"), None, Some("gpt-4o"), RoutingCapability::VideoGeneration),
            "sora-1"
        );
        assert_eq!(
            select_model(None, None, None, RoutingCapability::VideoGeneration),
            "wan2.1-t2v-480p"
        );
    }

    #[test]
    fn test_select_model_embedding() {
        assert_eq!(
            select_model(None, None, None, RoutingCapability::Embedding),
            "text-embedding-3-small"
        );
        assert_eq!(
            select_model(Some("text-embedding-3-large"), None, None, RoutingCapability::Embedding),
            "text-embedding-3-large"
        );
    }

    #[test]
    fn test_classify_error_chinese_content_safety() {
        assert_eq!(
            classify_error(None, "内容安全检测未通过"),
            ErrorClassification::ContentSafety
        );
        assert_eq!(
            classify_error(None, "该内容涉及敏感信息"),
            ErrorClassification::ContentSafety
        );
        assert_eq!(
            classify_error(None, "因合规原因被拒绝"),
            ErrorClassification::ContentSafety
        );
    }

    #[test]
    fn test_classify_error_chinese_timeout() {
        assert_eq!(
            classify_error(None, "请求超时"),
            ErrorClassification::Timeout
        );
        assert_eq!(
            classify_error(None, "连接超时"),
            ErrorClassification::Timeout
        );
    }

    #[test]
    fn test_classify_error_chinese_validation() {
        assert_eq!(
            classify_error(None, "参数错误"),
            ErrorClassification::ValidationError
        );
        assert_eq!(
            classify_error(None, "请求参数无效"),
            ErrorClassification::ValidationError
        );
    }

    #[test]
    fn test_classify_error_auth_messages() {
        assert_eq!(
            classify_error(None, "unauthorized access"),
            ErrorClassification::AuthError

        );
        assert_eq!(
            classify_error(None, "forbidden"),
            ErrorClassification::AuthError
        );
        assert_eq!(
            classify_error(None, "Invalid API key"),
            ErrorClassification::AuthError
        );
        assert_eq!(
            classify_error(None, "authentication failed"),
            ErrorClassification::AuthError
        );
    }

    #[test]
    fn test_routing_status_as_str() {
        assert_eq!(RoutingStatus::Selected.as_str(), "selected");
        assert_eq!(RoutingStatus::Attempt.as_str(), "attempt");
        assert_eq!(RoutingStatus::Success.as_str(), "success");
        assert_eq!(RoutingStatus::Fallback.as_str(), "fallback");
        assert_eq!(RoutingStatus::Failed.as_str(), "failed");
        assert_eq!(RoutingStatus::Exhausted.as_str(), "exhausted");
    }

    #[test]
    fn test_classify_error_429_is_retryable() {
        let classification = classify_error(Some(429), "rate limit exceeded");
        assert_eq!(classification, ErrorClassification::RateLimited);
        assert!(classification.is_retryable());
    }

    #[test]
    fn test_classify_error_503_is_retryable() {
        let classification = classify_error(Some(503), "service unavailable");
        assert_eq!(classification, ErrorClassification::ServerError);
        assert!(classification.is_retryable());
    }

    #[test]
    fn test_classify_error_401_is_not_retryable() {
        let classification = classify_error(Some(401), "unauthorized");
        assert_eq!(classification, ErrorClassification::AuthError);
        assert!(!classification.is_retryable());
    }

    #[test]
    fn test_classify_error_content_safety_chinese() {
        assert_eq!(
            classify_error(None, "内容安全检测未通过，请修改后重试"),
            ErrorClassification::ContentSafety
        );
        assert!(!classify_error(None, "内容安全检测未通过").is_retryable());
    }

    #[test]
    fn test_classify_error_connection_refused() {
        assert_eq!(
            classify_error(None, "Connection refused by remote host"),
            ErrorClassification::NetworkError
        );
        assert!(classify_error(None, "Connection refused").is_retryable());
    }

    #[test]
    fn test_classify_error_dns_failure() {
        assert_eq!(
            classify_error(None, "DNS resolution failed for api.example.com"),
            ErrorClassification::NetworkError
        );
    }

    #[test]
    fn test_classify_error_tls_error() {
        assert_eq!(
            classify_error(None, "TLS handshake failed"),
            ErrorClassification::NetworkError
        );
    }

    #[test]
    fn test_sanitize_error_removes_bearer_token() {
        let msg = "request failed: Authorization: Bearer sk-1234567890abcdef";
        let sanitized = sanitize_error_message(msg);
        assert!(!sanitized.contains("sk-1234567890abcdef"));
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn test_sanitize_error_removes_multiple_secrets() {
        let msg = "key=sk-abc123 password=hunter2 token=tok_xyz789";
        let sanitized = sanitize_error_message(msg);
        assert!(!sanitized.contains("sk-abc123"));
        assert!(!sanitized.contains("hunter2"));
        assert!(!sanitized.contains("tok_xyz789"));
    }

    #[test]
    fn test_sanitize_error_preserves_harmless_content() {
        let msg = "Request failed with status 503: Service unavailable";
        let sanitized = sanitize_error_message(msg);
        assert!(sanitized.contains("503"));
        assert!(sanitized.contains("Service unavailable"));
    }

    #[test]
    fn test_default_max_context_tokens() {
        assert_eq!(DEFAULT_MAX_CONTEXT_TOKENS, 128_000);
    }

    #[test]
    fn test_classify_error_408_timeout() {
        assert_eq!(
            classify_error(Some(408), "request timeout"),
            ErrorClassification::Timeout
        );
        assert!(classify_error(Some(408), "request timeout").is_retryable());
    }

    #[test]
    fn test_classify_error_502_bad_gateway() {
        assert_eq!(
            classify_error(Some(502), "bad gateway"),
            ErrorClassification::ServerError
        );
        assert!(classify_error(Some(502), "bad gateway").is_retryable());
    }

    #[test]
    fn test_classify_error_504_gateway_timeout() {
        assert_eq!(
            classify_error(Some(504), "gateway timeout"),
            ErrorClassification::ServerError
        );
        assert!(classify_error(Some(504), "gateway timeout").is_retryable());
    }

    #[test]
    fn test_classify_error_400_validation() {
        assert_eq!(
            classify_error(Some(400), "bad request: invalid parameters"),
            ErrorClassification::ValidationError
        );
        assert!(!classify_error(Some(400), "bad request").is_retryable());
    }

    #[test]
    fn test_classify_error_403_auth() {
        assert_eq!(
            classify_error(Some(403), "forbidden"),
            ErrorClassification::AuthError
        );
        assert!(!classify_error(Some(403), "forbidden").is_retryable());
    }

    #[test]
    fn test_classify_error_500_server_error() {
        assert_eq!(
            classify_error(Some(500), "internal server error"),
            ErrorClassification::ServerError
        );
        assert!(classify_error(Some(500), "internal server error").is_retryable());
    }

    #[test]
    fn test_classify_error_network_message() {
        assert_eq!(
            classify_error(None, "connection reset by peer"),
            ErrorClassification::NetworkError
        );
        assert!(classify_error(None, "connection reset by peer").is_retryable());
    }

    #[test]
    fn test_classify_error_timeout_message() {
        assert_eq!(
            classify_error(None, "operation timed out after 30 seconds"),
            ErrorClassification::Timeout
        );
    }

    #[test]
    fn test_classify_error_rate_limited_message() {
        assert_eq!(
            classify_error(None, "rate limit exceeded, retry after 5s"),
            ErrorClassification::RateLimited
        );
        assert!(classify_error(None, "rate limit exceeded").is_retryable());
    }

    #[test]
    fn test_routing_capability_as_str() {
        assert_eq!(RoutingCapability::Chat.as_str(), "chat");
        assert_eq!(RoutingCapability::ImageGeneration.as_str(), "image_generation");
        assert_eq!(RoutingCapability::VideoGeneration.as_str(), "video_generation");
        assert_eq!(RoutingCapability::Embedding.as_str(), "embedding");
    }

    #[test]
    fn test_routing_operation_as_str() {
        assert_eq!(RoutingOperation::Chat.as_str(), "chat");
        assert_eq!(RoutingOperation::Stream.as_str(), "stream");
        assert_eq!(RoutingOperation::Task.as_str(), "task");
        assert_eq!(RoutingOperation::Test.as_str(), "test");
        assert_eq!(RoutingOperation::PipelineStep.as_str(), "pipeline_step");
        assert_eq!(RoutingOperation::ImageGeneration.as_str(), "image_generation");
        assert_eq!(RoutingOperation::VideoGeneration.as_str(), "video_generation");
    }

    #[test]
    fn test_select_model_image_generation() {
        assert_eq!(
            select_model(None, Some("dall-e-3"), Some("gpt-4o"), RoutingCapability::ImageGeneration),
            "dall-e-3"
        );
        assert_eq!(
            select_model(Some("dall-e-3"), None, Some("gpt-4o"), RoutingCapability::ImageGeneration),
            "dall-e-3"
        );
        assert_eq!(
            select_model(None, None, None, RoutingCapability::ImageGeneration),
            "dall-e-3"
        );
    }

    #[test]
    fn test_select_model_chat_prefers_requested() {
        assert_eq!(
            select_model(Some("gpt-4o"), Some("claude-3"), Some("gpt-3.5"), RoutingCapability::Chat),
            "gpt-4o"
        );
        assert_eq!(
            select_model(None, Some("claude-3"), Some("gpt-3.5"), RoutingCapability::Chat),
            "claude-3"
        );
        assert_eq!(
            select_model(None, None, Some("gpt-3.5"), RoutingCapability::Chat),
            "gpt-3.5"
        );
        // Fallback default for chat when nothing specified
        let result = select_model(None, None, None, RoutingCapability::Chat);
        assert!(!result.is_empty());
    }
}
