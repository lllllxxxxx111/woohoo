use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::env;

/**
 * 统一错误类型
 *
 * 安全设计原则：
 * - 用户可见的错误消息应该友好且不泄露系统细节
 * - 内部错误详细信息仅记录到服务器日志
 * - 生产环境隐藏所有技术细节
 */
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("认证失败: {0}")]
    Auth(String),

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("参数错误: {0}")]
    Validation(String),

    #[error("请求错误: {0}")]
    BadRequest(String),

    #[error("积分不足: {0}")]
    PaymentRequired(String),

    #[error("冲突: {0}")]
    Conflict(String),

    #[error("权限不足: {0}")]
    Forbidden(String),

    #[error("请求过于频繁: {0}")]
    TooManyRequests(String),

    #[error("服务暂不可用: {0}")]
    ServiceUnavailable(String),

    #[error("内部错误: {0}")]
    Internal(String),

    /**
     * 数据库错误 - 自动脱敏处理
     * 不向客户端暴露SQL细节，防止信息泄露
     */
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    /**
     * 通用错误 - 自动脱敏处理
     * 仅记录到日志，不向客户端展示详情
     */
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, user_message, log_level, error_code, retryable) = match &self {
            // 认证相关错误 - 返回具体原因但不含敏感信息
            AppError::Auth(msg) => (
                StatusCode::UNAUTHORIZED,
                msg.clone(),
                "warn",
                "AUTH_FAILED",
                false,
            ),

            // 资源未找到 - 返回友好的提示
            AppError::NotFound(msg) => (
                StatusCode::NOT_FOUND,
                msg.clone(),
                "info",
                "NOT_FOUND",
                false,
            ),

            // 参数验证错误 - 返回具体的验证信息帮助用户修正
            AppError::Validation(msg) => (
                StatusCode::BAD_REQUEST,
                msg.clone(),
                "info",
                "VALIDATION_ERROR",
                false,
            ),

            // 请求错误 - 业务逻辑层面的请求不合法
            AppError::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                msg.clone(),
                "info",
                "BAD_REQUEST",
                false,
            ),

            // 积分不足
            AppError::PaymentRequired(msg) => (
                StatusCode::PAYMENT_REQUIRED,
                msg.clone(),
                "warning",
                "INSUFFICIENT_CREDITS",
                false,
            ),

            // 冲突错误 - 返回冲突原因
            AppError::Conflict(msg) => {
                (StatusCode::CONFLICT, msg.clone(), "warn", "CONFLICT", false)
            }

            // 权限不足 - 返回通用权限提示
            AppError::Forbidden(msg) => (
                StatusCode::FORBIDDEN,
                msg.clone(),
                "warn",
                "FORBIDDEN",
                false,
            ),

            // 请求过载 - 提示客户端退避重试
            AppError::TooManyRequests(msg) => (
                StatusCode::TOO_MANY_REQUESTS,
                msg.clone(),
                "warn",
                "RATE_LIMITED",
                true,
            ),

            // 服务临时不可用 - 提示客户端稍后重试
            AppError::ServiceUnavailable(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                msg.clone(),
                "error",
                "SERVICE_UNAVAILABLE",
                true,
            ),

            // 内部错误 - 根据环境决定是否暴露详情
            AppError::Internal(msg) => {
                if is_production_env() {
                    // 生产环境：不暴露任何内部错误详情
                    tracing::error!("Internal error (details hidden): {}", msg);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "服务器内部错误，请稍后重试".to_string(),
                        "error",
                        "INTERNAL_ERROR",
                        false,
                    )
                } else {
                    // 开发环境：显示详细错误信息便于调试
                    tracing::error!("Internal error: {}", msg);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("内部错误: {}", msg),
                        "error",
                        "INTERNAL_ERROR_DEV",
                        false,
                    )
                }
            }

            // SQL数据库错误 - 完全脱敏
            AppError::Sqlx(e) => {
                /*
                 * 安全处理：
                 * 1. 记录完整的错误堆栈到日志（包含SQL语句和参数）
                 * 2. 向客户端返回通用的数据库错误消息
                 * 3. 不暴露表名、列名、SQL语句等敏感信息
                 */
                tracing::error!(
                    error = %e,
                    sql_error_details = ?e,
                    "Database operation failed"
                );

                classify_sqlx_error(e)
            }

            // 通用错误 - 完全脱敏
            AppError::Anyhow(e) => {
                /*
                 * 安全处理：
                 * 1. 记录完整错误到日志
                 * 2. 向客户端返回通用错误消息
                 */
                tracing::error!(
                    error = %e,
                    "Unhandled internal error"
                );

                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "服务暂时不可用，请稍后重试".to_string(),
                    "error",
                    "INTERNAL_ANYHOW",
                    false,
                )
            }
        };

        // 根据日志级别记录错误
        match log_level {
            "info" => {
                tracing::info!(%user_message, status = %status.as_u16(), "Request completed with info")
            }
            "warn" => {
                tracing::warn!(%user_message, status = %status.as_u16(), "Request completed with warning")
            }
            "error" => {} // 已经在上面详细记录了
            _ => tracing::debug!(%user_message, status = %status.as_u16()),
        }

        /*
         * 统一错误响应格式
         *
         * 响应结构：
         * {
         *   "success": false,
         *   "error": "用户可读的错误消息",
         *   "statusCode": 401/404/500等
         * }
         */
        let body = json!({
            "success": false,
            "error": user_message,
            "statusCode": status.as_u16(),
            "errorCode": error_code,
            "retryable": retryable
        });

        (status, Json(body)).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

fn is_production_env() -> bool {
    env::var("RUST_ENV")
        .map(|v| v.eq_ignore_ascii_case("production"))
        .unwrap_or(false)
}

fn classify_sqlx_error(
    error: &sqlx::Error,
) -> (StatusCode, String, &'static str, &'static str, bool) {
    if let sqlx::Error::Database(db_error) = error {
        let message = db_error.message().to_ascii_lowercase();

        if db_error.is_unique_violation() || message.contains("unique") {
            return (
                StatusCode::CONFLICT,
                "数据已存在，请检查后重试".to_string(),
                "warn",
                "DB_UNIQUE_CONFLICT",
                false,
            );
        }

        if db_error.is_foreign_key_violation() || message.contains("foreign key") {
            return (
                StatusCode::BAD_REQUEST,
                "引用的数据不存在或已被删除".to_string(),
                "warn",
                "DB_FOREIGN_KEY_INVALID",
                false,
            );
        }

        if message.contains("database is locked") || message.contains("database is busy") {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "数据库忙，请稍后重试".to_string(),
                "error",
                "DB_BUSY",
                true,
            );
        }
    }

    match error {
        sqlx::Error::PoolTimedOut => (
            StatusCode::SERVICE_UNAVAILABLE,
            "数据库连接池繁忙，请稍后重试".to_string(),
            "error",
            "DB_POOL_TIMEOUT",
            true,
        ),
        sqlx::Error::PoolClosed => (
            StatusCode::SERVICE_UNAVAILABLE,
            "数据库连接不可用，请稍后重试".to_string(),
            "error",
            "DB_POOL_CLOSED",
            true,
        ),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "数据操作失败，请稍后重试".to_string(),
            "error",
            "DB_INTERNAL_ERROR",
            false,
        ),
    }
}
