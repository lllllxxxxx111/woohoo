use crate::error::{AppError, AppResult};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::{Arc, Mutex};

const STREAM_FALLBACK_TRIGGER_THRESHOLD: u32 = 3;
const IMAGE_GENERATION_REQUEST_TIMEOUT_SECS: u64 = 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamFallbackMode {
    Auto,
    Force,
    Disable,
}

impl Default for StreamFallbackMode {
    fn default() -> Self {
        Self::Auto
    }
}

/// 图片生成请求参数
#[derive(Debug, Serialize)]
struct ResponsesImageGenerateRequest {
    model: String,
    input: String,
    tools: Vec<ResponsesImageTool>,
    tool_choice: ResponsesToolChoice,
}

#[derive(Debug, Serialize)]
struct ResponsesImageTool {
    #[serde(rename = "type")]
    tool_type: String,
    size: String,
}

#[derive(Debug, Serialize)]
struct ResponsesToolChoice {
    #[serde(rename = "type")]
    tool_type: String,
}

#[derive(Debug, Serialize)]
struct ChatImageGenerateRequest {
    model: String,
    messages: Vec<ChatImageMessage>,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct ChatImageMessage {
    role: String,
    content: String,
}

fn build_image_generation_url(base_url: &str) -> (String, ImageGenerationApiKind) {
    let normalized = base_url.trim().trim_end_matches('/');
    let normalized_lower = normalized.to_ascii_lowercase();

    if normalized_lower.ends_with("/chat/completions") || normalized_lower.ends_with("/chat") {
        return (normalized.to_string(), ImageGenerationApiKind::Chat);
    }

    let responses_base = strip_known_generation_path(normalized);
    (
        append_responses_path(responses_base),
        ImageGenerationApiKind::Responses,
    )
}

fn strip_known_generation_path(base_url: &str) -> &str {
    let normalized_lower = base_url.to_ascii_lowercase();
    for suffix in ["/images/generations", "/responses"] {
        if normalized_lower.ends_with(suffix) {
            return base_url[..base_url.len() - suffix.len()].trim_end_matches('/');
        }
    }
    base_url
}

fn append_responses_path(base_url: &str) -> String {
    let lower = base_url.to_ascii_lowercase();
    if lower.ends_with("/responses") {
        return base_url.to_string();
    }
    if lower.ends_with("/v1") || lower.ends_with("/v2") {
        return format!("{}/responses", base_url);
    }
    if lower.contains("api.openai.com") && !lower.contains("/v1") && !lower.contains("/v2") {
        return format!("{}/v1/responses", base_url);
    }
    if lower.contains("/v1/") || lower.contains("/v2/") {
        return base_url.to_string();
    }
    format!("{}/v1/responses", base_url)
}

/// 图片生成响应
#[derive(Debug, Deserialize)]
pub struct ImageGenerateResponse {
    pub created: i64,
    pub data: Vec<ImageDataItem>,
}

/// 图片数据项
#[derive(Debug, Deserialize)]
pub struct ImageDataItem {
    #[serde(rename = "b64_json")]
    pub b64_json: Option<String>,
    pub url: Option<String>,
    #[serde(rename = "revised_prompt")]
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageGenerationApiKind {
    Responses,
    Chat,
}

impl AiClient {
    /**
     * 调用 OpenAI 兼容的图片生成 API（如 DALL-E 3）
     * 支持 base64 和 URL 两种返回格式
     */
    pub async fn generate_image(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        prompt: &str,
        size: &str,
        n: u32,
        _response_format: &str,
    ) -> AppResult<ImageGenerateResponse> {
        // SSRF 运行时校验：防止 DNS rebinding（写入时 DNS 解析到公网，
        // 请求时 DNS 切换到内网）。每次请求前重新解析并校验目标 IP。
        crate::ai::ssrf_guard::validate_endpoint_url(base_url).await?;

        let (url, api_kind) = build_image_generation_url(base_url);

        let mut request = self
            .http
            .post(&url)
            .timeout(std::time::Duration::from_secs(
                IMAGE_GENERATION_REQUEST_TIMEOUT_SECS,
            ))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity");

        if !api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", api_key.trim()));
        }

        let request = match api_kind {
            ImageGenerationApiKind::Responses => request.json(&ResponsesImageGenerateRequest {
                model: model.to_string(),
                input: prompt.to_string(),
                tools: vec![ResponsesImageTool {
                    tool_type: "image_generation".to_string(),
                    size: size.to_string(),
                }],
                tool_choice: ResponsesToolChoice {
                    tool_type: "image_generation".to_string(),
                },
            }),
            ImageGenerationApiKind::Chat => request.json(&ChatImageGenerateRequest {
                model: model.to_string(),
                messages: vec![ChatImageMessage {
                    role: "user".to_string(),
                    content: format!(
                        "请根据以下提示生成 {} 张 {} 图片，并只返回图片 base64 数据：{}",
                        n.min(4),
                        size,
                        prompt
                    ),
                }],
                stream: false,
            }),
        };

        let resp = request.send().await.map_err(|e| {
            AppError::Internal(format!(
                "图片生成 API 调用失败: {}",
                summarize_reqwest_error(&e)
            ))
        })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "图片生成 API 返回错误 {}: {}",
                status, body
            )));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| AppError::Internal(format!("图片生成响应读取失败: {}", e)))?;

        parse_image_generate_response(&body)
    }
}

fn parse_image_generate_response(body: &str) -> AppResult<ImageGenerateResponse> {
    let value: Value = serde_json::from_str(body)
        .map_err(|e| AppError::Internal(format!("图片生成响应解析失败: {}", e)))?;
    let mut data = Vec::new();

    collect_image_data_items(&value, &mut data);

    if data.is_empty() {
        return Err(AppError::Internal(format!(
            "图片生成响应未包含可保存的 base64 或 URL 图片数据；响应摘要: {}",
            summarize_json_for_error(&value)
        )));
    }

    Ok(ImageGenerateResponse {
        created: value
            .get("created")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp()),
        data,
    })
}

