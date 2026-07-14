use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 协同会话合法状态枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Discovery,
    Delegating,
    ResolvingQuestions,
    WorkspaceAdmission,
    WorkspaceExecution,
    Completed,
    Halted,
}

impl SessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionState::Discovery => "discovery",
            SessionState::Delegating => "delegating",
            SessionState::ResolvingQuestions => "resolving_questions",
            SessionState::WorkspaceAdmission => "workspace_admission",
            SessionState::WorkspaceExecution => "workspace_execution",
            SessionState::Completed => "completed",
            SessionState::Halted => "halted",
        }
    }

    /// 校验状态迁移是否合法
    ///
    /// halted 是人工暂停状态，resume/restart 操作可将其迁移回任意非终态工作状态
    /// （人工恢复特权，需配合审计记录）。restart 回到 discovery 重新发现；
    /// resume 回到 delegating/resolving_questions/workspace_admission/workspace_execution
    /// 继续 halted 前的工作阶段。
    pub fn can_transition_to(&self, target: &SessionState) -> bool {
        matches!(
            (self, target),
            (SessionState::Discovery, SessionState::Delegating)
                | (SessionState::Discovery, SessionState::Halted)
                | (SessionState::Delegating, SessionState::ResolvingQuestions)
                | (SessionState::Delegating, SessionState::Halted)
                | (
                    SessionState::ResolvingQuestions,
                    SessionState::ResolvingQuestions
                )
                | (
                    SessionState::ResolvingQuestions,
                    SessionState::WorkspaceAdmission
                )
                | (SessionState::ResolvingQuestions, SessionState::Halted)
                | (
                    SessionState::WorkspaceAdmission,
                    SessionState::WorkspaceExecution
                )
                | (SessionState::WorkspaceAdmission, SessionState::Halted)
                | (SessionState::WorkspaceExecution, SessionState::Completed)
                | (SessionState::WorkspaceExecution, SessionState::Halted)
                | (SessionState::Halted, SessionState::Discovery)
                | (SessionState::Halted, SessionState::Delegating)
                | (SessionState::Halted, SessionState::ResolvingQuestions)
                | (SessionState::Halted, SessionState::WorkspaceAdmission)
                | (SessionState::Halted, SessionState::WorkspaceExecution)
        )
    }
}

impl TryFrom<&str> for SessionState {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "discovery" => Ok(SessionState::Discovery),
            "delegating" => Ok(SessionState::Delegating),
            "resolving_questions" => Ok(SessionState::ResolvingQuestions),
            "workspace_admission" => Ok(SessionState::WorkspaceAdmission),
            "workspace_execution" => Ok(SessionState::WorkspaceExecution),
            "completed" => Ok(SessionState::Completed),
            "halted" => Ok(SessionState::Halted),
            other => Err(format!("unknown session state: {}", other)),
        }
    }
}

/// 任务卡合法状态枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentStatus {
    Idle,
    Assigned,
    Questioning,
    Ready,
    Running,
    Blocked,
    Done,
    Failed,
}

impl AssignmentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssignmentStatus::Idle => "idle",
            AssignmentStatus::Assigned => "assigned",
            AssignmentStatus::Questioning => "questioning",
            AssignmentStatus::Ready => "ready",
            AssignmentStatus::Running => "running",
            AssignmentStatus::Blocked => "blocked",
            AssignmentStatus::Done => "done",
            AssignmentStatus::Failed => "failed",
        }
    }

    /// 校验状态迁移是否合法
    pub fn can_transition_to(&self, target: &AssignmentStatus) -> bool {
        matches!(
            (self, target),
            (AssignmentStatus::Idle, AssignmentStatus::Assigned)
                | (AssignmentStatus::Assigned, AssignmentStatus::Questioning)
                | (AssignmentStatus::Assigned, AssignmentStatus::Ready)
                | (AssignmentStatus::Assigned, AssignmentStatus::Running)
                | (AssignmentStatus::Assigned, AssignmentStatus::Failed)
                | (AssignmentStatus::Questioning, AssignmentStatus::Blocked)
                | (AssignmentStatus::Questioning, AssignmentStatus::Ready)
                | (AssignmentStatus::Ready, AssignmentStatus::Running)
                | (AssignmentStatus::Blocked, AssignmentStatus::Ready)
                | (AssignmentStatus::Running, AssignmentStatus::Done)
                | (AssignmentStatus::Running, AssignmentStatus::Failed)
        )
    }
}

