use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 预算周期类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetPeriod {
    Daily,
    Monthly,
}

impl BudgetPeriod {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Monthly => "monthly",
        }
    }
}

/// 用户预算设置
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UserBudgetSettings {
    pub id: String,
    pub user_id: String,
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub warning_threshold: f64,
    pub block_high_cost_over_budget: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 更新预算设置的请求体
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBudgetSettingsReq {
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
    #[serde(default = "default_warning_threshold")]
    pub warning_threshold: f64,
    #[serde(default = "default_block_high_cost")]
    pub block_high_cost_over_budget: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_warning_threshold() -> f64 {
    0.8
}
fn default_block_high_cost() -> bool {
    true
}
fn default_true() -> bool {
    true
}

/// 单个周期的预算状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPeriodStatus {
    pub period_type: String,
    pub period_key: String,
    pub limit: Option<f64>,
    pub spent: f64,
    pub usage_ratio: Option<f64>,
    pub is_warning: bool,
    pub is_over_budget: bool,
    pub remaining: Option<f64>,
}

/// 预算检查结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub settings: UserBudgetSettings,
    pub daily: BudgetPeriodStatus,
    pub monthly: BudgetPeriodStatus,
    pub can_proceed: bool,
    pub warning_message: Option<String>,
    pub block_reason: Option<String>,
}

/// 预算拦截事件
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BudgetBlockEvent {
    pub id: String,
    pub user_id: String,
    pub period_type: String,
    pub period_key: String,
    pub limit_amount: f64,
    pub current_spent: f64,
    pub estimated_cost: f64,
    pub blocked_operation: String,
    pub blocked_resource_kind: Option<String>,
    pub reason: String,
    pub model: Option<String>,
    pub endpoint_id: Option<String>,
    pub created_at: String,
}

/// 高成本任务预估结果
#[derive(Debug, Clone)]
pub struct EstimatedCost {
    pub credits: f64,
    pub resource_kind: String,
    pub is_high_cost: bool,
}
