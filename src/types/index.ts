export type ProjectResponsibilityKind = 'design' | 'review' | 'editor' | 'manager' | 'custom';

/** AI 消息执行模式：task=异步任务 / sync=同步等待 / direct=直接返回 */
export type ExecutionMode = 'task' | 'sync' | 'direct';

export interface ProjectRoleCounts {
  design: number;
  review: number;
  editor: number;
  manager: number;
  custom: number;
}

export interface ProjectWorkflowSummary {
  status: string;
  phase: string;
  progressPercent: number;
  assetCount: number;
  scriptReady: boolean;
  storyboardReady: boolean;
  storyboardLineCount: number;
  conversationCount: number;
  messageCount: number;
  assignedAgentCount: number;
  queuedTaskCount: number;
  runningTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  roleCounts: ProjectRoleCounts;
}

export interface ResourceRef {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'document';
  projectId?: string;
  projectName?: string;
  versionLabel?: string;
}

export interface MessageMeta {
  provider?: string;
  triggerSource?: 'edit' | 'rewind' | 'normal' | string;
  taskId?: string;
  taskStatus?:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'missing'
    | 'scope_mismatch';
  operation?: string;
  outputKind?: 'text' | 'image' | 'video' | 'audio' | 'document' | 'other' | string;
  outputItems?: number;
  attemptIndex?: number;
  previousAttempts?: number;
  previousFailures?: number;
  previousSuccesses?: number;
  isRedo?: boolean;
  agentStatus?: 'idle' | 'queued' | 'busy' | string;
  activeTasks?: number;
  queuedTasks?: number;
  lastError?: string | null;
  confirmedWorkflowGuardMessageId?: string;
  workflowGuardConfirmPending?: boolean;
  resourceRefs?: ResourceRef[];
  attachments?: MessageAttachment[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  assistantActions?: Array<{
    actionType: string;
    status: string;
    summary: string;
    agentId?: string;
    agentName?: string;
    responsibilityKind?: string;
    responsibilityLabel?: string;
  }>;
  workflowGuard?: {
    title: string;
    summary?: string;
    confirmLabel?: string;
    suggestedReply?: string;
    confirmedAt?: string;
    reopenedAt?: string;
    items: Array<{
      label: string;
      done: boolean;
      required: boolean;
      hint?: string | null;
    }>;
  };
  projectWorkflow?: ProjectWorkflowSummary;
  rawMeta?: string;
  [key: string]: unknown;
}

/**
 * 附件来源枚举
 * 区分用户上传、AI生成、AI引用三种场景
 */
export type AttachmentSource = 'user_upload' | 'ai_generated' | 'ai_referenced';

/**
 * AI生成方式（用于AI生成的附件）
 */
export interface AIGenerationMethod {
  type: 'image_generation' | 'asset_reference' | 'document_generation';
  model?: string;
  prompt?: string;
  negativePrompt?: string;
  size?: string;
  seed?: number;
  steps?: number;
  assetId?: string;
  projectId?: string;
  originalName?: string;
  format?: string;
  templateId?: string;
  contentPreview?: string;
}

/**
 * AI生成元数据
 */
export interface AIGenerationMeta {
  generationTimeMs: number;
  model: string;
  tokensUsed?: number;
  generatedAt: string;
  regeneratable: boolean;
}

/**
 * 用户上传元数据
 */
export interface UserUploadMeta {
  uploadTime: string;
  deviceInfo?: string;
}

/**
 * AI引用元数据
 */
export interface AIReferencedMeta {
  assetId: string;
  originalName: string;
  projectId?: string;
}

/**
 * 消息附件 - 支持用户上传和AI生成两种来源
 */
export interface MessageAttachment {
  url: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailUrl?: string;
  source: AttachmentSource;
  sourceMeta?: UserUploadMeta | AIGenerationMeta | AIReferencedMeta;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  phase: string;
  chatSessions: ChatSession[];
  agentRoster: AgentContact[];
  workflow: ProjectWorkflowSummary;
  assetsCount: number;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  projectId?: string;
  title: string;
  messages: Message[];
  updatedAt: number;
}

export interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: number;
  agentId?: string;
  model?: string;
  status?: 'pending' | 'done' | 'error';
  type?: 'text' | 'script_gen' | 'storyboard_gen' | 'review_result';
  meta?: MessageMeta;
  attachments?: MessageAttachment[];
}

export interface Asset {
  id: string;
  projectId: string;
  ownerUserId?: string;
  projectName?: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'document';
  url: string;
  metadata?: Record<string, unknown> | null;
  versionLabel?: string;
  createdAt: number;
  updatedAt?: number;
}