impl TryFrom<&str> for AssignmentStatus {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "idle" => Ok(AssignmentStatus::Idle),
            "assigned" => Ok(AssignmentStatus::Assigned),
            "questioning" => Ok(AssignmentStatus::Questioning),
            "ready" => Ok(AssignmentStatus::Ready),
            "running" => Ok(AssignmentStatus::Running),
            "blocked" => Ok(AssignmentStatus::Blocked),
            "done" => Ok(AssignmentStatus::Done),
            "failed" => Ok(AssignmentStatus::Failed),
            other => Err(format!("unknown assignment status: {}", other)),
        }
    }
}

/// 协同消息类型枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Assign,
    Question,
    Answer,
    Status,
    Escalation,
}

impl MessageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MessageKind::Assign => "assign",
            MessageKind::Question => "question",
            MessageKind::Answer => "answer",
            MessageKind::Status => "status",
            MessageKind::Escalation => "escalation",
        }
    }
}

impl TryFrom<&str> for MessageKind {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "assign" => Ok(MessageKind::Assign),
            "question" => Ok(MessageKind::Question),
            "answer" => Ok(MessageKind::Answer),
            "status" => Ok(MessageKind::Status),
            "escalation" => Ok(MessageKind::Escalation),
            other => Err(format!("unknown message kind: {}", other)),
        }
    }
}

/// 协同会话数据库模型
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSession {
    pub id: String,
    pub user_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub entry_message_id: Option<String>,
    pub state: String,
    pub orchestrator_agent_id: Option<String>,
    pub admission_decision_json: Option<String>,
    pub loop_status_json: Option<String>,
    pub reply_queue_json: Option<String>,
    pub round_count: i64,
    pub pipeline_run_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    // 027 迁移新增：halt 追踪
    pub halt_reason: Option<String>,
    pub halted_by: Option<String>,
    pub halted_at: Option<String>,
    // 027 迁移新增：恢复审计
    pub recovery_audited: i64,
    pub recovery_action: Option<String>,
    pub recovery_operator_user_id: Option<String>,
    pub recovery_note: Option<String>,
    // 027 迁移新增：可配置轮次上限
    pub max_round_limit: i64,
}

/// 任务卡数据库模型
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationAssignment {
    pub id: String,
    pub session_id: String,
    pub agent_id: String,
    pub task_type: String,
    pub goal: String,
    pub input_json: Option<String>,
    pub depends_on_json: Option<String>,
    pub status: String,
    pub blocking_question_count: i64,
    pub last_question_fingerprint: Option<String>,
    pub ai_task_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    // 027 迁移新增：失败原因 + 语义指纹
    pub failure_reason: Option<String>,
    pub semantic_fingerprint: Option<String>,
}

/// 协同消息数据库模型
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationMessage {
    pub id: String,
    pub session_id: String,
    pub source_agent_id: Option<String>,
    pub target_agent_id: Option<String>,
    pub message_kind: String,
    pub content: String,
    pub question_fingerprint: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub queue_order: i64,
    pub created_at: String,
    // 027 迁移新增：语义哈希
    pub semantic_hash: Option<String>,
}

/// 协同事件数据库模型
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationEvent {
    pub id: String,
    pub session_id: String,
    pub event_type: String,
    pub payload_json: Option<String>,
    pub created_at: String,
}

/// 创建协同会话请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionReq {
    pub project_id: String,
    pub conversation_id: String,
    pub entry_message_id: Option<String>,
    pub orchestrator_agent_id: Option<String>,
}