fn collect_image_data_items(value: &Value, data: &mut Vec<ImageDataItem>) {
    match value {
        Value::Object(map) => {
            let revised_prompt = map
                .get("revised_prompt")
                .or_else(|| map.get("revisedPrompt"))
                .and_then(Value::as_str)
                .map(str::to_owned);

            for key in [
                "b64_json",
                "b64",
                "base64",
                "base64_json",
                "image",
                "image_base64",
                "imageData",
                "image_data",
                "data_url",
                "dataUrl",
                "result",
            ] {
                if let Some(base64) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .and_then(normalize_base64_image_text)
                {
                    push_image_data_item(
                        data,
                        ImageDataItem {
                            b64_json: Some(base64),
                            url: None,
                            revised_prompt: revised_prompt.clone(),
                        },
                    );
                }
            }

            for key in [
                "url",
                "image_url",
                "imageUrl",
                "output_url",
                "outputUrl",
                "src",
                "file_url",
                "fileUrl",
            ] {
                if let Some(url) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .and_then(extract_image_url_text)
                {
                    push_image_data_item(
                        data,
                        ImageDataItem {
                            b64_json: None,
                            url: Some(url),
                            revised_prompt: revised_prompt.clone(),
                        },
                    );
                }
            }

            for key in [
                "data",
                "output",
                "content",
                "message",
                "choices",
                "result",
                "results",
                "images",
                "items",
                "files",
                "attachments",
                "artifacts",
                "image_url",
                "imageUrl",
            ] {
                if let Some(child) = map.get(key) {
                    collect_image_data_items(child, data);
                }
            }

            for key in ["text", "content", "output_text"] {
                if let Some(text) = map.get(key).and_then(Value::as_str) {
                    collect_image_data_items(&Value::String(text.to_string()), data);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_image_data_items(item, data);
            }
        }
        Value::String(text) => {
            if let Ok(nested) = serde_json::from_str::<Value>(text) {
                collect_image_data_items(&nested, data);
                return;
            }

            if let Some(base64) = normalize_base64_image_text(text) {
                push_image_data_item(
                    data,
                    ImageDataItem {
                        b64_json: Some(base64),
                        url: None,
                        revised_prompt: None,
                    },
                );
            } else if let Some(url) = extract_image_url_text(text) {
                push_image_data_item(
                    data,
                    ImageDataItem {
                        b64_json: None,
                        url: Some(url),
                        revised_prompt: None,
                    },
                );
            }
        }
        _ => {}
    }
}

fn push_image_data_item(data: &mut Vec<ImageDataItem>, item: ImageDataItem) {
    let exists = data.iter().any(|existing| {
        item.b64_json
            .as_ref()
            .zip(existing.b64_json.as_ref())
            .map(|(left, right)| left == right)
            .unwrap_or(false)
            || item
                .url
                .as_ref()
                .zip(existing.url.as_ref())
                .map(|(left, right)| left == right)
                .unwrap_or(false)
    });

    if !exists {
        data.push(item);
    }
}

fn summarize_json_for_error(value: &Value) -> String {
    let serialized =
        serde_json::to_string(value).unwrap_or_else(|_| "<unserializable>".to_string());
    truncate_for_error(&serialized, 1200)
}

fn truncate_for_error(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for (index, char) in value.chars().enumerate() {
        if index >= max_chars {
            output.push_str("...");
            return output;
        }
        output.push(char);
    }
    output
}

fn normalize_base64_image_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = extract_data_url_base64(trimmed).unwrap_or(trimmed);
    let without_prefix = candidate
        .strip_prefix("data:image/png;base64,")
        .or_else(|| candidate.strip_prefix("data:image/jpeg;base64,"))
        .or_else(|| candidate.strip_prefix("data:image/jpg;base64,"))
        .or_else(|| candidate.strip_prefix("data:image/webp;base64,"))
        .unwrap_or(candidate)
        .trim();

    let compact: String = without_prefix
        .chars()
        .filter(|char| !char.is_ascii_whitespace())
        .collect();

    if compact.len() < 64 {
        return None;
    }

    if compact
        .bytes()
        .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'='))
    {
        Some(compact)
    } else {
        None
    }
}

fn extract_image_url_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.starts_with("/")
    {
        return Some(trim_url_delimiters(trimmed).to_string());
    }

    for marker in ["https://", "http://", "/assets/", "/api/"] {
        if let Some(start) = trimmed.find(marker) {
            let candidate = &trimmed[start..];
            return Some(trim_url_delimiters(candidate).to_string());
        }
    }

    None
}

fn trim_url_delimiters(value: &str) -> &str {
    value.trim_matches(|char: char| {
        char.is_ascii_whitespace()
            || matches!(char, '"' | '\'' | ')' | ']' | '}' | '<' | '>' | ',' | ';')
    })
}

fn extract_data_url_base64(value: &str) -> Option<&str> {
    let marker_index = value.find("data:image/")?;
    let base64_marker = ";base64,";
    let after_marker = &value[marker_index..];
    let base64_start = after_marker.find(base64_marker)? + base64_marker.len();
    let candidate = &after_marker[base64_start..];
    let end = candidate
        .find(|char: char| {
            char.is_ascii_whitespace() || matches!(char, '"' | '\'' | ')' | ']' | '}' | '<' | '>')
        })
        .unwrap_or(candidate.len());

    Some(&candidate[..end])
}

#[derive(Debug, Default, Clone, Copy)]
struct StreamFallbackState {
    consecutive_hits: u32,
    prefer_stream: bool,
}

/// 构建聊天完成 API 的 URL
fn build_chat_url(base_url: &str) -> String {
    let normalized = base_url.trim().trim_end_matches('/');

    // 检查是否已经包含完整的 chat completions 路径
    if normalized.ends_with("/chat/completions") {
        return normalized.to_string();
    }

    // 检查是否已经包含 /v1 路径
    if normalized.ends_with("/v1") || normalized.ends_with("/v2") {
        return format!("{}/chat/completions", normalized);
    }

    // 检查是否是常见的 API 端点格式
    let common_patterns = [
        "api.openai.com",
        "api.anthropic.com",
        "api.google.com",
        "api.azure.com",
    ];

    for pattern in &common_patterns {
        if normalized.contains(pattern) {
            // 如果是常见 API 端点且没有 /v1 路径，添加 /v1
            if !normalized.contains("/v1") && !normalized.contains("/v2") {
                return format!("{}/v1/chat/completions", normalized);
            }
            return format!("{}/chat/completions", normalized);
        }
    }

    // 默认情况：直接添加 /chat/completions
    format!("{}/chat/completions", normalized)
}

fn build_models_url(base_url: &str) -> String {
    let normalized = base_url.trim().trim_end_matches('/');
    let normalized_lower = normalized.to_ascii_lowercase();

    for suffix in [
        "/chat/completions",
        "/images/generations",
        "/videos/generations",
        "/responses",
        "/models",
    ] {
        if normalized_lower.ends_with(suffix) {
            return build_models_url(&normalized[..normalized.len() - suffix.len()]);
        }
    }

    if normalized_lower.ends_with("/v1") || normalized_lower.ends_with("/v2") {
        return format!("{}/models", normalized);
    }

    if normalized_lower.contains("/v1/") || normalized_lower.contains("/v2/") {
        return normalized.to_string();
    }

    if normalized_lower.contains("api.openai.com") && !normalized_lower.contains("/v1") {
        return format!("{}/v1/models", normalized);
    }

    format!("{}/v1/models", normalized)
}

/// OpenAI 兼容的 AI 客户端
/// 所有 AI 提供商（OpenAI/Claude/DeepSeek/Ollama）都走这个格式
#[derive(Clone)]
pub struct AiClient {
    http: Client,
    fallback_state: Arc<Mutex<HashMap<String, StreamFallbackState>>>,
    /// 流式请求是否附带 stream_options.include_usage 请求供应商上报 usage。
    stream_include_usage: bool,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frequency_penalty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<i64>,
    stream: bool,
    /// OpenAI 兼容的流式 usage 上报开关；部分网关不识别该字段，
    /// 请求失败时由 chat_stream 自动降级重试（不带 stream_options）。
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
}

#[derive(Debug, Serialize)]
struct StreamOptions {
    include_usage: bool,
}

/// 流式请求的 usage 收集句柄。
/// `chat_stream` 调用方创建并传入；流结束后通过 `take()` 获取供应商上报的
/// usage（需要 `stream_options.include_usage` 生效，部分供应商也会主动上报）。
#[derive(Clone, Default)]
pub struct StreamUsageCapture {
    inner: Arc<Mutex<Option<TokenUsage>>>,
}

impl StreamUsageCapture {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取出供应商上报的 usage；仅首次调用返回 Some，之后为 None。
    pub fn take(&self) -> Option<TokenUsage> {
        self.inner.lock().ok().and_then(|mut guard| guard.take())
    }

