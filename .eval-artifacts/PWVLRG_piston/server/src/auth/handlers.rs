use super::{jwt, model::*, repo};
use crate::{
    db,
    error::{AppError, AppResult},
    AppState,
};
use axum::{extract::State, http::StatusCode, Extension, Json};

/// POST /api/auth/register
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> AppResult<(StatusCode, Json<AuthResponse>)> {
    // 验证
    let username_trimmed = req.username.trim();
    if username_trimmed.is_empty() {
        return Err(AppError::Validation("用户名不能为空".into()));
    }
    if username_trimmed.len() < 2 || username_trimmed.len() > 50 {
        return Err(AppError::Validation("用户名长度应在2-50个字符之间".into()));
    }
    if !username_trimmed
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == ' ')
    {
        return Err(AppError::Validation(
            "用户名只能包含字母、数字、下划线、连字符和空格".into(),
        ));
    }

    let email_trimmed = req.email.trim();
    if email_trimmed.is_empty() {
        return Err(AppError::Validation("邮箱不能为空".into()));
    }
    if !email_trimmed.contains('@') || !email_trimmed.contains('.') {
        return Err(AppError::Validation("邮箱格式不正确".into()));
    }
    if email_trimmed.len() > 254 {
        return Err(AppError::Validation("邮箱长度不能超过254个字符".into()));
    }

    validate_password_strength(&req.password)?;

    // 创建用户
    let hash = bcrypt::hash(&req.password, state.config.password_hash_cost)
        .map_err(|e| AppError::Internal(format!("密码加密失败: {}", e)))?;
    let user = match repo::create_user(&state.db, &req.username, &req.email, &hash).await {
        Ok(user) => user,
        Err(AppError::Sqlx(sqlx::Error::Database(db_error))) => {
            if db_error.is_unique_violation() {
                let message = db_error.message().to_ascii_lowercase();
                if message.contains("users.email") || message.contains("email") {
                    return Err(AppError::Conflict("邮箱已注册".into()));
                }
                if message.contains("users.username") || message.contains("username") {
                    return Err(AppError::Conflict("用户名已存在".into()));
                }
                return Err(AppError::Conflict("用户已存在".into()));
            }

            return Err(AppError::Sqlx(sqlx::Error::Database(db_error)));
        }
        Err(error) => return Err(error),
    };
    db::ensure_default_agents_for_user(&state.db, &user.id).await?;
    let token = jwt::create_token(
        &user.id,
        &user.email,
        &state.config.jwt_secret,
        state.config.jwt_expire_hours,
    )
    .map_err(|e| {
        tracing::error!(error = %e, "JWT token 生成失败");
        AppError::Internal("Token 生成失败".into())
    })?;

    Ok((
        StatusCode::CREATED,
        Json(AuthResponse {
            token,
            user: user.into(),
        }),
    ))
}

/// POST /api/auth/login
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> AppResult<Json<AuthResponse>> {
    let user = repo::find_by_email(&state.db, &req.email)
        .await?
        .ok_or_else(|| AppError::Auth("邮箱或密码错误".into()))?;

    let valid = bcrypt::verify(&req.password, &user.password_hash)
        .map_err(|_| AppError::Internal("密码验证失败".into()))?;

    if !valid {
        return Err(AppError::Auth("邮箱或密码错误".into()));
    }

    db::ensure_default_agents_for_user(&state.db, &user.id).await?;

    let token = jwt::create_token(
        &user.id,
        &user.email,
        &state.config.jwt_secret,
        state.config.jwt_expire_hours,
    )
    .map_err(|e| {
        tracing::error!(error = %e, "JWT token 生成失败");
        AppError::Internal("Token 生成失败".into())
    })?;

    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

/// GET /api/auth/me
pub async fn me(
    State(state): State<AppState>,
    Extension(user_id): Extension<super::middleware::UserId>,
) -> AppResult<Json<UserProfile>> {
    let user = repo::find_by_id(&state.db, &user_id.0)
        .await?
        .ok_or_else(|| AppError::NotFound("用户不存在".into()))?;
    Ok(Json(user.into()))
}

/**
 * 验证密码强度
 *
 * 要求：
 * - 至少8个字符
 * - 包含至少一个字母
 * - 包含至少一个数字
 */
fn validate_password_strength(password: &str) -> AppResult<()> {
    if password.len() < 8 {
        return Err(AppError::Validation("密码至少8个字符".into()));
    }

    let has_letter = password.chars().any(|c| c.is_ascii_alphabetic());
    let has_digit = password.chars().any(|c| c.is_ascii_digit());

    if !has_letter {
        return Err(AppError::Validation("密码必须包含至少一个字母".into()));
    }

    if !has_digit {
        return Err(AppError::Validation("密码必须包含至少一个数字".into()));
    }

    Ok(())
}
