import type {
  AgentContact,
  AiSettings,
  Asset,
  AssetReferencesResponse,
  AssetSearchParams,
  AssetWithProject,
  ChatSession,
  Message,
  Project,
  ProjectWorkflowSummary,
  ResourceRef,
  Script,
  Storyboard,
  StoryboardLine,
} from '../types';
import { createAgentApi } from './serverApi.agents';
import { BUDGET_REFRESH_EVENT, createBudgetApi } from './serverApi.budget';
import { createCollaborationApi } from './serverApi.collaboration';
import { createEndpointApi } from './serverApi.endpoints';
import { createImageGenApi } from './serverApi.imageGen';
import { createNotificationApi } from './serverApi.notifications';
import { createOpsApi } from './serverApi.ops';
import { createPolicyApi } from './serverApi.policy';
import { createUsageTaskPipelineApi } from './serverApi.pipeline';
import { createVideoGenApi } from './serverApi.videoGen';

export type { CreateAgentInput, ProjectAgentInput } from './serverApi.agents';
export type {
  CreateImageGenerationInput,
  CreditTransaction,
  ImageGeneration,
  ImageGenerationStatus,
  UserCredits,
} from './serverApi.imageGen';
export type {
  CreateVideoGenerationInput,
  VideoGeneration,
  VideoGenerationStatus,
} from './serverApi.videoGen';
export type {
  ActionProjectScope,
  AssistantActionAudit,
  AssistantActionPolicy,
  AuditLogFilter,
  ConfirmationToken,
  ConsumeTokenInput,
} from './serverApi.policy';
export type {
  ListEndpointModelsInput,
  ListEndpointModelsResult,
  ServerAiEndpoint,
  ServerAiEndpointCapability,
  UpsertEndpointCapabilityInput,
} from './serverApi.endpoints';
export type {
  NotificationChannelType,
  OpsNotificationChannel,
  OpsNotificationEvent,
  TestNotificationInput,
  TestNotificationResult,
  UpsertNotificationChannelInput,
} from './serverApi.notifications';
export type {
  BudgetBlockEvent,
  BudgetLevel,
  BudgetSettings,
  BudgetStatus,
  BudgetWindowStatus,
  BudgetWindowType,
  UpdateBudgetSettingsInput,
} from './serverApi.budget';
export { BUDGET_REFRESH_EVENT, notifyBudgetChanged } from './serverApi.budget';

export type {
  CreatePipelineRunInput,
  PipelineRun,
  PipelineRunEvent,
  PipelineRunStatus,
  PipelineRunStep,
  PipelineStepOutput,
  PipelineStepStatus,
  PipelineRunSummary,
  PipelinePromptOptimization,
  PipelineManualReview,
  ReviewDecisionType,
  ReviewQueueItem,
  ReviewQueueResponse,
  ReviewQueueParams,
  SubmitReviewDecisionInput,
  SubmitReviewDecisionResult,
} from './serverApi.pipeline';

type AuthResponse = {
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
};

type ServerSession = {
  email?: string;
  token: string;
  username?: string;
  userId?: string;
};

export type StoredServerProfile = {
  email?: string;
  id?: string;
  username?: string;
};

type ServerMeResponse = {
  id: string;
  username: string;
  email: string;
};

type WorkspaceBootstrapResponse = {
  projects: Project[];
  assets: Asset[];
  scripts: Script[];
  storyboards: Storyboard[];
  agents: AgentContact[];
};

type ServerProject = {
  id: string;
  name: string;
  created_at: string;
};

type ServerConversation = {
  id: string;
  project_id: string;
  title: string;
  updated_at: string;
};

type RewindConversationResponse = {
  conversationId: string;
  anchorMessageId: string;
  removedMessageCount: number;
  cancelledTaskCount: number;
};

type ServerMessage = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  updated_at?: string;
  agent_id?: string | null;
  model_used?: string | null;
  msg_type?: string;
  meta?: string | null;
};

type ServerAsset = {
  id: string;
  projectId: string;
  ownerUserId?: string | null;
  name: string;
  type: Asset['type'];
  url: string;
  metadata?: Record<string, unknown> | string | null;
  createdAt: string | number;
  updatedAt?: string | number;
};

type ServerAssetWithProject = ServerAsset & {
  projectName: string;
};

type ServerScript = {
  id: string;
  projectId: string;
  title: string;
  content: string;
  updatedAt: string;
};

type ServerStoryboard = {
  id: string;
  projectId: string;
  lines: Array<{
    id: string;
    sceneNumber: number;
    description: string;
    duration: number;
    assets: ServerAsset[];
  }>;
  updatedAt: string;
};

type ServerAiChatResult = {
  content: string;
  model: string;
  meta?: Message['meta'];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type CreateMessageInput = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  agentId?: string;
  modelUsed?: string;
  type?: Message['type'];
  meta?: Message['meta'];
};

type CreateAssetInput = {
  name: string;
  type: Asset['type'];
  url: string;
  metadata?: Record<string, unknown>;
};

type RequestServerAiCompletionInput = {
  conversationId: string;
  content: string;
  resourceRefs?: ResourceRef[];
  agentId?: string;
  endpointId?: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  forceStreamFallback?: boolean;
  outputKind?: 'text' | 'image' | 'video' | 'audio' | 'document' | 'other';
  outputItems?: number;
  allowAssistantActions?: boolean;
  confirmedAssistantMessageId?: string;
  confirmedWorkflowGuardMessageId?: string;
  /**
   * 触发来源：用于区分正常发送、编辑后发送、撤回后重新发送
   * - undefined 或 'normal': 正常发送（默认）
   * - 'edit': 编辑消息后发送
   * - 'rewind': 撤回消息后重新发送
   */
  triggerSource?: 'edit' | 'rewind' | 'normal';
};

export type AiUsageBucket = 'hour' | 'day' | 'week' | 'month';

export type AiUsageBreakdownItem = {
  key: string;
  label: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  totalTokens: number;
  outputItems: number;
};

export type AiUsageWindow = {
  from?: string | null;
  to: string;
  days?: number | null;
  bucket: AiUsageBucket;
  projectId?: string | null;
  conversationId?: string | null;
  agentId?: string | null;
  endpointId?: string | null;
  apiKeyFingerprint?: string | null;
  resourceKind?: string | null;
  model?: string | null;
  operation?: string | null;
  status?: string | null;
};

export type AiUsageTotals = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  inputChars: number;
  outputChars: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  actualTokenRecords: number;
  estimatedTokenRecords: number;
  unavailableTokenRecords: number;
  outputItems: number;
  attemptGroupCount: number;
  redoRequestCount: number;
  redoTotalTokens: number;
  firstPassSuccessCount: number;
  firstPassSuccessTokens: number;
  retrySuccessCount: number;
  retrySuccessTokens: number;
  projectCount: number;
  conversationCount: number;
};