    fn set(&self, usage: TokenUsage) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(usage);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    /// 供应商上报的缓存命中 prompt tokens（无上报时为 None）。
    /// 兼容 OpenAI `prompt_tokens_details.cached_tokens` 与
    /// DeepSeek `prompt_cache_hit_tokens` 两种字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_prompt_tokens: Option<i64>,
}

/// AI 调用结果
pub struct AiResponse {
    pub content: String,
    pub model: String,
    pub usage: Option<TokenUsage>,
}

impl AiClient {
    pub fn new() -> Self {
        Self {
            http: Client::builder()
                .use_rustls_tls()
                .timeout(std::time::Duration::from_secs(120))
                // SSRF 防护：禁止自动跟随重定向。
                // 攻击者可能将 base_url 指向公网服务器，再 302 重定向到内网 IP
                // （如 169.254.169.254 云元数据）以绕过初始 URL 校验。
                // 禁用重定向后，3xx 响应会原样返回，由调用方决定是否跟随，
                // 跟随时应通过 ssrf_guard::validate_endpoint_url 重新校验 Location 头。
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Failed to create HTTP client"),
            fallback_state: Arc::new(Mutex::new(HashMap::new())),
            stream_include_usage: true,
        }
    }

    /// 设置流式请求是否请求供应商上报 usage（来自 AI_STREAM_INCLUDE_USAGE 配置）。
    pub fn with_stream_include_usage(mut self, enabled: bool) -> Self {
        self.stream_include_usage = enabled;
        self
    }

    pub async fn list_models(&self, base_url: &str, api_key: &str) -> AppResult<Vec<String>> {
        // SSRF 运行时校验：防止 DNS rebinding
        crate::ai::ssrf_guard::validate_endpoint_url(base_url).await?;

        let url = build_models_url(base_url);
        let mut request = self
            .http
            .get(&url)
            .timeout(std::time::Duration::from_secs(45))
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity");

        if !api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", api_key.trim()));
        }

