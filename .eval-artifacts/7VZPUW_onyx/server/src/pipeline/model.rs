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
 * 人工复核记录
 * 每次用户在失败/阻塞步骤上做出判断都会落一行，便于审计与聚合。
 *
 * 为什么不直接复用 pipeline_run_events？
 *   - events 是“系统发生了什么”的低结构事件流，按事件类型枚举；
 *     复核是“谁做了什么判断”的业务对象，按 decision/reviewer 维度聚合更自然；
 *   - 单独建表可以给 decision 加 CHECK 约束，避免脏数据；
 *   - 同时仍会写一条对应的 pipeline_run_event（manual_review），保持审计完整。
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelineManualReview {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub reviewer_id: String,
    /// retry / cancel / acknowledge
    pub decision: String,
    pub note: Option<String>,
    pub created_at: String,
}

/// 支持的人工复核决策集合
///
/// - retry: 触发步骤级重试，复用 retry-step 语义。
/// - cancel: 终止整个 run，将其推入 cancelled 终态，避免 UI 显示 running 但不可推进。
/// - acknowledge: 仅记录“已知晓”，不改变 run/step 状态，用于事后留痕。
///
/// 故意不提供 skip：当前 pipeline 状态机中 skipped 仅由 orchestrator 在“依赖失败”时自动产生，
/// 人工跳过会破坏依赖图完整性，避免制造伪功能。
pub const MANUAL_REVIEW_DECISIONS: &[&str] = &["retry", "cancel", "acknowledge"];

/**
 * 复核队列查询参数
 *
 * 聚合当前用户下 failed/blocked 或携带 prompt optimization 的步骤，供工作台展示。
 */
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PipelineReviewQueueFilter {
    #[serde(alias = "projectId")]
    pub project_id: Option<String>,
    /// 任意 PipelineRunStatus 字符串。留空则默认聚合 active 流程下的待处理步骤。
    pub status: Option<String>,
    #[serde(alias = "pipelineType")]
    pub pipeline_type: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/**
 * 复核队列条目 —— 把 run、step、最近事件、优化建议数量聚合到一起，
 * 避免前端多次往返请求才能渲染一行。
 */
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelineReviewQueueItem {
    pub run_id: String,
    pub run_status: String,
    pub pipeline_type: String,
    pub project_id: String,
    pub conversation_id: String,
    pub run_created_at: String,
    pub run_updated_at: String,
    pub step_id: String,
    pub step_key: String,
    pub step_name: String,
    pub step_order: i64,
    pub step_status: String,
    pub step_attempt_count: i64,
    pub step_error_message: Option<String>,
    pub step_last_error_at: Option<String>,
    pub step_updated_at: String,
    pub last_event_id: Option<String>,
    pub last_event_type: Option<String>,
    pub last_event_payload: Option<String>,
    pub last_event_created_at: Option<String>,
    pub optimization_count: i64,
}

/**
 * 步骤级复核动作请求体
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineReviewDecisionReq {
    /// 必须是 MANUAL_REVIEW_DECISIONS 中的值
    pub decision: String,
    pub note: Option<String>,
}

/**
 * 复核动作响应：返回最新 run 状态、被重试的步骤、刚创建的 review 记录
 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineReviewDecisionResp {
    pub review: PipelineManualReview,
    pub run: PipelineRun,
    pub step: PipelineRunStep,
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