export type AssetReferenceType = 'storyboard' | 'pipelineStep' | 'pipelineStepInput';

export interface AssetReference {
  refType: AssetReferenceType;
  projectId: string;
  projectName: string;
  title: string;
  subLocator?: string | null;
  entityId?: string | null;
}

export interface AssetReferencesResponse {
  assetId: string;
  references: AssetReference[];
  totalCount: number;
  hasReferences: boolean;
}

export interface AssetDeleteBlockedResponse {
  error: string;
  errorCode: 'ASSET_HAS_REFERENCES';
  references: AssetReference[];
  referenceCount: number;
}

export interface AssetSearchParams {
  query?: string;
  assetType?: Asset['type'];
  projectId?: string;
  favoriteOnly?: boolean;
  ratingMin?: number;
  tag?: string;
  sort?: 'recent' | 'name' | 'rating' | 'created';
  limit?: number;
  offset?: number;
}

export type AssetWithProject = Asset & {
  projectName: string;
};

export interface Script {
  id: string;
  projectId: string;
  title: string;
  content: string;
  updatedAt: number;
  /** 当前版本号（乐观锁基线），旧数据可能缺失 */
  version?: number;
  versionId?: string;
  contentHash?: string;
}

export interface StoryboardLine {
  id: string;
  sceneNumber: number;
  description: string;
  duration: number;
  assets: Asset[];
}

export interface Storyboard {
  id: string;
  projectId: string;
  lines: StoryboardLine[];
  updatedAt: number;
  /** 当前版本号（乐观锁基线），旧数据可能缺失 */
  version?: number;
  versionId?: string;
  contentHash?: string;
}

export type ActiveState = {
  projectId: string | null;
  chatSessionId: string | null;
  currentTab:
    | 'chat'
    | 'pipeline'
    | 'imageGeneration'
    | 'assets'
    | 'automation'
    | 'skills'
    | 'preview';
};

export interface AgentProjectHistory {
  projectId: string;
  projectName: string;
  role: string;
  joinedAt: string;
  completedTasks: number;
}

export interface AgentAsset {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'document';
  createdAt: string;
  projectId?: string;
}

export interface AgentContact {
  id: string;
  name: string;
  role: string;
  avatar?: string;
  workCount?: number;
  passRate?: number;
  badge?: string;
  systemPrompt?: string;
  description?: string;
  endpointId?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  status?: 'idle' | 'queued' | 'busy';
  activeTasks?: number;
  queuedTasks?: number;
  projectId?: string;
  assignmentId?: string;
  responsibilityKind?: ProjectResponsibilityKind;
  responsibilityLabel?: string;
  assignmentSource?: 'seed' | 'existing' | 'created' | string;

  mainCapabilities?: string[];
  projectHistories?: AgentProjectHistory[];
  assets?: AgentAsset[];
  redoCount?: number;
  totalTasksCompleted?: number;
  successRate?: number;
  createdAt?: string;
  lastActiveAt?: string;
}

export type AiProvider =
  | 'mock'
  | 'deepseek'
  | 'moonshot'
  | 'openai'
  | 'openrouter'
  | 'ollama'
  | 'custom';

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  forceStreamFallback: boolean;
  multiAgentBetaEnabled: boolean;
  promptOptimizerBetaEnabled: boolean;
  pipelineRetryBackoffSec: number;
  pipelineRetryMaxBackoffSec: number;
  assistantActionsEnabled?: boolean;
  maxActionsPerResponse?: number;
  actionProjectScope?: string;
  requireConfirmationFor?: string[];
}

export type CollaborationSessionState =
  | 'discovery'
  | 'delegating'
  | 'resolving_questions'
  | 'workspace_admission'
  | 'workspace_execution'
  | 'completed'
  | 'halted';

export type CollaborationAssignmentStatus =
  | 'idle'
  | 'assigned'
  | 'questioning'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed';

export type CollaborationMessageKind = 'assign' | 'question' | 'answer' | 'status' | 'escalation';

export interface CollaborationSession {
  id: string;
  userId: string;
  projectId: string;
  conversationId: string;
  entryMessageId?: string;
  state: CollaborationSessionState;
  orchestratorAgentId?: string;
  admissionDecisionJson?: string;
  pipelineRunId?: string;
  loopStatusJson?: string;
  replyQueueJson?: string;
  roundCount: number;
  createdAt: string;
  updatedAt: string;
  // 027 迁移新增：halt 追踪
  haltReason?: string;
  haltedBy?: string;
  haltedAt?: string;
  // 027 迁移新增：恢复审计
  recoveryAudited?: number;
  recoveryAction?: string;
  recoveryOperatorUserId?: string;
  recoveryNote?: string;
  // 027 迁移新增：可配置轮次上限
  maxRoundLimit?: number;
}

