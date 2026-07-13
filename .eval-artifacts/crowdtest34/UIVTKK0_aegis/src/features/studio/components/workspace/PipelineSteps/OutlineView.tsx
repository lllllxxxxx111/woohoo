import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  RotateCw,
  PauseCircle,
  CheckCircle,
  AlertCircle,
  XCircle,
  SkipForward,
  Eye,
  PencilLine,
  ArrowRight,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import styles from './PipelineSteps.module.css';
import {
  createPipelineRun,
  getPipelineRun,
  getPipelineOptimizations,
  getAiTask,
  getServerAssetBlob,
  listPipelineRuns,
  pausePipelineRun,
  resumePipelineRun,
  cancelPipelineRun,
  retryPipelineStep,
  streamPipelineRun,
  type PipelinePromptOptimization,
  type PipelineRunSummary,
  type PipelineStepOutput,
  type PipelineStepStatus,
} from '../../../../../lib/serverApi';
import { logger } from '../../../../../lib/logger';
import { useAppActions } from '../../../../../context/useAppActions';
import { useAppStore } from '../../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { useToast } from '../../../../../context/useToast';

type StepStatus = PipelineStepStatus;

/**
 * 步骤状态映射到显示信息
 */
const STEP_STATUS_MAP: Record<
  StepStatus,
  { label: string; icon: React.ReactNode; className: string }
> = {
  queued: { label: '排队中', icon: <PauseCircle size={14} />, className: styles.statusQueued },
  running: {
    label: '执行中',
    icon: <RotateCw size={14} className={styles.spinIcon} />,
    className: styles.statusRunning,
  },
  completed: {
    label: '已完成',
    icon: <CheckCircle size={14} />,
    className: styles.statusCompleted,
  },
  failed: { label: '失败', icon: <AlertCircle size={14} />, className: styles.statusFailed },
  skipped: { label: '已跳过', icon: <SkipForward size={14} />, className: styles.statusSkipped },
  blocked: { label: '已阻塞', icon: <XCircle size={14} />, className: styles.statusBlocked },
  retrying: {
    label: '重试中',
    icon: <RotateCw size={14} className={styles.spinIcon} />,
    className: styles.statusRetrying,
  },
};

const RUN_ERROR_LABELS: Record<string, { label: string; hint: string }> = {
  MISSING_ENDPOINT: {
    label: '缺少可用端点',
    hint: '当前没有可用 AI 端点，请先配置并激活端点。',
  },
  DEPENDENCY_UNSATISFIED: {
    label: '依赖未满足',
    hint: '步骤依赖未满足，请检查上游步骤状态或流程配置。',
  },
  RETRY_SCHEDULED: {
    label: '自动重试等待中',
    hint: '系统正在按退避策略等待下一次自动重试。',
  },
  WAITING_PREREQUISITE: {
    label: '等待前置条件',
    hint: '存在依赖未满足或端点未就绪，流程会在条件满足后继续推进。',
  },
  MANUAL_REVIEW_REQUIRED: {
    label: '需要人工复核',
    hint: '自动审核多次失败，建议人工检查后手动重试失败步骤。',
  },
  EXECUTION_FAILED: {
    label: '执行失败',
    hint: '流程已终止，请查看失败步骤错误信息并执行重试。',
  },
};

const EMPTY_PIPELINE_STEPS: PipelineRunSummary['steps'] = [];
const EMPTY_PIPELINE_OUTPUTS: PipelineRunSummary['outputs'] = [];

const extractOutlineTextCandidate = (value: unknown, allowSummary = true): string => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((v) => extractOutlineTextCandidate(v, allowSummary)).filter(Boolean).join('\n\n');
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // 检测审核 JSON 格式（包含 decision + issues 字段），不应作为大纲内容
    if ('decision' in record && 'issues' in record) {
      return '';
    }
    // summary 字段优先级最低，避免审核摘要被误提取
    const keys = allowSummary
      ? ['outline', 'content', 'text', 'result', 'draft', 'body', 'summary']
      : ['outline', 'content', 'text', 'result', 'draft', 'body'];
    for (const key of keys) {
      const candidate = extractOutlineTextCandidate(record[key], key !== 'summary');
      if (candidate) {
        return candidate;
      }
    }
  }

  return '';
};

/** 判断 AI Task 结果是否为审核格式（包含 decision/issues 字段的 JSON） */
const isReviewResult = (result: string | null | undefined): boolean => {
  const raw = result?.trim();
  if (!raw || !raw.startsWith('{') || !raw.endsWith('}')) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return 'decision' in parsed && 'issues' in parsed;
  } catch {
    return false;
  }
};

const normalizeOutlineTaskResult = (result: string | null | undefined): string => {
  const raw = result?.trim();
  if (!raw) {
    return '';
  }

  // 审核结果不应作为大纲内容
  if (isReviewResult(result)) {
    return '';
  }

  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const parsedText = extractOutlineTextCandidate(parsed);
      if (parsedText) {
        return parsedText;
      }
    } catch {
      // Plain markdown/text output is the common path.
    }
  }

  return raw;
};

const parseTextList = (value: string | null | undefined): string[] => {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) =>
          typeof item === 'string' ? item.trim() : item == null ? '' : String(item).trim(),
        )
        .filter(Boolean);
    }
    if (typeof parsed === 'string') {
      const parsedText = parsed.trim();
      return parsedText ? [parsedText] : [];
    }
  } catch {
    // fall through to line splitting
  }

  return trimmed
    .split(/\r?\n|[；;，,]/)
    .map((item) => item.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
};

const formatReviewScore = (score: number | null | undefined): string => {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return '未评分';
  }

  return score.toFixed(2);
};

const getReviewDecisionLabel = (decision: string | null | undefined): string => {
  if (decision === 'pass') {
    return '通过';
  }
  if (decision === 'fail') {
    return '未通过';
  }
  return '待解析';
};

const summarizeReviewOutput = (output: PipelineStepOutput | null): string => {
  if (!output) {
    return '';
  }

  const summaryParts = [`审核${getReviewDecisionLabel(output.reviewDecision)}`];
  if (typeof output.reviewScore === 'number' && !Number.isNaN(output.reviewScore)) {
    summaryParts.push(`评分 ${formatReviewScore(output.reviewScore)}`);
  }

  const issueCount = parseTextList(output.reviewIssuesJson).length;
  if (issueCount > 0) {
    summaryParts.push(`问题 ${issueCount} 条`);
  }

  const hintCount = parseTextList(output.retryHintsJson).length;
  if (hintCount > 0) {
    summaryParts.push(`建议 ${hintCount} 条`);
  }

  return summaryParts.join(' · ');
};

const extractOutputPreview = (output: PipelineStepOutput | null): string => {
  if (!output) {
    return '';
  }

  if (output.outputType === 'review') {
    return summarizeReviewOutput(output);
  }

  const source = output.rawContent ?? output.outputJson ?? '';
  return normalizeOutlineTaskResult(source);
};

