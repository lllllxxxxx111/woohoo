use crate::error::{AppError, AppResult};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const STREAM_FALLBACK_TRIGGER_THRESHOLD: u32 = 3;

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
struct ImageGenerateRequest {
    model: String,
    prompt: String,
    n: u32,
    size: String,
    response_format: String,
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
        response_format: &str,
    ) -> AppResult<ImageGenerateResponse> {
        let normalized = base_url.trim().trim_end_matches('/');
        let url = if normalized.ends_with("/v1") || normalized.ends_with("/v2") {
            format!("{}/images/generations", normalized)
        } else if normalized.contains("api.openai.com") {
            let url_with_v1 = if !normalized.contains("/v1") {
                format!("{}/v1", normalized)
            } else {
                normalized.to_string()
            };
            format!("{}/images/generations", url_with_v1)
        } else {
            format!("{}/v1/images/generations", normalized)
        };

        let req = ImageGenerateRequest {
            model: model.to_string(),
            prompt: prompt.to_string(),
            n: n.min(4),
            size: size.to_string(),
            response_format: response_format.to_string(),
        };

        let mut request = self
            .http
            .post(&url)
            .header("Content-Type", "application/json");

        if !api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", api_key.trim()));
        }

        let resp = request
            .json(&req)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("图片生成 API 调用失败: {}", e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "图片生成 API 返回错误 {}: {}",
                status, body
            )));
        }

        resp.json::<ImageGenerateResponse>()
            .await
            .map_err(|e| AppError::Internal(format!("图片生成响应解析失败: {}", e)))
    }
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

/// OpenAI 兼容的 AI 客户端
/// 所有 AI 提供商（OpenAI/Claude/DeepSeek/Ollama）都走这个格式
#[derive(Clone)]
pub struct AiClient {
    http: Client,
    fallback_state: Arc<Mutex<HashMap<String, StreamFallbackState>>>,
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
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("Failed to create HTTP client"),
            fallback_state: Arc::new(Mutex::new(HashMap::new())),
        }
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
                Ok(streamed_content) if !streamed_content.is_empty() => {
                    return Ok(AiResponse {
                        content: streamed_content,
                        model: model.to_string(),
                        usage: None,
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

        let resp = request
            .json(&req)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("AI 调用失败: {}", e)))?;

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
                let streamed_content = self
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
                    usage: None,
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

            let streamed_content = self
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
            streamed_content
        } else {
            let preview = summarize_response_body(&parsed.to_string());
            return Err(AppError::Internal(format!(
                "AI 返回结果中缺少可读文本；响应片段: {}",
                preview
            )));
        };

        let usage = parse_token_usage(&parsed);
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
    ) -> AppResult<String> {
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

        Ok(content.trim().to_string())
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
    ) -> AppResult<impl futures::Stream<Item = Result<String, AppError>>> {
        let url = build_chat_url(base_url);

        let req = ChatRequest {
            model: model.to_string(),
            messages,
            temperature,
            top_p,
            frequency_penalty,
            max_tokens,
            stream: true,
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

        let resp = request
            .json(&req)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("AI 调用失败: {}", e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "AI API 返回错误 {}: {}",
                status, body
            )));
        }

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

    Some(TokenUsage {
        prompt_tokens: prompt_tokens.unwrap_or(0),
        completion_tokens: completion_tokens.unwrap_or(0),
        total_tokens: total_tokens.unwrap_or(0),
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
        build_stream_fallback_cache_key, extract_api_error_message, extract_completion_text,
        should_retry_with_stream,
    };
    use serde_json::json;

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
            build_stream_fallback_cache_key("https://example.com/v1/", "GPT-5.4", " sk-test ");
        let key2 = build_stream_fallback_cache_key("https://example.com/v1", "gpt-5.4", "sk-test");

        assert_eq!(key1, key2);
    }
}
