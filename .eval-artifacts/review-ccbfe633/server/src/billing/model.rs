use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 积分流水类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreditTransactionKind {
    Earned,
    Spent,
    Refund,
}

impl CreditTransactionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Earned => "earned",
            Self::Spent => "spent",
            Self::Refund => "refund",
        }
    }
}

/// 用户积分余额
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UserCredits {
    pub id: String,
    pub user_id: String,
    pub balance: f64,
    pub total_earned: f64,
    pub total_spent: f64,
    pub created_at: String,
}

/// 积分流水记录
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CreditTransaction {
    pub id: String,
    pub user_id: String,
    pub amount: f64,
    pub balance_after: f64,
    pub kind: String,
    pub reason: Option<String>,
    pub ref_type: Option<String>,
    pub ref_id: Option<String>,
    pub created_at: String,
}