        let resp = request.send().await.map_err(|e| {
            AppError::Internal(format!("模型列表获取失败: {}", summarize_reqwest_error(&e)))
        })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "模型列表接口返回错误 {}: {}",
                status,
                summarize_response_body(&body)
            )));
        }

        let value: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("模型列表响应解析失败: {}", e)))?;
        let models = extract_model_ids(&value);

        if models.is_empty() {
            return Err(AppError::Internal(format!(
                "模型列表响应未包含模型 ID；响应摘要: {}",
                summarize_response_body(&value.to_string())
            )));
        }

        Ok(models)
    }

    /// 非流式调用（用于后台任务）
    pub async fn chat(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        temperature: Option<f64>,
        top_p: Option<f64>,
        frequency_penalty: Option<f64>,
        max_tokens: Option<i64>,
        stream_fallback_mode: StreamFallbackMode,
    ) -> AppResult<AiResponse> {
        // SSRF 运行时校验：防止 DNS rebinding
        crate::ai::ssrf_guard::validate_endpoint_url(base_url).await?;

        let fallback_key = build_stream_fallback_cache_key(base_url, model, api_key);
        let prefer_stream_by_cache = matches!(stream_fallback_mode, StreamFallbackMode::Auto)
            && self.is_stream_preferred(&fallback_key);

        if matches!(stream_fallback_mode, StreamFallbackMode::Force) || prefer_stream_by_cache {
            if prefer_stream_by_cache {
                tracing::warn!(
                    model = model,
                    base_url = %sanitize_base_url(base_url),
                    "已命中流式回退缓存标记，直接使用 stream=true",
                );
            }

            match self
                .collect_completion_via_stream(
                    base_url,
                    api_key,
                    model,
                    messages.clone(),
                    temperature,
                    top_p,
                    frequency_penalty,
                    max_tokens,
                )
                .await
            {
                Ok((streamed_content, streamed_usage)) if !streamed_content.is_empty() => {
                    return Ok(AiResponse {
                        content: streamed_content,
                        model: model.to_string(),
                        usage: streamed_usage,
                    });
                }
                Ok(_) if matches!(stream_fallback_mode, StreamFallbackMode::Force) => {
                    return Err(AppError::Internal(
                        "强制流式回退已启用，但流式返回内容为空".into(),
                    ));
                }
                Err(error) if matches!(stream_fallback_mode, StreamFallbackMode::Force) => {
                    return Err(error);
                }
                Ok(_) => {
                    tracing::warn!(
                        model = model,
                        base_url = %sanitize_base_url(base_url),
                        "流式直连返回空文本，回退到非流式请求",
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        model = model,
                        base_url = %sanitize_base_url(base_url),
                        error = %error,
                        "流式直连失败，回退到非流式请求",
                    );
                }
            }
        }

        let req = ChatRequest {
            model: model.to_string(),
            messages: messages.clone(),
            temperature,
            top_p,
            frequency_penalty,
            max_tokens,
            stream: false,
            stream_options: None,
        };
        let url = build_chat_url(base_url);

        let mut request = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            // 某些网关会返回有问题的压缩体，显式声明 identity 可降低 decode body 失败概率
            .header("Accept-Encoding", "identity");

        if !api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", api_key.trim()));
        }

        let resp = request.json(&req).send().await.map_err(|e| {
            AppError::Internal(format!("AI 调用失败: {}", summarize_reqwest_error(&e)))
        })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "AI API 返回错误 {}: {}",
                status,
                summarize_response_body(&body)
            )));
        }

        let raw_body = match resp.bytes().await {
            Ok(body) => body,
            Err(error) => {
                if matches!(stream_fallback_mode, StreamFallbackMode::Disable) {
                    return Err(AppError::Internal(format!("读取 AI 响应失败: {}", error)));
                }

                let (consecutive_hits, cached_prefer_stream) =
                    self.record_stream_fallback_hit(&fallback_key);
                tracing::warn!(
                    model = model,
                    base_url = %sanitize_base_url(base_url),
                    error = %error,
                    consecutive_hits,
                    cached_prefer_stream,
                    "读取非流式响应体失败，触发流式回退",
                );
                let (streamed_content, streamed_usage) = self
                    .collect_completion_via_stream(
                        base_url,
                        api_key,
                        model,
                        messages,
                        temperature,
                        top_p,
                        frequency_penalty,
                        max_tokens,
                    )
                    .await?;
                if streamed_content.is_empty() {
                    return Err(AppError::Internal(
                        "读取非流式响应体失败，且流式兜底返回空文本".into(),
                    ));
                }

                return Ok(AiResponse {
                    content: streamed_content,
                    model: model.to_string(),
                    usage: streamed_usage,
                });
            }
        };

        let parsed: Value = serde_json::from_slice(&raw_body).map_err(|e| {
            let preview = summarize_response_body(&String::from_utf8_lossy(&raw_body));
            AppError::Internal(format!("解析 AI 响应失败: {}；响应片段: {}", e, preview))
        })?;

        if let Some(error_message) = extract_api_error_message(&parsed) {
            return Err(AppError::Internal(format!(
                "AI API 返回错误: {}",
                error_message
            )));
        }

        // 流式兜底路径捕获的供应商 usage；原非流式响应自带 usage 时优先用后者。
        let mut streamed_usage: Option<TokenUsage> = None;
        let content = if let Some(content) = extract_completion_text(&parsed) {
            self.reset_stream_fallback_hits(&fallback_key);
            content
        } else if should_retry_with_stream(&parsed)
            && !matches!(stream_fallback_mode, StreamFallbackMode::Disable)
        {
            let (consecutive_hits, cached_prefer_stream) =
                self.record_stream_fallback_hit(&fallback_key);
            tracing::warn!(
                model = model,
                base_url = %sanitize_base_url(base_url),
                completion_tokens = parse_token_usage(&parsed)
                    .map(|usage| usage.completion_tokens)
                    .unwrap_or(0),
                consecutive_hits,
                cached_prefer_stream,
                "检测到非流式响应缺少可读文本，触发流式回退",
            );

            let (streamed_content, fallback_usage) = self
                .collect_completion_via_stream(
                    base_url,
                    api_key,
                    model,
                    messages,
                    temperature,
                    top_p,
                    frequency_penalty,
                    max_tokens,
                )
                .await?;
            if streamed_content.is_empty() {
                let preview = summarize_response_body(&parsed.to_string());
                return Err(AppError::Internal(format!(
                    "AI 非流式响应无文本，且流式兜底也为空；响应片段: {}",
                    preview
                )));
            }
            streamed_usage = fallback_usage;
            streamed_content
        } else {
            let preview = summarize_response_body(&parsed.to_string());
            return Err(AppError::Internal(format!(
                "AI 返回结果中缺少可读文本；响应片段: {}",
                preview
            )));
        };

        // 第二条兜底路径里原非流式响应可能已带 usage（只是缺文本），
        // 优先用它；流式兜底上报的 usage 作为回退。
        let usage = parse_token_usage(&parsed).or(streamed_usage);
        let response_model = parsed
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(model);

        Ok(AiResponse {
            content,
            model: response_model.to_string(),
            usage,
        })
    }

    async fn collect_completion_via_stream(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        temperature: Option<f64>,
        top_p: Option<f64>,
        frequency_penalty: Option<f64>,
        max_tokens: Option<i64>,
    ) -> AppResult<(String, Option<TokenUsage>)> {
        let usage_capture = StreamUsageCapture::new();
        let stream = self
            .chat_stream(
                base_url,
                api_key,
                model,
                messages,
                temperature,
                top_p,
                frequency_penalty,
                max_tokens,
                &usage_capture,
            )
            .await?;
        futures::pin_mut!(stream);

        let mut content = String::new();
        let mut chunk_count = 0u64;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(text) => {
                    content.push_str(&text);
                    chunk_count += 1;
                }
                Err(e) => {
                    if !content.is_empty() {
                        tracing::warn!(
                            error = %e,
                            received_chunks = chunk_count,
                            content_len = content.len(),
                            content_preview = %content_preview(&content, 300),
                            "流式响应部分成功后出错"
                        );
                        return Err(AppError::Internal(format!(
                            "AI 流式响应中断 - 已成功接收 {} 个数据块 (共 {} 字符): {}; 错误: {}",
                            chunk_count,
                            content.len(),
                            content_preview(&content, 200),
                            e
                        )));
                    }
                    return Err(e);
                }
            }
        }

        Ok((content.trim().to_string(), usage_capture.take()))
    }

    fn is_stream_preferred(&self, key: &str) -> bool {
        let Ok(state) = self.fallback_state.lock() else {
            return false;
        };
        state
            .get(key)
            .map(|item| item.prefer_stream)
            .unwrap_or(false)
    }

    fn record_stream_fallback_hit(&self, key: &str) -> (u32, bool) {
        let Ok(mut state) = self.fallback_state.lock() else {
            return (0, false);
        };

        let entry = state.entry(key.to_string()).or_default();
        entry.consecutive_hits = entry.consecutive_hits.saturating_add(1);
        if entry.consecutive_hits >= STREAM_FALLBACK_TRIGGER_THRESHOLD {
            entry.prefer_stream = true;
        }

        (entry.consecutive_hits, entry.prefer_stream)
    }

    fn reset_stream_fallback_hits(&self, key: &str) {
        let Ok(mut state) = self.fallback_state.lock() else {
            return;
        };

        if let Some(entry) = state.get_mut(key) {
            entry.consecutive_hits = 0;
            entry.prefer_stream = false;
        }
    }

    /// 流式调用（返回字节流，由 handler 转为 SSE）
    pub async fn chat_stream(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        temperature: Option<f64>,
        top_p: Option<f64>,
        frequency_penalty: Option<f64>,
        max_tokens: Option<i64>,
        usage_capture: &StreamUsageCapture,
    ) -> AppResult<impl futures::Stream<Item = Result<String, AppError>>> {
        // SSRF 运行时校验：防止 DNS rebinding
        crate::ai::ssrf_guard::validate_endpoint_url(base_url).await?;

        let url = build_chat_url(base_url);

        let build_request = |include_usage: bool| {
            let req = ChatRequest {
                model: model.to_string(),
                messages: messages.clone(),
                temperature,
                top_p,
                frequency_penalty,
                max_tokens,
                stream: true,
                stream_options: include_usage.then_some(StreamOptions {
                    include_usage: true,
                }),
            };
            let mut request = self
                .http
                .post(&url)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .header("Accept-Encoding", "identity");
            if !api_key.trim().is_empty() {
                request = request.header("Authorization", format!("Bearer {}", api_key.trim()));
            }
            request.json(&req)
        };

        let include_usage = self.stream_include_usage;
        let mut resp = build_request(include_usage).send().await.map_err(|e| {
            AppError::Internal(format!("AI 调用失败: {}", summarize_reqwest_error(&e)))
        })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            // 部分 OpenAI 兼容网关不识别 stream_options 字段（400/422），
            // 降级为不带该字段的请求重试一次，保证流式功能不因指标采集受损。
            if include_usage && matches!(status.as_u16(), 400 | 422) {
                tracing::warn!(
                    base_url = %sanitize_base_url(base_url),
                    status = %status,
                    "stream_options.include_usage 请求被拒绝，降级为不带 stream_options 重试"
                );
                resp = build_request(false).send().await.map_err(|e| {
                    AppError::Internal(format!("AI 调用失败: {}", summarize_reqwest_error(&e)))
                })?;
                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(AppError::Internal(format!(
                        "AI API 返回错误 {}: {}",
                        status, body
                    )));
                }
            } else {
                return Err(AppError::Internal(format!(
                    "AI API 返回错误 {}: {}",
                    status, body
                )));
            }
        }

        let usage_capture = usage_capture.clone();
        let stream = async_stream::stream! {
            let mut byte_stream = resp.bytes_stream();
            let mut buffer = String::new();
            let mut emitted_content = false;

            while let Some(chunk) = byte_stream.next().await {
                let chunk = match chunk {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        let received_len = buffer.len();
                        let error_type = classify_stream_error(&error);
                        let buffer_preview = if received_len > 200 {
                            format!("{}...(已接收 {} 字符)", &buffer[..200], received_len)
                        } else if received_len > 0 {
                            format!("{}(共 {} 字符)", buffer, received_len)
                        } else {
                            "无".to_string()
                        };

                        tracing::warn!(
                            error = %error,
                            error_type = %error_type,
                            buffer_len = received_len,
                            emitted_content,
                            "流式响应读取 chunk 失败"
                        );

                        if emitted_content {
                            tracing::warn!(
                                error = %error,
                                error_type = %error_type,
                                "流式响应已产出部分内容，忽略尾部读取错误并按现有内容收尾"
                            );
                            break;
                        }

                        let error_detail = format!(
                            "流读取错误 [{}] - 已接收内容: {}; 错误详情: {}",
                            error_type,
                            buffer_preview,
                            error
                        );
                        yield Err(AppError::Internal(error_detail));
                        return;
                    }
                };
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    if line.starts_with("data: ") {
                        let data = &line[6..];
                        if data == "[DONE]" {
                            return;
                        }
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                            // 供应商 usage 块（通常在 [DONE] 前的最后一块）：
                            // 记录到句柄供调用方在流结束后取用。
                            if json.get("usage").is_some_and(Value::is_object) {
                                if let Some(usage) = parse_token_usage(&json).filter(|usage| {
                                    usage.total_tokens > 0 || usage.completion_tokens > 0
                                }) {
                                    usage_capture.set(usage);
                                }
                            }
                            if let Some(content) = extract_stream_chunk_text(&json) {
                                if !content.is_empty() {
                                    emitted_content = true;
                                    yield Ok(content);
                                }
                            }
                        } else if !data.trim().is_empty() {
                            let preview = if data.len() > 200 { &data[..200] } else { data };
                            tracing::debug!(
                                preview,
                                "流式 SSE data 行 JSON 解析失败，已跳过"
                            );
                        }
                    }
                }
            }

            if !buffer.trim().is_empty() {
                let remaining = buffer.trim();
                if remaining.starts_with("data: ") {
                    let data = &remaining[6..];
                    if data != "[DONE]" {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                            if json.get("usage").is_some_and(Value::is_object) {
                                if let Some(usage) = parse_token_usage(&json).filter(|usage| {
                                    usage.total_tokens > 0 || usage.completion_tokens > 0
                                }) {
                                    usage_capture.set(usage);
                                }
                            }
                            if let Some(content) = extract_stream_chunk_text(&json) {
                                if !content.is_empty() {
                                    yield Ok(content);
                                }
                            }
                        }
                    }
                }
            }
        };

        Ok(stream)
    }
}

