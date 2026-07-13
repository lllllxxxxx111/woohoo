use serde::{Deserialize, Serialize};

/**
 * 流程运行主表模型
 * 记录每次一键启动的完整生命周期
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRun {
    pub id: String,
    pub user_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub pipeline_type: String,
    pub trigger_source: String,
    pub status: String,
    pub idempotency_key: String,
    pub total_steps: i64,
    pub completed_steps: i64,
    pub failed_steps: i64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
    pub error_message: Option<String>,
    pub error_code: Option<String>,
}

/**
 * 创建流程运行的请求
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePipelineRunReq {
    pub project_id: String,
    pub conversation_id: String,
    #[serde(default = "default_pipeline_type")]
    pub pipeline_type: String,
    #[serde(default = "default_trigger_source")]
    pub trigger_source: String,
    #[serde(default = "default_beta_enabled")]
    pub beta_enabled: bool,
    pub idempotency_key: Option<String>,
    pub steps: Vec<CreatePipelineStepReq>,
}

fn default_pipeline_type() -> String {
    "one_click".to_string()
}

fn default_trigger_source() -> String {
    "manual".to_string()
}

fn default_beta_enabled() -> bool {
    false
}

/**
 * 创建流程步骤的请求
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePipelineStepReq {
    pub step_key: String,
    pub step_name: String,
    pub step_order: i64,
    #[serde(default = "default_step_type")]
    pub step_type: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub review_policy: Option<serde_json::Value>,
    #[serde(default)]
    pub max_retries: Option<i64>,
    pub prompt_template: Option<String>,
}

fn default_step_type() -> String {
    "design".to_string()
}

/**
 * 流程步骤模型
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunStep {
    pub id: String,
    pub run_id: String,
    pub step_key: String,
    pub step_name: String,
    pub step_order: i64,
    pub step_type: Option<String>,
    pub depends_on_json: Option<String>,
    pub review_policy_json: Option<String>,
    pub retry_of_step_id: Option<String>,
    pub run_version: Option<i64>,
    pub ai_task_id: Option<String>,
    pub status: String,
    pub attempt_count: i64,
    pub max_retries: i64,
    pub duration_ms: i64,
    pub input_summary: Option<String>,
    pub output_ref: Option<String>,
    pub error_message: Option<String>,
    pub last_error_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/**
 * Prompt 优化建议模型（Beta）
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelinePromptOptimization {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub decision: String,
    pub design_prompt_patch: Option<String>,
    pub review_prompt_patch: Option<String>,
    pub rationale_json: Option<String>,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

/**
 * 流程事件模型
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunEvent {
    pub id: String,
    pub run_id: String,
    pub step_id: Option<String>,
    pub event_type: String,
    pub payload_json: Option<String>,
    pub source: String,
    pub created_at: String,
}

/**
 * 助理动作审计日志模型
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStepOutput {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub task_id: Option<String>,
    pub output_type: String,
    pub output_json: Option<String>,
    pub raw_content: Option<String>,
    pub review_decision: Option<String>,
    pub review_score: Option<f64>,
    pub review_issues_json: Option<String>,
    pub retry_hints_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/**
 * 鍔╃悊鍔ㄤ綔瀹¤鏃ュ織妯″瀷
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AssistantActionAudit {
    pub id: String,
    pub run_id: Option<String>,
    pub user_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub action_type: String,
    pub action_payload: String,
    pub confirmation_token: Option<String>,
    pub confirmation_expires_at: Option<String>,
    pub execution_status: String,
    pub execution_result: Option<String>,
    pub error_message: Option<String>,
    pub confirmed_by: Option<String>,
    pub confirmed_at: Option<String>,
    pub executed_at: Option<String>,
    pub envelope_hash: String,
    pub created_at: String,
    pub updated_at: String,
}

/**
 * 流程控制动作请求
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineControlReq {
    pub reason: Option<String>,
    pub step_id: Option<String>, // 用于 retry-step 时指定步骤
}

/**
 * 流程运行聚合视图（用于API响应）
 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunSummary {
    pub run: PipelineRun,
    pub steps: Vec<PipelineRunStep>,
    pub recent_events: Vec<PipelineRunEvent>,
    pub outputs: Vec<PipelineStepOutput>,
}
