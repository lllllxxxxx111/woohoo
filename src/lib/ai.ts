import type { AiProvider, AiSettings } from '../types';
import { logger } from './logger';
import { getServerBaseUrl } from './serverApi';

/** 获取认证请求头 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const rawSession = window.localStorage.getItem('woohoo-server-session-v1');
    if (rawSession) {
      const session = JSON.parse(rawSession) as { token?: string };
      if (session.token) {
        headers['Authorization'] = `Bearer ${session.token}`;
      }
    }
  } catch {
    // ignore
  }
  return headers;
}

export interface AiProviderPreset {
  label: string;
  description: string;
  baseUrl: string;
  model: string;
  requiresApiKey: boolean;
  apiKeyPlaceholder: string;
}

export interface AiRequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface AiCompletionResult {
  content: string;
  model: string;
  usage?: AiResponseUsage;
}

const DEFAULT_SYSTEM_PROMPT =
  '你是 Woohoo Studio 里的创作搭档。回答要直接、具体，优先给出可执行内容，默认使用简体中文。';
const KNOWN_AI_PROVIDERS: readonly AiProvider[] = [
  'mock',
  'deepseek',
  'moonshot',
  'openai',
  'openrouter',
  'ollama',
  'custom',
];

function parseEnvAiProvider(value: unknown): AiProvider | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return KNOWN_AI_PROVIDERS.includes(normalized as AiProvider) ? (normalized as AiProvider) : null;
}

function parseEnvBoolean(value: unknown): boolean | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return null;
}

const ENV_DEFAULT_AI_PROVIDER = parseEnvAiProvider(import.meta.env.VITE_DEFAULT_AI_PROVIDER);
const ENV_DEFAULT_AI_BASE_URL = import.meta.env.VITE_DEFAULT_AI_BASE_URL?.trim() || '';
const ENV_DEFAULT_AI_MODEL = import.meta.env.VITE_DEFAULT_AI_MODEL?.trim() || '';
const ENV_DEFAULT_AI_SYSTEM_PROMPT = import.meta.env.VITE_DEFAULT_AI_SYSTEM_PROMPT?.trim() || '';
const ENV_DEFAULT_AI_TEMPERATURE = Number.parseFloat(
  import.meta.env.VITE_DEFAULT_AI_TEMPERATURE || '',
);
const ENV_DEFAULT_AI_MAX_TOKENS = Number.parseInt(
  import.meta.env.VITE_DEFAULT_AI_MAX_TOKENS || '',
  10,
);
const ENV_DEFAULT_AI_TOP_P = Number.parseFloat(import.meta.env.VITE_DEFAULT_AI_TOP_P || '');
const ENV_DEFAULT_AI_FREQUENCY_PENALTY = Number.parseFloat(
  import.meta.env.VITE_DEFAULT_AI_FREQUENCY_PENALTY || '',
);
const ENV_DEFAULT_AI_FORCE_STREAM_FALLBACK = parseEnvBoolean(
  import.meta.env.VITE_DEFAULT_AI_FORCE_STREAM_FALLBACK,
);
const ENV_DEFAULT_MULTI_AGENT_BETA_ENABLED = parseEnvBoolean(
  import.meta.env.VITE_DEFAULT_MULTI_AGENT_BETA_ENABLED,
);
const ENV_DEFAULT_PROMPT_OPTIMIZER_BETA_ENABLED = parseEnvBoolean(
  import.meta.env.VITE_DEFAULT_PROMPT_OPTIMIZER_BETA_ENABLED,
);
const ENV_DEFAULT_PIPELINE_RETRY_BACKOFF_SEC = Number.parseInt(
  import.meta.env.VITE_DEFAULT_PIPELINE_RETRY_BACKOFF_SEC || '',
  10,
);
const ENV_DEFAULT_PIPELINE_RETRY_MAX_BACKOFF_SEC = Number.parseInt(
  import.meta.env.VITE_DEFAULT_PIPELINE_RETRY_MAX_BACKOFF_SEC || '',
  10,
);

type ChatCompletionResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: AiResponseUsage;
  error?: {
    message?: string;
  };
};

export const AI_PROVIDER_PRESETS: Record<AiProvider, AiProviderPreset> = {
  mock: {
    label: '本地 Mock AI',
    description: 'Woohoo 内置的本地调试模型，零配置即可联通前后端聊天流程。',
    baseUrl: 'http://127.0.0.1:8080/mock/v1',
    model: 'woohoo-local-mock',
    requiresApiKey: false,
    apiKeyPlaceholder: '本地 Mock 服务无需 Key',
  },
  deepseek: {
    label: 'DeepSeek',
    description: '中文创作性价比高，接口为 OpenAI 兼容协议。',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
  },
  moonshot: {
    label: 'Moonshot / Kimi',
    description: '适合长文本理解，使用 Moonshot 的兼容接口。',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
  },
  openai: {
    label: 'OpenAI',
    description: '官方 OpenAI 兼容接口。',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
  },
  openrouter: {
    label: 'OpenRouter',
    description: '统一转发多个模型供应商，走 OpenAI 兼容协议。',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-or-...',
  },
  ollama: {
    label: 'Ollama',
    description: '本地模型服务，默认无需 API Key。',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b-instruct',
    requiresApiKey: false,
    apiKeyPlaceholder: '本地服务通常留空',
  },
  custom: {
    label: '自定义兼容服务',
    description: '填写任意 OpenAI 兼容网关地址。',
    baseUrl: 'https://your-endpoint.example.com/v1',
    model: 'your-model',
    requiresApiKey: true,
    apiKeyPlaceholder: '按你的服务商要求填写',
  },
};

export const AI_PROVIDER_OPTIONS = Object.entries(AI_PROVIDER_PRESETS).map(([value, preset]) => ({
  value: value as AiProvider,
  label: preset.label,
  description: preset.description,
}));

function isKnownAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && value in AI_PROVIDER_PRESETS;
}

export function normalizeAiBaseUrl(provider: AiProvider, baseUrl: string): string {
  const normalized = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) {
    return normalized;
  }

  if (!['openai', 'deepseek', 'moonshot', 'openrouter'].includes(provider)) {
    return normalized;
  }

  try {
    const url = new URL(normalized);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1';
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    return normalized;
  }

  return normalized;
}

export function normalizeAiSettingsPayload(settings: AiSettings): AiSettings {
  const normalizedPipelineRetryBackoffSec = Number.isFinite(settings.pipelineRetryBackoffSec)
    ? Math.min(300, Math.max(1, Math.round(settings.pipelineRetryBackoffSec)))
    : 4;
  const normalizedPipelineRetryMaxBackoffSec = Number.isFinite(settings.pipelineRetryMaxBackoffSec)
    ? Math.min(
      900,
      Math.max(
        normalizedPipelineRetryBackoffSec,
        Math.round(settings.pipelineRetryMaxBackoffSec),
      ),
    )
    : Math.max(90, normalizedPipelineRetryBackoffSec);

  return {
    ...settings,
    baseUrl: normalizeAiBaseUrl(settings.provider, settings.baseUrl),
    model: settings.model.trim(),
    apiKey: settings.apiKey.trim(),
    systemPrompt: settings.systemPrompt.trim(),
    forceStreamFallback: settings.forceStreamFallback !== false,
    multiAgentBetaEnabled: settings.multiAgentBetaEnabled === true,
    promptOptimizerBetaEnabled: settings.promptOptimizerBetaEnabled === true,
    topP: Number.isFinite(settings.topP) ? Math.min(1, Math.max(0, settings.topP)) : 1,
    frequencyPenalty: Number.isFinite(settings.frequencyPenalty)
      ? Math.min(2, Math.max(-2, settings.frequencyPenalty))
      : 0,
    pipelineRetryBackoffSec: normalizedPipelineRetryBackoffSec,
    pipelineRetryMaxBackoffSec: normalizedPipelineRetryMaxBackoffSec,
  };
}

function getEnvironmentAiSettings(): AiSettings | null {
  if (!ENV_DEFAULT_AI_PROVIDER) {
    return null;
  }

  const preset = AI_PROVIDER_PRESETS[ENV_DEFAULT_AI_PROVIDER];
  return {
    provider: ENV_DEFAULT_AI_PROVIDER,
    baseUrl: normalizeAiBaseUrl(ENV_DEFAULT_AI_PROVIDER, ENV_DEFAULT_AI_BASE_URL || preset.baseUrl),
    model: ENV_DEFAULT_AI_MODEL || preset.model,
    apiKey: '',
    systemPrompt: ENV_DEFAULT_AI_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    temperature: Number.isFinite(ENV_DEFAULT_AI_TEMPERATURE) ? ENV_DEFAULT_AI_TEMPERATURE : 0.7,
    maxTokens:
      Number.isFinite(ENV_DEFAULT_AI_MAX_TOKENS) && ENV_DEFAULT_AI_MAX_TOKENS > 0
        ? ENV_DEFAULT_AI_MAX_TOKENS
        : 1200,
    topP: Number.isFinite(ENV_DEFAULT_AI_TOP_P) ? ENV_DEFAULT_AI_TOP_P : 1,
    frequencyPenalty: Number.isFinite(ENV_DEFAULT_AI_FREQUENCY_PENALTY)
      ? ENV_DEFAULT_AI_FREQUENCY_PENALTY
      : 0,
    forceStreamFallback: ENV_DEFAULT_AI_FORCE_STREAM_FALLBACK ?? true,
    multiAgentBetaEnabled: ENV_DEFAULT_MULTI_AGENT_BETA_ENABLED ?? false,
    promptOptimizerBetaEnabled: ENV_DEFAULT_PROMPT_OPTIMIZER_BETA_ENABLED ?? false,
    pipelineRetryBackoffSec:
      Number.isFinite(ENV_DEFAULT_PIPELINE_RETRY_BACKOFF_SEC) &&
        ENV_DEFAULT_PIPELINE_RETRY_BACKOFF_SEC > 0
        ? ENV_DEFAULT_PIPELINE_RETRY_BACKOFF_SEC
        : 4,
    pipelineRetryMaxBackoffSec:
      Number.isFinite(ENV_DEFAULT_PIPELINE_RETRY_MAX_BACKOFF_SEC) &&
        ENV_DEFAULT_PIPELINE_RETRY_MAX_BACKOFF_SEC > 0
        ? ENV_DEFAULT_PIPELINE_RETRY_MAX_BACKOFF_SEC
        : 90,
  };
}

function buildPresetSettings(
  provider: AiProvider,
  override?: Partial<AiSettings> | null,
): AiSettings {
  const preset = AI_PROVIDER_PRESETS[provider];

  return {
    provider,
    baseUrl: normalizeAiBaseUrl(provider, override?.baseUrl?.trim() || preset.baseUrl),
    model: override?.model?.trim() || preset.model,
    apiKey: override?.apiKey?.trim() || '',
    systemPrompt: override?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    temperature: typeof override?.temperature === 'number' ? override.temperature : 0.7,
    maxTokens: typeof override?.maxTokens === 'number' ? override.maxTokens : 1200,
    topP: typeof override?.topP === 'number' ? override.topP : 1,
    frequencyPenalty:
      typeof override?.frequencyPenalty === 'number' ? override.frequencyPenalty : 0,
    forceStreamFallback:
      typeof override?.forceStreamFallback === 'boolean'
        ? override.forceStreamFallback
        : (ENV_DEFAULT_AI_FORCE_STREAM_FALLBACK ?? true),
    multiAgentBetaEnabled:
      typeof override?.multiAgentBetaEnabled === 'boolean'
        ? override.multiAgentBetaEnabled
        : (ENV_DEFAULT_MULTI_AGENT_BETA_ENABLED ?? false),
    promptOptimizerBetaEnabled:
      typeof override?.promptOptimizerBetaEnabled === 'boolean'
        ? override.promptOptimizerBetaEnabled
        : (ENV_DEFAULT_PROMPT_OPTIMIZER_BETA_ENABLED ?? false),
    pipelineRetryBackoffSec:
      typeof override?.pipelineRetryBackoffSec === 'number'
        ? override.pipelineRetryBackoffSec
        : Number.isFinite(ENV_DEFAULT_PIPELINE_RETRY_BACKOFF_SEC) &&
          ENV_DEFAULT_PIPELINE_RETRY_BACKOFF_SEC > 0
          ? ENV_DEFAULT_PIPELINE_RETRY_BACKOFF_SEC
          : 4,
    pipelineRetryMaxBackoffSec:
      typeof override?.pipelineRetryMaxBackoffSec === 'number'
        ? override.pipelineRetryMaxBackoffSec
        : Number.isFinite(ENV_DEFAULT_PIPELINE_RETRY_MAX_BACKOFF_SEC) &&
          ENV_DEFAULT_PIPELINE_RETRY_MAX_BACKOFF_SEC > 0
          ? ENV_DEFAULT_PIPELINE_RETRY_MAX_BACKOFF_SEC
          : 90,
  };
}

export function createAiSettings(
  provider: AiProvider = getEnvironmentAiSettings()?.provider || 'mock',
): AiSettings {
  const environmentSettings = getEnvironmentAiSettings();
  const override = environmentSettings?.provider === provider ? environmentSettings : null;
  return buildPresetSettings(provider, override);
}

/** 验证AI设置是否完整有效 */
export function validateAiSettings(settings: Partial<AiSettings> | null | undefined): string[] {
  const provider = settings?.provider;
  const preset = isKnownAiProvider(provider) ? AI_PROVIDER_PRESETS[provider] : null;
  const errors: string[] = [];

  if (!preset) {
    errors.push('请先选择模型提供商');
  }

  /** 检查接口地址是否为空 */
  if (!(settings?.baseUrl || '').trim()) {
    errors.push('请填写接口地址');
  }

  /** 检查模型名称是否为空 */
  if (!(settings?.model || '').trim()) {
    errors.push('请填写模型名称');
  }

  /** 检查API Key（如果需要） */
  if (preset?.requiresApiKey && !(settings?.apiKey || '').trim()) {
    errors.push('请填写 API Key');
  }

  /** 验证温度参数范围 */
  if (
    !Number.isFinite(settings?.temperature) ||
    (settings?.temperature ?? 0) < 0 ||
    (settings?.temperature ?? 0) > 2
  ) {
    errors.push('Temperature 需在 0 到 2 之间');
  }

  if (!Number.isFinite(settings?.topP) || (settings?.topP ?? 0) < 0 || (settings?.topP ?? 0) > 1) {
    errors.push('Top P 需在 0 到 1 之间');
  }

  if (
    !Number.isFinite(settings?.frequencyPenalty) ||
    (settings?.frequencyPenalty ?? 0) < -2 ||
    (settings?.frequencyPenalty ?? 0) > 2
  ) {
    errors.push('Frequency Penalty 需在 -2 到 2 之间');
  }

  /** 验证最大输出上限 */
  if (!Number.isFinite(settings?.maxTokens) || (settings?.maxTokens ?? 0) < 1) {
    errors.push('最大输出上限需大于 0');
  }

  return errors;
}