fn summarize_response_body(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = compact.chars();
    let preview: String = chars.by_ref().take(280).collect();
    if chars.next().is_some() {
        format!("{}...", preview)
    } else {
        preview
    }
}

fn extract_model_ids(value: &Value) -> Vec<String> {
    let mut models = Vec::new();
    collect_model_ids(value, &mut models);
    models
}

fn collect_model_ids(value: &Value, models: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_model_ids(item, models);
            }
        }
        Value::Object(map) => {
            for key in ["data", "models"] {
                if let Some(child) = map.get(key) {
                    collect_model_ids(child, models);
                }
            }

            for key in ["id", "name", "model"] {
                if let Some(model) = map.get(key).and_then(Value::as_str) {
                    push_model_id(models, model);
                    break;
                }
            }
        }
        Value::String(model) => {
            push_model_id(models, model);
        }
        _ => {}
    }
}

fn push_model_id(models: &mut Vec<String>, value: &str) {
    let model = value.trim();
    if model.is_empty()
        || model.len() > 160
        || model.chars().any(char::is_whitespace)
        || matches!(model, "list" | "model")
        || models.iter().any(|item| item.eq_ignore_ascii_case(model))
    {
        return;
    }

    models.push(model.to_string());
}

fn summarize_reqwest_error(error: &reqwest::Error) -> String {
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_request() {
        "request"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else if error.is_redirect() {
        "redirect"
    } else {
        "unknown"
    };

    let mut message = format!("[{}] {}", category, error);
    let mut current = error.source();
    while let Some(source) = current {
        message.push_str("; caused by: ");
        message.push_str(&source.to_string());
        current = source.source();
    }

    append_transport_error_hint(category, message)
}

fn append_transport_error_hint(category: &str, message: String) -> String {
    let lower = message.to_ascii_lowercase();
    let hint = if lower.contains("安全包中没有可用的凭证")
        || lower.contains("schannel")
        || lower.contains("certificate")
        || lower.contains("cert")
        || lower.contains("tls")
    {
        Some(
            "建议：这是 TLS/证书层错误。当前后端已使用 rustls；请确认正在运行的是最新后端，并检查代理或网关证书配置。",
        )
    } else if lower.contains("proxy")
        || lower.contains("127.0.0.1:7890")
        || lower.contains("connection refused")
        || lower.contains("actively refused")
        || lower.contains("由于目标计算机积极拒绝")
    {
        Some("建议：检查本机代理是否已启动、端口是否正确，或临时移除 server/.env 中的 HTTP_PROXY/HTTPS_PROXY。")
    } else if lower.contains("dns")
        || lower.contains("name or service not known")
        || lower.contains("failed to lookup address")
        || lower.contains("nodename nor servname")
    {
        Some("建议：检查 Base URL 域名是否正确，以及当前网络/DNS 是否能解析该域名。")
    } else if category == "timeout" || lower.contains("timed out") || lower.contains("timeout") {
        Some("建议：上游接口响应超时。请检查代理、网关稳定性，或稍后重试。")
    } else if category == "connect" {
        Some("建议：无法建立到上游接口的连接。请检查 Base URL、代理设置和网络连通性。")
    } else {
        None
    };

    match hint {
        Some(hint) => format!("{}。{}", message, hint),
        None => message,
    }
}

/**
 * 生成内容预览，用于错误信息中显示已接收的部分内容
 */
fn content_preview(content: &str, max_len: usize) -> String {
    if content.len() <= max_len {
        content.to_string()
    } else {
        format!("{}...(共 {} 字符)", &content[..max_len], content.len())
    }
}

fn value_to_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(num) = value.as_i64() {
        return Some(num);
    }
    if let Some(num) = value.as_u64() {
        return i64::try_from(num).ok();
    }
    if let Some(num) = value.as_f64() {
        return Some(num.round() as i64);
    }
    if let Some(text) = value.as_str() {
        return text.trim().parse::<i64>().ok();
    }
    None
}

fn parse_token_usage(payload: &Value) -> Option<TokenUsage> {
    let usage = payload.get("usage")?;
    let prompt_tokens = value_to_i64(
        usage
            .get("prompt_tokens")
            .or_else(|| usage.get("input_tokens")),
    );
    let completion_tokens = value_to_i64(
        usage
            .get("completion_tokens")
            .or_else(|| usage.get("output_tokens")),
    );
    let total_tokens = value_to_i64(usage.get("total_tokens"))
        .or_else(|| Some(prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0)));

    let cached_prompt_tokens = value_to_i64(
        usage
            .get("prompt_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .or_else(|| usage.get("prompt_cache_hit_tokens")),
    )
    .filter(|value| *value > 0);

    Some(TokenUsage {
        prompt_tokens: prompt_tokens.unwrap_or(0),
        completion_tokens: completion_tokens.unwrap_or(0),
        total_tokens: total_tokens.unwrap_or(0),
        cached_prompt_tokens,
    })
}

fn extract_non_empty_text(value: Option<&Value>) -> Option<String> {
    extract_non_empty_text_with_mode(value, false)
}

fn extract_non_empty_text_preserve_whitespace(value: Option<&Value>) -> Option<String> {
    extract_non_empty_text_with_mode(value, true)
}

fn extract_non_empty_text_with_mode(
    value: Option<&Value>,
    preserve_whitespace: bool,
) -> Option<String> {
    value
        .map(|item| extract_text_content_with_mode(item, preserve_whitespace))
        .filter(|text| !text.is_empty())
}

