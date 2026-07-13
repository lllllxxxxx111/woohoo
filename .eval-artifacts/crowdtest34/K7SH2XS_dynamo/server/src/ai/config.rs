use serde::{Deserialize, Serialize};

/// AI 端点配置实体
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpoint {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub provider: String, // openai, claude, deepseek, ollama, custom
    pub base_url: String,
    #[serde(skip_serializing)]
    pub api_key: String,
    pub default_model: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointCapability {
    pub id: String,
    pub endpoint_id: String,
    pub capability: String,
    pub model: Option<String>,
    pub path_override: Option<String>,
    pub request_adapter: String,
    pub response_adapter: String,
    pub supports_stream: bool,
    pub supports_tools: bool,
    pub supports_files: bool,
    pub enabled: bool,
    pub priority: i64,
    pub config_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointCapabilityView {
    pub id: String,
    pub endpoint_id: String,
    pub capability: String,
    pub model: Option<String>,
    pub path_override: Option<String>,
    pub request_adapter: String,
    pub response_adapter: String,
    pub supports_stream: bool,
    pub supports_tools: bool,
    pub supports_files: bool,
    pub enabled: bool,
    pub priority: i64,
    pub config_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<AiEndpointCapability> for AiEndpointCapabilityView {
    fn from(capability: AiEndpointCapability) -> Self {
        Self {
            id: capability.id,
            endpoint_id: capability.endpoint_id,
            capability: capability.capability,
            model: capability.model,
            path_override: capability.path_override,
            request_adapter: capability.request_adapter,
            response_adapter: capability.response_adapter,
            supports_stream: capability.supports_stream,
            supports_tools: capability.supports_tools,
            supports_files: capability.supports_files,
            enabled: capability.enabled,
            priority: capability.priority,
            config_json: capability.config_json,
            created_at: capability.created_at,
            updated_at: capability.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointView {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub default_model: Option<String>,
    pub is_active: bool,
    pub has_api_key: bool,
    pub created_at: String,
    pub updated_at: String,
    pub capabilities: Vec<AiEndpointCapabilityView>,
}

impl From<AiEndpoint> for AiEndpointView {
    fn from(endpoint: AiEndpoint) -> Self {
        Self {
            id: endpoint.id,
            user_id: endpoint.user_id,
            name: endpoint.name,
            provider: endpoint.provider,
            base_url: endpoint.base_url,
            default_model: endpoint.default_model,
            is_active: endpoint.is_active,
            has_api_key: !endpoint.api_key.trim().is_empty(),
            created_at: endpoint.created_at,
            updated_at: endpoint.updated_at,
            capabilities: Vec::new(),
        }
    }
}

/// 智能体实体（对应前端 AgentContact）
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub role: String,
    pub description: String,
    pub system_prompt: String,
    pub endpoint_id: Option<String>,
    pub model: Option<String>,
    pub temperature: f64,
    pub max_tokens: i64,
    pub badge: String,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy)]
pub struct DefaultAgentSeed {
    pub legacy_id: &'static str,
    pub name: &'static str,
    pub role: &'static str,
    pub description: &'static str,
    pub system_prompt: &'static str,
    pub temperature: f64,
    pub max_tokens: i64,
    pub badge: &'static str,
}

pub const DEFAULT_AGENT_SEEDS: [DefaultAgentSeed; 6] = [
    DefaultAgentSeed {
        legacy_id: "agent-outline",
        name: "大纲架构师",
        role: "剧情大纲",
        description: "负责短剧的大纲与结构设计，输出钩子、冲突升级与集数拆分。",
        system_prompt:
            "你负责短剧的大纲与结构设计。回答时优先给出剧情钩子、冲突升级、人物目标和集数拆分。",
        temperature: 0.7,
        max_tokens: 4096,
        badge: "资深",
    },
    DefaultAgentSeed {
        legacy_id: "agent-character",
        name: "人设生成专家",
        role: "人物设定",
        description: "负责生成角色设定、人物标签、关系张力与反差。",
        system_prompt: "你负责角色设定。回答时优先生成人物标签、关系张力、外形辨识度和人设反差。",
        temperature: 0.7,
        max_tokens: 4096,
        badge: "设定",
    },
    DefaultAgentSeed {
        legacy_id: "agent-storyboard",
        name: "分镜渲染师",
        role: "视觉分镜",
        description: "负责镜头语言、动作节奏、景别与画面调度建议。",
        system_prompt: "你负责分镜和画面表达。回答时优先给镜头语言、景别、动作节奏和画面调度建议。",
        temperature: 0.6,
        max_tokens: 4096,
        badge: "视觉",
    },
    DefaultAgentSeed {
        legacy_id: "agent-review",
        name: "合规审核官",
        role: "风控审核",
        description: "负责内容风险审视、敏感表达替换与合规建议。",
        system_prompt: "你负责内容风险审视。回答时优先指出潜在违规点、敏感表达和可替换说法。",
        temperature: 0.2,
        max_tokens: 4096,
        badge: "审核",
    },
    DefaultAgentSeed {
        legacy_id: "agent-chief-editor",
        name: "主编统筹官",
        role: "主编统筹",
        description: "负责剧情方向把关、节奏统筹、选题取舍与最终文字口径。",
        system_prompt:
            "你负责项目的主编统筹。回答时优先给出结构取舍、节奏优化、内容统一和交付优先级。",
        temperature: 0.4,
        max_tokens: 4096,
        badge: "主编",
    },
    DefaultAgentSeed {
        legacy_id: "agent-project-manager",
        name: "项目管理官",
        role: "项目管理",
        description: "负责拆解任务、推进节点、协调成员与跟踪风险。",
        system_prompt: "你负责项目管理。回答时优先给出任务拆解、责任划分、节点风险和推进建议。",
        temperature: 0.3,
        max_tokens: 4096,
        badge: "管理",
    },
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentReq {
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub endpoint_id: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub badge: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentReq {
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub endpoint_id: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub badge: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignProjectAgentReq {
    pub agent_id: String,
    pub responsibility_kind: Option<String>,
    pub responsibility_label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectAgentReq {
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub endpoint_id: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub badge: Option<String>,
    pub responsibility_kind: Option<String>,
    pub responsibility_label: Option<String>,
}

/// 创建 AI 端点请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEndpointReq {
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub default_model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEndpointReq {
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub default_model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertEndpointCapabilityReq {
    pub capability: String,
    pub model: Option<String>,
    pub path_override: Option<String>,
    pub request_adapter: Option<String>,
    pub response_adapter: Option<String>,
    pub supports_stream: Option<bool>,
    pub supports_tools: Option<bool>,
    pub supports_files: Option<bool>,
    pub enabled: Option<bool>,
    pub priority: Option<i64>,
    pub config_json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestReq {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub force_stream_fallback: Option<bool>,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub max_tokens: Option<i64>,
    pub content: Option<String>,
    pub output_kind: Option<String>,
    pub output_items: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointTestReq {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub force_stream_fallback: Option<bool>,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub max_tokens: Option<i64>,
    pub content: Option<String>,
    pub output_kind: Option<String>,
    pub output_items: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointModelsReq {
    pub endpoint_id: Option<String>,
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointModelsResp {
    pub models: Vec<String>,
}

/// AI 聊天请求（服务器端调用）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatReq {
    pub conversation_id: String,
    pub content: String,
    pub resource_refs: Option<Vec<ResourceRef>>,
    pub agent_id: Option<String>,    // @某个智能体
    pub endpoint_id: Option<String>, // 指定端点（可选）
    pub model: Option<String>,       // 指定模型（可选）
    pub force_stream_fallback: Option<bool>,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub max_tokens: Option<i64>,
    pub output_kind: Option<String>,
    pub output_items: Option<i64>,
    #[serde(default)]
    pub allow_assistant_actions: bool,
    pub confirmed_message_id: Option<String>,
    pub confirmed_workflow_guard_message_id: Option<String>,
    /**
     * 触发来源：用于区分正常发送、编辑后发送、撤回后重新发送
     * - None 或 "normal": 正常发送（默认）
     * - "edit": 编辑消息后发送
     * - "rewind": 撤回消息后重新发送
     */
    #[serde(default)]
    pub trigger_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub resource_type: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub version_label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum AgentRuntimeState {
    #[default]
    Idle,
    Queued,
    Busy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiTaskStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTask {
    pub id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub user_message_id: Option<String>,
    pub assistant_message_id: Option<String>,
    pub agent_id: Option<String>,
    pub content: String,
    pub endpoint_id: Option<String>,
    pub model: Option<String>,
    pub output_kind: Option<String>,
    pub output_items: Option<i64>,
    pub status: AiTaskStatus,
    pub result: Option<String>,
    pub error: Option<String>,
    pub attempt_index: i64,
    pub previous_attempts: i64,
    pub previous_failures: i64,
    pub previous_successes: i64,
    pub is_redo: bool,
    pub last_error: Option<String>,
    pub agent_status: AgentRuntimeState,
    pub active_tasks: i64,
    pub queued_tasks: i64,
    /// Whether routing fell back to a different endpoint than requested
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_was_fallback: Option<bool>,
    /// Number of endpoints attempted before success
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_attempt_count: Option<i64>,
    /// Human-readable fallback reason (sanitized)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_fallback_reason: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskEvent {
    pub event_type: String,
    pub task: AiTask,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_delta: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskFilter {
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub limit: Option<usize>,
}

/// Agent 统计信息（对应前端 AgentContact.workCount, passRate）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContact {
    pub id: String,
    pub name: String,
    pub role: String,
    pub work_count: i64,
    pub pass_rate: f64,
    pub badge: String,
    pub system_prompt: String,
    pub description: String,
    pub endpoint_id: Option<String>,
    pub model: Option<String>,
    pub temperature: f64,
    pub max_tokens: i64,
    pub status: AgentRuntimeState,
    pub active_tasks: i64,
    pub queued_tasks: i64,
    pub project_id: Option<String>,
    pub assignment_id: Option<String>,
    pub responsibility_kind: Option<String>,
    pub responsibility_label: Option<String>,
    pub assignment_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoleCounts {
    pub design: i64,
    pub review: i64,
    pub editor: i64,
    pub manager: i64,
    pub custom: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkflowSummary {
    pub status: String,
    pub phase: String,
    pub progress_percent: i64,
    pub asset_count: i64,
    pub script_ready: bool,
    pub storyboard_ready: bool,
    pub storyboard_line_count: i64,
    pub conversation_count: i64,
    pub message_count: i64,
    pub assigned_agent_count: i64,
    pub queued_task_count: i64,
    pub running_task_count: i64,
    pub completed_task_count: i64,
    pub failed_task_count: i64,
    pub role_counts: ProjectRoleCounts,
}

impl Default for ProjectWorkflowSummary {
    fn default() -> Self {
        Self {
            status: "draft".to_string(),
            phase: "ideation".to_string(),
            progress_percent: 0,
            asset_count: 0,
            script_ready: false,
            storyboard_ready: false,
            storyboard_line_count: 0,
            conversation_count: 0,
            message_count: 0,
            assigned_agent_count: 0,
            queued_task_count: 0,
            running_task_count: 0,
            completed_task_count: 0,
            failed_task_count: 0,
            role_counts: ProjectRoleCounts::default(),
        }
    }
}