/** 判断AI设置是否已就绪 */
export function isAiSettingsReady(settings: AiSettings): boolean {
  return validateAiSettings(settings).length === 0;
}

export function applyProviderPreset(
  provider: AiProvider,
  current?: Partial<AiSettings>,
): AiSettings {
  const presetSettings = createAiSettings(provider);

  return {
    ...presetSettings,
    ...current,
    provider,
    baseUrl: presetSettings.baseUrl,
    model: presetSettings.model,
    apiKey: current?.apiKey ?? '',
  };
}

export function hydrateAiSettings(value?: Partial<AiSettings> | null): AiSettings {
  const environmentSettings = getEnvironmentAiSettings();

  if (environmentSettings && shouldAdoptEnvironmentDefaults(value, environmentSettings)) {
    return environmentSettings;
  }

  const provider =
    value?.provider && value.provider in AI_PROVIDER_PRESETS
      ? value.provider
      : environmentSettings?.provider || 'mock';

  if (shouldMigrateToMockPreset(value, provider)) {
    return createAiSettings('mock');
  }

  const defaults = createAiSettings(provider);

  return {
    ...defaults,
    ...value,
    provider,
    baseUrl: normalizeAiBaseUrl(provider, value?.baseUrl?.trim() || defaults.baseUrl),
    model: value?.model?.trim() ?? defaults.model,
    apiKey: value?.apiKey?.trim() || '',
    systemPrompt: value?.systemPrompt?.trim() || defaults.systemPrompt,
    temperature: typeof value?.temperature === 'number' ? value.temperature : defaults.temperature,
    maxTokens: typeof value?.maxTokens === 'number' ? value.maxTokens : defaults.maxTokens,
    topP: typeof value?.topP === 'number' ? value.topP : defaults.topP,
    frequencyPenalty:
      typeof value?.frequencyPenalty === 'number'
        ? value.frequencyPenalty
        : defaults.frequencyPenalty,
    forceStreamFallback:
      typeof value?.forceStreamFallback === 'boolean'
        ? value.forceStreamFallback
        : defaults.forceStreamFallback,
    multiAgentBetaEnabled:
      typeof value?.multiAgentBetaEnabled === 'boolean'
        ? value.multiAgentBetaEnabled
        : defaults.multiAgentBetaEnabled,
    promptOptimizerBetaEnabled:
      typeof value?.promptOptimizerBetaEnabled === 'boolean'
        ? value.promptOptimizerBetaEnabled
        : defaults.promptOptimizerBetaEnabled,
    pipelineRetryBackoffSec:
      typeof value?.pipelineRetryBackoffSec === 'number'
        ? value.pipelineRetryBackoffSec
        : defaults.pipelineRetryBackoffSec,
    pipelineRetryMaxBackoffSec:
      typeof value?.pipelineRetryMaxBackoffSec === 'number'
        ? value.pipelineRetryMaxBackoffSec
        : defaults.pipelineRetryMaxBackoffSec,
  };
}

