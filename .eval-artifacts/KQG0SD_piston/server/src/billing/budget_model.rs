use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 预算窗口类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetWindow {
    Daily,
    Monthly,
}

impl BudgetWindow {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Monthly => "monthly",
        }
    }
}

/// 预算检查结果级别
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetCheckLevel {
    /// 允许执行
    Ok,
    /// 接近阈值，给出警告但允许执行
    Warning,
    /// 超限，拦截高成本任务
    Blocked,
}

/// 预算设置
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSettings {
    pub id: String,
    pub user_id: String,
    pub daily_limit: f64,
    pub monthly_limit: f64,
    pub warn_threshold: f64,
    pub block_high_cost_only: bool,
    pub high_cost_threshold: f64,
    pub enabled: bool,
    pub updated_at: String,
    pub created_at: String,
}

/// 更新预算设置的请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBudgetSettingsReq {
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub warn_threshold: Option<f64>,
    pub block_high_cost_only: Option<bool>,
    pub high_cost_threshold: Option<f64>,
    pub enabled: Option<bool>,
}

/// 单个窗口的预算状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetWindowStatus {
    pub window: String,
    pub limit: f64,
    pub spent: f64,
    pub remaining: f64,
    pub usage_ratio: f64,
    pub has_limit: bool,
}

/// 预算拦截事件记录
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BudgetBlockEvent {
    pub id: String,
    pub user_id: String,
    pub window_type: String,
    pub limit_amount: f64,
    pub current_spent: f64,
    pub estimated_cost: f64,
    pub task_type: String,
    pub reason: String,
    pub model: Option<String>,
    pub project_id: Option<String>,
    pub created_at: String,
}

/// 预算状态汇总（设置 + 当前窗口用量 + 预警级别）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub settings: BudgetSettings,
    pub daily: BudgetWindowStatus,
    pub monthly: BudgetWindowStatus,
    pub level: BudgetCheckLevel,
    pub warnings: Vec<String>,
    /// 最近拦截事件（最多10条）
    pub recent_blocks: Vec<BudgetBlockEvent>,
}

/// 预算检查结果（在请求处理前返回）
#[derive(Debug, Clone)]
pub struct BudgetCheckResult {
    pub level: BudgetCheckLevel,
    pub window: Option<BudgetWindow>,
    pub message: Option<String>,
    pub estimated_cost: f64,
    pub daily_spent: f64,
    pub monthly_spent: f64,
}