/// 编导分派请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchReq {
    pub assignments: Vec<DispatchAssignmentReq>,
}

/// 单个分派任务请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchAssignmentReq {
    pub agent_id: String,
    pub task_type: String,
    pub goal: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub input: Option<serde_json::Value>,
}

/// 发送协同消息请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageReq {
    pub source_agent_id: Option<String>,
    pub target_agent_id: Option<String>,
    pub message_kind: String,
    pub content: String,
    pub question_fingerprint: Option<String>,
    pub reply_to_message_id: Option<String>,
}

/// 循环检测响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopCheckResponse {
    pub loop_detected: bool,
    pub signals: Vec<String>,
    pub level: i32,
    pub action: String,
    pub message: String,
}

/// 入工作区响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmitResponse {
    pub admitted: bool,
    pub pipeline_run_id: Option<String>,
    pub reason: String,
    pub blocking_issues: Option<Vec<BlockingIssue>>,
}

/// 阻塞问题
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockingIssue {
    pub assignment_id: String,
    pub agent_id: String,
    pub question: String,
    pub status: String,
}

/// 暂停协同请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HaltReq {
    pub reason: String,
    #[serde(default)]
    pub detail: Option<String>,
}

/// 查询活跃协同会话请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSessionQuery {
    pub project_id: String,
    pub conversation_id: Option<String>,
}

/// 查询当前对话是否具备启动协同的条件
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessQuery {
    pub conversation_id: String,
}

/// 协同启动成熟度结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationReadinessResponse {
    pub ready: bool,
    pub missing: Vec<String>,
}

/// 协同会话聚合视图
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session: CollaborationSession,
    pub assignments: Vec<CollaborationAssignment>,
}

/// 分派响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResponse {
    pub dispatched_count: i64,
    pub assignments: Vec<CollaborationAssignment>,
}

/// 恢复协同会话请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeReq {
    /// 恢复动作：restart（回到 discovery 重新开始）/ resume（尝试继续当前阶段）
    pub action: String,
    /// 操作者备注
    #[serde(default)]
    pub note: Option<String>,
}

/// 队列可视化视图
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueVisualization {
    pub session_id: String,
    pub current_speaker: Option<QueueSpeaker>,
    pub pending_queue: Vec<QueueSpeaker>,
    pub completed_members: Vec<CompletedMember>,
    pub blocked_members: Vec<BlockedMember>,
}

/// 当前/待发言者
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSpeaker {
    pub agent_id: String,
    pub intent: String,
}

/// 已完成成员
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedMember {
    pub agent_id: String,
    pub goal: String,
    pub completed_at: String,
}

/// 阻塞成员
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedMember {
    pub agent_id: String,
    pub goal: String,
    pub blocking_reason: String,
    pub blocking_question_count: i64,
}

/// 协同状态机错误码（稳定，前端可据此分支处理）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationStateError {
    pub error_code: String,
    pub message: String,
    pub current_state: String,
    pub target_state: String,
}

