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
 * - 自动清理过期记录防止内存泄漏
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

        // 获取或创建该IP的请求记录
        let request_times = requests.entry(client_ip.to_string()).or_default();

        // 清理过期的请求记录（防止内存泄漏）
        request_times.retain(|&time| time > window_start);

        // 检查是否超过限制
        if request_times.len() >= self.max_requests {
            false // 超过限制，拒绝请求
        } else {
            // 记录本次请求时间
            request_times.push(now);
            true // 允许请求
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
 * 1. x-forwarded-for 头（反向代理场景）
 * 2. x-real-ip 头（Nginx 等代理场景）
 * 3. Axum 连接信息中的远程地址（直连场景）
 * 4. 兜底使用 "unknown" 并附带唯一标识避免合并限速
 */
fn extract_client_ip(request: &Request) -> String {
    if let Some(forwarded) = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(first_ip) = forwarded.split(',').next() {
            let trimmed = first_ip.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
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

    if let Some(addr) = request.extensions().get::<SocketAddr>() {
        return addr.ip().to_string();
    }

    if let Some(connect_info) = request
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
    {
        return connect_info.0.ip().to_string();
    }

    "unknown".to_string()
}

fn should_skip_rate_limit(request: &Request) -> bool {
    request.method() == Method::OPTIONS
        || request.uri().path() == "/health"
        || (request.method() == Method::GET
            && matches!(
                request.uri().path(),
                "/api/auth/me"
                    | "/api/workspace/bootstrap"
                    | "/api/ai/endpoints"
                    | "/api/notifications/channels"
                    | "/api/image-gen/generations"
                    | "/api/billing/credits"
                    | "/api/billing/transactions"
            ))
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

    // 检查是否允许请求
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
