use super::model::User;
use crate::error::AppResult;
use sqlx::SqlitePool;
use uuid::Uuid;

/// 创建用户
pub async fn create_user(
    pool: &SqlitePool,
    username: &str,
    email: &str,
    password_hash: &str,
) -> AppResult<User> {
    let id = Uuid::new_v4().to_string();
    sqlx::query_as::<_, User>(
        "INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .bind(&id)
    .bind(username)
    .bind(email)
    .bind(password_hash)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

/// 根据 email 查找用户
pub async fn find_by_email(pool: &SqlitePool, email: &str) -> AppResult<Option<User>> {
    sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = ?")
        .bind(email)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// 根据 ID 查找用户
pub async fn find_by_id(pool: &SqlitePool, id: &str) -> AppResult<Option<User>> {
    sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}
