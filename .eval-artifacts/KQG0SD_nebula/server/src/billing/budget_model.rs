use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 超限后的策略
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetOverlimitAction {
    /// 拦截高成本任务（默认）
    Block,
    /// 仅警告，不拦截
    WarnOnly,
}

impl BudgetOverlimitAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::WarnOnly => "warn_only",
        }
    }

    pub fn from_str_loose(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "warn_only" | "warn" | "warn-only" => Self::WarnOnly,
            _ => Self::Block,
        }
    }
}

/// 预算窗口（日 / 月）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetWindow {
    Daily,
    Monthly,
}

impl BudgetWindow {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Monthly => "monthly",
        }
    }
}

/// 预算事件类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetEventKind {
    Warning,
    Blocked,
}

impl BudgetEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Warning => "warning",
            Self::Blocked => "blocked",
        }
    }
}

/// 用户预算配置（DB 行）
#[derive(Debug, Clone, FromRow)]
pub struct UserBudgetSettingsRow {
    pub id: String,
    pub user_id: String,
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub warning_threshold_pct: i64,
    pub overlimit_action: String,
    pub enabled: i64,
    pub last_warning_at: Option<String>,
    pub last_warning_kind: Option<String>,
    pub updated_at: String,
    pub created_at: String,
}

/// 用户预算配置（API 输出）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserBudgetSettings {
    pub id: String,
    pub user_id: String,
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub warning_threshold_pct: i64,
    pub overlimit_action: String,
    pub enabled: bool,
    pub last_warning_at: Option<String>,
    pub last_warning_kind: Option<String>,
    pub updated_at: String,
    pub created_at: String,
}

impl From<UserBudgetSettingsRow> for UserBudgetSettings {
    fn from(value: UserBudgetSettingsRow) -> Self {
        Self {
            id: value.id,
            user_id: value.user_id,
            daily_limit: value.daily_limit,
            monthly_limit: value.month_limit,
            warning_threshold_pct: value.warning_threshold_pct,
            overlimit_action: value.overlimit_action,
            enabled: value.enabled != 0,
            last_warning_at: value.last_warning_at,
            last_warning_kind: value.last_warning_kind,
            updated_at: value.updated_at,
            created_at: value.created_at,
        }
    }
}

/// 设置预算的请求体
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertBudgetSettingsReq {
    pub daily_limit: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub warning_threshold_pct: Option<i64>,
    pub overlimit_action: Option<String>,
    pub enabled: Option<bool>,
}

/// 预算事件（DB 行）
#[derive(Debug, Clone, FromRow)]
pub struct BudgetEventRow {
    pub id: String,
    pub user_id: String,
    pub kind: String,
    pub window: String,
    pub spent_amount: f64,
    pub limit_amount: Option<f64>,
    pub estimated_cost: Option<f64>,
    pub resource_kind: Option<String>,
    pub reason: Option<String>,
    pub ref_type: Option<String>,
    pub ref_id: Option<String>,
    pub created_at: String,
}

/// 预算事件（API 输出）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetEvent {
    pub id: String,
    pub user_id: String,
    pub kind: String,
    pub window: String,
    pub spent_amount: f64,
    pub limit_amount: Option<f64>,
    pub estimated_cost: Option<f64>,
    pub resource_kind: Option<String>,
    pub reason: Option<String>,
    pub ref_type: Option<String>,
    pub ref_id: Option<String>,
    pub created_at: String,
}

impl From<BudgetEventRow> for BudgetEvent {
    fn from(value: BudgetEventRow) -> Self {
        Self {
            id: value.id,
            user_id: value.user_id,
            kind: value.kind,
            window: value.window,
            spent_amount: value.spent_amount,
            limit_amount: value.limit_amount,
            estimated_cost: value.estimated_cost,
            resource_kind: value.resource_kind,
            reason: value.reason,
            ref_type: value.ref_type,
            ref_id: value.ref_id,
            created_at: value.created_at,
        }
    }
}

/// 预算快照：当前用量、阈值、状态判断
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSnapshot {
    pub settings: UserBudgetSettings,
    pub daily_spent: f64,
    pub monthly_spent: f64,
    pub daily_used_pct: Option<f64>,
    pub monthly_used_pct: Option<f64>,
    pub daily_remaining: Option<f64>,
    pub monthly_remaining: Option<f64>,
    /// 当前是否已超出日/月预算（即便策略是仅警告，这里仍会标记）
    pub daily_exceeded: bool,
    pub monthly_exceeded: bool,
    /// 当前是否已达到警告阈值（但未超限）
    pub daily_warning: bool,
    pub monthly_warning: bool,
}

/// 预算闸门检查结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "decision")]
pub enum BudgetGateDecision {
    /// 允许通过
    Allow,
    /// 警告：已达阈值但策略允许继续
    Warn {
        window: String,
        spent_amount: f64,
        limit_amount: f64,
        used_pct: f64,
        message: String,
    },
    /// 拦截：超过预算
    Block {
        window: String,
        spent_amount: f64,
        limit_amount: f64,
        estimated_cost: Option<f64>,
        used_pct: f64,
        message: String,
    },
}

impl BudgetGateDecision {
    pub fn is_blocked(&self) -> bool {
        matches!(self, BudgetGateDecision::Block { .. })
    }
}
