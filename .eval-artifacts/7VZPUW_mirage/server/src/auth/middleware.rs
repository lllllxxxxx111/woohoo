use super::jwt;
use crate::AppState;
use axum::{
    extract::{Request, State},
    http::{self, StatusCode},
    middleware::Next,
    response::Response,
};

/// 从请求头提取并验证 JWT，将 user_id 注入到 request extensions
pub async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let claims =
        jwt::verify_token(token, &state.config.jwt_secret).map_err(|_| StatusCode::UNAUTHORIZED)?;

    let user_id = claims.sub;
    let user_exists = sqlx::query_scalar::<_, i64>("SELECT 1 FROM users WHERE id = ? LIMIT 1")
        .bind(&user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|error| {
            tracing::error!(
                error = %error,
                user_id = %user_id,
                "认证中间件校验用户存在性失败"
            );
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .is_some();

    if !user_exists {
        tracing::warn!(user_id = %user_id, "JWT 对应用户不存在，拒绝请求");
        return Err(StatusCode::UNAUTHORIZED);
    }

    // 将 user_id 注入 request extensions，后续 handler 可以用 req.extensions().get::<UserId>()
    req.extensions_mut().insert(UserId(user_id));
    Ok(next.run(req).await)
}

/// 已认证用户的 ID，通过 request extensions 传递
#[derive(Debug, Clone)]
pub struct UserId(pub String);
