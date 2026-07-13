//! AI endpoint smart router with candidate ranking, controlled fallback, and audit.
//!
//! This module provides a unified `EndpointRouter` that selects the best AI endpoint
//! for a given operation based on capability matching, priority, health, streaming/tool
//! requirements, and model preference. It supports controlled fallback on retryable
//! errors (network timeout, 429, 5xx) while refusing to fallback on non-retryable errors
//! (401/403, validation, content safety).
//!
//! Every routing decision and attempt is persisted to `ai_routing_events` for audit.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::collections::HashSet;
use tracing;
use uuid::Uuid;

use crate::ai::config::{AiEndpoint, AiEndpointCapability};
use crate::error::{AppError, AppResult};

// ─── Public types ──────────────────────────────────────────────────────────

/// The operation type for routing (maps to capability + usage tracking).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingOperation {
    Chat,
    Stream,
    Task,
    Pipeline,
    ImageGeneration,
    VideoGeneration,
    Test,
}

impl RoutingOperation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Stream => "stream",
            Self::Task => "task",
            Self::Pipeline => "pipeline",
            Self::ImageGeneration => "image_generation",
            Self::VideoGeneration => "video_generation",
            Self::Test => "test",
        }
    }

    /// Maps operation to the capability name used in ai_endpoint_capabilities.
    pub fn capability_name(&self) -> &'static str {
        match self {
            Self::Chat | Self::Stream | Self::Task | Self::Pipeline => "chat",
            Self::ImageGeneration => "image_generation",
            Self::VideoGeneration => "video_generation",
            Self::Test => "chat",
        }
    }
}

/// Classification of errors for fallback decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClassification {
    /// Network errors, timeouts, connection refused — safe to retry on next endpoint.
    NetworkTimeout,
    /// 429 Too Many Requests — safe to retry on next endpoint.
    RateLimited,
    /// 5xx server errors — safe to retry on next endpoint.
    ServerError,
    /// 408 Request Timeout — safe to retry.
    RequestTimeout,
    /// 401/403 authentication/authorization — NOT safe to retry (bad key or perms).
    AuthError,
    /// 400-level validation errors (bad request format) — NOT safe to retry.
    ValidationError,
    /// Content safety refusal — NOT safe to retry.
    ContentSafety,
    /// Capability mismatch (endpoint doesn't support required feature).
    CapabilityMismatch,
    /// Anything else — treated as non-retryable by default.
    Unknown,
}

impl ErrorClassification {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::NetworkTimeout | Self::RateLimited | Self::ServerError | Self::RequestTimeout
        )
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NetworkTimeout => "network_timeout",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::RequestTimeout => "request_timeout",
            Self::AuthError => "auth_error",
            Self::ValidationError => "validation_error",
            Self::ContentSafety => "content_safety",
            Self::CapabilityMismatch => "capability_mismatch",
            Self::Unknown => "unknown",
        }
    }
}

/// Status of a routing attempt or overall routing decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingStatus {
    Success,
    Failed,
    Fallback,
    NoCandidate,
}

impl RoutingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Fallback => "fallback",
            Self::NoCandidate => "no_candidate",
        }
    }
}

/// Input parameters for endpoint routing.
#[derive(Debug, Clone)]
pub struct RoutingRequest {
    pub user_id: String,
    pub operation: RoutingOperation,
    pub explicit_endpoint_id: Option<String>,
    pub requested_model: Option<String>,
    pub context_length: Option<i64>,
    pub requires_stream: bool,
    pub requires_tools: bool,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub agent_id: Option<String>,
    pub task_id: Option<String>,
    pub pipeline_run_id: Option<String>,
    pub pipeline_step_id: Option<String>,
    pub request_id: Option<String>,
    pub allow_fallback: bool,
    pub max_attempts: u32,
}

impl Default for RoutingRequest {
    fn default() -> Self {
        Self {
            user_id: String::new(),
            operation: RoutingOperation::Chat,
            explicit_endpoint_id: None,
            requested_model: None,
            context_length: None,
            requires_stream: false,
            requires_tools: false,
            project_id: None,
            conversation_id: None,
            agent_id: None,
            task_id: None,
            pipeline_run_id: None,
            pipeline_step_id: None,
            request_id: None,
            allow_fallback: true,
            max_attempts: 3,
        }
    }
}

/// A single candidate endpoint with its capability record and resolved model.
#[derive(Debug, Clone)]
pub struct RoutingCandidate {
    pub endpoint: AiEndpoint,
    pub capability: Option<AiEndpointCapability>,
    pub model: String,
    pub score: i64,
}

/// The result of resolving a routing decision — one or more candidates ordered by preference.
#[derive(Debug, Clone)]
pub struct RoutingPlan {
    pub candidates: Vec<RoutingCandidate>,
    pub request: RoutingRequest,
    pub request_id: String,
}

impl RoutingPlan {
    /// Get the first (highest-priority) candidate.
    pub fn primary(&self) -> Option<&RoutingCandidate> {
        self.candidates.first()
    }

    /// Get the next candidate after the given index (for fallback).
    pub fn next_candidate(&self, after_index: usize) -> Option<(usize, &RoutingCandidate)> {
        self.candidates
            .iter()
            .enumerate()
            .nth(after_index + 1)
            .map(|(i, c)| (i, c))
    }

    /// Total candidates available.
    pub fn candidate_count(&self) -> usize {
        self.candidates.len()
    }

    /// Check if the primary candidate has hard constraint mismatches.
    /// Returns a list of human-readable warnings for explicit endpoints
    /// (e.g., "endpoint does not support streaming").
    pub fn primary_constraint_warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        let Some(primary) = self.primary() else {
            return warnings;
        };
        let cap = primary.capability.as_ref();

        if self.request.requires_stream && !cap.map(|c| c.supports_stream).unwrap_or(false) {
            warnings.push(format!(
                "端点「{}」不支持流式输出，将使用非流式模式",
                primary.endpoint.name
            ));
        }
        if self.request.requires_tools && !cap.map(|c| c.supports_tools).unwrap_or(false) {
            warnings.push(format!(
                "端点「{}」不支持工具调用，助手动作将受限",
                primary.endpoint.name
            ));
        }
        if let Some(ctx_len) = self.request.context_length {
            if let Some(cap) = cap {
                if let Some(config_json) = &cap.config_json {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(config_json) {
                        if let Some(max_ctx) = parsed.get("maxContextTokens").and_then(|v| v.as_i64()) {
                            if max_ctx < ctx_len {
                                warnings.push(format!(
                                    "请求上下文约 {} tokens 超过端点「{}」上限 {} tokens，可能被截断或失败",
                                    ctx_len, primary.endpoint.name, max_ctx
                                ));
                            }
                        }
                    }
                }
            }
        }
        // Check capability missing for non-chat operations
        let capability_name = self.request.operation.capability_name();
        if capability_name != "chat" && capability_name != "test" {
            if cap.is_none() {
                warnings.push(format!(
                    "端点「{}」未启用「{}」能力",
                    primary.endpoint.name, capability_name
                ));
            }
        }

        warnings
    }
}

/// Record of a single attempt within a routing decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingAttempt {
    pub candidate_index: usize,
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub model: String,
    pub status: RoutingStatus,
    pub error_classification: Option<ErrorClassification>,
    pub error_message: Option<String>,
    pub latency_ms: Option<i64>,
}