fn extract_text_content(value: &Value) -> String {
    extract_text_content_with_mode(value, false)
}

fn extract_text_content_with_mode(value: &Value, preserve_whitespace: bool) -> String {
    let text = match value {
        Value::String(text) => {
            if preserve_whitespace {
                text.clone()
            } else {
                text.trim().to_string()
            }
        }
        Value::Array(items) => items
            .iter()
            .map(|item| extract_text_content_with_mode(item, preserve_whitespace))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => {
            // 优先提取常见的文本字段，兼容不同 OpenAI 兼容网关实现
            for key in [
                "output_text",
                "text",
                "value",
                "content",
                "delta",
                "reasoning_content",
                "reasoning",
                "message",
            ] {
                if let Some(text) =
                    extract_non_empty_text_with_mode(map.get(key), preserve_whitespace)
                {
                    return text;
                }
            }

            map.values()
                .map(|item| extract_text_content_with_mode(item, preserve_whitespace))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => String::new(),
    };

    if preserve_whitespace {
        text
    } else {
        text.trim().to_string()
    }
}

fn extract_completion_text(payload: &Value) -> Option<String> {
    if let Some(choices) = payload.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(text) =
                extract_non_empty_text(choice.get("message").and_then(|item| item.get("content")))
            {
                return Some(text);
            }

            if let Some(text) = extract_non_empty_text(
                choice
                    .get("message")
                    .and_then(|item| item.get("reasoning_content")),
            ) {
                return Some(text);
            }

            if let Some(text) =
                extract_non_empty_text(choice.get("message").and_then(|item| item.get("reasoning")))
            {
                return Some(text);
            }

            if let Some(text) = extract_non_empty_text(choice.get("text")) {
                return Some(text);
            }

            if let Some(text) =
                extract_non_empty_text(choice.get("delta").and_then(|item| item.get("content")))
            {
                return Some(text);
            }

            if let Some(text) = extract_non_empty_text(
                choice
                    .get("delta")
                    .and_then(|item| item.get("reasoning_content")),
            ) {
                return Some(text);
            }

            if let Some(text) = extract_non_empty_text(choice.get("output_text")) {
                return Some(text);
            }

            if let Some(text) = extract_non_empty_text(choice.get("content")) {
                return Some(text);
            }
        }
    }

    for candidate in [
        payload.get("output_text"),
        payload.get("content"),
        payload.get("message").and_then(|item| item.get("content")),
        payload
            .get("response")
            .and_then(|item| item.get("output_text")),
        payload.get("response").and_then(|item| item.get("output")),
        payload.get("output"),
        payload.get("data"),
        payload.get("result"),
    ] {
        if let Some(text) = extract_non_empty_text(candidate) {
            return Some(text);
        }
    }

    None
}

fn extract_api_error_message(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;

    if let Some(message) = extract_non_empty_text(
        error
            .get("message")
            .or_else(|| error.get("msg"))
            .or_else(|| error.get("error"))
            .or_else(|| error.get("detail")),
    ) {
        return Some(message);
    }

    extract_non_empty_text(Some(error))
}

fn extract_stream_chunk_text(payload: &Value) -> Option<String> {
    if let Some(choices) = payload.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(text) = extract_non_empty_text_preserve_whitespace(
                choice.get("delta").and_then(|item| item.get("content")),
            ) {
                return Some(text);
            }
            if let Some(text) = extract_non_empty_text_preserve_whitespace(
                choice.get("message").and_then(|item| item.get("content")),
            ) {
                return Some(text);
            }
            if let Some(text) = extract_non_empty_text_preserve_whitespace(choice.get("text")) {
                return Some(text);
            }
        }
    }

    extract_non_empty_text_preserve_whitespace(payload.get("output_text"))
}

fn build_stream_fallback_cache_key(base_url: &str, model: &str, api_key: &str) -> String {
    let normalized_base_url = base_url.trim().trim_end_matches('/').to_ascii_lowercase();
    let normalized_model = model.trim().to_ascii_lowercase();
    let trimmed_api_key = api_key.trim();

    let mut hasher = Sha256::new();
    hasher.update(normalized_base_url.as_bytes());
    hasher.update(b"|");
    hasher.update(normalized_model.as_bytes());
    hasher.update(b"|");
    hasher.update(trimmed_api_key.as_bytes());

    format!("{:x}", hasher.finalize())
}

fn sanitize_base_url(base_url: &str) -> String {
    let normalized = base_url.trim().trim_end_matches('/');
    if normalized.is_empty() {
        return "<empty>".to_string();
    }

    reqwest::Url::parse(normalized)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            let port = url
                .port()
                .map(|value| format!(":{}", value))
                .unwrap_or_default();
            Some(format!("{}{}", host, port))
        })
        .unwrap_or_else(|| normalized.to_string())
}

fn should_retry_with_stream(payload: &Value) -> bool {
    let Some(choices) = payload.get("choices").and_then(Value::as_array) else {
        return false;
    };
    let Some(choice) = choices.first() else {
        return false;
    };

    let finish_reason_is_stop = choice
        .get("finish_reason")
        .or_else(|| choice.get("finishreason"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| value.eq_ignore_ascii_case("stop"))
        .unwrap_or(false);
    if !finish_reason_is_stop {
        return false;
    }

    let message = match choice.get("message") {
        Some(Value::Object(map)) => map,
        _ => return false,
    };

    let role_is_assistant = message
        .get("role")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| value.eq_ignore_ascii_case("assistant"))
        .unwrap_or(false);
    if !role_is_assistant {
        return false;
    }

    let message_content_empty = match message.get("content") {
        None => true,
        Some(Value::Null) => true,
        Some(value) => extract_text_content(value).trim().is_empty(),
    };
    if !message_content_empty {
        return false;
    }

    let completion_tokens = payload
        .get("usage")
        .and_then(|usage| {
            usage
                .get("completion_tokens")
                .or_else(|| usage.get("output_tokens"))
        })
        .and_then(|value| value_to_i64(Some(value)))
        .unwrap_or(0);

    completion_tokens > 0
}

/**
 * 分类流式响应错误类型
 * 根据错误信息判断是超时、网络错误还是解码错误
 */
