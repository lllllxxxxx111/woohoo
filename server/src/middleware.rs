use crate::error::{AppError, AppResult};
use axum::{
    extract::Request,
    extract::State,
    http::{header::HeaderName, HeaderValue, Method},
    middleware::Next,
    response::Response,
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use uuid::Uuid;

pub const REQUEST_ID_HEADER: &str = "x-request-id";

/// 清理操作的阈值：每次 is_allowed 调用后，以 1/CLEANUP_PROBABILITY 的概率执行全局清理
const CLEANUP_PROBABILITY: usize = 100;

#[derive(Debug, Clone)]
pub struct RequestId {
    pub _value: String,
}

/**
 * 请求速率限制中间件
 *
 * 使用滑动窗口算法实现IP级别的请求频率控制
 *
 * 安全特性：
 * - 防止DDoS攻击和暴力破解
 * - 基于IP地址的请求计数
 * - 可配置的窗口大小和最大请求数
 * - 概率性全局清理过期记录防止内存泄漏
 */
pub struct RateLimiter {
    /**
     * 存储每个IP的请求时间戳列表
     * Key: 客户端IP地址
     * Value: 该IP的最近请求时间点
     */
    requests: RwLock<HashMap<String, Vec<Instant>>>,

    /**
     * 时间窗口大小（秒）
     * 在此时间段内计算请求数量
     */
    window_secs: u64,

    /**
     * 窗口内允许的最大请求数
     */
    max_requests: usize,
}

impl RateLimiter {
    /**
     * 创建新的速率限制器实例
     *
     * @param window_secs 时间窗口大小（秒）
     * @param max_requests 窗口内允许的最大请求数
     * @return 配置好的RateLimiter实例
     */
    pub fn new(window_secs: u64, max_requests: usize) -> Self {
        Self {
            requests: RwLock::new(HashMap::new()),
            window_secs,
            max_requests,
        }
    }

    /**
     * 检查指定IP是否允许发送新请求
     *
     * @param client_ip 客户端IP地址
     * @return true表示允许请求，false表示超过限制
     */
    pub async fn is_allowed(&self, client_ip: &str) -> bool {
        let mut requests = self.requests.write().await;
        let now = Instant::now();
        let window_start = now - Duration::from_secs(self.window_secs);

        let request_times = requests.entry(client_ip.to_string()).or_default();

        request_times.retain(|&time| time > window_start);

        if request_times.len() >= self.max_requests {
            false
        } else {
            request_times.push(now);

            // 概率性全局清理过期记录，防止内存泄漏
            let now_nanos = now.elapsed().as_nanos() as usize;
            if now_nanos % CLEANUP_PROBABILITY == 0 {
                let window_start = window_start;
                requests.retain(|_, times| {
                    times.retain(|&time| time > window_start);
                    !times.is_empty()
                });
            }

            true
        }
    }
}

/**
 * 创建全局共享的速率限制器实例
 *
 * 默认配置：
 * - 时间窗口：60秒
 * - 最大请求数：100次/分钟（普通API）
 * - 认证端点更严格：20次/分钟
 */
pub fn create_rate_limiter() -> Arc<RateLimiter> {
    Arc::new(RateLimiter::new(60, 100))
}

/**
 * 认证端点的严格速率限制器
 * 用于登录、注册等敏感操作
 */
pub fn create_auth_rate_limiter() -> Arc<RateLimiter> {
    Arc::new(RateLimiter::new(60, 20))
}

/**
 * 大文件分片上传的专用限流器
 *
 * 一个合规的大文件上传本身就需要几百上千个分片 PUT（例如 400MB / 4MB 分片
 * = 100 个请求），若计入通用 100 次/分钟额度，合规上传必然被 429 打断。
 * 分片路由要求登录且校验会话归属，滥用面小，单独放宽到 1200 次/分钟。
 */
pub fn create_upload_rate_limiter() -> Arc<RateLimiter> {
    Arc::new(RateLimiter::new(60, 1200))
}

/**
 * 为每个请求注入 request_id，并回写到响应头
 */
pub async fn request_id_middleware(mut request: Request, next: Next) -> Response {
    let request_id = request
        .headers()
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    request.extensions_mut().insert(RequestId {
        _value: request_id.clone(),
    });

    let mut response = next.run(request).await;
    let header_name = HeaderName::from_static(REQUEST_ID_HEADER);
    if let Ok(header_value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert(header_name, header_value);
    }
    response
}

/**
 * 从请求中提取客户端真实IP地址
 *
 * 优先级：
 * 1. Axum 连接信息中的远程地址（直连场景，最可信）
 * 2. x-real-ip 头（Nginx 等代理场景）
 * 3. x-forwarded-for 头的最后一个IP（反向代理场景，最不可信）
 * 4. 兜底使用 "unknown-{uuid}" 避免合并限速
 *
 * 安全说明：
 * - 连接信息优先于代理头，防止客户端伪造 x-forwarded-for 绕过限速
 * - x-forwarded-for 取最后一个IP（最接近代理服务器的IP），而非第一个（可被客户端伪造）
 */
fn extract_client_ip(request: &Request) -> String {
    if let Some(addr) = request.extensions().get::<SocketAddr>() {
        return addr.ip().to_string();
    }

    if let Some(connect_info) = request
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
    {
        return connect_info.0.ip().to_string();
    }

    if let Some(real_ip) = request
        .headers()
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
    {
        if !real_ip.is_empty() {
            return real_ip.to_string();
        }
    }

    if let Some(forwarded) = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(last_ip) = forwarded.split(',').last() {
            let trimmed = last_ip.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }

    format!("unknown-{}", Uuid::new_v4().as_simple())
}

fn should_skip_rate_limit(request: &Request) -> bool {
    let path = request.uri().path();

    request.method() == Method::OPTIONS
        || path == "/health"
        || is_generation_rate_limit_exempt(request.method(), path)
        // 分片 PUT 走 upload_rate_limit_middleware 的专用额度，
        // 不再计入通用 100 次/分钟（否则大文件合规上传也会被拦）。
        || is_chunk_part_upload(request.method(), path)
        // SSE 长连接流端点不受限流
        || path.starts_with("/api/ai/tasks/stream")
        || path.starts_with("/api/collaboration/events/stream")
        || path.contains("/stream") && path.starts_with("/api/pipelines/runs/")
        || (request.method() == Method::GET
            && matches!(
                path,
                "/api/auth/me"
                    | "/api/workspace/bootstrap"
                    | "/api/ai/endpoints"
                    | "/api/ai/usage/summary"
                    | "/api/ai/usage/records"
                    | "/api/notifications/channels"
                    | "/api/billing/credits"
                    | "/api/billing/transactions"
            ))
}

fn is_generation_rate_limit_exempt(method: &Method, path: &str) -> bool {
    if method == Method::POST {
        return matches!(
            path,
            "/api/image-gen/generations" | "/api/video-gen/generations"
        );
    }

    method == Method::GET
        && (matches!(
            path,
            "/api/image-gen/generations" | "/api/video-gen/generations"
        ) || path.starts_with("/api/image-gen/generations/")
            || path.starts_with("/api/video-gen/generations/"))
}

/// 分片 PUT 端点：/api/projects/{project_id}/uploads/{session_id}/parts/{part_number}
fn is_chunk_part_upload(method: &Method, path: &str) -> bool {
    if method != Method::PUT {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    // ["", "api", "projects", p, "uploads", s, "parts", n]
    segments.len() == 8
        && segments[1] == "api"
        && segments[2] == "projects"
        && segments[4] == "uploads"
        && segments[6] == "parts"
        && !segments[3].is_empty()
        && !segments[5].is_empty()
        && !segments[7].is_empty()
}

/**
 * Axum 中间件函数：通用速率限制
 *
 * 应用到路由后自动检查客户端IP的请求频率
 * 超过限制时返回429 Too Many Requests响应
 */
pub async fn rate_limit_middleware(
    State(limiter): State<Arc<RateLimiter>>,
    request: Request,
    next: Next,
) -> AppResult<Response> {
    if should_skip_rate_limit(&request) {
        return Ok(next.run(request).await);
    }

    let client_ip = extract_client_ip(&request);

    if limiter.is_allowed(&client_ip).await {
        Ok(next.run(request).await)
    } else {
        tracing::warn!(
            ip = %client_ip,
            "请求被速率限制拦截"
        );

        Err(AppError::TooManyRequests(
            "请求过于频繁，请稍后重试".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    fn request(method: Method, path: &str) -> Request {
        Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .unwrap()
    }

    #[test]
    fn skips_rate_limit_for_generation_submission() {
        assert!(should_skip_rate_limit(&request(
            Method::POST,
            "/api/image-gen/generations"
        )));
        assert!(should_skip_rate_limit(&request(
            Method::POST,
            "/api/video-gen/generations"
        )));
    }

    #[test]
    fn skips_rate_limit_for_generation_status_polling() {
        assert!(should_skip_rate_limit(&request(
            Method::GET,
            "/api/image-gen/generations/image-123"
        )));
        assert!(should_skip_rate_limit(&request(
            Method::GET,
            "/api/video-gen/generations/video-123"
        )));
    }

    #[test]
    fn skips_global_rate_limit_for_chunk_part_uploads() {
        assert!(should_skip_rate_limit(&request(
            Method::PUT,
            "/api/projects/p-1/uploads/s-1/parts/42"
        )));
    }

    #[test]
    fn does_not_skip_rate_limit_for_upload_control_endpoints() {
        // init / status / complete / abort 仍走通用额度
        assert!(!should_skip_rate_limit(&request(
            Method::POST,
            "/api/projects/p-1/uploads"
        )));
        assert!(!should_skip_rate_limit(&request(
            Method::GET,
            "/api/projects/p-1/uploads/s-1"
        )));
        assert!(!should_skip_rate_limit(&request(
            Method::POST,
            "/api/projects/p-1/uploads/s-1/complete"
        )));
        assert!(!should_skip_rate_limit(&request(
            Method::DELETE,
            "/api/projects/p-1/uploads/s-1"
        )));
        // 非分片路径不受分片豁免影响
        assert!(!should_skip_rate_limit(&request(
            Method::PUT,
            "/api/projects/p-1/uploads/s-1/parts"
        )));
    }
}