function shouldAdoptEnvironmentDefaults(
  value: Partial<AiSettings> | null | undefined,
  environmentSettings: AiSettings | null,
): boolean {
  if (!environmentSettings) {
    return false;
  }

  if (!value) {
    return true;
  }

  const mockDefaults = buildPresetSettings('mock');
  const normalizedProvider = value.provider || 'mock';
  const normalizedBaseUrl = value.baseUrl?.trim() || mockDefaults.baseUrl;
  const normalizedModel = value.model?.trim() || mockDefaults.model;
  const normalizedApiKey = value.apiKey?.trim() || '';
  const normalizedPrompt = value.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  const normalizedTemperature =
    typeof value.temperature === 'number' ? value.temperature : mockDefaults.temperature;
  const normalizedMaxTokens =
    typeof value.maxTokens === 'number' ? value.maxTokens : mockDefaults.maxTokens;
  const normalizedTopP = typeof value.topP === 'number' ? value.topP : mockDefaults.topP;
  const normalizedFrequencyPenalty =
    typeof value.frequencyPenalty === 'number'
      ? value.frequencyPenalty
      : mockDefaults.frequencyPenalty;
  const normalizedForceStreamFallback =
    typeof value.forceStreamFallback === 'boolean'
      ? value.forceStreamFallback
      : mockDefaults.forceStreamFallback;
  const normalizedMultiAgentBetaEnabled =
    typeof value.multiAgentBetaEnabled === 'boolean'
      ? value.multiAgentBetaEnabled
      : mockDefaults.multiAgentBetaEnabled;
  const normalizedPromptOptimizerBetaEnabled =
    typeof value.promptOptimizerBetaEnabled === 'boolean'
      ? value.promptOptimizerBetaEnabled
      : mockDefaults.promptOptimizerBetaEnabled;
  const normalizedPipelineRetryBackoffSec =
    typeof value.pipelineRetryBackoffSec === 'number'
      ? value.pipelineRetryBackoffSec
      : mockDefaults.pipelineRetryBackoffSec;
  const normalizedPipelineRetryMaxBackoffSec =
    typeof value.pipelineRetryMaxBackoffSec === 'number'
      ? value.pipelineRetryMaxBackoffSec
      : mockDefaults.pipelineRetryMaxBackoffSec;

  const isUnconfiguredMock =
    normalizedProvider === 'mock' &&
    normalizedBaseUrl === mockDefaults.baseUrl &&
    normalizedModel === mockDefaults.model &&
    normalizedApiKey === '' &&
    normalizedPrompt === mockDefaults.systemPrompt &&
    normalizedTemperature === mockDefaults.temperature &&
    normalizedMaxTokens === mockDefaults.maxTokens &&
    normalizedTopP === mockDefaults.topP &&
    normalizedFrequencyPenalty === mockDefaults.frequencyPenalty &&
    normalizedForceStreamFallback === mockDefaults.forceStreamFallback &&
    normalizedMultiAgentBetaEnabled === mockDefaults.multiAgentBetaEnabled &&
    normalizedPromptOptimizerBetaEnabled === mockDefaults.promptOptimizerBetaEnabled &&
    normalizedPipelineRetryBackoffSec === mockDefaults.pipelineRetryBackoffSec &&
    normalizedPipelineRetryMaxBackoffSec === mockDefaults.pipelineRetryMaxBackoffSec;

  const isSameGatewayButMissingKey =
    normalizedProvider === environmentSettings.provider &&
    normalizedBaseUrl === environmentSettings.baseUrl &&
    normalizedModel === environmentSettings.model &&
    normalizedApiKey === '';

  return isUnconfiguredMock || isSameGatewayButMissingKey;
}