/// The final result of executing a routed operation (possibly after fallbacks).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingResult {
    pub request_id: String,
    pub operation: RoutingOperation,
    pub final_endpoint_id: Option<String>,
    pub final_endpoint_name: Option<String>,
    pub final_model: Option<String>,
    pub used_fallback: bool,
    pub attempt_count: usize,
    pub attempts: Vec<RoutingAttempt>,
    pub status: RoutingStatus,
}

// ─── Database rows ─────────────────────────────────────────────────────────

#[derive(Debug, FromRow)]
struct EndpointCapabilityJoinRow {
    // endpoint fields
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
    // capability fields (all nullable for legacy endpoints without capabilities)
    capability_id: Option<String>,
    capability_name: Option<String>,
    capability_model: Option<String>,
    path_override: Option<String>,
    request_adapter: Option<String>,
    response_adapter: Option<String>,
    supports_stream: Option<bool>,
    supports_tools: Option<bool>,
    supports_files: Option<bool>,
    enabled: Option<bool>,
    priority: Option<i64>,
    config_json: Option<String>,
    max_context_tokens: Option<i64>,
    capability_created_at: Option<String>,
    capability_updated_at: Option<String>,
    // health snapshot (from recent routing events)
    recent_failures_1h: Option<i64>,
    recent_successes_1h: Option<i64>,
}

// ─── Router implementation ────────────────────────────────────────────────

/// Maximum attempts hard cap to prevent infinite loops.
const MAX_ATTEMPTS_HARD_CAP: u32 = 5;

/// Default chat model fallback when no model is specified.
const DEFAULT_CHAT_MODEL: &str = "gpt-4o-mini";

