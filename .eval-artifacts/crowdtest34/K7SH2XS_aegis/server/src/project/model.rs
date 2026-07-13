use serde::{Deserialize, Serialize};

/// 项目实体（对应前端 Project）
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Project {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub description: String,
    pub status: String, // draft, active, archived
    pub phase: String,  // ideation, script, storyboard, shooting, post, publish
    pub created_at: String,
    pub updated_at: String,
}

/// 创建项目请求
#[derive(Debug, Deserialize)]
pub struct CreateProjectReq {
    pub name: String,
    pub description: Option<String>,
}

/// 更新项目请求
#[derive(Debug, Deserialize)]
pub struct UpdateProjectReq {
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub phase: Option<String>,
}