function shouldMigrateToMockPreset(
  value: Partial<AiSettings> | null | undefined,
  provider: AiProvider,
): boolean {
  if (!value || provider === 'mock') {
    return false;
  }

  const defaults = createAiSettings(provider);
  const normalizedBaseUrl = value.baseUrl?.trim() || defaults.baseUrl;
  const normalizedModel = value.model?.trim() || defaults.model;
  const normalizedApiKey = value.apiKey?.trim() || '';
  const normalizedPrompt = value.systemPrompt?.trim() || defaults.systemPrompt;
  const normalizedTemperature =
    typeof value.temperature === 'number' ? value.temperature : defaults.temperature;
  const normalizedMaxTokens =
    typeof value.maxTokens === 'number' ? value.maxTokens : defaults.maxTokens;
  const normalizedTopP = typeof value.topP === 'number' ? value.topP : defaults.topP;
  const normalizedFrequencyPenalty =
    typeof value.frequencyPenalty === 'number' ? value.frequencyPenalty : defaults.frequencyPenalty;
  const normalizedForceStreamFallback =
    typeof value.forceStreamFallback === 'boolean'
      ? value.forceStreamFallback
      : defaults.forceStreamFallback;
  const normalizedMultiAgentBetaEnabled =
    typeof value.multiAgentBetaEnabled === 'boolean'
      ? value.multiAgentBetaEnabled
      : defaults.multiAgentBetaEnabled;
  const normalizedPromptOptimizerBetaEnabled =
    typeof value.promptOptimizerBetaEnabled === 'boolean'
      ? value.promptOptimizerBetaEnabled
      : defaults.promptOptimizerBetaEnabled;
  const normalizedPipelineRetryBackoffSec =
    typeof value.pipelineRetryBackoffSec === 'number'
      ? value.pipelineRetryBackoffSec
      : defaults.pipelineRetryBackoffSec;
  const normalizedPipelineRetryMaxBackoffSec =
    typeof value.pipelineRetryMaxBackoffSec === 'number'
      ? value.pipelineRetryMaxBackoffSec
      : defaults.pipelineRetryMaxBackoffSec;

  return (
    normalizedBaseUrl === defaults.baseUrl &&
    normalizedModel === defaults.model &&
    normalizedApiKey === '' &&
    normalizedPrompt === defaults.systemPrompt &&
    normalizedTemperature === defaults.temperature &&
    normalizedMaxTokens === defaults.maxTokens &&
    normalizedTopP === defaults.topP &&
    normalizedFrequencyPenalty === defaults.frequencyPenalty &&
    normalizedForceStreamFallback === defaults.forceStreamFallback &&
    normalizedMultiAgentBetaEnabled === defaults.multiAgentBetaEnabled &&
    normalizedPromptOptimizerBetaEnabled === defaults.promptOptimizerBetaEnabled &&
    normalizedPipelineRetryBackoffSec === defaults.pipelineRetryBackoffSec &&
    normalizedPipelineRetryMaxBackoffSec === defaults.pipelineRetryMaxBackoffSec
  );
}

