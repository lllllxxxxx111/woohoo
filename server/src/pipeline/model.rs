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
 *
 * decision 取值：suggested（已生成待处理）/ applied（已应用为当前版本）/ rolled_back（已回滚）/ dismissed（已忽略）
 * version：0 表示未版本化的建议；>0 表示已被应用并分配的版本号（按 project_id+step_key 单调递增）
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
    // 026 迁移新增字段
    pub step_key: Option<String>,
    pub version: i64,
    pub strategy: String,
    pub operator_user_id: Option<String>,
    pub applied_at: Option<String>,
    pub applied_request_id: Option<String>,
    pub original_prompt: Option<String>,
    pub optimized_prompt: Option<String>,
    pub previous_version_id: Option<String>,
    pub rolled_back_at: Option<String>,
    pub rolled_back_by: Option<String>,
    pub rolled_back_reason: Option<String>,
    pub rollback_request_id: Option<String>,
}

/**
 * 应用优化建议请求
 * POST /api/pipelines/runs/{run_id}/optimizations/{optimization_id}/apply
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOptimizationReq {
    /// 应用范围：project（同项目同 step_key 后续 run 生效）/ run（仅当前 run）
    #[serde(default = "default_apply_scope")]
    pub scope: String,
}

fn default_apply_scope() -> String {
    "project".to_string()
}

/**
 * 回滚优化建议请求
 * POST /api/pipelines/runs/{run_id}/optimizations/{optimization_id}/rollback
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackOptimizationReq {
    pub reason: Option<String>,
}

/**
 * 自动应用优化开关配置
 */
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelinePromptAutoApplyConfig {
    pub id: String,
    pub user_id: String,
    pub project_id: String,
    pub step_key: Option<String>,
    pub enabled: bool,
    pub risk_acknowledged: bool,
    pub operator_user_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/**
 * 设置自动应用开关请求
 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAutoApplyConfigReq {
    pub enabled: bool,
    /// 启用前必须确认风险，前端需展示风险提示后再传 true
    #[serde(default)]
    pub risk_acknowledged: bool,
    /// 步骤级开关时传入 step_key；不传则视为项目级开关
    pub step_key: Option<String>,
}

/**
 * 版本差异视图
 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationVersionDiff {
    pub optimization_id: String,
    pub version: i64,
    pub step_key: Option<String>,
    pub original_prompt: Option<String>,
    pub optimized_prompt: Option<String>,
    pub design_prompt_patch: Option<String>,
    pub review_prompt_patch: Option<String>,
    pub rationale_json: Option<String>,
    pub operator_user_id: Option<String>,
    pub applied_at: Option<String>,
    pub previous_version_id: Option<String>,
}

/**
 * 效果对比指标分组
 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectMetricGroup {
    pub label: String,
    pub sample_count: i64,
    pub success_count: i64,
    pub failed_count: i64,
    pub avg_duration_ms: Option<f64>,
    pub avg_review_score: Option<f64>,
    pub manual_review_count: i64,
    pub total_tokens: Option<i64>,
}

/**
 * 效果对比响应
 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationEffectComparison {
    pub optimization_id: String,
    pub version: i64,
    pub step_key: Option<String>,
    pub applied_at: Option<String>,
    pub baseline: EffectMetricGroup,
    pub optimized: EffectMetricGroup,
    pub sample_sufficient: bool,
    pub note: String,
}

/**
 * 回滚建议
 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRecommendation {
    pub optimization_id: String,
    pub version: i64,
    pub step_key: Option<String>,
    pub recommend_rollback: bool,
    pub reasons: Vec<String>,
    pub recent_failure_count: i64,
    pub recent_manual_review_count: i64,
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
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelineManualReview {
    pub id: String,
    pub user_id: String,
    pub run_id: String,
    pub step_id: String,
    pub decision: String,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineReviewDecisionReq {
    pub decision: String,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewQueueFilter {
    #[serde(alias = "projectId")]
    pub project_id: Option<String>,
    pub status: Option<String>,
    #[serde(alias = "pipelineType")]
    pub pipeline_type: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueueItem {
    pub run: PipelineRun,
    pub step: PipelineRunStep,
    pub latest_event: Option<PipelineRunEvent>,
    pub latest_error_event: Option<PipelineRunEvent>,
    pub optimization_count: i64,
    pub review_count: i64,
    pub latest_review: Option<PipelineManualReview>,
    pub project_name: Option<String>,
    pub conversation_title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueueResponse {
    pub items: Vec<ReviewQueueItem>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunSummary {
    pub run: PipelineRun,
    pub steps: Vec<PipelineRunStep>,
    pub recent_events: Vec<PipelineRunEvent>,
    pub outputs: Vec<PipelineStepOutput>,
    pub reviews: Vec<PipelineManualReview>,
}