export type AiUsageSeriesPoint = {
  bucketStart: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  totalTokens: number;
  outputItems: number;
};

export type AiUsageSummary = {
  window: AiUsageWindow;
  totals: AiUsageTotals;
  series: AiUsageSeriesPoint[];
  byEndpoint: AiUsageBreakdownItem[];
  byApiKey: AiUsageBreakdownItem[];
  byModel: AiUsageBreakdownItem[];
  byAgent: AiUsageBreakdownItem[];
  byProject: AiUsageBreakdownItem[];
  byOperation: AiUsageBreakdownItem[];
  byResourceKind: AiUsageBreakdownItem[];
  recent: AiUsageRecord[];
};

export type AiUsageRecord = {
  id: string;
  projectName?: string;
  projectId?: string;
  conversationId?: string;
  agentName?: string;
  agentId?: string;
  endpointName?: string;
  endpointId?: string;
  apiKeyFingerprint: string;
  provider: string;
  model?: string;
  operation: string;
  status: string;
  resourceKind: string;
  outputItems: number;
  requestFingerprint: string;
  attemptIndex: number;
  isRedo: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokenSource: string;
  inputChars: number;
  outputChars: number;
  latencyMs: number;
  errorMessage?: string;
  createdAt: string;
};

export type AiTaskStatus = 'queued' | 'running' | 'completed' | 'failed';

export type AiTask = {
  id: string;
  projectId: string;
  conversationId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  agentId?: string | null;
  content: string;
  endpointId?: string | null;
  model?: string | null;
  outputKind?: string | null;
  outputItems?: number | null;
  status: AiTaskStatus;
  result?: string | null;
  error?: string | null;
  attemptIndex?: number | null;
  previousAttempts?: number | null;
  previousFailures?: number | null;
  previousSuccesses?: number | null;
  isRedo?: boolean;
  lastError?: string | null;
  agentStatus?: 'idle' | 'queued' | 'busy' | null;
  activeTasks?: number | null;
  queuedTasks?: number | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
};

const STORAGE_KEY = 'woohoo-server-session-v1';
const SERVER_BASE_URL_STORAGE_KEY = 'woohoo-server-base-url-v2';
const DEFAULT_SERVER_BASE_URL = (import.meta.env.VITE_SERVER_BASE_URL || 'http://127.0.0.1:8080')
  .trim()
  .replace(/\/+$/, '');
const DEFAULT_SERVER_PORT = Number.parseInt(import.meta.env.VITE_SERVER_PORT || '8080', 10) || 8080;
const COMMON_SERVER_PORTS = [3001];
const SERVER_PORT_SEARCH_LIMIT =
  Number.parseInt(import.meta.env.VITE_SERVER_PORT_SEARCH_LIMIT || '12', 10) || 12;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS =
  Number.parseInt(import.meta.env.VITE_SERVER_REQUEST_TIMEOUT_MS || '10000', 10) || 10000;
const SERVER_BASE_URL_PROBE_TTL_MS =
  Number.parseInt(import.meta.env.VITE_SERVER_BASE_URL_PROBE_TTL_MS || '30000', 10) || 30000;
const SERVER_BASE_URL_FAILURE_BACKOFF_MS =
  Number.parseInt(import.meta.env.VITE_SERVER_BASE_URL_FAILURE_BACKOFF_MS || '8000', 10) || 8000;
const REQUEST_ID_HEADER = 'x-request-id';
const CACHE_KEYS = {
  aiEndpoints: 'ai-endpoints',
  workspaceBootstrap: 'workspace-bootstrap',
  notificationChannels: 'notification-channels',
} as const;
const CACHE_TTLS = {
  aiEndpoints: 15_000,
  workspaceBootstrap: 3_000,
  notificationChannels: 5_000,
} as const;

let pendingSessionPromise: Promise<ServerSession> | null = null;
let cachedSession: ServerSession | null = null;
let resolvedServerBaseUrl: string | null = null;
let pendingServerBaseUrlPromise: Promise<string> | null = null;
type PendingCacheRequest = {
  promise: Promise<unknown>;
  generation: number;
  version: number;
};

type CachedResponse = {
  expiresAt: number;
  value: unknown;
  generation: number;
  version: number;
};

const pendingCacheRequests = new Map<string, PendingCacheRequest>();
const responseCache = new Map<string, CachedResponse>();
const cacheKeyVersions = new Map<string, number>();
const serverBaseUrlProbeCache = new Map<string, number>();
let apiCacheGeneration = 0;
let serverBaseUrlDiscoveryFailureUntil = 0;
let serverBaseUrlDiscoveryFailureMessage: string | null = null;

function clearAllApiCaches() {
  apiCacheGeneration += 1;
  responseCache.clear();
  pendingCacheRequests.clear();
}

function createClientRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `woohoo-${crypto.randomUUID()}`;
  }
  return `woohoo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function appendRequestId(message: string, requestId?: string | null) {
  const normalizedRequestId = (requestId || '').trim();
  if (!normalizedRequestId) {
    return message;
  }
  return `${message} [request_id=${normalizedRequestId}]`;
}

function normalizeServerBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function loadStoredServerBaseUrl() {
  if (resolvedServerBaseUrl) {
    return resolvedServerBaseUrl;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.localStorage.getItem(SERVER_BASE_URL_STORAGE_KEY);
  if (!value) {
    return null;
  }

  // Windows 上 localhost 可能解析到 IPv6 ::1，统一替换为 127.0.0.1
  resolvedServerBaseUrl = normalizeServerBaseUrl(value).replace('//localhost:', '//127.0.0.1:');
  return resolvedServerBaseUrl;
}

function persistServerBaseUrl(baseUrl: string) {
  // Windows 上 localhost 可能解析到 IPv6 ::1，统一替换为 127.0.0.1
  const safeUrl = normalizeServerBaseUrl(baseUrl).replace('//localhost:', '//127.0.0.1:');
  resolvedServerBaseUrl = safeUrl;
  serverBaseUrlDiscoveryFailureUntil = 0;
  serverBaseUrlDiscoveryFailureMessage = null;

  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(SERVER_BASE_URL_STORAGE_KEY, resolvedServerBaseUrl);
}

function clearStoredServerBaseUrl() {
  resolvedServerBaseUrl = null;
  serverBaseUrlProbeCache.clear();

  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(SERVER_BASE_URL_STORAGE_KEY);
}

function markServerBaseUrlDiscoveryFailure(message: string) {
  serverBaseUrlDiscoveryFailureUntil = Date.now() + SERVER_BASE_URL_FAILURE_BACKOFF_MS;
  serverBaseUrlDiscoveryFailureMessage = message;
}

function hasRecentServerBaseUrlDiscoveryFailure() {
  return Date.now() < serverBaseUrlDiscoveryFailureUntil;
}

function getRecentServerBaseUrlDiscoveryFailureMessage() {
  if (!hasRecentServerBaseUrlDiscoveryFailure()) {
    return null;
  }

  return (
    serverBaseUrlDiscoveryFailureMessage ||
    '本地后端不可达，请先检查后端是否正常运行，稍后重试。'
  );
}

function getServerBaseUrlCandidates() {
  const candidates: string[] = [];
  const seen = new Set<string>();

  /** 添加候选 URL，去重并优先使用 127.0.0.1 而非 localhost（避免 Windows IPv6 解析问题） */
  const addCandidate = (url: string) => {
    const normalized = normalizeServerBaseUrl(url);
    // Windows 上 localhost 可能解析到 IPv6 ::1，导致连接失败，统一替换为 127.0.0.1
    const safeUrl = normalized.replace('//localhost:', '//127.0.0.1:');
    if (!seen.has(safeUrl)) {
      seen.add(safeUrl);
      candidates.push(safeUrl);
    }
  };

  const envBaseUrl = import.meta.env.VITE_SERVER_BASE_URL?.trim();
  if (envBaseUrl) {
    addCandidate(envBaseUrl);
  }

  const storedBaseUrl = loadStoredServerBaseUrl();
  if (storedBaseUrl) {
    addCandidate(storedBaseUrl);
  }

  addCandidate(DEFAULT_SERVER_BASE_URL);

  for (let offset = 0; offset <= SERVER_PORT_SEARCH_LIMIT; offset += 1) {
    const port = DEFAULT_SERVER_PORT + offset;
    addCandidate(`http://127.0.0.1:${port}`);
  }

  for (const port of COMMON_SERVER_PORTS) {
    addCandidate(`http://127.0.0.1:${port}`);
  }

  return candidates;
}

function getLoopbackFallbackBaseUrls(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    const fallbacks: string[] = [];

    // 只做 localhost → 127.0.0.1 的 fallback，不做反向
    // Windows 上 localhost 可能解析到 IPv6 ::1，导致连接失败
    if (host === 'localhost') {
      parsed.hostname = '127.0.0.1';
      fallbacks.push(normalizeServerBaseUrl(parsed.toString()));
    }
    // 不再将 127.0.0.1 转为 localhost，避免 IPv6 解析问题

    return fallbacks;
  } catch {
    return [];
  }
}

function hasRecentServerBaseUrlProbe(baseUrl: string) {
  const checkedAt = serverBaseUrlProbeCache.get(normalizeServerBaseUrl(baseUrl));
  return Boolean(checkedAt && Date.now() - checkedAt < SERVER_BASE_URL_PROBE_TTL_MS);
}

function markServerBaseUrlReachable(baseUrl: string) {
  serverBaseUrlProbeCache.set(normalizeServerBaseUrl(baseUrl), Date.now());
  serverBaseUrlDiscoveryFailureUntil = 0;
  serverBaseUrlDiscoveryFailureMessage = null;
}

async function probeServerBaseUrl(baseUrl: string) {
  const controller = new AbortController();
  const timeoutId =
    typeof window !== 'undefined'
      ? window.setTimeout(() => controller.abort(), 3000)
      : setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }

    const rawText = await response.text();
    const parsed = rawText ? tryParseJson(rawText) : null;

    if (typeof parsed === 'string') {
      const ok = parsed.trim() === 'OK';
      if (ok) {
        markServerBaseUrlReachable(baseUrl);
      }
      return ok;
    }

    const ok = Boolean(
      parsed &&
      typeof parsed === 'object' &&
      'service' in parsed &&
      parsed.service === 'woohoo-server' &&
      'status' in parsed &&
      typeof parsed.status === 'string' &&
      parsed.status.toLowerCase() === 'ok',
    );
    if (ok) {
      markServerBaseUrlReachable(baseUrl);
    }
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function discoverServerBaseUrl() {
  for (const candidate of getServerBaseUrlCandidates()) {
    if (await probeServerBaseUrl(candidate)) {
      persistServerBaseUrl(candidate);
      return candidate;
    }
  }

  clearStoredServerBaseUrl();
  const errorMessage =
    '本地后端不可达，系统已尝试自动切换端口但未发现可用服务';
  markServerBaseUrlDiscoveryFailure(errorMessage);
  throw new Error(errorMessage);
}

export async function getServerBaseUrl(forceRefresh = false) {
  if (pendingServerBaseUrlPromise) {
    return pendingServerBaseUrlPromise;
  }

  const recentFailureMessage = getRecentServerBaseUrlDiscoveryFailureMessage();
  if (recentFailureMessage) {
    throw new Error(recentFailureMessage);
  }

  const envBaseUrl = import.meta.env.VITE_SERVER_BASE_URL?.trim();

  if (!forceRefresh) {
    const storedBaseUrl = loadStoredServerBaseUrl();
    if (storedBaseUrl) {
      if (hasRecentServerBaseUrlProbe(storedBaseUrl)) {
        return storedBaseUrl;
      }

      if (await probeServerBaseUrl(storedBaseUrl)) {
        persistServerBaseUrl(storedBaseUrl);
        return storedBaseUrl;
      }

      for (const fallbackBaseUrl of getLoopbackFallbackBaseUrls(storedBaseUrl)) {
        if (await probeServerBaseUrl(fallbackBaseUrl)) {
          persistServerBaseUrl(fallbackBaseUrl);
          return fallbackBaseUrl;
        }
      }
    }

    if (envBaseUrl) {
      const normalizedEnvBaseUrl = normalizeServerBaseUrl(envBaseUrl);
      if (hasRecentServerBaseUrlProbe(normalizedEnvBaseUrl)) {
        return normalizedEnvBaseUrl;
      }

      if (await probeServerBaseUrl(normalizedEnvBaseUrl)) {
        persistServerBaseUrl(normalizedEnvBaseUrl);
        return normalizedEnvBaseUrl;
      }
    }
  }

  if (!pendingServerBaseUrlPromise || forceRefresh) {
    pendingServerBaseUrlPromise = discoverServerBaseUrl().finally(() => {
      pendingServerBaseUrlPromise = null;
    });
  }

  return pendingServerBaseUrlPromise;
}