/** 发送AI完成请求 */
export async function requestAiCompletion(
  settings: AiSettings,
  messages: AiRequestMessage[],
): Promise<AiCompletionResult> {
  const errors = validateAiSettings(settings);

  if (errors.length > 0) {
    throw new Error(errors[0]);
  }

  const url = buildChatUrl(settings.baseUrl);
  const headers = new Headers({
    'Content-Type': 'application/json',
  });

  if ((settings.apiKey || '').trim()) {
    headers.set('Authorization', `Bearer ${(settings.apiKey || '').trim()}`);
  }

  const preferStream = settings.forceStreamFallback !== false;
  if (preferStream) {
    try {
      return await requestAiCompletionStream(url, headers, settings, messages);
    } catch (streamError) {
      logger.warn('[requestAiCompletion] stream mode failed, fallback to non-stream', streamError);
    }
  }

  const nonStreamResult = await requestAiCompletionNonStream(url, headers, settings, messages);
  if (nonStreamResult.content) {
    return nonStreamResult;
  }

  if (!preferStream) {
    return nonStreamResult;
  }

  return requestAiCompletionStream(url, headers, settings, messages);
}

/** 构建聊天请求URL */
function buildChatUrl(baseUrl: string): string {
  const normalized = (baseUrl || '').trim().replace(/\/+$/, '');

  // 检查是否已经包含完整的 chat completions 路径
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }

  // 检查是否已经包含 /v1 路径
  if (/\/v\d+$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }

  // 检查是否是常见的 API 端点格式
  const commonPatterns = [
    /api\.openai\.com/i,
    /api\.anthropic\.com/i,
    /api\.google\.com/i,
    /api\.azure\.com/i,
  ];

  for (const pattern of commonPatterns) {
    if (pattern.test(normalized)) {
      // 如果是常见 API 端点且没有 /v1 路径，添加 /v1
      if (!/\/v\d+/.test(normalized)) {
        return `${normalized}/v1/chat/completions`;
      }
      return `${normalized}/chat/completions`;
    }
  }

  // 默认情况：直接添加 /chat/completions
  return `${normalized}/chat/completions`;
}