fn classify_stream_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "连接超时"
    } else if error.is_connect() {
        "连接失败"
    } else if error.is_request() {
        "请求错误"
    } else if error.is_body() {
        "请求体错误"
    } else if error.is_decode() {
        "响应解码失败"
    } else if error.is_redirect() {
        "重定向错误"
    } else {
        let error_msg = error.to_string().to_lowercase();
        if error_msg.contains("timeout") || error_msg.contains("timed out") {
            "操作超时"
        } else if error_msg.contains("connection") || error_msg.contains("reset") {
            "连接中断"
        } else if error_msg.contains("eof") || error_msg.contains("unexpected end") {
            "流意外结束"
        } else if error_msg.contains("decode")
            || error_msg.contains("utf-8")
            || error_msg.contains("encoding")
        {
            "编码解码错误"
        } else {
            "未知流错误"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_transport_error_hint, build_image_generation_url, build_stream_fallback_cache_key,
        extract_api_error_message, extract_completion_text, extract_stream_chunk_text,
        parse_image_generate_response, parse_token_usage, should_retry_with_stream, ChatRequest,
        ImageGenerationApiKind, StreamOptions, StreamUsageCapture, TokenUsage,
    };
    use serde_json::json;

    #[test]
    fn image_generation_url_uses_responses_for_openai_root() {
        let (url, kind) = build_image_generation_url("https://api.openai.com");

        assert_eq!(kind, ImageGenerationApiKind::Responses);
        assert_eq!(url, "https://api.openai.com/v1/responses");
    }

    #[test]
    fn image_generation_url_uses_responses_for_openai_v1_root() {
        let (url, kind) = build_image_generation_url("https://api.openai.com/v1");

        assert_eq!(kind, ImageGenerationApiKind::Responses);
        assert_eq!(url, "https://api.openai.com/v1/responses");
    }

    #[test]
    fn image_generation_url_rewrites_legacy_images_path_to_responses() {
        let (url, kind) =
            build_image_generation_url("https://api.openai.com/v1/images/generations");

        assert_eq!(kind, ImageGenerationApiKind::Responses);
        assert_eq!(url, "https://api.openai.com/v1/responses");
    }

    #[test]
    fn image_generation_url_keeps_chat_gateway_path() {
        let (url, kind) =
            build_image_generation_url("https://gateway.example.com/v1/chat/completions");

        assert_eq!(kind, ImageGenerationApiKind::Chat);
        assert_eq!(url, "https://gateway.example.com/v1/chat/completions");
    }

    #[test]
    fn image_generation_response_extracts_responses_result_base64() {
        let base64 = "A".repeat(80);
        let payload = json!({
            "created": 1,
            "output": [{
                "type": "image_generation_call",
                "result": base64
            }]
        });

        let response = parse_image_generate_response(&payload.to_string()).unwrap();

        assert_eq!(response.data.len(), 1);
        assert_eq!(response.data[0].b64_json.as_deref(), Some(base64.as_str()));
    }

    #[test]
    fn image_generation_response_extracts_nested_image_url() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": [{
                        "type": "image_url",
                        "image_url": {
                            "url": "https://cdn.example.com/generated.png"
                        }
                    }]
                }
            }]
        });

        let response = parse_image_generate_response(&payload.to_string()).unwrap();

        assert_eq!(response.data.len(), 1);
        assert_eq!(
            response.data[0].url.as_deref(),
            Some("https://cdn.example.com/generated.png")
        );
    }

    #[test]
    fn image_generation_response_extracts_markdown_image_url() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": "![result](https://cdn.example.com/generated.webp)"
                }
            }]
        });

        let response = parse_image_generate_response(&payload.to_string()).unwrap();

        assert_eq!(response.data.len(), 1);
        assert_eq!(
            response.data[0].url.as_deref(),
            Some("https://cdn.example.com/generated.webp")
        );
    }

    #[test]
    fn extracts_message_content_from_nested_text_object() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": [{
                        "type": "text",
                        "text": { "value": "连接成功" }
                    }]
                }
            }]
        });

        let text = extract_completion_text(&payload);
        assert_eq!(text.as_deref(), Some("连接成功"));
    }

    #[test]
    fn extracts_reasoning_when_content_missing() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": "",
                    "reasoning_content": "连接成功"
                }
            }]
        });

        let text = extract_completion_text(&payload);
        assert_eq!(text.as_deref(), Some("连接成功"));
    }

    #[test]
    fn extracts_output_text_from_response_payload() {
        let payload = json!({
            "response": {
                "output": [{
                    "content": [{
                        "type": "output_text",
                        "text": "连接成功"
                    }]
                }]
            }
        });

        let text = extract_completion_text(&payload);
        assert_eq!(text.as_deref(), Some("连接成功"));
    }

    #[test]
    fn extracts_api_error_message() {
        let payload = json!({
            "error": {
                "message": "invalid_api_key"
            }
        });

        let message = extract_api_error_message(&payload);
        assert_eq!(message.as_deref(), Some("invalid_api_key"));
    }

    #[test]
    fn retries_with_stream_when_non_stream_body_has_empty_assistant_message() {
        let payload = json!({
            "choices": [{
                "message": { "role": "assistant" },
                "finish_reason": "stop"
            }],
            "usage": {
                "completion_tokens": 10
            }
        });

        assert!(should_retry_with_stream(&payload));
    }

    #[test]
    fn retries_with_stream_when_non_stream_body_uses_finishreason_alias() {
        let payload = json!({
            "choices": [{
                "message": { "role": "assistant" },
                "finishreason": "stop"
            }],
            "usage": {
                "completion_tokens": 10
            }
        });

        assert!(should_retry_with_stream(&payload));
    }

    #[test]
    fn does_not_retry_with_stream_when_completion_tokens_is_zero() {
        let payload = json!({
            "choices": [{
                "message": { "role": "assistant" },
                "finish_reason": "stop"
            }],
            "usage": {
                "completion_tokens": 0
            }
        });

        assert!(!should_retry_with_stream(&payload));
    }

    #[test]
    fn stream_fallback_key_is_stable_for_normalized_inputs() {
        let key1 =
            build_stream_fallback_cache_key("https://example.com/v1/", "TEST-MODEL", " sk-test ");
        let key2 =
            build_stream_fallback_cache_key("https://example.com/v1", "test-model", "sk-test");

        assert_eq!(key1, key2);
    }

    #[test]
    fn transport_error_hint_explains_windows_tls_credentials() {
        let summary = append_transport_error_hint(
            "connect",
            "安全包中没有可用的凭证 (os error -2146893042)".to_string(),
        );

        assert!(summary.contains("TLS/证书层错误"));
        assert!(summary.contains("rustls"));
    }

    #[test]
    fn transport_error_hint_explains_local_proxy_refusal() {
        let summary = append_transport_error_hint(
            "connect",
            "tcp connect error: connection refused at 127.0.0.1:7890".to_string(),
        );

        assert!(summary.contains("本机代理"));
        assert!(summary.contains("HTTP_PROXY/HTTPS_PROXY"));
    }

    #[test]
    fn transport_error_hint_explains_dns_failures() {
        let summary = append_transport_error_hint(
            "connect",
            "dns error: failed to lookup address information".to_string(),
        );

        assert!(summary.contains("DNS"));
        assert!(summary.contains("Base URL"));
    }

    #[test]
    fn transport_error_hint_explains_generic_connect_failures() {
        let summary = append_transport_error_hint("connect", "network unreachable".to_string());

        assert!(summary.contains("无法建立到上游接口的连接"));
    }

    #[test]
    fn parse_token_usage_reads_openai_cached_tokens() {
        let payload = json!({
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 200,
                "total_tokens": 1200,
                "prompt_tokens_details": { "cached_tokens": 800 }
            }
        });

        let usage = parse_token_usage(&payload).expect("usage");

        assert_eq!(usage.prompt_tokens, 1000);
        assert_eq!(usage.cached_prompt_tokens, Some(800));
    }

    #[test]
    fn parse_token_usage_reads_deepseek_cached_tokens() {
        let payload = json!({
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 200,
                "total_tokens": 1200,
                "prompt_cache_hit_tokens": 640,
                "prompt_cache_miss_tokens": 360
            }
        });

        let usage = parse_token_usage(&payload).expect("usage");

        assert_eq!(usage.cached_prompt_tokens, Some(640));
    }

    #[test]
    fn parse_token_usage_without_cache_report_is_none() {
        let no_fields = json!({
            "usage": { "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110 }
        });
        let zero_cached = json!({
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "total_tokens": 110,
                "prompt_tokens_details": { "cached_tokens": 0 }
            }
        });

        let usage = parse_token_usage(&no_fields).expect("usage");
        assert_eq!(usage.cached_prompt_tokens, None);

        // 0 命中与未上报等价：视为无缓存数据而不是命中率为 0。
        let usage = parse_token_usage(&zero_cached).expect("usage");
        assert_eq!(usage.cached_prompt_tokens, None);
    }

    #[test]
    fn stream_usage_capture_take_semantics() {
        let capture = StreamUsageCapture::new();
        assert!(capture.take().is_none(), "未上报时 take 返回 None");

        capture.set(TokenUsage {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            cached_prompt_tokens: Some(80),
        });
        let usage = capture.take().expect("set 后首次 take 返回 Some");
        assert_eq!(usage.cached_prompt_tokens, Some(80));
        assert!(capture.take().is_none(), "take 只生效一次");
    }

    #[test]
    fn stream_usage_chunk_sets_capture_without_content() {
        // 供应商 usage 块通常choices 为空且位于 [DONE] 前；
        // 不应产出内容，但应写入句柄（含缓存命中 tokens）。
        let chunk = json!({
            "choices": [],
            "usage": {
                "prompt_tokens": 900,
                "completion_tokens": 150,
                "total_tokens": 1050,
                "prompt_tokens_details": { "cached_tokens": 700 }
            }
        });

        assert_eq!(extract_stream_chunk_text(&chunk), None);

        let capture = StreamUsageCapture::new();
        if let Some(usage) = parse_token_usage(&chunk)
            .filter(|usage| usage.total_tokens > 0 || usage.completion_tokens > 0)
        {
            capture.set(usage);
        }
        let usage = capture.take().expect("usage 块应被捕获");
        assert_eq!(usage.prompt_tokens, 900);
        assert_eq!(usage.cached_prompt_tokens, Some(700));
    }

    #[test]
    fn stream_null_usage_chunk_is_ignored() {
        // 部分网关发送 "usage": null 的空块，不得捕获为零值 usage。
        let chunk = json!({ "choices": [], "usage": null });
        assert!(!chunk.get("usage").is_some_and(serde_json::Value::is_object));

        let capture = StreamUsageCapture::new();
        let parsed = parse_token_usage(&chunk)
            .filter(|usage| usage.total_tokens > 0 || usage.completion_tokens > 0);
        if let Some(usage) = parsed {
            capture.set(usage);
        }
        assert!(capture.take().is_none());
    }

    #[test]
    fn chat_request_serializes_stream_options_only_when_set() {
        let with_options = ChatRequest {
            model: "m".into(),
            messages: vec![],
            temperature: None,
            top_p: None,
            frequency_penalty: None,
            max_tokens: None,
            stream: true,
            stream_options: Some(StreamOptions {
                include_usage: true,
            }),
        };
        let value = serde_json::to_value(&with_options).expect("serialize");
        assert_eq!(
            value["stream_options"]["include_usage"],
            serde_json::Value::Bool(true)
        );

        let without_options = ChatRequest {
            stream_options: None,
            ..with_options
        };
        let value = serde_json::to_value(&without_options).expect("serialize");
        assert!(value.get("stream_options").is_none());
    }
}