function loadStoredSession(): ServerSession | null {
  if (cachedSession) {
    return cachedSession;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<ServerSession> & { password?: unknown };
    if (typeof parsed?.token !== 'string' || !parsed.token.trim()) {
      return null;
    }

    const session: ServerSession = {
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      token: parsed.token,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
    };

    // 兼容历史版本：若本地还残留 password 字段，立即覆盖为脱敏结构。
    if (Object.prototype.hasOwnProperty.call(parsed, 'password')) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    }

    cachedSession = session;
    return session;
  } catch {
    return null;
  }
}

export function getStoredServerUserId() {
  return loadStoredSession()?.userId || null;
}

export function getStoredServerProfile(): StoredServerProfile | null {
  const session = loadStoredSession();
  if (!session) {
    return null;
  }

  return {
    email: session.email,
    id: session.userId,
    username: session.username,
  };
}

function persistSession(session: ServerSession) {
  const previousSession = cachedSession ?? loadStoredSession();
  const previousUserId = previousSession?.userId ?? null;
  const previousToken = previousSession?.token ?? null;
  const nextUserId = session.userId ?? null;
  const nextToken = session.token;

  if (previousUserId !== nextUserId || (previousToken && previousToken !== nextToken)) {
    clearAllApiCaches();
  }

  cachedSession = session;

  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

async function validateServerSessionToken(session: ServerSession): Promise<ServerSession> {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${session.token}`);

  const response = await fetchServer(
    '/api/auth/me',
    {
      method: 'GET',
      headers,
    },
    false,
  );

  if (response.status === 401 || response.status === 403) {
    clearStoredSession();
    throw new Error('UNAUTHORIZED');
  }

  if (!response.ok) {
    throw new Error(`会话校验失败 (${response.status})`);
  }

  const profile = await parseResponse<ServerMeResponse>(response);
  const nextSession: ServerSession = {
    token: session.token,
    email: profile.email || session.email,
    username: profile.username || session.username,
    userId: profile.id || session.userId,
  };
  persistSession(nextSession);
  return nextSession;
}

function invalidateApiCache(...keys: string[]) {
  for (const key of keys) {
    cacheKeyVersions.set(key, (cacheKeyVersions.get(key) ?? 0) + 1);
    responseCache.delete(key);
    pendingCacheRequests.delete(key);
  }
}

async function readCachedApi<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const generation = apiCacheGeneration;
  const version = cacheKeyVersions.get(key) ?? 0;
  const cached = responseCache.get(key);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.generation === generation &&
    cached.version === version
  ) {
    return cached.value as T;
  }

  const pending = pendingCacheRequests.get(key);
  if (pending && pending.generation === generation && pending.version === version) {
    return pending.promise as Promise<T>;
  }

  const promise = loader()
    .then((value) => {
      if (apiCacheGeneration === generation && (cacheKeyVersions.get(key) ?? 0) === version) {
        responseCache.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
          generation,
          version,
        });
      }
      return value;
    })
    .finally(() => {
      const currentPending = pendingCacheRequests.get(key);
      if (currentPending?.promise === promise) {
        pendingCacheRequests.delete(key);
      }
    });

  pendingCacheRequests.set(key, {
    promise,
    generation,
    version,
  });
  return promise;
}

export function clearStoredSession() {
  clearAllApiCaches();
  pendingSessionPromise = null;
  cachedSession = null;
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

// Demo session generator removed - enforcing real authentication

function parseTimestamp(value: string | number | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Date.now();
  }

  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function parseMeta(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as Message['meta'];
  } catch {
    return {
      rawMeta: value,
    } satisfies Message['meta'];
  }
}

function parseAssetMetadata(
  value: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function inferMessageStatus(
  role: Message['role'],
  content: string,
  meta: Message['meta'] | undefined,
): Message['status'] {
  if (
    meta?.taskStatus === 'failed' ||
    meta?.taskStatus === 'missing' ||
    meta?.taskStatus === 'scope_mismatch'
  ) {
    return 'error';
  }

  if (meta?.taskStatus === 'queued' || meta?.taskStatus === 'running') {
    return 'pending';
  }

  if (role === 'system' && content.startsWith('任务失败')) {
    return 'error';
  }

  return 'done';
}

function mapProject(project: ServerProject): Project {
  return {
    id: project.id,
    name: project.name,
    status: 'draft',
    phase: 'ideation',
    chatSessions: [],
    agentRoster: [],
    workflow: emptyWorkflowSummary(),
    assetsCount: 0,
    createdAt: parseTimestamp(project.created_at),
  };
}

function emptyWorkflowSummary(): ProjectWorkflowSummary {
  return {
    status: 'draft',
    phase: 'ideation',
    progressPercent: 0,
    assetCount: 0,
    scriptReady: false,
    storyboardReady: false,
    storyboardLineCount: 0,
    conversationCount: 0,
    messageCount: 0,
    assignedAgentCount: 0,
    queuedTaskCount: 0,
    runningTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    roleCounts: {
      design: 0,
      review: 0,
      editor: 0,
      manager: 0,
      custom: 0,
    },
  };
}

function mapConversation(conversation: ServerConversation): ChatSession {
  return {
    id: conversation.id,
    projectId: conversation.project_id,
    title: conversation.title,
    messages: [],
    updatedAt: parseTimestamp(conversation.updated_at),
  };
}

function mapMessage(message: ServerMessage): Message {
  const role = message.role === 'assistant' ? 'ai' : (message.role as Message['role']);
  const meta = parseMeta(message.meta);
  return {
    id: message.id,
    role,
    content: message.content,
    timestamp: parseTimestamp(message.created_at),
    agentId: message.agent_id || undefined,
    model: message.model_used || undefined,
    status: inferMessageStatus(role, message.content, meta),
    type: (message.msg_type as Message['type']) || 'text',
    meta,
  };
}

function deriveAssetVersionLabel(metadata?: Record<string, unknown> | null) {
  if (!metadata || typeof metadata !== 'object') {
    return '当前版';
  }

  const versionLabel =
    typeof metadata.versionLabel === 'string' ? metadata.versionLabel.trim() : '';
  if (versionLabel) {
    return versionLabel;
  }

  const reviewStatus =
    typeof metadata.reviewStatus === 'string' ? metadata.reviewStatus.trim() : '';
  const derivationType =
    typeof metadata.derivationType === 'string' ? metadata.derivationType.trim() : '';

  if (reviewStatus === 'approved') {
    return '已审核';
  }
  if (reviewStatus === 'rejected') {
    return '待修订';
  }
  if (derivationType === 'optimized') {
    return '优化版';
  }
  if (derivationType === 'remake') {
    return '重制版';
  }
  if (derivationType === 'variant') {
    return '变体版';
  }
  if (metadata.parentAssetId || metadata.sourceAssetId) {
    return '派生版';
  }

  return '当前版';
}

function mapAsset(asset: ServerAsset): Asset {
  let url = asset.url;
  if (url.startsWith('/uploads/')) {
    url = `/api/assets/${asset.id}/file`;
  }
  if (url.startsWith('/') && resolvedServerBaseUrl) {
    url = `${resolvedServerBaseUrl}${url}`;
  }

  const metadata = parseAssetMetadata(asset.metadata);

  return {
    id: asset.id,
    projectId: asset.projectId,
    ownerUserId: asset.ownerUserId || getStoredServerUserId() || undefined,
    name: asset.name,
    type: asset.type,
    url,
    metadata,
    versionLabel: deriveAssetVersionLabel(metadata),
    createdAt: parseTimestamp(asset.createdAt),
    updatedAt: asset.updatedAt ? parseTimestamp(asset.updatedAt) : undefined,
  };
}

function mapScript(script: ServerScript): Script {
  return {
    id: script.id,
    projectId: script.projectId,
    title: script.title,
    content: script.content,
    updatedAt: parseTimestamp(script.updatedAt),
  };
}

function mapStoryboard(storyboard: ServerStoryboard): Storyboard {
  return {
    id: storyboard.id,
    projectId: storyboard.projectId,
    updatedAt: parseTimestamp(storyboard.updatedAt),
    lines: storyboard.lines.map((line) => ({
      id: line.id,
      sceneNumber: line.sceneNumber,
      description: line.description,
      duration: line.duration,
      assets: line.assets.map(mapAsset),
    })),
  };
}

async function requestAuth<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  const response = await fetchServer(path, {
    ...init,
    headers,
  });

  return parseResponse<T>(response);
}

async function requestApi<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const session = await ensureServerSession(retry ? false : true);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.token}`);

  if (init.body instanceof FormData) {
    // Let the browser set the boundary
  } else if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetchServer(path, {
    ...init,
    headers,
  });

  if (response.status === 401 && retry) {
    const refreshed = await ensureServerSession(true);
    const retryHeaders = new Headers(headers);
    retryHeaders.set('Authorization', `Bearer ${refreshed.token}`);

    const retryResponse = await fetchServer(
      path,
      {
        ...init,
        headers: retryHeaders,
      },
      true,
    );

    return parseResponse<T>(retryResponse);
  }

  return parseResponse<T>(response);
}