async function requestAiCompletionNonStream(
  url: string,
  headers: Headers,
  settings: AiSettings,
  messages: AiRequestMessage[],
): Promise<AiCompletionResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: (settings.model || '').trim(),
      messages,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      top_p: settings.topP,
      frequency_penalty: settings.frequencyPenalty,
      stream: false,
    }),
  });

  const rawText = await response.text();
  const parsed = parseResponse(rawText);

  if (!response.ok) {
    const message =
      parsed?.error?.message ||
      parsed?.choices?.[0]?.message?.content ||
      rawText ||
      `请求失败 (${response.status})`;
    throw new Error(normalizeErrorMessage(message, response.status));
  }

  const content = extractTextContent(parsed?.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error('模型没有返回可显示的内容');
  }

  return {
    content,
    model: parsed?.model || (settings.model || '').trim(),
    usage: parsed?.usage,
  };
}

async function requestAiCompletionStream(
  url: string,
  headers: Headers,
  settings: AiSettings,
  messages: AiRequestMessage[],
): Promise<AiCompletionResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: (settings.model || '').trim(),
      messages,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      top_p: settings.topP,
      frequency_penalty: settings.frequencyPenalty,
      stream: true,
    }),
  });

  if (!response.ok) {
    const rawText = await response.text();
    const parsed = parseResponse(rawText);
    const message =
      parsed?.error?.message ||
      parsed?.choices?.[0]?.message?.content ||
      rawText ||
      `请求失败 (${response.status})`;
    throw new Error(normalizeErrorMessage(message, response.status));
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('模型响应流不可读');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let model = (settings.model || '').trim();
  let usage: AiResponseUsage | undefined;
  let done = false;

  const consumeLine = (line: string) => {
    if (!line.startsWith('data:')) {
      return;
    }

    const rawPayload = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
    const payload = rawPayload;
    if (payload.trim() === '[DONE]') {
      done = true;
      return;
    }
    if (!payload.trim()) {
      return;
    }

    let parsedChunk: {
      error?: { message?: string };
      model?: string;
      usage?: AiResponseUsage;
      choices?: Array<{
        delta?: { content?: unknown };
        message?: { content?: unknown };
        finish_reason?: string;
        finishreason?: string;
      }>;
    } | null = null;
    try {
      parsedChunk = JSON.parse(payload);
    } catch {
      return;
    }

    if (parsedChunk?.error?.message) {
      throw new Error(String(parsedChunk.error.message));
    }

    if (typeof parsedChunk?.model === 'string' && parsedChunk.model.trim()) {
      model = parsedChunk.model.trim();
    }
    if (parsedChunk?.usage && typeof parsedChunk.usage === 'object') {
      usage = parsedChunk.usage as AiResponseUsage;
    }

    const choice = Array.isArray(parsedChunk?.choices) ? parsedChunk.choices[0] : null;
    const delta = choice?.delta ?? choice?.message;
    const deltaContent = extractTextContent(delta?.content, true);
    if (deltaContent) {
      content += deltaContent;
    }

    const finishReason =
      (typeof choice?.finish_reason === 'string' && choice.finish_reason) ||
      (typeof choice?.finishreason === 'string' && choice.finishreason) ||
      null;
    if (finishReason) {
      done = true;
    }
  };

  while (!done) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      consumeLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeLine(buffer.replace(/\r$/, ''));
  }

  if (!content.trim()) {
    throw new Error('流式调用完成但未返回可显示内容');
  }

  return {
    content,
    model,
    usage,
  };
}