/// 协同状态机错误码常量
pub mod error_codes {
    /// 非法状态迁移
    pub const INVALID_TRANSITION: &str = "COLLABORATION_INVALID_TRANSITION";
    /// 未知状态值
    pub const UNKNOWN_STATE: &str = "COLLABORATION_UNKNOWN_STATE";
    /// 达到轮次上限
    pub const ROUND_LIMIT_REACHED: &str = "COLLABORATION_ROUND_LIMIT_REACHED";
    /// 同智能体重复追问超限
    pub const QUESTION_LIMIT_REACHED: &str = "COLLABORATION_QUESTION_LIMIT_REACHED";
    /// 语义近似重复问题
    pub const SEMANTIC_DUPLICATE_QUESTION: &str = "COLLABORATION_SEMANTIC_DUPLICATE";
    /// 任务无法恢复（AI task 缺失）
    pub const TASK_UNRECOVERABLE: &str = "COLLABORATION_TASK_UNRECOVERABLE";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_state_transitions_are_valid() {
        let valid = [
            (SessionState::Discovery, SessionState::Delegating),
            (SessionState::Discovery, SessionState::Halted),
            (SessionState::Delegating, SessionState::ResolvingQuestions),
            (SessionState::Delegating, SessionState::Halted),
            (
                SessionState::ResolvingQuestions,
                SessionState::WorkspaceAdmission,
            ),
            (SessionState::ResolvingQuestions, SessionState::Halted),
            (
                SessionState::WorkspaceAdmission,
                SessionState::WorkspaceExecution,
            ),
            (SessionState::WorkspaceAdmission, SessionState::Halted),
            (SessionState::WorkspaceExecution, SessionState::Completed),
            (SessionState::WorkspaceExecution, SessionState::Halted),
            // halted 人工恢复迁移（resume/restart 特权操作）
            (SessionState::Halted, SessionState::Discovery),
            (SessionState::Halted, SessionState::Delegating),
            (SessionState::Halted, SessionState::ResolvingQuestions),
            (SessionState::Halted, SessionState::WorkspaceAdmission),
            (SessionState::Halted, SessionState::WorkspaceExecution),
        ];
        for (from, to) in &valid {
            assert!(
                from.can_transition_to(to),
                "{:?} -> {:?} should be valid",
                from,
                to
            );
        }

        let invalid = [
            (SessionState::Discovery, SessionState::Completed),
            (SessionState::Completed, SessionState::Discovery),
            (SessionState::Halted, SessionState::Completed),
        ];
        for (from, to) in &invalid {
            assert!(
                !from.can_transition_to(to),
                "{:?} -> {:?} should be invalid",
                from,
                to
            );
        }
    }

    #[test]
    fn assignment_status_transitions_are_valid() {
        let valid = [
            (AssignmentStatus::Idle, AssignmentStatus::Assigned),
            (AssignmentStatus::Assigned, AssignmentStatus::Questioning),
            (AssignmentStatus::Assigned, AssignmentStatus::Ready),
            (AssignmentStatus::Assigned, AssignmentStatus::Running),
            (AssignmentStatus::Assigned, AssignmentStatus::Failed),
            (AssignmentStatus::Questioning, AssignmentStatus::Blocked),
            (AssignmentStatus::Questioning, AssignmentStatus::Ready),
            (AssignmentStatus::Ready, AssignmentStatus::Running),
            (AssignmentStatus::Blocked, AssignmentStatus::Ready),
            (AssignmentStatus::Running, AssignmentStatus::Done),
            (AssignmentStatus::Running, AssignmentStatus::Failed),
        ];
        for (from, to) in &valid {
            assert!(
                from.can_transition_to(to),
                "{:?} -> {:?} should be valid",
                from,
                to
            );
        }

        let invalid = [
            (AssignmentStatus::Idle, AssignmentStatus::Running),
            (AssignmentStatus::Done, AssignmentStatus::Assigned),
            (AssignmentStatus::Failed, AssignmentStatus::Ready),
        ];
        for (from, to) in &invalid {
            assert!(
                !from.can_transition_to(to),
                "{:?} -> {:?} should be invalid",
                from,
                to
            );
        }
    }

    #[test]
    fn session_state_try_from_str() {
        assert_eq!(
            SessionState::try_from("discovery").unwrap(),
            SessionState::Discovery
        );
        assert_eq!(
            SessionState::try_from("halted").unwrap(),
            SessionState::Halted
        );
        assert!(SessionState::try_from("invalid").is_err());
    }

    #[test]
    fn assignment_status_try_from_str() {
        assert_eq!(
            AssignmentStatus::try_from("idle").unwrap(),
            AssignmentStatus::Idle
        );
        assert_eq!(
            AssignmentStatus::try_from("ready").unwrap(),
            AssignmentStatus::Ready
        );
        assert!(AssignmentStatus::try_from("invalid").is_err());
    }
}