#[cfg(test)]
mod stream_degrade_tests {
    use super::{AiClient, ChatMessage, StreamUsageCapture};
    use futures::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn find_header_end(buffer: &[u8]) -> Option<usize> {
        buffer.windows(4).position(|window| window == b"\r\n\r\n")
    }

    /// 读取一个完整 HTTP 请求（header + Content-Length 定长 body）。
    async fn read_http_request(stream: &mut TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_end = loop {
            let n = stream.read(&mut chunk).await.expect("read request");
            assert!(n > 0, "连接在 header 读取完成前关闭");
            buffer.extend_from_slice(&chunk[..n]);
            if let Some(pos) = find_header_end(&buffer) {
                break pos;
            }
        };
        let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let content_length = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.trim().eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        let mut body = buffer[header_end + 4..].to_vec();
        while body.len() < content_length {
            let n = stream.read(&mut chunk).await.expect("read body");
            assert!(n > 0, "连接在 body 读取完成前关闭");
            body.extend_from_slice(&chunk[..n]);
        }
        body.truncate(content_length);
        String::from_utf8_lossy(&body).to_string()
    }

    /// 回复一个带 Content-Length 的 HTTP 响应并关闭连接。
    async fn respond(stream: &mut TcpStream, status_line: &str, body: &str) {
        let response = format!(
            "{status_line}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .await
            .expect("write response");
        stream.flush().await.expect("flush response");
        stream.shutdown().await.expect("shutdown");
    }

    /// 400/422 自动降级：首请求带 stream_options 被拒后，
    /// 重试请求不带该字段且流式内容与 usage 上报不受影响。
    #[tokio::test]
    async fn chat_stream_downgrades_after_400_and_retries_without_stream_options() {
        // 本地 mock 走 loopback，需要开发模式放行。环境变量操作必须持
        // ssrf 测试共享锁：并发跑的 dev_mode/is_production 环境变量测试
        // 与本测试的 set_var/remove_var 若不串行化，会偶发互相踩踏。
        let _env_guard = crate::ai::ssrf_guard::env_test_support::lock_env();
        std::env::set_var("WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS", "true");

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let server = tokio::spawn(async move {
            // 第 1 个请求：带 stream_options → 400 拒绝
            let (mut socket, _) = listener.accept().await.expect("accept first request");
            let body = read_http_request(&mut socket).await;
            assert!(
                body.contains("stream_options"),
                "首请求应携带 stream_options: {body}"
            );
            respond(&mut socket, "HTTP/1.1 400 Bad Request", "").await;

            // 第 2 个请求：降级重试，不带 stream_options → 200 SSE
            let (mut socket, _) = listener.accept().await.expect("accept retry request");
            let body = read_http_request(&mut socket).await;
            assert!(
                !body.contains("stream_options"),
                "重试请求不应携带 stream_options: {body}"
            );
            let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
                       data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\n\
                       data: [DONE]\n\n";
            respond(&mut socket, "HTTP/1.1 200 OK", sse).await;
        });

        let client = AiClient::new().with_stream_include_usage(true);
        let capture = StreamUsageCapture::new();
        let base_url = format!("http://{addr}/v1");

        let stream = client
            .chat_stream(
                &base_url,
                "sk-test",
                "gpt-test",
                vec![ChatMessage {
                    role: "user".to_string(),
                    content: "ping".to_string(),
                }],
                None,
                None,
                None,
                None,
                &capture,
            )
            .await
            .expect("chat_stream 应在 400 后降级重试成功");
        tokio::pin!(stream);

        let mut content = String::new();
        while let Some(item) = stream.next().await {
            content.push_str(&item.expect("stream item"));
        }
        assert!(content.contains("hi"), "应产出降级响应的内容: {content}");

        let usage = capture.take().expect("降级响应的 usage 仍应上报");
        assert_eq!(usage.prompt_tokens, 10);
        assert_eq!(usage.total_tokens, 12);
        assert_eq!(usage.cached_prompt_tokens, None);

        server.await.expect("mock server task");

        // 恢复环境（锁仍持有至测试结束；后续 env 测试的 EnvGuard 也会自愈）
        std::env::remove_var("WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS");
    }
}