/** 解析响应文本为JSON对象 */
function parseResponse(text: string): ChatCompletionResponse | null {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as ChatCompletionResponse;
  } catch {
    return null;
  }
}

/** 提取文本内容 */
function extractTextContent(content: unknown, preserveWhitespace = false): string {
  if (typeof content === 'string') {
    return preserveWhitespace ? content : content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && 'text' in item) {
          const text = item.text;
          return typeof text === 'string' ? text : '';
        }

        return '';
      })
      .join('\n');
    return preserveWhitespace ? text : text.trim();
  }

  return '';
}

/** 标准化错误消息 */
function normalizeErrorMessage(message: unknown, status: number): string {
  if (typeof message === 'string' && message.trim()) {
    return `${message.trim()} (${status})`;
  }

  return `请求失败 (${status})`;
}

/**
 * 取消正在运行或排队的AI任务
 */
export async function cancelTask(taskId: string): Promise<void> {
  const baseUrl = await getServerBaseUrl();
  const headers = await getAuthHeaders();
  const response = await fetch(`${baseUrl}/api/ai/tasks/${taskId}`, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.error || `取消任务失败 (${response.status})`);
  }
}

/**
 * 彻底删除已完成的任务
 */
export async function removeTask(taskId: string): Promise<void> {
  const baseUrl = await getServerBaseUrl();
  const headers = await getAuthHeaders();
  const response = await fetch(`${baseUrl}/api/ai/tasks/${taskId}/remove`, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.error || `删除任务失败 (${response.status})`);
  }
}
