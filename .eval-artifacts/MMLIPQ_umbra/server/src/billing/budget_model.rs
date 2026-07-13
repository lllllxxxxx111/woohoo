use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetWindowType {
    Daily,
    Monthly,
}

impl BudgetWindowType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Monthly => "monthly",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetCheckLevel {
    Ok,
    Warning,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSettings {
    pub id: String,
    pub user_id: String,
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub warning_threshold: f64,
    pub block_high_cost_only: bool,
    pub high_cost_threshold: f64,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBudgetSettingsInput {
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub warning_threshold: f64,
    pub block_high_cost_only: bool,
    pub high_cost_threshold: f64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetWindowStatus {
    pub window_type: BudgetWindowType,
    pub limit: Option<f64>,
    pub spent: f64,
    pub remaining: Option<f64>,
    pub percent_used: Option<f64>,
    pub warning: bool,
    pub blocked: bool,
    pub window_start: String,
    pub window_end: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BudgetBlockEvent {
    pub id: String,
    pub user_id: String,
    pub window_type: String,
    pub limit_amount: f64,
    pub spent_amount: f64,
    pub estimated_cost: f64,
    pub task_type: String,
    pub reason: String,
    pub model: Option<String>,
    pub project_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub settings: BudgetSettings,
    pub daily: BudgetWindowStatus,
    pub monthly: BudgetWindowStatus,
    pub overall_level: BudgetCheckLevel,
    pub warnings: Vec<String>,
    pub recent_blocks: Vec<BudgetBlockEvent>,
}

#[derive(Debug, Clone)]
pub struct BudgetCheckResult {
    pub level: BudgetCheckLevel,
    pub message: Option<String>,
    pub window_type: Option<BudgetWindowType>,
    pub limit: Option<f64>,
    pub spent: f64,
    pub estimated_cost: f64,
}

#[derive(Debug, Clone)]
pub struct BudgetBlockInput<'a> {
    pub window_type: BudgetWindowType,
    pub limit: f64,
    pub spent: f64,
    pub estimated_cost: f64,
    pub task_type: &'a str,
    pub reason: &'a str,
    pub model: Option<&'a str>,
    pub project_id: Option<&'a str>,
}
