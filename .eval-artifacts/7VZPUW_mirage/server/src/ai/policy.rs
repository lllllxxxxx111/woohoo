use serde::{Deserialize, Serialize};

/**
 * 助理动作策略配置（升级版）
 * 从简单的布尔开关升级为细粒度策略对象
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantActionPolicy {
    /**
     * 是否允许助理动作（总开关）
     */
    pub enabled: bool,

    /**
     * 允许的动作类型白名单
     * 空列表表示允许所有已知类型
     */
    pub allowed_action_types: Vec<String>,

    /**
     * 单次响应最大动作数量
     */
    pub max_actions_per_response: usize,

    /**
     * 项目作用域限制
     */
    pub project_scope: ActionProjectScope,

    /**
     * 策略过期时间（ISO 8601），空表示永不过期
     */
    pub expires_at: Option<String>,

    /**
     * 需要用户确认的动作类型
     * 这些动作不会自动执行，需要用户显式确认
     */
    pub require_confirmation_for: Vec<String>,
}

impl Default for AssistantActionPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            allowed_action_types: vec![],
            max_actions_per_response: 5,
            project_scope: ActionProjectScope::CurrentOnly,
            expires_at: None,
            require_confirmation_for: vec![
                "remove_project_agent".to_string(),
                "create_project_agent".to_string(),
                "delete_project_path".to_string(),
                "move_project_path".to_string(),
            ],
        }
    }
}

/**
 * 动作项目作用域
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionProjectScope {
    /**
     * 仅当前项目
     */
    CurrentOnly,

    /**
     * 当前项目 + 用户拥有的其他项目
     */
    UserProjects,

    /**
     * 所有可访问的项目（包括共享的）
     */
    AllAccessible,
}

/**
 * 确认令牌（一次性）
 * 用于防止重放攻击和越权确认
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationToken {
    pub token: String,
    pub user_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub envelope_hash: String,
    pub created_at: String,
    pub expires_at: String,
    pub consumed: bool,
    pub consumed_at: Option<String>,
    pub consumed_by: Option<String>,
}

/**
 * 确认令牌使用请求
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeConfirmationTokenReq {
    pub token: String,
    pub approved: bool,
    pub reason: Option<String>,
}

/**
 * 审计日志查询过滤器
 */
#[derive(Debug, Deserialize)]
pub struct AuditLogFilter {
    pub project_id: Option<String>,
    pub action_type: Option<String>,
    pub execution_status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub since: Option<String>,
    pub until: Option<String>,
}
