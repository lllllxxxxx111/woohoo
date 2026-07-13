use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 预算配置
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UserBudgetConfig {
    pub id: String,
    pub user_id: String,
    pub daily_credit_limit: Option<f64>,
    pub monthly_credit_limit: Option<f64>,
    pub warn_ratio: f64,
    pub is_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 预算状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub config: UserBudgetConfig,
    pub daily_usage: f64,           // 今日消耗积分
    pub monthly_usage: f64,         // 本月消耗积分
    pub daily_usage_ratio: f64,     // 今日使用率 0-1
    pub monthly_usage_ratio: f64,   // 本月使用率 0-1
    pub is_daily_warning: bool,     // 今日是否预警
    pub is_monthly_warning: bool,   // 本月是否预警
    pub is_daily_exceeded: bool,    // 今日是否超限
    pub is_monthly_exceeded: bool,  // 本月是否超限
    pub has_warning: bool,          // 是否有任意预警
    pub has_exceeded: bool,         // 是否有任意超限
}

/// 预算检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetCheckResult {
    pub allowed: bool,
    pub reason: Option<String>,
    pub daily_usage: f64,
    pub monthly_usage: f64,
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
}

/// 更新预算配置的输入
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBudgetConfigInput {
    pub daily_credit_limit: Option<f64>,
    pub monthly_credit_limit: Option<f64>,
    pub warn_ratio: Option<f64>,
    pub is_enabled: Option<bool>,
}

/// 预算拦截记录
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BudgetBlock {
    pub id: String,
    pub user_id: String,
    pub operation: String,
    pub reason: String,
    pub current_usage: f64,
    pub limit_value: f64,
    pub request_details: Option<String>,
    pub created_at: String,
}