export interface CollaborationAssignment {
  id: string;
  sessionId: string;
  agentId: string;
  taskType: string;
  goal: string;
  inputJson?: string;
  dependsOnJson?: string;
  status: CollaborationAssignmentStatus;
  blockingQuestionCount: number;
  lastQuestionFingerprint?: string;
  aiTaskId?: string;
  createdAt: string;
  updatedAt: string;
  // 027 迁移新增：失败原因 + 语义指纹
  failureReason?: string;
  semanticFingerprint?: string;
}

export interface CollaborationMessage {
  id: string;
  sessionId: string;
  sourceAgentId?: string;
  targetAgentId?: string;
  messageKind: CollaborationMessageKind;
  content: string;
  questionFingerprint?: string;
  replyToMessageId?: string;
  queueOrder: number;
  createdAt: string;
}

export interface CollaborationEvent {
  id: string;
  sessionId: string;
  eventType: string;
  payloadJson?: string;
  createdAt: string;
}

export interface CollaborationSessionSummary {
  session: CollaborationSession;
  assignments: CollaborationAssignment[];
}

export interface CollaborationReadiness {
  ready: boolean;
  missing: string[];
}

export interface CreateCollaborationSessionReq {
  projectId: string;
  conversationId: string;
  entryMessageId?: string;
  orchestratorAgentId?: string;
}

export interface DispatchAssignmentReq {
  agentId: string;
  taskType: string;
  goal: string;
  dependsOn?: string[];
  input?: unknown;
}

export interface DispatchReq {
  assignments: DispatchAssignmentReq[];
}

export interface DispatchResponse {
  dispatchedCount: number;
  assignments: CollaborationAssignment[];
}

export interface SendCollaborationMessageReq {
  sourceAgentId?: string;
  targetAgentId?: string;
  messageKind: CollaborationMessageKind;
  content: string;
  questionFingerprint?: string;
  replyToMessageId?: string;
}

export interface LoopCheckResponse {
  loopDetected: boolean;
  signals: string[];
  level: number;
  action: string;
  message: string;
}

export interface AdmitResponse {
  admitted: boolean;
  pipelineRunId?: string;
  reason: string;
  blockingIssues?: BlockingIssue[];
}

export interface BlockingIssue {
  assignmentId: string;
  agentId: string;
  question: string;
  status: string;
}

export interface HaltReq {
  reason: string;
  detail?: string;
}

/** 恢复协同会话请求 */
export interface ResumeReq {
  /** 恢复动作：restart（回到 discovery）/ resume（继续当前阶段） */
  action: 'restart' | 'resume';
  note?: string;
}

/** 队列可视化：当前发言者/待发言/已完成/阻塞 */
export interface QueueVisualization {
  sessionId: string;
  currentSpeaker?: QueueSpeaker;
  pendingQueue: QueueSpeaker[];
  completedMembers: CompletedMember[];
  blockedMembers: BlockedMember[];
}

/** 当前/待发言者 */
export interface QueueSpeaker {
  agentId: string;
  intent: string;
}

/** 已完成成员 */
export interface CompletedMember {
  agentId: string;
  goal: string;
  completedAt: string;
}

/** 阻塞成员 */
export interface BlockedMember {
  agentId: string;
  goal: string;
  blockingReason: string;
  blockingQuestionCount: number;
}

/** 协同稳定错误码（前端可据此分支处理） */
export const COLLABORATION_ERROR_CODES = {
  INVALID_TRANSITION: 'COLLABORATION_INVALID_TRANSITION',
  UNKNOWN_STATE: 'COLLABORATION_UNKNOWN_STATE',
  ROUND_LIMIT_REACHED: 'COLLABORATION_ROUND_LIMIT_REACHED',
  QUESTION_LIMIT_REACHED: 'COLLABORATION_QUESTION_LIMIT_REACHED',
  SEMANTIC_DUPLICATE: 'COLLABORATION_SEMANTIC_DUPLICATE',
  TASK_UNRECOVERABLE: 'COLLABORATION_TASK_UNRECOVERABLE',
} as const;

export type CollaborationErrorCode =
  (typeof COLLABORATION_ERROR_CODES)[keyof typeof COLLABORATION_ERROR_CODES];