async function requestApiBlob(path: string, init: RequestInit = {}, retry = true): Promise<Blob> {
  const session = await ensureServerSession(retry ? false : true);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.token}`);

  const response = await fetchServer(path, {
    ...init,
    headers,
  });

  if (response.status === 401 && retry) {
    const refreshed = await ensureServerSession(true);
    const retryHeaders = new Headers(headers);
    retryHeaders.set('Authorization', `Bearer ${refreshed.token}`);

    const retryResponse = await fetchServer(
      path,
      {
        ...init,
        headers: retryHeaders,
      },
      true,
    );

    return parseBlobResponse(retryResponse);
  }

  return parseBlobResponse(response);
}

export async function fetchServer(
  path: string,
  init: RequestInit,
  forceRefresh = false,
): Promise<Response> {
  const executeFetch = async (url: string) => {
    const headers = new Headers(init.headers);
    let requestId = headers.get(REQUEST_ID_HEADER)?.trim();
    if (!requestId) {
      requestId = createClientRequestId();
      headers.set(REQUEST_ID_HEADER, requestId);
    }

    if (init.signal) {
      return fetch(url, {
        ...init,
        headers,
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_SERVER_REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      // 优雅处理连接中断（用户主动取消、组件卸载等场景）
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error; // 保持原始 AbortError 以便调用方识别
      }
      // 处理网络层中断（ERR_ABORTED 等），静默传递不输出控制台错误
      if (error instanceof TypeError && (
        error.message.includes('Failed to fetch') ||
        error.message.includes('NetworkError') ||
        error.message.includes('aborted')
      )) {
        throw new DOMException('Request aborted by user or system', 'AbortError');
      }
      if (error instanceof TypeError) {
        throw new Error(
          appendRequestId('后端服务不可达，请确认服务端已启动并检查端口配置', requestId),
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const baseUrl = await getServerBaseUrl(forceRefresh);

  try {
    const response = await executeFetch(`${baseUrl}${path}`);
    markServerBaseUrlReachable(baseUrl);
    return response;
  } catch (error) {
    for (const fallbackBaseUrl of getLoopbackFallbackBaseUrls(baseUrl)) {
      try {
        const fallbackResponse = await executeFetch(`${fallbackBaseUrl}${path}`);
        markServerBaseUrlReachable(fallbackBaseUrl);
        persistServerBaseUrl(fallbackBaseUrl);
        return fallbackResponse;
      } catch {
        // ignore and continue fallback chain
      }
    }

    if (forceRefresh) {
      throw error;
    }

    const refreshedBaseUrl = await getServerBaseUrl(true);
    if (refreshedBaseUrl === baseUrl) {
      throw error;
    }

    const response = await executeFetch(`${refreshedBaseUrl}${path}`);
    markServerBaseUrlReachable(refreshedBaseUrl);
    return response;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const rawText = await response.text();
  const parsed = rawText ? tryParseJson(rawText) : null;
  const requestId = response.headers.get(REQUEST_ID_HEADER);

  if (!response.ok) {
    const errorCode =
      parsed && typeof parsed === 'object' && 'errorCode' in parsed
        ? String(parsed.errorCode)
        : '';
    if (errorCode === 'BUDGET_EXCEEDED' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(BUDGET_REFRESH_EVENT));
    }
    const errorMessage =
      (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
        ? parsed.error
        : rawText) || `请求失败 (${response.status})`;
    throw new Error(appendRequestId(errorMessage, requestId));
  }

  return (parsed as T) ?? (undefined as T);
}

async function parseBlobResponse(response: Response): Promise<Blob> {
  const requestId = response.headers.get(REQUEST_ID_HEADER);
  if (!response.ok) {
    const rawText = await response.text();
    const parsed = rawText ? tryParseJson(rawText) : null;
    const errorMessage =
      (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
        ? parsed.error
        : rawText) || `请求失败 (${response.status})`;
    throw new Error(appendRequestId(errorMessage, requestId));
  }

  return response.blob();
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function loginUser(email: string, password: string) {
  const auth = await requestAuth<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  const nextSession = {
    email: auth.user.email || email,
    username: auth.user.username || email.split('@')[0],
    token: auth.token,
    userId: auth.user.id,
  };
  persistSession(nextSession);
  return nextSession;
}

export async function registerUser(username: string, email: string, password: string) {
  const auth = await requestAuth<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email, password }),
  });

  const nextSession = {
    email: auth.user.email || email,
    username: auth.user.username || username,
    token: auth.token,
    userId: auth.user.id,
  };
  persistSession(nextSession);
  return nextSession;
}

export async function ensureServerSession(forceRefresh = false): Promise<ServerSession> {
  const existing = loadStoredSession();
  if (!forceRefresh && existing?.token) {
    return existing;
  }

  if (!pendingSessionPromise) {
    pendingSessionPromise = (async () => {
      if (!existing?.token) {
        throw new Error('UNAUTHORIZED');
      }

      try {
        return await validateServerSessionToken(existing);
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          throw error;
        }
        throw error;
      }
    })().finally(() => {
      pendingSessionPromise = null;
    });
  }

  return pendingSessionPromise;
}

export async function bootstrapWorkspace(forceRefresh = false) {
  if (forceRefresh) {
    invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  }

  return readCachedApi(CACHE_KEYS.workspaceBootstrap, CACHE_TTLS.workspaceBootstrap, () =>
    requestApi<WorkspaceBootstrapResponse>('/api/workspace/bootstrap'),
  );
}

export function applyWorkspaceBootstrap(workspace: WorkspaceBootstrapResponse) {
  return {
    projects: workspace.projects,
    assets: workspace.assets,
    scripts: workspace.scripts,
    storyboards: workspace.storyboards,
    agents: workspace.agents,
  };
}

export async function createServerProject(name: string) {
  const project = await requestApi<ServerProject>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: name.trim(),
      description: '',
    }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapProject(project);
}

export async function updateServerProject(projectId: string, name: string) {
  const project = await requestApi<ServerProject>(`/api/projects/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify({ name: name.trim() }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapProject(project);
}