const parseJsonRecord = (value: string | null | undefined): Record<string, unknown> | null => {
  if (!value) {
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
};

const extractPipelineOutputAssetIds = (outputs: PipelineStepOutput[]): string[] => {
  return outputs
    .map((output) => {
      const payload = parseJsonRecord(output.outputJson);
      if (typeof payload?.assetId === 'string' && payload.assetId.trim()) {
        return payload.assetId.trim();
      }
      const nestedAsset = payload?.asset;
      if (
        nestedAsset &&
        typeof nestedAsset === 'object' &&
        !Array.isArray(nestedAsset) &&
        typeof (nestedAsset as { id?: unknown }).id === 'string'
      ) {
        return ((nestedAsset as { id: string }).id || '').trim();
      }
      return '';
    })
    .filter(Boolean);
};

const OUTLINE_DESIGN_STEP_KEYS = new Set(['outline_design', 'collab_outline_design']);
const OUTLINE_REVIEW_STEP_KEYS = new Set(['outline_review', 'collab_outline_review']);

const isOutlineDesignStep = (stepKey: string | null | undefined) =>
  typeof stepKey === 'string' && OUTLINE_DESIGN_STEP_KEYS.has(stepKey);

const isOutlineReviewStep = (stepKey: string | null | undefined) =>
  typeof stepKey === 'string' && OUTLINE_REVIEW_STEP_KEYS.has(stepKey);

type OutlineDocumentSource = {
  assetId?: string;
  inlineText?: string;
  key: string;
  taskId?: string;
};

const extractPipelineOutputAssetId = (output: PipelineStepOutput | null | undefined): string => {
  const payload = parseJsonRecord(output?.outputJson);
  if (typeof payload?.assetId === 'string' && payload.assetId.trim()) {
    return payload.assetId.trim();
  }

  const nestedAsset = payload?.asset;
  if (
    nestedAsset &&
    typeof nestedAsset === 'object' &&
    !Array.isArray(nestedAsset) &&
    typeof (nestedAsset as { id?: unknown }).id === 'string'
  ) {
    return ((nestedAsset as { id: string }).id || '').trim();
  }

  return '';
};

const getCompletedOutlineDocumentSource = (
  run: PipelineRunSummary | null,
): OutlineDocumentSource | null => {
  if (!run) {
    return null;
  }

  const designStep = run.steps.find(
    (step) => isOutlineDesignStep(step.stepKey) && step.status === 'completed',
  );
  if (!designStep) {
    return null;
  }

  const output = run.outputs.find(
    (item) => item.stepId === designStep.id && item.outputType === 'design',
  );
  const assetId = extractPipelineOutputAssetId(output);
  const inlineText = normalizeOutlineTaskResult(output?.rawContent);

  if (assetId) {
    return {
      assetId,
      inlineText: inlineText || undefined,
      key: `asset:${assetId}`,
      taskId: output?.taskId || designStep.aiTaskId || undefined,
    };
  }

  if (inlineText) {
    return {
      inlineText,
      key: `output:${output?.id ?? designStep.id}:${output?.updatedAt ?? designStep.updatedAt}`,
      taskId: output?.taskId || designStep.aiTaskId || undefined,
    };
  }

  if (designStep.aiTaskId) {
    return {
      key: `task:${designStep.aiTaskId}`,
      taskId: designStep.aiTaskId,
    };
  }

  return null;
};

type OutlineViewProps = {
  onAdvanceToScript?: () => void;
};

export const OutlineView: React.FC<OutlineViewProps> = ({ onAdvanceToScript }) => {
  const [outlineDraft, setOutlineDraft] = useState('');
  const [outlineViewMode, setOutlineViewMode] = useState<'preview' | 'edit'>('preview');
  const [currentRun, setCurrentRun] = useState<PipelineRunSummary | null>(null);
  const [outlineDocumentSource, setOutlineDocumentSource] = useState<OutlineDocumentSource | null>(
    null,
  );
  const [promptOptimizations, setPromptOptimizations] = useState<PipelinePromptOptimization[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualReviewOwner, setManualReviewOwner] = useState('');
  const [manualReviewNote, setManualReviewNote] = useState('');
  const [isReviewPanelCollapsed, setIsReviewPanelCollapsed] = useState(true);
  const [selectedManualReviewStepId, setSelectedManualReviewStepId] = useState<string | null>(null);
  const focusedRunIdRef = useRef<string | null>(null);
  const lastSyncedOutlineSourceKeyRef = useRef<string | null>(null);
  const refreshedAssetIdsRef = useRef<Set<string>>(new Set());
  const { showToast } = useToast();
  const { refreshWorkspace } = useAppActions();
  const { activeState, isServerWorkspaceReady, aiSettings, setSettingsOpen } = useAppStore(
    useShallow((state) => ({
      activeState: state.activeState,
      isServerWorkspaceReady: state.isServerWorkspaceReady,
      aiSettings: state.aiSettings,
      setSettingsOpen: state.setSettingsOpen,
    })),
  );
  const multiAgentBetaEnabled = aiSettings.multiAgentBetaEnabled === true;
  const retryBackoffSec = Number.isFinite(aiSettings.pipelineRetryBackoffSec)
    ? Math.min(300, Math.max(1, Math.round(aiSettings.pipelineRetryBackoffSec)))
    : 4;
  const retryMaxBackoffSec = Number.isFinite(aiSettings.pipelineRetryMaxBackoffSec)
    ? Math.min(900, Math.max(retryBackoffSec, Math.round(aiSettings.pipelineRetryMaxBackoffSec)))
    : Math.max(90, retryBackoffSec);
  const currentRunStatus = currentRun?.run.status;
  const currentRunOutputs = currentRun?.outputs ?? EMPTY_PIPELINE_OUTPUTS;
  const pipelineOutputAssetIds = useMemo(
    () => extractPipelineOutputAssetIds(currentRunOutputs),
    [currentRunOutputs],
  );
  const outlineReviewStep =
    currentRun?.steps.find((step) => isOutlineReviewStep(step.stepKey)) ?? null;
  const latestReviewOutput = currentRunOutputs.find((output) => output.outputType === 'review') ?? null;
  const latestReviewDecision = latestReviewOutput?.reviewDecision ?? null;
  const latestReviewStep = latestReviewOutput
    ? currentRun?.steps.find((step) => step.id === latestReviewOutput.stepId) ?? null
    : outlineReviewStep;
  const latestReviewIssues = parseTextList(latestReviewOutput?.reviewIssuesJson);
  const latestRetryHints = parseTextList(latestReviewOutput?.retryHintsJson);
  const latestReviewSummaryEvent = currentRun
    ? currentRun.recentEvents.find((event) => {
        if (event.eventType !== 'assistant_step_summary') {
          return false;
        }
        const payload = parseJsonRecord(event.payloadJson);
        const stepType = typeof payload?.stepType === 'string' ? payload.stepType : '';
        const stepKey = typeof payload?.stepKey === 'string' ? payload.stepKey : '';
        return stepType === 'review' || isOutlineReviewStep(stepKey);
      }) ?? null
    : null;
  const latestReviewSummaryPayload = parseJsonRecord(latestReviewSummaryEvent?.payloadJson);
  const latestReviewSummaryText =
    typeof latestReviewSummaryPayload?.summary === 'string'
      ? latestReviewSummaryPayload.summary
      : '';
  const latestReviewNextAction =
    typeof latestReviewSummaryPayload?.nextAction === 'string'
      ? latestReviewSummaryPayload.nextAction
      : '';
  const latestReviewSummaryDecision = latestReviewSummaryText.includes('已通过')
    ? 'pass'
    : latestReviewSummaryText.includes('未通过')
      ? 'fail'
      : null;
  const currentRunStep = useMemo(
    () =>
      currentRun?.steps.find((step) => step.status === 'running') ??
      currentRun?.steps.find((step) => step.status === 'retrying') ??
      currentRun?.steps.find((step) => step.status === 'queued') ??
      currentRun?.steps.find((step) => step.status === 'blocked') ??
      null,
    [currentRun],
  );
  const currentRunProgressLabel = useMemo(() => {
    if (!currentRun) {
      return '等待大纲流程';
    }

    switch (currentRun.run.status) {
      case 'queued':
        return '大纲流程排队中';
      case 'paused':
        return '大纲流程已暂停';
      case 'completed':
        if (latestReviewDecision === 'pass') {
          return '大纲审核通过，可进入下一步';
        }
        if (latestReviewDecision === 'fail') {
          return '大纲审核未通过';
        }
        return '大纲生成完成';
      case 'failed':
        return '大纲生成失败';
      case 'cancelled':
        return '大纲流程已取消';
      case 'running':
      default:
        if (isOutlineReviewStep(currentRunStep?.stepKey)) {
          return '正在审核大纲中';
        }
        if (isOutlineDesignStep(currentRunStep?.stepKey)) {
          return '正在生成大纲中';
        }
        if (currentRunStep?.stepName) {
          return `正在执行 ${currentRunStep.stepName}`;
        }
        return '大纲流程执行中';
    }
  }, [currentRun, currentRunStep, latestReviewDecision]);

  useEffect(() => {
    const newAssetIds = pipelineOutputAssetIds.filter(
      (assetId) => !refreshedAssetIdsRef.current.has(assetId),
    );
    if (newAssetIds.length === 0) {
      return;
    }

    newAssetIds.forEach((assetId) => refreshedAssetIdsRef.current.add(assetId));
    void refreshWorkspace('pipeline document asset sync', 2).catch((error) => {
      logger.warn('Failed to refresh workspace after pipeline asset creation', error);
    });
  }, [pipelineOutputAssetIds, refreshWorkspace]);

  const buildOutlineDesignPrompt = (draftText: string, promptPatch?: string | null) => {
    const normalizedDraft =
      draftText.trim() || '当前没有现成草稿，请从项目目标和历史对话中补齐完整大纲。';
    const sections = [
      '你是大纲架构师，请基于当前项目上下文产出可执行的大纲方案。',
      '',
      `已有草稿：${normalizedDraft}`,
      '',
      '要求：',
      '1. 给出故事钩子、核心冲突、关键转折和结局走向。',
      '2. 按短视频/短剧节奏拆出段落节点（起承转合）。',
      '3. 标记每段的目标情绪和人物推进。',
      '4. 输出内容可直接进入剧本阶段，不要只给抽象建议。',
    ];

    if (promptPatch?.trim()) {
      sections.push('', promptPatch.trim());
    }

    return sections.join('\n');
  };

  const buildOutlineReviewPrompt = (targetOutline?: string, promptPatch?: string | null) => {
    const normalizedTargetOutline = targetOutline?.trim();
    const sections = [
      '你是合规审核官，请审核大纲内容，并给出可执行评语。',
      '',
      normalizedTargetOutline
        ? `待审核大纲：\n${normalizedTargetOutline}`
        : '待审核内容：优先审核上游步骤的大纲产出；如果没有上游产出或正文为空，请判定为 fail，并在 issues 中说明缺少待审核内容。',
      '',
      '审核标准：',
      '1. 结构完整度（钩子、冲突、转折、结局）',
      '2. 节奏可执行性（短剧节奏和段落拆分是否可落地）',
      '3. 风险与合规（是否有明显风险或不当表述）',
      '',
      '如果不通过，请给出可执行修改项和重试建议。',
      '必须只返回 JSON，不要使用 Markdown 代码块或解释文字：',
      '{"decision":"pass|fail","score":0.0,"issues":["问题或通过理由"],"retryHints":["下一步建议"],"riskLevel":"low|medium|high"}',
    ];

    if (promptPatch?.trim()) {
      sections.push('', promptPatch.trim());
    }

    return sections.join('\n');
  };

  const createOutlinePipelineRun = async (
    mode: 'full' | 'review_only',
    optimization?: Pick<PipelinePromptOptimization, 'designPromptPatch' | 'reviewPromptPatch'>,
  ) => {
    if (!multiAgentBetaEnabled) {
      showToast({
        type: 'warning',
        title: 'Beta 功能未开启',
        message: '请在 设置 > 制作流程 中开启“多智能体自动编排（Beta）”后再试。',
      });
      setSettingsOpen(true);
      return;
    }

    if (!isServerWorkspaceReady) {
      showToast({
        type: 'error',
        title: '服务端未就绪',
        message: '请先确保后端已启动，再执行大纲流程。',
      });
      return;
    }

    if (!activeState.projectId) {
      showToast({
        type: 'warning',
        title: '缺少项目上下文',
        message: '请先选择项目后再启动大纲流程。',
      });
      return;
    }

    if (!activeState.chatSessionId) {
      showToast({
        type: 'warning',
        title: '缺少会话上下文',
        message: '请先进入项目对话，再启动大纲流程。',
      });
      return;
    }

    if (mode === 'review_only' && !outlineDraft.trim()) {
      showToast({
        type: 'warning',
        title: '缺少审核内容',
        message: '请先生成或填写大纲后再提交审核。',
      });
      return;
    }

    const designPrompt = buildOutlineDesignPrompt(outlineDraft, optimization?.designPromptPatch);
    const reviewPrompt = buildOutlineReviewPrompt(
      mode === 'review_only' ? outlineDraft : undefined,
      optimization?.reviewPromptPatch,
    );
    const normalizedRetryBackoffSec = Math.min(300, Math.max(1, Math.round(retryBackoffSec || 4)));
    const normalizedRetryMaxBackoffSec = Math.min(
      900,
      Math.max(normalizedRetryBackoffSec, Math.round(retryMaxBackoffSec || 90)),
    );
    const idempotencyKey = `outline-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setIsSubmitting(true);
    try {
      const run = await createPipelineRun({
        projectId: activeState.projectId,
        conversationId: activeState.chatSessionId,
        pipelineType: 'outline',
        triggerSource: 'manual',
        betaEnabled: multiAgentBetaEnabled,
        idempotencyKey,
        steps:
          mode === 'review_only'
            ? [
                {
                  stepKey: 'outline_review',
                  stepName: '大纲审核',
                  stepOrder: 1,
                  stepType: 'review',
                  maxRetries: 2,
                  reviewPolicy: {
                    strictJson: true,
                    requiredFields: ['decision', 'score', 'issues', 'retryHints', 'riskLevel'],
                    promptOptimizerBetaEnabled: aiSettings.promptOptimizerBetaEnabled === true,
                    retryBackoffSec: normalizedRetryBackoffSec,
                    retryMaxBackoffSec: normalizedRetryMaxBackoffSec,
                  },
                  promptTemplate: reviewPrompt,
                },
              ]
            : [
                {
                  stepKey: 'outline_design',
                  stepName: '大纲设计',
                  stepOrder: 1,
                  stepType: 'design',
                  maxRetries: 2,
                  reviewPolicy: {
                    promptOptimizerBetaEnabled: aiSettings.promptOptimizerBetaEnabled === true,
                    retryBackoffSec: normalizedRetryBackoffSec,
                    retryMaxBackoffSec: normalizedRetryMaxBackoffSec,
                  },
                  promptTemplate: designPrompt,
                },
                {
                  stepKey: 'outline_review',
                  stepName: '大纲审核',
                  stepOrder: 2,
                  stepType: 'review',
                  dependsOn: ['outline_design'],
                  maxRetries: 2,
                  reviewPolicy: {
                    strictJson: true,
                    requiredFields: ['decision', 'score', 'issues', 'retryHints', 'riskLevel'],
                    promptOptimizerBetaEnabled: aiSettings.promptOptimizerBetaEnabled === true,
                    retryBackoffSec: normalizedRetryBackoffSec,
                    retryMaxBackoffSec: normalizedRetryMaxBackoffSec,
                  },
                  promptTemplate: reviewPrompt,
                },
              ],
      });

      focusedRunIdRef.current = run.id;
      const detail = await getPipelineRun(run.id);
      setCurrentRun(detail);
      showToast({
        type: 'success',
        title: mode === 'review_only' ? '审核流程已启动' : '大纲编排流程已启动',
        message: `运行ID: ${run.id.slice(0, 8)}...`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '流程启动失败',
        message: error instanceof Error ? error.message : '无法创建流程运行，请检查服务端日志',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * 加载当前项目的最新流程运行状态
   */
  const loadLatestRun = useCallback(async () => {
    if (!activeState.projectId) {
      setLoadError('');
      return;
    }
    try {
      setLoadError('');
      const runs = await listPipelineRuns({
        projectId: activeState.projectId,
        conversationId: activeState.chatSessionId ?? undefined,
        limit: 30,
      });
      if (runs.length === 0) {
        setCurrentRun(null);
        setOutlineDocumentSource(null);
        setPromptOptimizations([]);
        return;
      }
      const focusedRunId = focusedRunIdRef.current;
      const targetRun =
        (focusedRunId ? runs.find((run) => run.id === focusedRunId) : null) ?? runs[0];
      if (targetRun.status === 'completed' || targetRun.status === 'failed' || targetRun.status === 'cancelled') {
        focusedRunIdRef.current = null;
      } else {
        focusedRunIdRef.current = targetRun.id;
      }
      const [detail, optimizations] = await Promise.all([
        getPipelineRun(targetRun.id),
        getPipelineOptimizations(targetRun.id),
      ]);
      let nextOutlineDocumentSource = getCompletedOutlineDocumentSource(detail);
      if (!nextOutlineDocumentSource) {
        for (const run of runs.slice(1)) {
          try {
            const candidateDetail = await getPipelineRun(run.id);
            nextOutlineDocumentSource = getCompletedOutlineDocumentSource(candidateDetail);
            if (nextOutlineDocumentSource) {
              break;
            }
          } catch (candidateError) {
            logger.error('Failed to load outline source run:', candidateError);
          }
        }
      }
      setCurrentRun(detail);
      setOutlineDocumentSource(nextOutlineDocumentSource);
      setPromptOptimizations(optimizations);
    } catch (error) {
      const message = error instanceof Error ? error.message : '流程数据加载失败，请稍后重试';
      setLoadError(message === 'UNAUTHORIZED' ? '登录状态已失效，请重新登录后再查看流程。' : message);
      logger.error('Failed to load pipeline run:', error);
    }
  }, [activeState.chatSessionId, activeState.projectId]);

  useEffect(() => {
    if (isServerWorkspaceReady && activeState.projectId) {
      void loadLatestRun();
      const isTerminal = currentRunStatus
        ? ['completed', 'failed', 'cancelled'].includes(currentRunStatus)
        : false;
      if (isTerminal) {
        return;
      }

      const focusedRunId = focusedRunIdRef.current;
      if (!focusedRunId) {
        const interval = setInterval(() => {
          void loadLatestRun();
        }, 5000);
        return () => clearInterval(interval);
      }

      const controller = streamPipelineRun(
        focusedRunId,
        () => {
          void loadLatestRun();
        },
        () => {
          void loadLatestRun();
        },
        () => {
          void loadLatestRun();
        },
      );

      return () => controller.close();
    }
  }, [isServerWorkspaceReady, activeState.projectId, currentRunStatus, loadLatestRun]);

  useEffect(() => {
    if (
      !outlineDocumentSource ||
      lastSyncedOutlineSourceKeyRef.current === outlineDocumentSource.key
    ) {
      return;
    }

    let cancelled = false;

    const syncGeneratedOutline = async () => {
      try {
        let nextOutline = '';
        if (outlineDocumentSource.assetId) {
          const blob = await getServerAssetBlob(outlineDocumentSource.assetId);
          nextOutline = normalizeOutlineTaskResult(await blob.text());
        }
        if (!nextOutline && outlineDocumentSource.inlineText) {
          nextOutline = normalizeOutlineTaskResult(outlineDocumentSource.inlineText);
        }
        if (!nextOutline && outlineDocumentSource.taskId) {
          const task = await getAiTask(outlineDocumentSource.taskId);
          // 校验：只有非审核结果才同步到大纲内容，避免审核 JSON 被写入 outlineDraft
          if (!isReviewResult(task.result)) {
            nextOutline = normalizeOutlineTaskResult(task.result);
          }
        }
        if (cancelled) {
          return;
        }

        if (!nextOutline) {
          return;
        }

        lastSyncedOutlineSourceKeyRef.current = outlineDocumentSource.key;
        setOutlineDraft(nextOutline);
        setOutlineViewMode('preview');
      } catch (error) {
        logger.error('Failed to sync generated outline document:', error);
      }
    };

    void syncGeneratedOutline();

    return () => {
      cancelled = true;
    };
  }, [outlineDocumentSource]);

  const handleRegenerate = () => {
    void createOutlinePipelineRun('full');
  };

  const handleApprove = () => {
    void createOutlinePipelineRun('review_only');
  };

  const handleRegenerateWithOptimization = () => {
    if (!latestOptimization) {
      return;
    }
    void createOutlinePipelineRun('full', latestOptimization);
  };

  const handleReviewWithOptimization = () => {
    if (!latestOptimization) {
      return;
    }
    void createOutlinePipelineRun('review_only', latestOptimization);
  };

  /**
   * 暂停当前流程运行
   */
  const handlePause = async () => {
    if (!currentRun) return;
    setIsLoading(true);
    try {
      await pausePipelineRun(currentRun.run.id, '用户手动暂停');
      await loadLatestRun();
    } catch (error) {
      logger.error('Failed to pause pipeline:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 恢复当前流程运行
   */
  const handleResume = async () => {
    if (!currentRun) return;
    setIsLoading(true);
    try {
      await resumePipelineRun(currentRun.run.id);
      await loadLatestRun();
    } catch (error) {
      logger.error('Failed to resume pipeline:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 取消当前流程运行
   */
  const handleCancel = async () => {
    if (!currentRun) return;
    setIsLoading(true);
    try {
      await cancelPipelineRun(currentRun.run.id, '用户取消');
      setCurrentRun(null);
    } catch (error) {
      logger.error('Failed to cancel pipeline:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const canControl = currentRun && ['running', 'paused', 'queued'].includes(currentRun.run.status);
  const isPaused = currentRun?.run.status === 'paused';
  const runErrorMeta = currentRun?.run.errorCode
    ? RUN_ERROR_LABELS[currentRun.run.errorCode]
    : undefined;
  const failedOrBlockedSteps = useMemo(
    () =>
      currentRun
        ? currentRun.steps.filter((step) => step.status === 'failed' || step.status === 'blocked')
        : EMPTY_PIPELINE_STEPS,
    [currentRun],
  );
  const isWaitingPrerequisite = currentRun
    ? ['WAITING_PREREQUISITE', 'MISSING_ENDPOINT', 'DEPENDENCY_UNSATISFIED'].includes(
        currentRun.run.errorCode || '',
      )
    : false;
  const isMissingEndpoint = currentRun?.run.errorCode === 'MISSING_ENDPOINT';
  const isManualReviewRequired = currentRun?.run.errorCode === 'MANUAL_REVIEW_REQUIRED';
  const selectedManualReviewStep =
    failedOrBlockedSteps.find((step) => step.id === selectedManualReviewStepId) ??
    failedOrBlockedSteps[0] ??
    null;

  useEffect(() => {
    if (!currentRun || failedOrBlockedSteps.length === 0) {
      setSelectedManualReviewStepId(null);
      return;
    }

    const stillExists = selectedManualReviewStepId
      ? failedOrBlockedSteps.some((step) => step.id === selectedManualReviewStepId)
      : false;

    if (!stillExists) {
      setSelectedManualReviewStepId(failedOrBlockedSteps[0].id);
    }
  }, [currentRun, failedOrBlockedSteps, selectedManualReviewStepId]);

  const parseEventPayload = (payloadJson: string | null) => {
    if (!payloadJson) {
      return null;
    }

    try {
      return JSON.parse(payloadJson) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const summarizeEvent = (eventType: string, payloadJson: string | null) => {
    const payload = parseEventPayload(payloadJson);

    switch (eventType) {
      case 'created':
        return `创建流程（${payload?.totalSteps ?? '-'} 步）`;
      case 'started':
        return '流程开始执行';
      case 'step_queued':
        return `步骤入队：${payload?.stepName ?? payload?.stepId ?? '未知步骤'}`;
      case 'step_started':
        return `步骤开始：${payload?.stepId ?? '未知步骤'}`;
      case 'step_completed':
        return `步骤完成：${payload?.stepId ?? '未知步骤'}`;
      case 'step_failed':
        return `步骤失败：${payload?.reason ?? '请查看错误详情'}`;
      case 'step_retry':
        return `步骤重试：${payload?.stepName ?? payload?.stepId ?? '未知步骤'}${
          payload?.nextRetryAt ? `（预计 ${formatEventTime(String(payload.nextRetryAt))}）` : ''
        }${
          typeof payload?.reason === 'string' && payload.reason.trim()
            ? `；人工说明：${payload.reason}`
            : ''
        }`;
      case 'assistant_step_summary':
        return typeof payload?.summary === 'string' && payload.summary.trim()
          ? payload.summary
          : `步骤摘要：${payload?.stepId ?? '未知步骤'}`;
      case 'prompt_optimization_suggested':
        return typeof payload?.summary === 'string' && payload.summary.trim()
          ? payload.summary
          : `已生成 Prompt 优化建议（步骤 ${payload?.stepId ?? '未知'}）`;
      case 'paused':
        return '流程已暂停';
      case 'resumed':
        if (payload?.reason === 'manual_retry_step') {
          return `人工复核后恢复流程：${
            typeof payload?.manualReviewNote === 'string' && payload.manualReviewNote.trim()
              ? payload.manualReviewNote
              : (payload?.stepName ?? payload?.stepId ?? '已恢复执行')
          }`;
        }
        return '流程已恢复';
      case 'cancelled':
        return '流程已取消';
      case 'completed':
        return '流程完成';
      case 'failed':
        return `流程失败：${payload?.errorMessage ?? payload?.reason ?? '执行失败'}`;
      default:
        return `${eventType} 事件`;
    }
  };

  const formatEventTime = (value: string) => {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
      return value;
    }
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  };

  const progressPercent = currentRun
    ? currentRun.run.totalSteps > 0
      ? Math.round((currentRun.run.completedSteps / currentRun.run.totalSteps) * 100)
      : 0
    : 0;
  const latestOptimization = promptOptimizations[0] ?? null;
  const latestOutputPreview = extractOutputPreview(currentRunOutputs[0] ?? null);
  const latestReviewRuntimeEvent = currentRun
    ? currentRun.recentEvents.find((event) => {
        if (
          outlineReviewStep?.id &&
          event.stepId &&
          event.stepId !== outlineReviewStep.id
        ) {
          return false;
        }
        return [
          'assistant_step_summary',
          'step_failed',
          'step_retry',
          'step_started',
          'step_completed',
          'failed',
        ].includes(event.eventType);
      }) ?? null
    : null;
  const latestReviewRuntimeEventText = latestReviewRuntimeEvent
    ? summarizeEvent(latestReviewRuntimeEvent.eventType, latestReviewRuntimeEvent.payloadJson)
    : '';
  const reviewStepStatusLabel = outlineReviewStep
    ? STEP_STATUS_MAP[outlineReviewStep.status as StepStatus]?.label || outlineReviewStep.status
    : '等待审核';
  const reviewFallbackMessage = (() => {
    if (!currentRun) {
      return '审核结果会在这里展示，包含结论、评分、问题和重试建议。';
    }
    if (latestReviewSummaryText) {
      return latestReviewSummaryText;
    }
    if (outlineReviewStep?.errorMessage) {
      return outlineReviewStep.errorMessage;
    }
    if (currentRun.run.errorMessage) {
      return currentRun.run.errorMessage;
    }
    if (latestReviewRuntimeEventText) {
      return latestReviewRuntimeEventText;
    }
    if (outlineReviewStep?.status === 'queued') {
      return '审核任务已提交，正在等待调度。';
    }
    if (outlineReviewStep?.status === 'running') {
      return '审核智能体正在分析大纲，完成后会显示结论、评分、问题和建议。';
    }
    if (outlineReviewStep?.status === 'blocked') {
      return '审核步骤被阻塞，请查看右侧流程控制中的说明后处理。';
    }
    return currentRunOutputs.length > 0
      ? latestOutputPreview || '当前产出已生成，但暂未提取到审核结论。'
      : '审核任务已创建，评语会在审核完成后显示。';
  })();
  const reviewFallbackNextAction =
    latestReviewNextAction ||
    (outlineReviewStep?.status === 'failed' || currentRun?.run.status === 'failed'
      ? '检查失败原因后重试审核步骤。'
      : outlineReviewStep?.status === 'running'
        ? '等待审核智能体返回结构化结果。'
        : outlineReviewStep?.status === 'queued'
          ? '等待后端调度审核任务。'
          : '');
  const reviewCompactSummary = latestReviewOutput
    ? `结论 ${getReviewDecisionLabel(latestReviewOutput.reviewDecision)} · 评分 ${formatReviewScore(
        latestReviewOutput.reviewScore,
      )} · 问题 ${latestReviewIssues.length} 条`
    : latestReviewSummaryText
      ? latestReviewSummaryText
      : reviewFallbackMessage;
  const manualReviewEvents = currentRun
    ? currentRun.recentEvents.filter((event) => {
        const payload = parseEventPayload(event.payloadJson);
        if (event.eventType === 'step_retry' && event.source === 'user') {
          return true;
        }
        if (event.eventType === 'resumed' && payload?.reason === 'manual_retry_step') {
          return true;
        }
        if (event.eventType === 'step_failed') {
          return true;
        }
        return false;
      })
    : [];

  const composeManualReviewReason = () => {
    const note = manualReviewNote.trim();
    if (!note) {
      return null;
    }

    const owner = manualReviewOwner.trim();
    return owner ? `处理责任人：${owner}；人工结论：${note}` : `人工结论：${note}`;
  };

  const handleRetryStep = async (stepId: string, reason?: string) => {
    if (!currentRun) return;
    if (isManualReviewRequired && !reason?.trim()) {
      showToast({
        type: 'warning',
        title: '请先填写人工复核结论',
        message: '人工复核状态下，重试前需要填写人工说明以便留痕。',
      });
      return;
    }
    setIsLoading(true);
    try {
      focusedRunIdRef.current = currentRun.run.id;
      await retryPipelineStep(currentRun.run.id, stepId, reason);
      await loadLatestRun();
      if (reason?.trim()) {
        setManualReviewNote('');
        showToast({
          type: 'success',
          title: '人工复核已提交',
          message: '已记录人工说明并触发步骤重试。',
        });
      }
    } catch (error) {
      logger.error('Failed to retry step:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetryFailedSteps = async (reason?: string) => {
    if (!currentRun) {
      return;
    }
    if (failedOrBlockedSteps.length === 0) {
      showToast({ type: 'info', title: '当前无可重试步骤' });
      return;
    }
    if (isManualReviewRequired && !reason?.trim()) {
      showToast({
        type: 'warning',
        title: '请先填写人工复核结论',
        message: '人工复核状态下，批量重试前需要填写人工说明。',
      });
      return;
    }

    setIsLoading(true);
    try {
      let successCount = 0;
      focusedRunIdRef.current = currentRun.run.id;
      for (const step of failedOrBlockedSteps) {
        try {
          await retryPipelineStep(currentRun.run.id, step.id, reason);
          successCount += 1;
        } catch (error) {
          logger.error('Failed to retry step in batch mode:', error);
        }
      }

      await loadLatestRun();
      if (reason?.trim()) {
        setManualReviewNote('');
      }
      if (successCount === failedOrBlockedSteps.length) {
        showToast({
          type: 'success',
          title: reason?.trim() ? '人工复核批量重试已提交' : '批量重试已触发',
          message: `已重试 ${successCount} 个步骤`,
        });
      } else {
        showToast({
          type: 'warning',
          title: '部分步骤重试失败',
          message: `成功 ${successCount} / ${failedOrBlockedSteps.length}`,
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitManualReview = async () => {
    if (!selectedManualReviewStep) {
      showToast({
        type: 'warning',
        title: '当前没有待处理步骤',
      });
      return;
    }

    const reason = composeManualReviewReason();
    await handleRetryStep(selectedManualReviewStep.id, reason ?? undefined);
  };

  const handleSubmitManualReviewBatch = async () => {
    const reason = composeManualReviewReason();
    await handleRetryFailedSteps(reason ?? undefined);
  };

  return (
    <div className={styles.splitLayout}>
      <div className={styles.mainArea}>
        <div className={styles.areaHeader}>
          <h3>大纲内容</h3>
          <div className={styles.outlineModeSwitch} role="group" aria-label="大纲视图模式">
            <button
              type="button"
              className={outlineViewMode === 'preview' ? styles.activeModeBtn : ''}
              onClick={() => setOutlineViewMode('preview')}
            >
              <Eye size={14} />
              预览
            </button>
            <button
              type="button"
              className={outlineViewMode === 'edit' ? styles.activeModeBtn : ''}
              onClick={() => setOutlineViewMode('edit')}
            >
              <PencilLine size={14} />
              编辑
            </button>
          </div>
          {currentRun && (
            <span className={styles.pipelineBadge} data-status={currentRun.run.status}>
              {currentRun.run.status === 'running' && '执行中'}
              {currentRun.run.status === 'paused' && '已暂停'}
              {currentRun.run.status === 'queued' && '排队中'}
              {currentRun.run.status === 'completed' && '已完成'}
              {currentRun.run.status === 'failed' && '失败'}
              {currentRun.run.status === 'cancelled' && '已取消'}
            </span>
          )}
        </div>

        {currentRun && (
          <div className={styles.runPreview}>
            <div className={styles.runPreviewHeader}>
              <div>
                <span className={styles.runPreviewTitle}>流程预览</span>
                <strong>{currentRunProgressLabel}</strong>
              </div>
              <span className={styles.runPreviewId}>流程 {currentRun.run.id.slice(0, 8)}</span>
            </div>
            <div className={styles.runPreviewMeta}>
              <span>当前步骤：{currentRunStep?.stepName || '等待调度'}</span>
              <span>
                已完成 {currentRun.run.completedSteps}/{currentRun.run.totalSteps} 步
              </span>
            </div>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
              <span className={styles.progressText}>{progressPercent}%</span>
            </div>
          </div>
        )}

        {!currentRun && loadError && (
          <div className={`${styles.alertCard} ${styles.alertWarning}`}>
            <div className={styles.alertTitle}>流程数据加载失败</div>
            <div className={styles.alertBody}>{loadError}</div>
            <div className={styles.alertActions}>
              <button
                className={styles.btnSmall}
                type="button"
                onClick={() => void loadLatestRun()}
                disabled={isLoading}
              >
                <RotateCw size={12} /> 重试
              </button>
              <button
                className={styles.btnSmall}
                type="button"
                onClick={() => setSettingsOpen(true)}
                disabled={isLoading}
              >
                <AlertCircle size={12} /> 检查配置
              </button>
            </div>
          </div>
        )}

        {outlineViewMode === 'preview' ? (
          <div className={styles.markdownPreview}>
            {outlineDraft.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{outlineDraft}</ReactMarkdown>
            ) : (
              <div className={styles.emptyMarkdownState}>
                <span>暂无大纲内容</span>
                <button type="button" onClick={() => setOutlineViewMode('edit')}>
                  开始编辑
                </button>
              </div>
            )}
          </div>
        ) : (
          <textarea
            className={styles.fullTextArea}
            placeholder="暂无大纲内容..."
            value={outlineDraft}
            onChange={(event) => setOutlineDraft(event.target.value)}
          />
        )}

        {/* 真实步骤列表 */}
        {currentRun && currentRun.steps.length > 0 && (
          <div className={styles.stepsList}>
            <h4>流程步骤</h4>
            {currentRun.steps.map((step) => {
              const statusInfo =
                STEP_STATUS_MAP[step.status as StepStatus] || STEP_STATUS_MAP.queued;
              return (
                <div key={step.id} className={styles.stepItem} data-step-status={step.status}>
                  <span className={styles.stepIcon}>{statusInfo.icon}</span>
                  <span className={styles.stepName}>{step.stepName}</span>
                  <span className={`${styles.stepStatus} ${statusInfo.className}`}>
                    {statusInfo.label}
                  </span>
                  {step.attemptCount > 1 && (
                    <span className={styles.stepAttempts}>尝试{step.attemptCount}次</span>
                  )}
                  {step.errorMessage && (
                    <span className={styles.stepError}>{step.errorMessage.slice(0, 50)}</span>
                  )}
                  {(step.status === 'failed' || step.status === 'blocked') && (
                    <button
                      className={styles.btnSmall}
                      onClick={() =>
                        void handleRetryStep(
                          step.id,
                          isManualReviewRequired
                            ? (composeManualReviewReason() ?? undefined)
                            : undefined,
                        )
                      }
                      disabled={isLoading}
                    >
                      <RotateCw size={12} /> 重试
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {currentRun && (
          <div className={styles.panelBlock}>
            <h4 className={styles.panelTitle}>审核结果与产出</h4>
            <div className={styles.reviewPanelToolbar}>
              <div className={styles.reviewCompactSummary}>{reviewCompactSummary}</div>
              <button
                type="button"
                className={styles.panelToggleButton}
                onClick={() => setIsReviewPanelCollapsed((value) => !value)}
                aria-expanded={!isReviewPanelCollapsed}
              >
                {isReviewPanelCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                {isReviewPanelCollapsed ? '展开' : '收起'}
              </button>
            </div>
            {!isReviewPanelCollapsed && (latestReviewOutput ? (
              <div className={styles.outputCard}>
                <div className={styles.outputHeader}>
                  <div className={styles.outputTitleGroup}>
                    <span className={styles.outputType} data-output-type="review">
                      审核
                    </span>
                    <strong>{latestReviewStep?.stepName || '审核步骤'}</strong>
                  </div>
                  <span className={styles.outputTime}>{formatEventTime(latestReviewOutput.createdAt)}</span>
                </div>

                <div className={styles.reviewSummaryGrid}>
                  <div className={styles.reviewSummaryItem}>
                    <span className={styles.reviewSummaryLabel}>结论</span>
                    <strong
                      className={styles.reviewDecision}
                      data-decision={latestReviewOutput.reviewDecision || 'pending'}
                    >
                      {getReviewDecisionLabel(latestReviewOutput.reviewDecision)}
                    </strong>
                  </div>
                  <div className={styles.reviewSummaryItem}>
                    <span className={styles.reviewSummaryLabel}>评分</span>
                    <strong>{formatReviewScore(latestReviewOutput.reviewScore)}</strong>
                  </div>
                  <div className={styles.reviewSummaryItem}>
                    <span className={styles.reviewSummaryLabel}>问题</span>
                    <div className={styles.reviewBulletList}>
                      {latestReviewIssues.length > 0 ? (
                        latestReviewIssues.map((issue) => <span key={issue}>{issue}</span>)
                      ) : (
                        <span className={styles.reviewEmptyText}>未提取到明确问题</span>
                      )}
                    </div>
                  </div>
                  <div className={styles.reviewSummaryItem}>
                    <span className={styles.reviewSummaryLabel}>建议</span>
                    <div className={styles.reviewBulletList}>
                      {latestRetryHints.length > 0 ? (
                        latestRetryHints.map((hint) => <span key={hint}>{hint}</span>)
                      ) : (
                        <span className={styles.reviewEmptyText}>暂无补充建议</span>
                      )}
                    </div>
                  </div>
                </div>

                {(latestReviewOutput.rawContent || latestReviewOutput.outputJson) && (
                  <details className={styles.outputDetails}>
                    <summary>查看原始审核输出</summary>
                    <pre className={styles.outputRawText}>
                      {latestReviewOutput.rawContent || latestReviewOutput.outputJson}
                    </pre>
                  </details>
                )}

                {latestReviewDecision === 'pass' && onAdvanceToScript && (
                  <div className={styles.outputActions}>
                    <button className={styles.btnSmall} type="button" onClick={onAdvanceToScript}>
                      <ArrowRight size={12} /> 进入剧本生成
                    </button>
                  </div>
                )}
              </div>
            ) : latestReviewSummaryText ? (
              <div className={styles.outputCard}>
                <div className={styles.outputHeader}>
                  <div className={styles.outputTitleGroup}>
                    <span className={styles.outputType} data-output-type="review">
                      审核
                    </span>
                    <strong>{latestReviewStep?.stepName || '审核步骤'}</strong>
                  </div>
                  <span className={styles.outputTime}>
                    {latestReviewSummaryEvent ? formatEventTime(latestReviewSummaryEvent.createdAt) : ''}
                  </span>
                </div>
                <div className={styles.outputPreview}>{latestReviewSummaryText}</div>
                {latestReviewNextAction && (
                  <div className={styles.reviewSummaryItem}>
                    <span className={styles.reviewSummaryLabel}>下一步</span>
                    <strong>{latestReviewNextAction}</strong>
                  </div>
                )}
                {(latestReviewSummaryEvent?.payloadJson || latestReviewSummaryDecision) && (
                  <details className={styles.outputDetails}>
                    <summary>查看原始事件摘要</summary>
                    <pre className={styles.outputRawText}>
                      {latestReviewSummaryEvent?.payloadJson || latestReviewSummaryText}
                    </pre>
                  </details>
                )}
                {latestReviewSummaryDecision === 'pass' && onAdvanceToScript && (
                  <div className={styles.outputActions}>
                    <button className={styles.btnSmall} type="button" onClick={onAdvanceToScript}>
                      <ArrowRight size={12} /> 进入剧本生成
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className={styles.outputCard}>
                <div className={styles.outputHeader}>
                  <div className={styles.outputTitleGroup}>
                    <span className={styles.outputType} data-output-type="review">
                      审核
                    </span>
                    <strong>{outlineReviewStep?.stepName || '审核任务'}</strong>
                  </div>
                  <span className={styles.outputTime}>
                    {latestReviewRuntimeEvent
                      ? formatEventTime(latestReviewRuntimeEvent.createdAt)
                      : outlineReviewStep?.updatedAt
                        ? formatEventTime(outlineReviewStep.updatedAt)
                        : ''}
                  </span>
                </div>

                <div className={styles.reviewSummaryGrid}>
                  <div className={styles.reviewSummaryItem}>
                    <span className={styles.reviewSummaryLabel}>状态</span>
                    <strong
                      className={
                        outlineReviewStep
                          ? STEP_STATUS_MAP[outlineReviewStep.status as StepStatus]?.className
                          : styles.statusQueued
                      }
                    >
                      {reviewStepStatusLabel}
                    </strong>
                  </div>
                  <div className={styles.reviewSummaryItem}>
                    <span className={styles.reviewSummaryLabel}>评语</span>
                    <div className={styles.outputPreview}>{reviewFallbackMessage}</div>
                  </div>
                  {reviewFallbackNextAction && (
                    <div className={styles.reviewSummaryItem}>
                      <span className={styles.reviewSummaryLabel}>下一步</span>
                      <strong>{reviewFallbackNextAction}</strong>
                    </div>
                  )}
                </div>

                {(outlineReviewStep?.errorMessage || latestReviewRuntimeEvent?.payloadJson) && (
                  <details className={styles.outputDetails}>
                    <summary>查看审核状态详情</summary>
                    <pre className={styles.outputRawText}>
                      {outlineReviewStep?.errorMessage || latestReviewRuntimeEvent?.payloadJson}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.sidePanel}>
        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>流程控制</h4>
          <div className={styles.statusRow}>
            <span className={styles.label}>当前状态：</span>
            <span>
              {currentRun ? (
                <span
                  className={
                    styles[
                      currentRun.run.status === 'completed'
                        ? 'statusCompleted'
                        : currentRun.run.status === 'failed' ||
                            currentRun.run.status === 'cancelled'
                          ? 'statusFailed'
                          : 'statusGenerating'
                    ]
                  }
                >
                  {(currentRun.run.status === 'running' || currentRun.run.status === 'queued') && (
                    <RotateCw size={14} className={styles.spinIcon} />
                  )}
                  {currentRunProgressLabel}
                </span>
              ) : (
                <span className={styles.statusGenerating}>
                  <RotateCw size={14} className={styles.spinIcon} /> 等待执行
                </span>
              )}
            </span>
          </div>
          {currentRun && (
            <>
              <div className={styles.statusRow}>
                <span className={styles.label}>当前步骤：</span>
                <span>{currentRunStep?.stepName || '等待调度'}</span>
              </div>
              <div className={styles.statusRow}>
                <span className={styles.label}>进度：</span>
                <span>
                  {currentRun.run.completedSteps}/{currentRun.run.totalSteps} 步骤完成
                </span>
              </div>
              {currentRun.run.errorCode && (
                <div className={styles.statusRow}>
                  <span className={styles.label}>错误码：</span>
                  <span style={{ color: 'var(--color-danger)' }}>
                    {runErrorMeta?.label || currentRun.run.errorCode}
                  </span>
                </div>
              )}
              {currentRun.run.errorCode && (
                <div className={styles.statusRow}>
                  <span className={styles.label}>说明：</span>
                  <span
                    style={{ color: 'var(--text-secondary)', maxWidth: 180, textAlign: 'right' }}
                  >
                    {runErrorMeta?.hint || currentRun.run.errorMessage || '请查看步骤错误详情'}
                  </span>
                </div>
              )}
            </>
          )}
          <div className={styles.statusRow}>
            <span className={styles.label}>下一流程：</span>
            <span>合规智能审核</span>
          </div>
        </div>

        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>制作流程设置</h4>
          <div className={styles.statusRow}>
            <span className={styles.label}>多智能体编排：</span>
            <span>{multiAgentBetaEnabled ? '已开启' : '未开启'}</span>
          </div>
          <div className={styles.statusRow}>
            <span className={styles.label}>Prompt 优化：</span>
            <span>{aiSettings.promptOptimizerBetaEnabled === true ? '已开启' : '未开启'}</span>
          </div>
          <div className={styles.statusRow}>
            <span className={styles.label}>基础退避：</span>
            <span>{retryBackoffSec} 秒</span>
          </div>
          <div className={styles.statusRow}>
            <span className={styles.label}>最大退避：</span>
            <span>{retryMaxBackoffSec} 秒</span>
          </div>
          <div className={styles.infoText}>
            这些参数已统一收口到 设置 &gt; 制作流程。修改后会影响大纲设计、审核和自动重试。
          </div>
          <div className={styles.alertActions} style={{ marginTop: 12 }}>
            <button className={styles.btnSecondary} onClick={() => setSettingsOpen(true)}>
              <PencilLine size={16} /> 打开设置调整
            </button>
          </div>
        </div>

        {currentRun && (isWaitingPrerequisite || isManualReviewRequired) && (
          <div
            className={`${styles.alertCard} ${isManualReviewRequired ? styles.alertDanger : styles.alertWarning}`}
          >
            <div className={styles.alertTitle}>
              {isManualReviewRequired ? '需要人工复核后重试' : '流程等待前置条件满足'}
            </div>
            <div className={styles.alertBody}>
              {currentRun.run.errorMessage ||
                (isManualReviewRequired
                  ? '审核阶段已触发人工复核要求，请处理失败步骤后重试。'
                  : '当前存在阻塞步骤，请先满足前置条件。')}
            </div>
            <div className={styles.alertActions}>
              {failedOrBlockedSteps.length > 0 && (
                <button
                  className={styles.btnSmall}
                  onClick={() =>
                    void handleRetryFailedSteps(
                      isManualReviewRequired
                        ? (composeManualReviewReason() ?? undefined)
                        : undefined,
                    )
                  }
                  disabled={isLoading}
                >
                  <RotateCw size={12} /> 一键重试失败步骤
                </button>
              )}
              {isWaitingPrerequisite && (
                <>
                  <button
                    className={styles.btnSmall}
                    onClick={() => void loadLatestRun()}
                    disabled={isLoading}
                  >
                    <RotateCw size={12} /> 刷新状态
                  </button>
                  {isMissingEndpoint && (
                    <button
                      className={styles.btnSmall}
                      onClick={() => setSettingsOpen(true)}
                      disabled={isLoading}
                    >
                      <AlertCircle size={12} /> 检查端点配置
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {currentRun && isManualReviewRequired && (
          <div className={styles.panelBlock}>
            <h4 className={styles.panelTitle}>人工复核工作台</h4>
            <div className={styles.manualReviewSummary}>
              当前共有 {failedOrBlockedSteps.length}{' '}
              个待处理步骤。请确认责任人、填写人工结论后再触发重试，系统会将这条说明写入流程事件。
            </div>
            <div className={styles.reviewStepList}>
              {failedOrBlockedSteps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className={`${styles.reviewStepCard} ${selectedManualReviewStep?.id === step.id ? styles.reviewStepCardActive : ''}`}
                  onClick={() => setSelectedManualReviewStepId(step.id)}
                >
                  <div className={styles.reviewStepHead}>
                    <span className={styles.stepName}>{step.stepName}</span>
                    <span
                      className={`${styles.stepStatus} ${STEP_STATUS_MAP[step.status as StepStatus]?.className || styles.statusQueued}`}
                    >
                      {STEP_STATUS_MAP[step.status as StepStatus]?.label || step.status}
                    </span>
                  </div>
                  <div className={styles.reviewMeta}>
                    <span>尝试 {step.attemptCount} 次</span>
                    {step.lastErrorAt && <span>最近失败 {formatEventTime(step.lastErrorAt)}</span>}
                  </div>
                  {step.errorMessage && <div className={styles.stepError}>{step.errorMessage}</div>}
                </button>
              ))}
            </div>
            <label className={styles.reviewField}>
              <span>处理责任人</span>
              <input
                className={styles.reviewInput}
                placeholder="例：主编统筹官 / 当前处理人"
                value={manualReviewOwner}
                onChange={(event) => setManualReviewOwner(event.target.value)}
              />
            </label>
            <label className={styles.reviewField}>
              <span>人工复核结论</span>
              <textarea
                className={styles.reviewTextarea}
                placeholder="请填写本次人工检查结论、修正判断或允许重试的依据。"
                value={manualReviewNote}
                onChange={(event) => setManualReviewNote(event.target.value)}
              />
            </label>
            <div className={styles.alertActions}>
              <button
                className={styles.btnPrimary}
                onClick={() => void handleSubmitManualReview()}
                disabled={isLoading || !selectedManualReviewStep}
              >
                <RotateCw size={16} /> 重试所选步骤
              </button>
              <button
                className={styles.btnSecondary}
                onClick={() => void handleSubmitManualReviewBatch()}
                disabled={isLoading || failedOrBlockedSteps.length === 0}
              >
                <CheckCircle size={16} /> 批量重试并留痕
              </button>
            </div>
            <div className={styles.reviewHistoryList}>
              <div className={styles.infoText}>人工复核记录</div>
              {manualReviewEvents.length > 0 ? (
                manualReviewEvents.slice(0, 6).map((event) => (
                  <div key={event.id} className={styles.reviewHistoryItem}>
                    <div className={styles.eventHeader}>
                      <span className={styles.eventType}>{event.eventType}</span>
                      <span className={styles.eventTime}>{formatEventTime(event.createdAt)}</span>
                    </div>
                    <div className={styles.eventText}>
                      {summarizeEvent(event.eventType, event.payloadJson)}
                    </div>
                  </div>
                ))
              ) : (
                <div className={styles.infoText}>暂无人工复核记录</div>
              )}
            </div>
          </div>
        )}

        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>执行 Agent</h4>
          <div className={styles.agentCard}>
            <div className={styles.agentAvatar}>AI</div>
            <div className={styles.agentInfo}>
              <div className={styles.agentName}>大纲节点</div>
              <div className={styles.agentRole}>
                {currentRun
                  ? `运行ID: ${currentRun.run.id.slice(0, 8)}...`
                  : '等待分配智能体进行梳理'}
              </div>
            </div>
          </div>
        </div>

        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>最近事件</h4>
          {currentRun && currentRun.recentEvents.length > 0 ? (
            <div className={styles.eventList}>
              {currentRun.recentEvents.slice(0, 8).map((event) => (
                <div key={event.id} className={styles.eventItem}>
                  <div className={styles.eventHeader}>
                    <span className={styles.eventType}>{event.eventType}</span>
                    <span className={styles.eventTime}>{formatEventTime(event.createdAt)}</span>
                  </div>
                  <div className={styles.eventText}>
                    {summarizeEvent(event.eventType, event.payloadJson)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.infoText}>暂无流程事件</div>
          )}
        </div>

        {latestOptimization && (
          <div className={styles.panelBlock}>
            <h4 className={styles.panelTitle}>下一轮优化建议</h4>
            <div className={styles.infoText}>
              这些建议会在你点击下方按钮后自动带入下一次生成或复审。
            </div>
            {latestOptimization.designPromptPatch && (
              <div className={styles.optimizationCard}>
                <div className={styles.eventHeader}>
                  <span className={styles.eventType}>设计改进建议</span>
                  <span className={styles.eventTime}>{formatEventTime(latestOptimization.createdAt)}</span>
                </div>
                <div className={styles.eventText}>
                  {latestOptimization.designPromptPatch.slice(0, 180)}
                  {latestOptimization.designPromptPatch.length > 180 ? '...' : ''}
                </div>
                <button
                  type="button"
                  className={styles.btnSmall}
                  onClick={handleRegenerateWithOptimization}
                  disabled={isSubmitting || isLoading || !multiAgentBetaEnabled}
                >
                  <RotateCw size={12} /> 按建议重新生成
                </button>
              </div>
            )}
            {latestOptimization.reviewPromptPatch && (
              <div className={styles.optimizationCard}>
                <div className={styles.eventHeader}>
                  <span className={styles.eventType}>审核规则补充</span>
                  <span className={styles.eventTime}>{formatEventTime(latestOptimization.createdAt)}</span>
                </div>
                <div className={styles.eventText}>
                  {latestOptimization.reviewPromptPatch.slice(0, 180)}
                  {latestOptimization.reviewPromptPatch.length > 180 ? '...' : ''}
                </div>
                <button
                  type="button"
                  className={styles.btnSmall}
                  onClick={handleReviewWithOptimization}
                  disabled={isSubmitting || isLoading || !multiAgentBetaEnabled}
                >
                  <CheckCircle size={12} /> 按建议重新复审
                </button>
              </div>
            )}
          </div>
        )}

        <div className={styles.panelActions}>
          {!multiAgentBetaEnabled && (
            <button className={styles.btnSecondary} onClick={() => setSettingsOpen(true)}>
              <AlertCircle size={16} /> 前往设置调整流程
            </button>
          )}
          {canControl && (
            <>
              {isPaused ? (
                <button className={styles.btnPrimary} onClick={handleResume} disabled={isLoading}>
                  <Play size={16} /> 恢复执行
                </button>
              ) : (
                <button className={styles.btnSecondary} onClick={handlePause} disabled={isLoading}>
                  <PauseCircle size={16} /> 暂停生成
                </button>
              )}
              <button className={styles.btnSecondary} onClick={handleCancel} disabled={isLoading}>
                <XCircle size={16} /> 取消任务
              </button>
            </>
          )}
          <button
            className={styles.btnSecondary}
            onClick={handleRegenerate}
            disabled={isSubmitting || isLoading || !multiAgentBetaEnabled}
          >
            <RotateCw size={16} /> 重新生成
          </button>
          <button
            className={styles.btnPrimary}
            onClick={handleApprove}
            disabled={isSubmitting || isLoading || !multiAgentBetaEnabled}
          >
            <CheckCircle size={16} /> {latestReviewDecision === 'pass' ? '重新复审' : '提交审核任务'}
          </button>
        </div>
      </div>
    </div>
  );
};