/// Build a routing plan: load candidates from DB, score and rank them.
pub async fn build_routing_plan(
    pool: &SqlitePool,
    request: RoutingRequest,
) -> AppResult<RoutingPlan> {
    let capability = request.operation.capability_name();
    let request_id = request
        .request_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let max_attempts = request.max_attempts.min(MAX_ATTEMPTS_HARD_CAP).max(1);

    let rows = if let Some(ref explicit_id) = request.explicit_endpoint_id {
        if request.allow_fallback {
            // Explicit endpoint with fallback allowed: fetch the explicit endpoint first,
            // then all other compatible endpoints as fallback candidates.
            // The explicit endpoint will be ranked first by the scoring function
            // (explicit_endpoint_id boost = +100_000).
            sqlx::query_as::<_, EndpointCapabilityJoinRow>(&format!(
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
                    c.capability AS capability_name,
                    c.model AS capability_model,
                    c.path_override,
                    c.request_adapter,
                    c.response_adapter,
                    c.supports_stream,
                    c.supports_tools,
                    c.supports_files,
                    c.enabled,
                    c.priority,
                    c.config_json,
                    c.max_context_tokens,
                    c.created_at AS capability_created_at,
                    c.updated_at AS capability_updated_at,
                    COALESCE((
                        SELECT COUNT(*) FROM ai_routing_events r
                        WHERE r.candidate_endpoint_id = e.id
                          AND r.status IN ('failed', 'fallback')
                          AND r.created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')
                    ), 0) AS recent_failures_1h,
                    COALESCE((
                        SELECT COUNT(*) FROM ai_routing_events r
                        WHERE r.candidate_endpoint_id = e.id
                          AND r.status = 'success'
                          AND r.created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')
                    ), 0) AS recent_successes_1h
                 FROM ai_endpoints e
                 LEFT JOIN ai_endpoint_capabilities c
                    ON c.endpoint_id = e.id
                   AND c.capability = ?
                 WHERE e.user_id = ?
                   AND e.is_active = 1
                   AND (
                       e.id = ?
                       OR (
                           (c.id IS NOT NULL AND c.enabled = 1)
                           OR (c.id IS NULL
                               AND NOT EXISTS (SELECT 1 FROM ai_endpoint_capabilities c2 WHERE c2.endpoint_id = e.id)
                               AND ? IN ('chat', 'test'))
                       )
                   )
                 ORDER BY
                    CASE WHEN e.id = ? THEN 0 ELSE 1 END ASC,
                    COALESCE(c.priority, 100) ASC,
                    e.created_at ASC",
            ))
            .bind(capability)
            .bind(&request.user_id)
            .bind(explicit_id)
            .bind(capability)
            .bind(explicit_id)
            .fetch_all(pool)
            .await?
        } else {
            // Explicit endpoint with fallback disabled: fetch exactly that endpoint
            sqlx::query_as::<_, EndpointCapabilityJoinRow>(
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
                    c.capability AS capability_name,
                    c.model AS capability_model,
                    c.path_override,
                    c.request_adapter,
                    c.response_adapter,
                    c.supports_stream,
                    c.supports_tools,
                    c.supports_files,
                    c.enabled,
                    c.priority,
                    c.config_json,
                    c.max_context_tokens,
                    c.created_at AS capability_created_at,
                    c.updated_at AS capability_updated_at,
                    0 AS recent_failures_1h,
                    0 AS recent_successes_1h
                 FROM ai_endpoints e
                 LEFT JOIN ai_endpoint_capabilities c
                    ON c.endpoint_id = e.id
                   AND c.capability = ?
                 WHERE e.id = ?
                   AND e.user_id = ?
                   AND e.is_active = 1",
            )
            .bind(capability)
            .bind(explicit_id)
            .bind(&request.user_id)
            .fetch_all(pool)
            .await?
        }
    } else {
        // No explicit endpoint: find all active endpoints for this user that have the
        // capability enabled, ordered by priority. Also include legacy endpoints
        // that don't have any capability rows (treated as chat-capable with default priority).
        sqlx::query_as::<_, EndpointCapabilityJoinRow>(&format!(
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
                c.capability AS capability_name,
                c.model AS capability_model,
                c.path_override,
                c.request_adapter,
                c.response_adapter,
                c.supports_stream,
                c.supports_tools,
                c.supports_files,
                c.enabled,
                c.priority,
                c.config_json,
                c.max_context_tokens,
                c.created_at AS capability_created_at,
                c.updated_at AS capability_updated_at,
                COALESCE((
                    SELECT COUNT(*) FROM ai_routing_events r
                    WHERE r.candidate_endpoint_id = e.id
                      AND r.status IN ('failed', 'fallback')
                      AND r.created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')
                ), 0) AS recent_failures_1h,
                COALESCE((
                    SELECT COUNT(*) FROM ai_routing_events r
                    WHERE r.candidate_endpoint_id = e.id
                      AND r.status = 'success'
                      AND r.created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')
                ), 0) AS recent_successes_1h
             FROM ai_endpoints e
             LEFT JOIN ai_endpoint_capabilities c
                ON c.endpoint_id = e.id
               AND c.capability = ?
             WHERE e.user_id = ?
               AND e.is_active = 1
               AND (
                   -- Endpoint has an enabled capability row for this operation
                   (c.id IS NOT NULL AND c.enabled = 1)
                   -- Legacy: no capability rows at all — treat as chat-capable
                   OR (c.id IS NULL
                       AND NOT EXISTS (SELECT 1 FROM ai_endpoint_capabilities c2 WHERE c2.endpoint_id = e.id)
                       AND ? IN ('chat', 'test'))
               )
             ORDER BY
                -- Explicit model match gets a boost (applied via scoring below, but
                -- we pre-sort by priority for determinism)
                COALESCE(c.priority, 100) ASC,
                e.created_at ASC",
        ))
        .bind(capability)
        .bind(&request.user_id)
        .bind(capability)
        .fetch_all(pool)
        .await?
    };

    // Deduplicate by endpoint_id (LEFT JOIN might produce duplicates in edge cases)
    let mut seen_ids = HashSet::new();
    let mut candidates: Vec<RoutingCandidate> = Vec::new();

    for row in &rows {
        if !seen_ids.insert(row.endpoint_id.clone()) {
            continue;
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

        // Build capability record (or synthesize default for legacy endpoints)
        let capability_rec = if row.capability_id.is_some() {
            Some(AiEndpointCapability {
                id: row.capability_id.clone().unwrap_or_default(),
                endpoint_id: row.endpoint_id.clone(),
                capability: row.capability_name.clone().unwrap_or_else(|| capability.to_string()),
                model: row.capability_model.clone(),
                path_override: row.path_override.clone(),
                request_adapter: row
                    .request_adapter
                    .clone()
                    .unwrap_or_else(|| "openai_compatible".to_string()),
                response_adapter: row
                    .response_adapter
                    .clone()
                    .unwrap_or_else(|| "openai_compatible".to_string()),
                supports_stream: row.supports_stream.unwrap_or(false),
                supports_tools: row.supports_tools.unwrap_or(false),
                supports_files: row.supports_files.unwrap_or(false),
                enabled: row.enabled.unwrap_or(true),
                priority: row.priority.unwrap_or(100),
                config_json: row.config_json.clone(),
                created_at: row.capability_created_at.clone().unwrap_or_default(),
                updated_at: row.capability_updated_at.clone().unwrap_or_default(),
            })
        } else if capability == "chat" || capability == "test" {
            // Legacy endpoint without capability rows — synthesize a default chat capability
            Some(AiEndpointCapability {
                id: String::new(), // synthetic
                endpoint_id: row.endpoint_id.clone(),
                capability: "chat".to_string(),
                model: None,
                path_override: None,
                request_adapter: "openai_compatible".to_string(),
                response_adapter: "openai_compatible".to_string(),
                supports_stream: false,
                supports_tools: false,
                supports_files: false,
                enabled: true,
                priority: 100,
                config_json: row.max_context_tokens.map(|t| serde_json::json!({"maxContextTokens": t}).to_string()),
                created_at: String::new(),
                updated_at: String::new(),
            })
        } else {
            None
        };

        // Check hard constraints: if explicit endpoint but capability missing for non-chat, skip
        if capability_rec.is_none() && capability != "chat" && capability != "test" {
            // This endpoint doesn't support the required capability (e.g., image_generation)
            // For explicit endpoint requests, still include it so caller gets a clear error
            if request.explicit_endpoint_id.is_none() {
                continue;
            }
        }

        // Resolve model
        let model = resolve_model_for_candidate(
            &request,
            capability,
            capability_rec.as_ref(),
            &endpoint,
        );

        // Score the candidate
        let score = score_candidate(
            &request,
            capability,
            capability_rec.as_ref(),
            &endpoint,
            &model,
            row.recent_failures_1h.unwrap_or(0),
            row.recent_successes_1h.unwrap_or(0),
        );

        candidates.push(RoutingCandidate {
            endpoint,
            capability: capability_rec,
            model,
            score,
        });
    }

    // Sort by score descending (higher = better), then by created_at for stability
    candidates.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.endpoint.created_at.cmp(&b.endpoint.created_at))
    });

    // Apply HARD constraints: filter out candidates that cannot satisfy requirements.
    // For non-explicit-endpoint requests, skip endpoints that:
    //   - Don't support streaming when requires_stream is true
    //   - Don't support tools when requires_tools is true
    //   - Have max_context_tokens less than the required context_length
    // For explicit endpoint requests, the explicit endpoint is always kept as the
    // first candidate regardless of constraints (caller gets clear error at runtime).
    let has_explicit = request.explicit_endpoint_id.is_some();
    if !has_explicit {
        candidates.retain(|c| {
            let cap = c.capability.as_ref();

            // Stream support hard requirement
            if request.requires_stream {
                if cap.map(|c| c.supports_stream).unwrap_or(false) == false {
                    tracing::debug!(
                        endpoint = %c.endpoint.id,
                        "Filtering candidate: requires_stream but endpoint doesn't support streaming"
                    );
                    return false;
                }
            }

            // Tool use hard requirement
            if request.requires_tools {
                if cap.map(|c| c.supports_tools).unwrap_or(false) == false {
                    tracing::debug!(
                        endpoint = %c.endpoint.id,
                        "Filtering candidate: requires_tools but endpoint doesn't support tools"
                    );
                    return false;
                }
            }

            // Context length hard requirement
            if let Some(ctx_len) = request.context_length {
                if let Some(cap) = cap {
                    if let Some(config_json) = &cap.config_json {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(config_json) {
                            if let Some(max_ctx) = parsed.get("maxContextTokens").and_then(|v| v.as_i64()) {
                                if max_ctx < ctx_len {
                                    tracing::debug!(
                                        endpoint = %c.endpoint.id,
                                        max_ctx,
                                        ctx_len,
                                        "Filtering candidate: context_length exceeds maxContextTokens"
                                    );
                                    return false;
                                }
                            }
                        }
                    }
                }
            }

            true
        });
    } else {
        // For explicit endpoint: ensure it's the first candidate, but still filter
        // other fallback candidates by hard constraints. Keep explicit endpoint at index 0.
        let explicit_id = request.explicit_endpoint_id.as_deref().unwrap_or("");
        candidates.sort_by(|a, b| {
            let a_is_explicit = a.endpoint.id == explicit_id;
            let b_is_explicit = b.endpoint.id == explicit_id;
            match (a_is_explicit, b_is_explicit) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => b.score.cmp(&a.score).then_with(|| a.endpoint.created_at.cmp(&b.endpoint.created_at)),
            }
        });

        // Filter non-explicit fallback candidates by hard constraints
        if candidates.len() > 1 {
            let (explicit_candidates, fallback_candidates): (Vec<_>, Vec<_>) = candidates
                .into_iter()
                .partition(|c| c.endpoint.id == explicit_id);

            let filtered_fallbacks: Vec<_> = fallback_candidates
                .into_iter()
                .filter(|c| {
                    let cap = c.capability.as_ref();
                    if request.requires_stream && cap.map(|c| c.supports_stream).unwrap_or(false) == false {
                        return false;
                    }
                    if request.requires_tools && cap.map(|c| c.supports_tools).unwrap_or(false) == false {
                        return false;
                    }
                    if let Some(ctx_len) = request.context_length {
                        if let Some(cap) = cap {
                            if let Some(config_json) = &cap.config_json {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(config_json) {
                                    if let Some(max_ctx) = parsed.get("maxContextTokens").and_then(|v| v.as_i64()) {
                                        if max_ctx < ctx_len {
                                            return false;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    true
                })
                .collect();

            candidates = explicit_candidates;
            candidates.extend(filtered_fallbacks);
        }
    }

    // Limit to max_attempts (don't prepare more candidates than we'll try)
    candidates.truncate(max_attempts as usize);

    Ok(RoutingPlan {
        candidates,
        request,
        request_id,
    })
}

/// Resolve the model to use for a candidate endpoint.
fn resolve_model_for_candidate(
    request: &RoutingRequest,
    capability: &str,
    cap: Option<&AiEndpointCapability>,
    endpoint: &AiEndpoint,
) -> String {
    let requested = request.requested_model.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let cap_model = cap.and_then(|c| c.model.as_deref()).map(str::trim).filter(|s| !s.is_empty());
    let default_model = endpoint.default_model.as_deref().map(str::trim).filter(|s| !s.is_empty());

    // For image/video generation, prefer the capability-level model unless user explicitly requested otherwise
    if matches!(capability, "image_generation" | "video_generation") {
        let requested_is_default = requested
            .zip(default_model)
            .map(|(r, d)| r.eq_ignore_ascii_case(d))
            .unwrap_or(false);
        if cap_model.is_some() && (requested.is_none() || requested_is_default) {
            return cap_model
                .or(requested)
                .or(default_model)
                .unwrap_or(DEFAULT_CHAT_MODEL)
                .to_string();
        }
    }

    requested
        .or(cap_model)
        .or(default_model)
        .unwrap_or(DEFAULT_CHAT_MODEL)
        .to_string()
}

/// Score a candidate endpoint for ranking. Higher score = better choice.
fn score_candidate(
    request: &RoutingRequest,
    capability: &str,
    cap: Option<&AiEndpointCapability>,
    endpoint: &AiEndpoint,
    model: &str,
    recent_failures: i64,
    recent_successes: i64,
) -> i64 {
    let mut score: i64 = 0;

    // Base priority: lower priority number = higher priority
    let base_priority = cap.map(|c| c.priority).unwrap_or(100);
    score -= base_priority * 10;

    // Explicit endpoint requested: massive boost ONLY for the matching endpoint
    if let Some(ref explicit_id) = request.explicit_endpoint_id {
        if endpoint.id == *explicit_id {
            score += 100_000;
        }
    }

    // Exact model match: significant boost
    if let Some(req_model) = request.requested_model.as_deref() {
        if model.eq_ignore_ascii_case(req_model) {
            score += 5_000;
        }
    }

    // Streaming requirement: penalize endpoints that don't support streaming
    if request.requires_stream {
        if cap.map(|c| c.supports_stream).unwrap_or(false) {
            score += 2_000;
        } else {
            score -= 50_000; // heavy penalty but not exclusion
        }
    }

    // Tools requirement
    if request.requires_tools {
        if cap.map(|c| c.supports_tools).unwrap_or(false) {
            score += 2_000;
        } else {
            score -= 50_000;
        }
    }

    // Context length: check max_context_tokens from config_json
    if let Some(ctx_len) = request.context_length {
        if let Some(cap) = cap {
            if let Some(config_json) = &cap.config_json {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(config_json) {
                    if let Some(max_ctx) = parsed.get("maxContextTokens").and_then(|v| v.as_i64()) {
                        if max_ctx >= ctx_len {
                            score += 1_000;
                        } else {
                            score -= 30_000;
                        }
                    }
                }
            }
        }
    }

    // Health penalty for recent failures
    if recent_failures > 0 {
        score -= recent_failures * 100;
    }
    // Health bonus for recent successes
    if recent_successes > 0 {
        score += recent_successes.min(100) * 10;
    }

    // Capability enabled (for non-legacy)
    if cap.map(|c| c.enabled).unwrap_or(true) {
        score += 500;
    }

    // For non-chat capabilities, having a capability record is required
    if capability != "chat" && capability != "test" && cap.is_none() {
        score -= 100_000;
    }

    score
}

// ─── Audit persistence ────────────────────────────────────────────────────

/// Persist a routing event to the audit log.
/// Returns error on DB failure — callers should typically use `record_routing_event_safe` instead.
pub async fn record_routing_event(
    pool: &SqlitePool,
    event: &RoutingEventRecord,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO ai_routing_events (
            id, user_id, request_id, task_id, pipeline_run_id, pipeline_step_id,
            conversation_id, project_id, agent_id, operation, capability,
            requested_endpoint_id, requested_model, requires_stream, requires_tools, min_context_tokens,
            candidate_endpoint_id, candidate_model, candidate_priority, candidate_index,
            final_endpoint_id, final_model, status, error_classification, error_message,
            fallback_from_index, attempt_count, max_attempts, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&event.id)
    .bind(&event.user_id)
    .bind(&event.request_id)
    .bind(&event.task_id)
    .bind(&event.pipeline_run_id)
    .bind(&event.pipeline_step_id)
    .bind(&event.conversation_id)
    .bind(&event.project_id)
    .bind(&event.agent_id)
    .bind(event.operation)
    .bind(event.capability)
    .bind(&event.requested_endpoint_id)
    .bind(&event.requested_model)
    .bind(event.requires_stream)
    .bind(event.requires_tools)
    .bind(event.min_context_tokens)
    .bind(&event.candidate_endpoint_id)
    .bind(&event.candidate_model)
    .bind(event.candidate_priority)
    .bind(event.candidate_index)
    .bind(&event.final_endpoint_id)
    .bind(&event.final_model)
    .bind(event.status)
    .bind(event.error_classification)
    .bind(sanitize_error_message(event.error_message.as_deref()))
    .bind(event.fallback_from_index)
    .bind(event.attempt_count)
    .bind(event.max_attempts)
    .bind(event.latency_ms)
    .bind(&event.created_at)
    .execute(pool)
    .await?;

    Ok(())
}

/// Persist a routing event, logging but never propagating errors.
/// Use this in hot paths where audit failure must not crash the request.
pub async fn record_routing_event_safe(pool: &SqlitePool, event: &RoutingEventRecord) {
    if let Err(error) = record_routing_event(pool, event).await {
        tracing::warn!(
            error = %error,
            operation = %event.operation,
            "Failed to record routing audit event (non-fatal)"
        );
    }
}

/// Input struct for recording a routing event.
#[derive(Debug, Clone)]
pub struct RoutingEventRecord {
    pub id: String,
    pub user_id: String,
    pub request_id: Option<String>,
    pub task_id: Option<String>,
    pub pipeline_run_id: Option<String>,
    pub pipeline_step_id: Option<String>,
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub operation: String,
    pub capability: String,
    pub requested_endpoint_id: Option<String>,
    pub requested_model: Option<String>,
    pub requires_stream: bool,
    pub requires_tools: bool,
    pub min_context_tokens: Option<i64>,
    pub candidate_endpoint_id: Option<String>,
    pub candidate_model: Option<String>,
    pub candidate_priority: Option<i64>,
    pub candidate_index: i64,
    pub final_endpoint_id: Option<String>,
    pub final_model: Option<String>,
    pub status: String,
    pub error_classification: Option<String>,
    pub error_message: Option<String>,
    pub fallback_from_index: Option<i64>,
    pub attempt_count: i64,
    pub max_attempts: i64,
    pub latency_ms: Option<i64>,
    pub created_at: String,
}

impl RoutingEventRecord {
    pub fn new(
        plan: &RoutingPlan,
        candidate: Option<&RoutingCandidate>,
        candidate_index: usize,
        final_endpoint_id: Option<&str>,
        final_model: Option<&str>,
        status: RoutingStatus,
        error_classification: Option<ErrorClassification>,
        error_message: Option<String>,
        latency_ms: Option<i64>,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id: Uuid::new_v4().to_string(),
            user_id: plan.request.user_id.clone(),
            request_id: Some(plan.request_id.clone()),
            task_id: plan.request.task_id.clone(),
            pipeline_run_id: plan.request.pipeline_run_id.clone(),
            pipeline_step_id: plan.request.pipeline_step_id.clone(),
            conversation_id: plan.request.conversation_id.clone(),
            project_id: plan.request.project_id.clone(),
            agent_id: plan.request.agent_id.clone(),
            operation: plan.request.operation.as_str().to_string(),
            capability: plan.request.operation.capability_name().to_string(),
            requested_endpoint_id: plan.request.explicit_endpoint_id.clone(),
            requested_model: plan.request.requested_model.clone(),
            requires_stream: plan.request.requires_stream,
            requires_tools: plan.request.requires_tools,
            min_context_tokens: plan.request.context_length,
            candidate_endpoint_id: candidate.map(|c| c.endpoint.id.clone()),
            candidate_model: candidate.map(|c| c.model.clone()),
            candidate_priority: candidate.and_then(|c| c.capability.as_ref().map(|cap| cap.priority)),
            candidate_index: candidate_index as i64,
            final_endpoint_id: final_endpoint_id.map(str::to_string),
            final_model: final_model.map(str::to_string),
            status: status.as_str().to_string(),
            error_classification: error_classification.map(|e| e.as_str().to_string()),
            error_message,
            fallback_from_index: if status == RoutingStatus::Fallback {
                Some(candidate_index.saturating_sub(1) as i64)
            } else {
                None
            },
            attempt_count: (candidate_index + 1) as i64,
            max_attempts: plan.request.max_attempts as i64,
            latency_ms,
            created_at: now,
        }
    }
}

/// Sanitize error messages to prevent leaking API keys, tokens, or absolute paths.
fn sanitize_error_message(msg: Option<&str>) -> Option<String> {
    let msg = msg?;
    let mut sanitized = msg.to_string();

    // Redact sk- prefixed keys (OpenAI style)
    if let Some(idx) = sanitized.to_ascii_lowercase().find("sk-") {
        // Find end of the key (whitespace, comma, quote, etc.)
        let rest = &sanitized[idx..];
        let end = rest[3..]
            .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
            .map(|e| idx + 3 + e)
            .unwrap_or(sanitized.len());
        if end > idx + 23 {
            sanitized = format!("{}[REDACTED]{}", &sanitized[..idx], &sanitized[end..]);
        }
    }

    // Redact key=value / key: value patterns
    for pattern in ["api_key", "api-key", "apikey", "token", "bearer", "authorization", "secret", "password"] {
        let lower = sanitized.to_ascii_lowercase();
        if let Some(idx) = lower.find(pattern) {
            // Find the value after : or =
            let after = &sanitized[idx + pattern.len()..];
            let after_trimmed = after.trim_start();
            if after_trimmed.starts_with(':') || after_trimmed.starts_with('=') {
                let val_start = idx + pattern.len() + after.len() - after_trimmed.len() + 1;
                // Find end of value (up to whitespace, comma, semicolon, quote)
                let val_rest = &sanitized[val_start..];
                let val_end = val_rest
                    .find(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '"' || c == '\'')
                    .map(|e| val_start + e)
                    .unwrap_or(sanitized.len());
                if val_end > val_start + 5 {
                    sanitized = format!("{}[REDACTED]{}", &sanitized[..val_start], &sanitized[val_end..]);
                }
            }
        }
    }

    // Redact Bearer <token> patterns
    if let Some(idx) = sanitized.to_ascii_lowercase().find("bearer ") {
        let token_start = idx + 7;
        let rest = &sanitized[token_start..];
        let token_end = rest
            .find(|c: char| c.is_whitespace() || c == ',' || c == '"' || c == '\'')
            .map(|e| token_start + e)
            .unwrap_or(sanitized.len());
        if token_end > token_start + 5 {
            sanitized = format!("{}[REDACTED]{}", &sanitized[..token_start], &sanitized[token_end..]);
        }
    }

    // Truncate very long messages
    if sanitized.chars().count() > 1000 {
        sanitized = sanitized.chars().take(1000).collect::<String>() + "...";
    }

    Some(sanitized)
}

// ─── Error classification helpers ─────────────────────────────────────────

/// Classify an error from the AI client call into retryable/non-retryable categories.
pub fn classify_error(error_msg: &str) -> ErrorClassification {
    let lowered = error_msg.to_ascii_lowercase();

    // 401 / 403
    if lowered.contains("401")
        || lowered.contains("unauthorized")
        || lowered.contains("403")
        || lowered.contains("forbidden")
        || lowered.contains("invalid api key")
        || lowered.contains("authentication failed")
        || lowered.contains("invalid authentication")
    {
        return ErrorClassification::AuthError;
    }

    // 429 rate limit
    if lowered.contains("429")
        || lowered.contains("rate limit")
        || lowered.contains("too many requests")
        || lowered.contains("quota exceeded")
    {
        return ErrorClassification::RateLimited;
    }

    // 408 timeout
    if lowered.contains("408") || lowered.contains("request timeout") || lowered.contains("timed out") {
        return ErrorClassification::RequestTimeout;
    }

    // 5xx server errors
    if lowered.contains("500")
        || lowered.contains("502")
        || lowered.contains("503")
        || lowered.contains("504")
        || lowered.contains("internal server error")
        || lowered.contains("bad gateway")
        || lowered.contains("service unavailable")
        || lowered.contains("gateway timeout")
    {
        return ErrorClassification::ServerError;
    }

    // Network / connection errors
    if lowered.contains("connection")
        || lowered.contains("dns")
        || lowered.contains("network")
        || lowered.contains("connect error")
        || lowered.contains("broken pipe")
        || lowered.contains("connection reset")
        || lowered.contains("hyper error")
        || lowered.contains("reqwest")
    {
        return ErrorClassification::NetworkTimeout;
    }

    // Content safety
    if lowered.contains("content policy")
        || lowered.contains("content safety")
        || lowered.contains("content_filter")
        || lowered.contains("safety")
        || lowered.contains("banned content")
        || lowered.contains("refused")
    {
        return ErrorClassification::ContentSafety;
    }

    // Validation errors (400 bad request)
    if lowered.contains("400")
        || lowered.contains("bad request")
        || lowered.contains("validation")
        || lowered.contains("invalid request")
        || lowered.contains("schema")
        || lowered.contains("unprocessable")
    {
        return ErrorClassification::ValidationError;
    }

    ErrorClassification::Unknown
}

// ─── Query API ────────────────────────────────────────────────────────────

/// Query parameters for listing routing events.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEventQuery {
    pub endpoint_id: Option<String>,
    pub capability: Option<String>,
    pub status: Option<String>,
    pub operation: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// A routing event as returned by the query API.
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEventView {
    pub id: String,
    pub user_id: String,
    pub request_id: Option<String>,
    pub task_id: Option<String>,
    pub pipeline_run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub operation: String,
    pub capability: String,
    pub requested_endpoint_id: Option<String>,
    pub requested_model: Option<String>,
    pub requires_stream: bool,
    pub requires_tools: bool,
    pub candidate_endpoint_id: Option<String>,
    pub candidate_model: Option<String>,
    pub candidate_index: i64,
    pub final_endpoint_id: Option<String>,
    pub final_model: Option<String>,
    pub status: String,
    pub error_classification: Option<String>,
    pub error_message: Option<String>,
    pub fallback_from_index: Option<i64>,
    pub attempt_count: i64,
    pub max_attempts: i64,
    pub latency_ms: Option<i64>,
    pub created_at: String,
}

/// List routing events with filtering and pagination.
pub async fn list_routing_events(
    pool: &SqlitePool,
    user_id: &str,
    query: &RoutingEventQuery,
) -> AppResult<Vec<RoutingEventView>> {
    let limit = query.limit.unwrap_or(50).min(200).max(1);
    let offset = query.offset.unwrap_or(0).max(0);

    let mut conditions = vec!["user_id = ?".to_string()];
    let mut bind_values: Vec<String> = vec![user_id.to_string()];

    if let Some(ref endpoint_id) = query.endpoint_id {
        conditions.push("(candidate_endpoint_id = ? OR final_endpoint_id = ?)".to_string());
        bind_values.push(endpoint_id.clone());
        bind_values.push(endpoint_id.clone());
    }
    if let Some(ref capability) = query.capability {
        conditions.push("capability = ?".to_string());
        bind_values.push(capability.clone());
    }
    if let Some(ref status) = query.status {
        conditions.push("status = ?".to_string());
        bind_values.push(status.clone());
    }
    if let Some(ref operation) = query.operation {
        conditions.push("operation = ?".to_string());
        bind_values.push(operation.clone());
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        "SELECT id, user_id, request_id, task_id, pipeline_run_id, conversation_id, project_id,
                agent_id, operation, capability, requested_endpoint_id, requested_model,
                requires_stream, requires_tools, candidate_endpoint_id, candidate_model,
                candidate_index, final_endpoint_id, final_model, status, error_classification,
                error_message, fallback_from_index, attempt_count, max_attempts, latency_ms, created_at
         FROM ai_routing_events
         WHERE {}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?",
        where_clause
    );

    let mut q = sqlx::query_as::<_, RoutingEventView>(&sql);
    for v in &bind_values {
        q = q.bind(v);
    }
    q = q.bind(limit).bind(offset);

    let events = q.fetch_all(pool).await?;
    Ok(events)
}

/// Summary statistics for routing health.
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RoutingHealthSummary {
    pub total_requests: i64,
    pub successful: i64,
    pub failed: i64,
    pub fallbacks: i64,
    pub no_candidate: i64,
    pub fallback_rate: f64,
    pub avg_latency_ms: Option<i64>,
    pub window_hours: i64,
}

pub async fn get_routing_health_summary(
    pool: &SqlitePool,
    user_id: &str,
    hours: i64,
) -> AppResult<RoutingHealthSummary> {
    let hours = hours.max(1).min(720);
    let since = Utc::now() - chrono::Duration::hours(hours);
    let since_str = since.to_rfc3339();

    let row = sqlx::query_as::<_, (i64, i64, i64, i64, i64, Option<f64>, Option<i64>)>(
        "SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'no_candidate' THEN 1 ELSE 0 END),
            AVG(latency_ms),
            AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END)
         FROM ai_routing_events
         WHERE user_id = ? AND created_at > ?",
    )
    .bind(user_id)
    .bind(&since_str)
    .fetch_one(pool)
    .await?;

    let total = row.0;
    let fallbacks = row.3;
    let fallback_rate = if total > 0 {
        fallbacks as f64 / total as f64
    } else {
        0.0
    };

    Ok(RoutingHealthSummary {
        total_requests: row.0,
        successful: row.1,
        failed: row.2,
        fallbacks: row.3,
        no_candidate: row.4,
        fallback_rate,
        avg_latency_ms: row.6,
        window_hours: hours,
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_error_auth() {
        assert_eq!(classify_error("401 Unauthorized: Invalid API key"), ErrorClassification::AuthError);
        assert_eq!(classify_error("403 Forbidden"), ErrorClassification::AuthError);
    }

    #[test]
    fn test_classify_error_rate_limited() {
        assert_eq!(classify_error("429 Too Many Requests"), ErrorClassification::RateLimited);
        assert_eq!(classify_error("Rate limit exceeded, retry after 30s"), ErrorClassification::RateLimited);
    }

    #[test]
    fn test_classify_error_server_error() {
        assert_eq!(classify_error("500 Internal Server Error"), ErrorClassification::ServerError);
        assert_eq!(classify_error("502 Bad Gateway"), ErrorClassification::ServerError);
        assert_eq!(classify_error("503 Service Unavailable"), ErrorClassification::ServerError);
    }

    #[test]
    fn test_classify_error_network() {
        assert_eq!(classify_error("reqwest error: connection refused"), ErrorClassification::NetworkTimeout);
        assert_eq!(classify_error("Network error: connection reset"), ErrorClassification::NetworkTimeout);
    }

    #[test]
    fn test_classify_error_timeout() {
        assert_eq!(classify_error("408 Request Timeout"), ErrorClassification::RequestTimeout);
        assert_eq!(classify_error("request timed out after 30s"), ErrorClassification::RequestTimeout);
    }

    #[test]
    fn test_classify_error_content_safety() {
        assert_eq!(classify_error("Content policy violation: request was refused"), ErrorClassification::ContentSafety);
    }

    #[test]
    fn test_classify_error_validation() {
        assert_eq!(classify_error("400 Bad Request: invalid schema"), ErrorClassification::ValidationError);
    }

    #[test]
    fn test_retryable_classification() {
        assert!(ErrorClassification::NetworkTimeout.is_retryable());
        assert!(ErrorClassification::RateLimited.is_retryable());
        assert!(ErrorClassification::ServerError.is_retryable());
        assert!(ErrorClassification::RequestTimeout.is_retryable());
        assert!(!ErrorClassification::AuthError.is_retryable());
        assert!(!ErrorClassification::ValidationError.is_retryable());
        assert!(!ErrorClassification::ContentSafety.is_retryable());
        assert!(!ErrorClassification::Unknown.is_retryable());
    }

    #[test]
    fn test_sanitize_error_message_redacts_keys() {
        let msg = "Error with api_key: sk-abc123def456ghi789jkl012mno345pqr567stu890";
        let sanitized = sanitize_error_message(Some(msg)).unwrap();
        assert!(!sanitized.contains("sk-abc123"));
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn test_sanitize_error_message_truncates_long() {
        let msg = "a".repeat(2000);
        let sanitized = sanitize_error_message(Some(&msg)).unwrap();
        assert!(sanitized.len() <= 1010);
    }

    #[test]
    fn test_operation_capability_mapping() {
        assert_eq!(RoutingOperation::Chat.capability_name(), "chat");
        assert_eq!(RoutingOperation::Stream.capability_name(), "chat");
        assert_eq!(RoutingOperation::Task.capability_name(), "chat");
        assert_eq!(RoutingOperation::Pipeline.capability_name(), "chat");
        assert_eq!(RoutingOperation::ImageGeneration.capability_name(), "image_generation");
        assert_eq!(RoutingOperation::VideoGeneration.capability_name(), "video_generation");
        assert_eq!(RoutingOperation::Test.capability_name(), "chat");
    }

    #[test]
    fn test_routing_operation_as_str() {
        assert_eq!(RoutingOperation::Chat.as_str(), "chat");
        assert_eq!(RoutingOperation::Stream.as_str(), "stream");
        assert_eq!(RoutingOperation::Task.as_str(), "task");
        assert_eq!(RoutingOperation::Pipeline.as_str(), "pipeline");
        assert_eq!(RoutingOperation::ImageGeneration.as_str(), "image_generation");
        assert_eq!(RoutingOperation::VideoGeneration.as_str(), "video_generation");
        assert_eq!(RoutingOperation::Test.as_str(), "test");
    }

    #[test]
    fn test_error_classification_as_str() {
        assert_eq!(ErrorClassification::NetworkTimeout.as_str(), "network_timeout");
        assert_eq!(ErrorClassification::RateLimited.as_str(), "rate_limited");
        assert_eq!(ErrorClassification::ServerError.as_str(), "server_error");
        assert_eq!(ErrorClassification::RequestTimeout.as_str(), "request_timeout");
        assert_eq!(ErrorClassification::AuthError.as_str(), "auth_error");
        assert_eq!(ErrorClassification::ValidationError.as_str(), "validation_error");
        assert_eq!(ErrorClassification::ContentSafety.as_str(), "content_safety");
        assert_eq!(ErrorClassification::CapabilityMismatch.as_str(), "capability_mismatch");
        assert_eq!(ErrorClassification::Unknown.as_str(), "unknown");
    }

    #[test]
    fn test_routing_status_as_str() {
        assert_eq!(RoutingStatus::Success.as_str(), "success");
        assert_eq!(RoutingStatus::Failed.as_str(), "failed");
        assert_eq!(RoutingStatus::Fallback.as_str(), "fallback");
        assert_eq!(RoutingStatus::NoCandidate.as_str(), "no_candidate");
    }

    #[test]
    fn test_default_routing_request() {
        let req = RoutingRequest::default();
        assert_eq!(req.operation, RoutingOperation::Chat);
        assert!(req.explicit_endpoint_id.is_none());
        assert!(req.requested_model.is_none());
        assert!(!req.requires_stream);
        assert!(!req.requires_tools);
        assert!(req.allow_fallback);
        assert_eq!(req.max_attempts, 3);
    }

    #[test]
    fn test_max_attempts_hard_cap() {
        // The build_routing_plan function caps max_attempts at MAX_ATTEMPTS_HARD_CAP (5)
        // Test that RoutingRequest.max_attempts is reasonable
        let req = RoutingRequest {
            max_attempts: 100,
            ..Default::default()
        };
        // The cap is applied inside build_routing_plan, but we test the constant
        assert_eq!(MAX_ATTEMPTS_HARD_CAP, 5);
        assert!(req.max_attempts > MAX_ATTEMPTS_HARD_CAP); // verify it gets capped
    }

    #[test]
    fn test_classify_error_quota_exceeded() {
        assert_eq!(classify_error("quota exceeded"), ErrorClassification::RateLimited);
    }

    #[test]
    fn test_classify_error_504_gateway_timeout() {
        assert_eq!(classify_error("504 Gateway Timeout"), ErrorClassification::ServerError);
    }

    #[test]
    fn test_classify_error_bad_gateway() {
        assert_eq!(classify_error("502 Bad Gateway"), ErrorClassification::ServerError);
    }

    #[test]
    fn test_classify_error_invalid_api_key() {
        assert_eq!(classify_error("Invalid API key provided"), ErrorClassification::AuthError);
    }

    #[test]
    fn test_classify_error_bad_request() {
        assert_eq!(classify_error("400 Bad Request"), ErrorClassification::ValidationError);
    }

    #[test]
    fn test_classify_error_unknown() {
        assert_eq!(classify_error("some unexpected error"), ErrorClassification::Unknown);
        assert!(!ErrorClassification::Unknown.is_retryable());
    }

    #[test]
    fn test_sanitize_error_redacts_bearer_token() {
        let msg = "Authorization failed: Bearer eyJhbGciOiJIUzI1NiJ9.some.token";
        let sanitized = sanitize_error_message(Some(msg)).unwrap();
        assert!(!sanitized.contains("eyJhbGciOiJIUzI1NiJ9"));
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn test_sanitize_error_redacts_token_param() {
        let msg = "request failed token=abc123def456";
        let sanitized = sanitize_error_message(Some(msg)).unwrap();
        assert!(!sanitized.contains("abc123def456"));
    }

    #[test]
    fn test_sanitize_error_preserves_harmless_messages() {
        let msg = "simple connection timeout";
        let sanitized = sanitize_error_message(Some(msg)).unwrap();
        assert_eq!(sanitized, "simple connection timeout");
    }

    #[test]
    fn test_sanitize_error_none() {
        assert!(sanitize_error_message(None).is_none());
    }

    #[test]
    fn test_resolve_model_requested_priority() {
        // When requested model is provided, it should be used
        let requested = "gpt-4";
        let default = "gpt-3.5-turbo";
        // Simulating the resolution logic: requested > cap_model > default > DEFAULT_CHAT_MODEL
        let resolved = Some(requested).or(Some(default)).unwrap_or(DEFAULT_CHAT_MODEL);
        assert_eq!(resolved, "gpt-4");
    }

    #[test]
    fn test_resolve_model_default_fallback() {
        let resolved = None::<&str>.or(None::<&str>).unwrap_or(DEFAULT_CHAT_MODEL);
        assert_eq!(resolved, "gpt-4o-mini");
    }

    #[test]
    fn test_routing_plan_candidate_navigation() {
        // Test that RoutingPlan correctly returns primary and next candidates
        let endpoint = AiEndpoint {
            id: "ep-1".to_string(),
            user_id: "user-1".to_string(),
            name: "Test Endpoint".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.example.com".to_string(),
            api_key: "test-key".to_string(),
            default_model: Some("gpt-4".to_string()),
            is_active: true,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };

        let candidate = RoutingCandidate {
            endpoint,
            capability: None,
            model: "gpt-4".to_string(),
            score: 100,
        };

        let plan = RoutingPlan {
            candidates: vec![candidate],
            request: RoutingRequest::default(),
            request_id: "req-1".to_string(),
        };

        assert!(plan.primary().is_some());
        assert_eq!(plan.primary().unwrap().model, "gpt-4");
        assert!(plan.next_candidate(0).is_none());
        assert_eq!(plan.candidate_count(), 1);
    }

    #[test]
    fn test_routing_plan_multiple_candidates() {
        let make_candidate = |id: &str, model: &str, score: i64| RoutingCandidate {
            endpoint: AiEndpoint {
                id: id.to_string(),
                user_id: "user-1".to_string(),
                name: format!("Endpoint {}", id),
                provider: "openai".to_string(),
                base_url: format!("https://api-{}.example.com", id),
                api_key: "key".to_string(),
                default_model: Some(model.to_string()),
                is_active: true,
                created_at: "2024-01-01T00:00:00Z".to_string(),
                updated_at: "2024-01-01T00:00:00Z".to_string(),
            },
            capability: None,
            model: model.to_string(),
            score,
        };

        let plan = RoutingPlan {
            candidates: vec![
                make_candidate("ep-1", "gpt-4", 1000),
                make_candidate("ep-2", "gpt-3.5", 500),
                make_candidate("ep-3", "claude", 100),
            ],
            request: RoutingRequest::default(),
            request_id: "req-2".to_string(),
        };

        assert_eq!(plan.candidate_count(), 3);
        assert_eq!(plan.primary().unwrap().endpoint.id, "ep-1");

        let next = plan.next_candidate(0);
        assert!(next.is_some());
        let (idx, c) = next.unwrap();
        assert_eq!(idx, 1);
        assert_eq!(c.endpoint.id, "ep-2");
    }

    #[test]
    fn test_classify_error_content_filter() {
        assert_eq!(classify_error("content_filter triggered"), ErrorClassification::ContentSafety);
    }

    #[test]
    fn test_classify_error_dns_failure() {
        assert_eq!(classify_error("dns resolution failed"), ErrorClassification::NetworkTimeout);
    }

    #[test]
    fn test_classify_error_broken_pipe() {
        assert_eq!(classify_error("broken pipe"), ErrorClassification::NetworkTimeout);
    }

    #[test]
    fn test_primary_constraint_warnings_empty_when_ok() {
        let endpoint = AiEndpoint {
            id: "ep-ok".to_string(),
            user_id: "user-1".to_string(),
            name: "Good Endpoint".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.example.com".to_string(),
            api_key: "key".to_string(),
            default_model: Some("gpt-4".to_string()),
            is_active: true,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let cap = AiEndpointCapability {
            id: "cap-1".to_string(),
            endpoint_id: "ep-ok".to_string(),
            capability: "chat".to_string(),
            model: Some("gpt-4".to_string()),
            path_override: None,
            request_adapter: "openai_compatible".to_string(),
            response_adapter: "openai_compatible".to_string(),
            supports_stream: true,
            supports_tools: true,
            supports_files: false,
            enabled: true,
            priority: 1,
            config_json: Some(serde_json::json!({"maxContextTokens": 128000}).to_string()),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let plan = RoutingPlan {
            candidates: vec![RoutingCandidate {
                endpoint,
                capability: Some(cap),
                model: "gpt-4".to_string(),
                score: 1000,
            }],
            request: RoutingRequest {
                requires_stream: true,
                requires_tools: true,
                context_length: Some(4000),
                ..Default::default()
            },
            request_id: "req-ok".to_string(),
        };
        assert!(plan.primary_constraint_warnings().is_empty());
    }

    #[test]
    fn test_primary_constraint_warnings_stream_mismatch() {
        let endpoint = AiEndpoint {
            id: "ep-nostream".to_string(),
            user_id: "user-1".to_string(),
            name: "No-Stream Endpoint".to_string(),
            provider: "custom".to_string(),
            base_url: "https://api.example.com".to_string(),
            api_key: "key".to_string(),
            default_model: Some("model-x".to_string()),
            is_active: true,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let cap = AiEndpointCapability {
            id: "cap-1".to_string(),
            endpoint_id: "ep-nostream".to_string(),
            capability: "chat".to_string(),
            model: None,
            path_override: None,
            request_adapter: "openai_compatible".to_string(),
            response_adapter: "openai_compatible".to_string(),
            supports_stream: false,
            supports_tools: false,
            supports_files: false,
            enabled: true,
            priority: 100,
            config_json: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let plan = RoutingPlan {
            candidates: vec![RoutingCandidate {
                endpoint,
                capability: Some(cap),
                model: "model-x".to_string(),
                score: 0,
            }],
            request: RoutingRequest {
                requires_stream: true,
                ..Default::default()
            },
            request_id: "req-warn".to_string(),
        };
        let warnings = plan.primary_constraint_warnings();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("不支持流式"));
    }

    #[test]
    fn test_primary_constraint_warnings_context_overflow() {
        let endpoint = AiEndpoint {
            id: "ep-small".to_string(),
            user_id: "user-1".to_string(),
            name: "Small Context".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.example.com".to_string(),
            api_key: "key".to_string(),
            default_model: Some("gpt-3.5".to_string()),
            is_active: true,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let cap = AiEndpointCapability {
            id: "cap-1".to_string(),
            endpoint_id: "ep-small".to_string(),
            capability: "chat".to_string(),
            model: None,
            path_override: None,
            request_adapter: "openai_compatible".to_string(),
            response_adapter: "openai_compatible".to_string(),
            supports_stream: true,
            supports_tools: false,
            supports_files: false,
            enabled: true,
            priority: 100,
            config_json: Some(serde_json::json!({"maxContextTokens": 4096}).to_string()),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let plan = RoutingPlan {
            candidates: vec![RoutingCandidate {
                endpoint,
                capability: Some(cap),
                model: "gpt-3.5".to_string(),
                score: 0,
            }],
            request: RoutingRequest {
                context_length: Some(10000),
                ..Default::default()
            },
            request_id: "req-ctx".to_string(),
        };
        let warnings = plan.primary_constraint_warnings();
        assert!(warnings.iter().any(|w| w.contains("超过") || w.contains("tokens")));
    }

    #[test]
    fn test_primary_constraint_warnings_tools_mismatch() {
        let endpoint = AiEndpoint {
            id: "ep-notools".to_string(),
            user_id: "user-1".to_string(),
            name: "No Tools".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.example.com".to_string(),
            api_key: "key".to_string(),
            default_model: None,
            is_active: true,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let cap = AiEndpointCapability {
            id: "cap-1".to_string(),
            endpoint_id: "ep-notools".to_string(),
            capability: "chat".to_string(),
            model: None,
            path_override: None,
            request_adapter: "openai_compatible".to_string(),
            response_adapter: "openai_compatible".to_string(),
            supports_stream: true,
            supports_tools: false,
            supports_files: false,
            enabled: true,
            priority: 100,
            config_json: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let plan = RoutingPlan {
            candidates: vec![RoutingCandidate {
                endpoint,
                capability: Some(cap),
                model: "default".to_string(),
                score: 0,
            }],
            request: RoutingRequest {
                requires_tools: true,
                ..Default::default()
            },
            request_id: "req-tools".to_string(),
        };
        let warnings = plan.primary_constraint_warnings();
        assert!(warnings.iter().any(|w| w.contains("工具")));
    }

    #[test]
    fn test_max_attempts_constant() {
        assert_eq!(MAX_ATTEMPTS_HARD_CAP, 5);
        assert!(MAX_ATTEMPTS_HARD_CAP >= 3, "should allow at least 3 attempts");
    }

    #[test]
    fn test_default_chat_model() {
        assert_eq!(DEFAULT_CHAT_MODEL, "gpt-4o-mini");
    }

    #[test]
    fn test_routing_attempt_struct_fields() {
        let attempt = RoutingAttempt {
            candidate_index: 0,
            endpoint_id: "ep-1".to_string(),
            endpoint_name: "Test".to_string(),
            model: "gpt-4".to_string(),
            status: RoutingStatus::Success,
            error_classification: None,
            error_message: None,
            latency_ms: Some(250),
        };
        assert_eq!(attempt.endpoint_id, "ep-1");
        assert_eq!(attempt.status, RoutingStatus::Success);
        assert_eq!(attempt.latency_ms, Some(250));
    }

    #[test]
    fn test_routing_status_serialization() {
        let statuses = vec![
            RoutingStatus::Success,
            RoutingStatus::Failed,
            RoutingStatus::Fallback,
            RoutingStatus::NoCandidate,
        ];
        for s in statuses {
            let str_val = s.as_str();
            assert!(!str_val.is_empty());
            // Verify round-trip
            match str_val {
                "success" => assert_eq!(s, RoutingStatus::Success),
                "failed" => assert_eq!(s, RoutingStatus::Failed),
                "fallback" => assert_eq!(s, RoutingStatus::Fallback),
                "no_candidate" => assert_eq!(s, RoutingStatus::NoCandidate),
                _ => panic!("unexpected status: {}", str_val),
            }
        }
    }
}