export async function deleteServerProject(projectId: string) {
  await requestApi<void>(`/api/projects/${projectId}`, {
    method: 'DELETE',
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
}

export async function createServerConversation(projectId: string, title = '新对话') {
  const conversation = await requestApi<ServerConversation>(
    `/api/projects/${projectId}/conversations`,
    {
      method: 'POST',
      body: JSON.stringify({ title }),
    },
  );

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapConversation(conversation);
}

export async function updateServerConversation(id: string, title: string) {
  const conversation = await requestApi<ServerConversation>(`/api/conversations/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title: title.trim() }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapConversation(conversation);
}

export async function deleteServerConversation(id: string) {
  await requestApi<void>(`/api/conversations/${id}`, {
    method: 'DELETE',
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
}

export async function deleteServerMessage(conversationId: string, messageId: string) {
  await requestApi<void>(`/api/conversations/${conversationId}/messages/${messageId}`, {
    method: 'DELETE',
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
}

/** 更新消息内容（仅修改 content，不删除消息、不回滚资源） */
export async function updateServerMessage(
  conversationId: string,
  messageId: string,
  content: string,
) {
  const message = await requestApi<ServerMessage>(
    `/api/conversations/${conversationId}/messages/${messageId}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    },
  );

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return message;
}

export async function rewindServerConversation(
  conversationId: string,
  messageId: string,
  assetsOnly = false,
) {
  const result = await requestApi<RewindConversationResponse>(
    `/api/conversations/${conversationId}/rewind`,
    {
      method: 'POST',
      body: JSON.stringify({ messageId, assetsOnly }),
    },
  );

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return result;
}

export async function createServerMessage(conversationId: string, input: CreateMessageInput) {
  const message = await requestApi<ServerMessage>(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      role: input.role,
      content: input.content,
      agent_id: input.agentId,
      model_used: input.modelUsed,
      msg_type: input.type || 'text',
      meta: input.meta,
    }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapMessage(message);
}

export async function createServerAsset(projectId: string, input: CreateAssetInput) {
  const asset = await requestApi<ServerAsset>(`/api/projects/${projectId}/assets`, {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      type: input.type,
      url: input.url,
      metadata: input.metadata,
    }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapAsset(asset);
}

export async function uploadServerAsset(projectId: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const asset = await requestApi<ServerAsset>(`/api/projects/${projectId}/assets/upload`, {
    method: 'POST',
    body: formData,
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapAsset(asset);
}

export async function updateServerAsset(
  assetId: string,
  input: Partial<Pick<Asset, 'name' | 'type' | 'url' | 'metadata'>>,
) {
  const asset = await requestApi<ServerAsset>(`/api/assets/${assetId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: input.name,
      type: input.type,
      url: input.url,
      metadata: input.metadata,
    }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapAsset(asset);
}

export async function getServerAssetBlob(assetId: string) {
  return requestApiBlob(`/api/assets/${assetId}/file`);
}

export async function deleteServerAsset(assetId: string, force = false) {
  await requestApi<void>(`/api/assets/${assetId}${force ? '?force=true' : ''}`, {
    method: 'DELETE',
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
}

export async function getAssetReferences(assetId: string) {
  return requestApi<AssetReferencesResponse>(`/api/assets/${assetId}/references`);
}

export async function searchAssetsAcrossProjects(params: AssetSearchParams = {}) {
  const query = new URLSearchParams();
  if (params.query?.trim()) query.set('query', params.query.trim());
  if (params.assetType) query.set('assetType', params.assetType);
  if (params.projectId) query.set('projectId', params.projectId);
  if (params.favoriteOnly) query.set('favoriteOnly', 'true');
  if (params.ratingMin && params.ratingMin > 0) query.set('ratingMin', String(params.ratingMin));
  if (params.tag?.trim()) query.set('tag', params.tag.trim());
  if (params.sort) query.set('sort', params.sort);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));

  const qs = query.toString();
  const assets = await requestApi<ServerAssetWithProject[]>(
    `/api/assets/search${qs ? `?${qs}` : ''}`,
  );

  return assets.map((asset): AssetWithProject => ({
    ...mapAsset(asset),
    projectName: asset.projectName,
  }));
}

export async function updateAssetTags(assetId: string, tags: string[]) {
  const asset = await requestApi<ServerAsset>(`/api/assets/${assetId}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tags }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapAsset(asset);
}

export async function upsertServerScript(projectId: string, title: string, content: string) {
  const script = await requestApi<ServerScript>(`/api/projects/${projectId}/script`, {
    method: 'PUT',
    body: JSON.stringify({
      title,
      content,
    }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapScript(script);
}

export async function upsertServerStoryboard(projectId: string, lines: StoryboardLine[]) {
  const storyboard = await requestApi<ServerStoryboard>(`/api/projects/${projectId}/storyboard`, {
    method: 'PUT',
    body: JSON.stringify({
      lines: lines.map((line) => ({
        id: line.id,
        sceneNumber: line.sceneNumber,
        description: line.description,
        duration: line.duration,
        assetIds: line.assets.map((asset) => asset.id),
      })),
    }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return mapStoryboard(storyboard);
}

export async function requestServerAiCompletion(input: RequestServerAiCompletionInput) {
  const result = await requestApi<ServerAiChatResult>('/api/ai/chat', {
    method: 'POST',
    headers:
      typeof input.forceStreamFallback === 'boolean'
        ? { 'x-force-stream-fallback': input.forceStreamFallback ? '1' : '0' }
        : undefined,
    body: JSON.stringify({
      conversationId: input.conversationId,
      content: input.content,
      resourceRefs: input.resourceRefs,
      agentId: input.agentId,
      endpointId: input.endpointId,
      model: input.model?.trim() || undefined,
      systemPrompt: input.systemPrompt?.trim() || undefined,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      topP: input.topP,
      frequencyPenalty: input.frequencyPenalty,
      forceStreamFallback: input.forceStreamFallback,
      outputKind: input.outputKind,
      outputItems: input.outputItems,
      allowAssistantActions: input.allowAssistantActions,
      confirmedMessageId: input.confirmedAssistantMessageId,
      confirmedWorkflowGuardMessageId: input.confirmedWorkflowGuardMessageId,
      triggerSource: input.triggerSource,
    }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return result;
}

export async function createAiTask(input: RequestServerAiCompletionInput) {
  const task = await requestApi<AiTask>('/api/ai/tasks', {
    method: 'POST',
    headers:
      typeof input.forceStreamFallback === 'boolean'
        ? { 'x-force-stream-fallback': input.forceStreamFallback ? '1' : '0' }
        : undefined,
    body: JSON.stringify({
      conversationId: input.conversationId,
      content: input.content,
      resourceRefs: input.resourceRefs,
      agentId: input.agentId,
      endpointId: input.endpointId,
      model: input.model?.trim() || undefined,
      systemPrompt: input.systemPrompt?.trim() || undefined,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      topP: input.topP,
      frequencyPenalty: input.frequencyPenalty,
      forceStreamFallback: input.forceStreamFallback,
      outputKind: input.outputKind,
      outputItems: input.outputItems,
      allowAssistantActions: input.allowAssistantActions,
      confirmedMessageId: input.confirmedAssistantMessageId,
      confirmedWorkflowGuardMessageId: input.confirmedWorkflowGuardMessageId,
      triggerSource: input.triggerSource,
    }),
  });

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
  return task;
}

export async function testServerAiCompletion(
  settings: AiSettings,
  content = '请只回复“连接成功”。',
  options?: {
    forceStreamFallback?: boolean;
  },
) {
  return requestApi<ServerAiChatResult>('/api/ai/test', {
    method: 'POST',
    headers:
      typeof options?.forceStreamFallback === 'boolean'
        ? { 'x-force-stream-fallback': options.forceStreamFallback ? '1' : '0' }
        : undefined,
    body: JSON.stringify({
      provider: settings.provider,
      baseUrl: settings.baseUrl.trim(),
      apiKey: settings.apiKey.trim(),
      model: settings.model.trim(),
      systemPrompt: settings.systemPrompt.trim() || undefined,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      topP: settings.topP,
      frequencyPenalty: settings.frequencyPenalty,
      forceStreamFallback: options?.forceStreamFallback,
      content,
    }),
  });
}

export async function testServerAiCompletionByEndpoint(
  endpointId: string,
  settings: AiSettings,
  content = '请只回复“连接成功”。',
  options?: {
    forceStreamFallback?: boolean;
  },
) {
  return requestApi<ServerAiChatResult>(`/api/ai/endpoints/${endpointId}/test`, {
    method: 'POST',
    headers:
      typeof options?.forceStreamFallback === 'boolean'
        ? { 'x-force-stream-fallback': options.forceStreamFallback ? '1' : '0' }
        : undefined,
    body: JSON.stringify({
      provider: settings.provider,
      baseUrl: settings.baseUrl.trim(),
      model: settings.model.trim(),
      systemPrompt: settings.systemPrompt.trim() || undefined,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      topP: settings.topP,
      frequencyPenalty: settings.frequencyPenalty,
      forceStreamFallback: options?.forceStreamFallback,
      content,
    }),
  });
}

export async function requestServerAiCompletionStream(
  input: RequestServerAiCompletionInput,
  onMessage: (chunk: string) => void,
): Promise<void> {
  const session = await ensureServerSession();
  const baseUrl = await getServerBaseUrl();
  const url = `${baseUrl}/api/ai/chat/stream`;

  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.token}`,
    ...(typeof input.forceStreamFallback === 'boolean'
      ? { 'x-force-stream-fallback': input.forceStreamFallback ? '1' : '0' }
      : {}),
  });
  const requestId = createClientRequestId();
  headers.set(REQUEST_ID_HEADER, requestId);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        conversationId: input.conversationId,
        content: input.content,
        resourceRefs: input.resourceRefs,
        agentId: input.agentId,
        endpointId: input.endpointId,
        model: input.model?.trim() || undefined,
        systemPrompt: input.systemPrompt?.trim() || undefined,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        topP: input.topP,
        frequencyPenalty: input.frequencyPenalty,
        forceStreamFallback: input.forceStreamFallback,
        outputKind: input.outputKind,
        outputItems: input.outputItems,
        allowAssistantActions: input.allowAssistantActions,
        confirmedMessageId: input.confirmedAssistantMessageId,
        confirmedWorkflowGuardMessageId: input.confirmedWorkflowGuardMessageId,
      }),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(appendRequestId('流式请求失败，请检查服务端与网络连接', requestId));
    }
    throw error;
  }

  const responseRequestId = response.headers.get(REQUEST_ID_HEADER) || requestId;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      appendRequestId(`流式请求失败 (${response.status}): ${text}`, responseRequestId),
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error(appendRequestId('无法初始化响应流', responseRequestId));

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';
  let currentDataLines: string[] = [];
  let sawDone = false;
  let streamError: string | null = null;
  let receivedChunkCount = 0;

  const dispatchEvent = () => {
    if (currentDataLines.length === 0) {
      currentEvent = 'message';
      return;
    }

    const eventType = currentEvent || 'message';
    const data = currentDataLines.join('\n');
    currentEvent = 'message';
    currentDataLines = [];

    if (eventType === 'error') {
      streamError = data.trim() || '流式请求失败';
      return;
    }

    if (eventType === 'done') {
      sawDone = true;
      return;
    }

    if (data.trim() === '[DONE]') {
      sawDone = true;
      return;
    }

    onMessage(data);
    receivedChunkCount++;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;

    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        dispatchEvent();
        continue;
      }

      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim() || 'message';
        continue;
      }

      if (line.startsWith('data:')) {
        currentDataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    const line = buffer.replace(/\r$/, '');
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim() || 'message';
    } else if (line.startsWith('data:')) {
      currentDataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
    }
  }

  dispatchEvent();

  if (streamError && receivedChunkCount === 0) {
    throw new Error(appendRequestId(streamError, responseRequestId));
  }

  if (!sawDone && receivedChunkCount === 0) {
    throw new Error(appendRequestId('流式响应未正常完成', responseRequestId));
  }

  invalidateApiCache(CACHE_KEYS.workspaceBootstrap);
}

const endpointApi = createEndpointApi({
  requestApi,
  readCachedApi,
  invalidateApiCache,
  cacheKeys: {
    aiEndpoints: CACHE_KEYS.aiEndpoints,
  },
  cacheTtls: {
    aiEndpoints: CACHE_TTLS.aiEndpoints,
  },
});

export const listServerAiEndpoints = endpointApi.listServerAiEndpoints;
export const createServerAiEndpoint = endpointApi.createServerAiEndpoint;
export const updateServerAiEndpoint = endpointApi.updateServerAiEndpoint;
export const deleteServerAiEndpoint = endpointApi.deleteServerAiEndpoint;
export const listServerAiEndpointModels = endpointApi.listServerAiEndpointModels;
export const listServerAiEndpointCapabilities = endpointApi.listServerAiEndpointCapabilities;
export const upsertServerAiEndpointCapability = endpointApi.upsertServerAiEndpointCapability;

const notificationApi = createNotificationApi({
  requestApi,
  readCachedApi,
  invalidateApiCache,
  cacheKeys: {
    notificationChannels: CACHE_KEYS.notificationChannels,
  },
  cacheTtls: {
    notificationChannels: CACHE_TTLS.notificationChannels,
  },
});

export const listNotificationChannels = notificationApi.listNotificationChannels;
export const createNotificationChannel = notificationApi.createNotificationChannel;
export const updateNotificationChannel = notificationApi.updateNotificationChannel;
export const deleteNotificationChannel = notificationApi.deleteNotificationChannel;
export const testNotificationChannel = notificationApi.testNotificationChannel;
export const listNotificationEvents = notificationApi.listNotificationEvents;

const agentApi = createAgentApi({
  requestApi,
  invalidateApiCache,
  cacheKeys: {
    workspaceBootstrap: CACHE_KEYS.workspaceBootstrap,
  },
});

export const listServerAgents = agentApi.listServerAgents;
export const createServerAgent = agentApi.createServerAgent;
export const updateServerAgent = agentApi.updateServerAgent;
export const deleteServerAgent = agentApi.deleteServerAgent;
export const listProjectAgents = agentApi.listProjectAgents;
export const assignProjectAgent = agentApi.assignProjectAgent;
export const createProjectAgent = agentApi.createProjectAgent;
export const removeProjectAgent = agentApi.removeProjectAgent;

const usageTaskPipelineApi = createUsageTaskPipelineApi(requestApi);

export const getUsageSummary = usageTaskPipelineApi.getUsageSummary;
export const getUsageRecords = usageTaskPipelineApi.getUsageRecords;
export const listAiTasks = usageTaskPipelineApi.listAiTasks;
export const getAiTask = usageTaskPipelineApi.getAiTask;
export const createPipelineRun = usageTaskPipelineApi.createPipelineRun;
export const getPipelineRun = usageTaskPipelineApi.getPipelineRun;
export const getPipelineOptimizations = usageTaskPipelineApi.getPipelineOptimizations;
export const listPipelineRuns = usageTaskPipelineApi.listPipelineRuns;
export const pausePipelineRun = usageTaskPipelineApi.pausePipelineRun;
export const resumePipelineRun = usageTaskPipelineApi.resumePipelineRun;
export const cancelPipelineRun = usageTaskPipelineApi.cancelPipelineRun;
export const retryPipelineStep = usageTaskPipelineApi.retryPipelineStep;
export const getReviewQueue = usageTaskPipelineApi.getReviewQueue;
export const submitReviewDecision = usageTaskPipelineApi.submitReviewDecision;
export const listStepReviews = usageTaskPipelineApi.listStepReviews;
export const streamPipelineRun = usageTaskPipelineApi.streamPipelineRun;

const budgetApi = createBudgetApi(requestApi);

export const getBudgetStatus = budgetApi.getBudgetStatus;
export const updateBudgetSettings = budgetApi.updateBudgetSettings;
export const listBudgetBlocks = budgetApi.listBudgetBlocks;

const collaborationApi = createCollaborationApi({ requestApi });

export const createCollaborationSession = collaborationApi.createSession;
export const getCollaborationSession = collaborationApi.getSession;
export const getActiveCollaborationSession = collaborationApi.getActiveSession;
export const getCollaborationReadiness = collaborationApi.getReadiness;
export const dispatchCollaboration = collaborationApi.dispatch;
export const sendCollaborationMessage = collaborationApi.sendMessage;
export const listCollaborationMessages = collaborationApi.listMessages;
export const checkCollaborationLoop = collaborationApi.loopCheck;
export const admitCollaboration = collaborationApi.admit;
export const haltCollaboration = collaborationApi.halt;
export const streamCollaborationEvents = collaborationApi.streamEvents;

const imageGenApi = createImageGenApi(requestApi, {
  invalidateWorkspaceCache: () => invalidateApiCache(CACHE_KEYS.workspaceBootstrap),
});

export const listImageGenerations = imageGenApi.listGenerations;
export const getImageGeneration = imageGenApi.getGeneration;
export const createImageGeneration = imageGenApi.createGeneration;
export const getImageCredits = imageGenApi.getCredits;
export const listImageCreditTransactions = imageGenApi.listCreditTransactions;

const videoGenApi = createVideoGenApi(requestApi, {
  invalidateWorkspaceCache: () => invalidateApiCache(CACHE_KEYS.workspaceBootstrap),
});

export const listVideoGenerations = videoGenApi.listGenerations;
export const getVideoGeneration = videoGenApi.getGeneration;
export const createVideoGeneration = videoGenApi.createGeneration;

const policyApi = createPolicyApi(requestApi);

export const getActionPolicy = policyApi.getPolicy;
export const updateActionPolicy = policyApi.updatePolicy;
export const listActionAudits = policyApi.listAudits;
export const createConfirmationToken = policyApi.createConfirmationToken;
export const consumeConfirmationToken = policyApi.consumeConfirmationToken;

const opsApi = createOpsApi(requestApi);

export const getOpsOverview = opsApi.getOverview;
export const listOpsHeartbeats = opsApi.listHeartbeats;
export const listOpsFindings = opsApi.listFindings;
