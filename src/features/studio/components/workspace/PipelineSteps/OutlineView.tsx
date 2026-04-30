import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Play,
  RotateCw,
  PauseCircle,
  CheckCircle,
  AlertCircle,
  XCircle,
  SkipForward,
} from 'lucide-react';

import styles from './PipelineSteps.module.css';
import {
  createPipelineRun,
  getPipelineRun,
  getPipelineOptimizations,
  listPipelineRuns,
  pausePipelineRun,
  resumePipelineRun,
  cancelPipelineRun,
  retryPipelineStep,
  type PipelinePromptOptimization,
  type PipelineRunSummary,
  type PipelineStepStatus,
} from '../../../../../lib/serverApi';
import { logger } from '../../../../../lib/logger';
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

export const OutlineView: React.FC = () => {
  const [outlineDraft, setOutlineDraft] = useState('');
  const [currentRun, setCurrentRun] = useState<PipelineRunSummary | null>(null);
  const [promptOptimizations, setPromptOptimizations] = useState<PipelinePromptOptimization[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualReviewOwner, setManualReviewOwner] = useState('');
  const [manualReviewNote, setManualReviewNote] = useState('');
  const [selectedManualReviewStepId, setSelectedManualReviewStepId] = useState<string | null>(null);
  const { showToast } = useToast();
  const { activeState, isServerWorkspaceReady, aiSettings, updateAiSettings, setSettingsOpen } =
    useAppStore(
      useShallow((state) => ({
        activeState: state.activeState,
        isServerWorkspaceReady: state.isServerWorkspaceReady,
        aiSettings: state.aiSettings,
        updateAiSettings: state.updateAiSettings,
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

  const updateRetryPolicy = (nextBackoffSec: number, nextMaxBackoffSec: number) => {
    const normalizedBackoffSec = Math.min(300, Math.max(1, Math.round(nextBackoffSec || 4)));
    const normalizedMaxBackoffSec = Math.min(
      900,
      Math.max(normalizedBackoffSec, Math.round(nextMaxBackoffSec || 90)),
    );
    updateAiSettings({
      ...aiSettings,
      pipelineRetryBackoffSec: normalizedBackoffSec,
      pipelineRetryMaxBackoffSec: normalizedMaxBackoffSec,
    });
  };

  const buildOutlineDesignPrompt = (draftText: string) => {
    const normalizedDraft =
      draftText.trim() || '当前没有现成草稿，请从项目目标和历史对话中补齐完整大纲。';
    return [
      '你是大纲架构师，请基于当前项目上下文产出可执行的大纲方案。',
      '',
      `已有草稿：${normalizedDraft}`,
      '',
      '要求：',
      '1. 给出故事钩子、核心冲突、关键转折和结局走向。',
      '2. 按短视频/短剧节奏拆出段落节点（起承转合）。',
      '3. 标记每段的目标情绪和人物推进。',
      '4. 输出内容可直接进入剧本阶段，不要只给抽象建议。',
    ].join('\n');
  };

  const buildOutlineReviewPrompt = () => {
    return [
      '你是合规审核官，请审核上一步大纲产出。',
      '',
      '审核标准：',
      '1. 结构完整度（钩子、冲突、转折、结局）',
      '2. 节奏可执行性（短剧节奏和段落拆分是否可落地）',
      '3. 风险与合规（是否有明显风险或不当表述）',
      '',
      '如果不通过，请给出可执行修改项和重试建议。',
    ].join('\n');
  };

  const createOutlinePipelineRun = async (mode: 'full' | 'review_only') => {
    if (!multiAgentBetaEnabled) {
      showToast({
        type: 'warning',
        title: 'Beta 功能未开启',
        message: '请在 设置 > 高级解码参数 中开启“多智能体自动编排（Beta）”后再试。',
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

    const designPrompt = buildOutlineDesignPrompt(outlineDraft);
    const reviewPrompt = buildOutlineReviewPrompt();
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
    if (!activeState.projectId) return;
    try {
      const runs = await listPipelineRuns({
        projectId: activeState.projectId,
        limit: 1,
      });
      if (runs.length === 0) {
        setCurrentRun(null);
        setPromptOptimizations([]);
        return;
      }
      const [detail, optimizations] = await Promise.all([
        getPipelineRun(runs[0].id),
        getPipelineOptimizations(runs[0].id),
      ]);
      setCurrentRun(detail);
      setPromptOptimizations(optimizations);
    } catch (error) {
      logger.error('Failed to load pipeline run:', error);
    }
  }, [activeState.projectId]);

  useEffect(() => {
    if (isServerWorkspaceReady && activeState.projectId) {
      void loadLatestRun();
      const isTerminal = currentRunStatus
        ? ['completed', 'failed', 'cancelled'].includes(currentRunStatus)
        : false;
      if (isTerminal) {
        return;
      }
      const interval = setInterval(() => {
        void loadLatestRun();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [isServerWorkspaceReady, activeState.projectId, currentRunStatus, loadLatestRun]);

  const handleRegenerate = () => {
    void createOutlinePipelineRun('full');
  };

  const handleApprove = () => {
    void createOutlinePipelineRun('review_only');
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
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
            <span className={styles.progressText}>{progressPercent}%</span>
          </div>
        )}

        <textarea
          className={styles.fullTextArea}
          placeholder="暂无大纲内容..."
          value={outlineDraft}
          onChange={(event) => setOutlineDraft(event.target.value)}
        />

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
                      currentRun.run.status === 'completed' ? 'statusCompleted' : 'statusGenerating'
                    ]
                  }
                >
                  {STEP_STATUS_MAP[
                    (currentRun.steps.find((s) => s.status === 'running')?.status ||
                      currentRun.run.status) as StepStatus
                  ]?.label || currentRun.run.status}
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
          <h4 className={styles.panelTitle}>自动重试策略</h4>
          <div className={styles.retryPolicyGrid}>
            <label className={styles.retryPolicyItem}>
              <span>基础退避秒数</span>
              <input
                className={styles.numberInput}
                type="number"
                min={1}
                max={300}
                step={1}
                value={retryBackoffSec}
                onChange={(event) => {
                  const nextBackoffSec = Number(event.target.value || retryBackoffSec);
                  updateRetryPolicy(nextBackoffSec, retryMaxBackoffSec);
                }}
              />
            </label>
            <label className={styles.retryPolicyItem}>
              <span>最大退避秒数</span>
              <input
                className={styles.numberInput}
                type="number"
                min={1}
                max={900}
                step={1}
                value={retryMaxBackoffSec}
                onChange={(event) => {
                  const nextMaxBackoffSec = Number(event.target.value || retryMaxBackoffSec);
                  updateRetryPolicy(retryBackoffSec, nextMaxBackoffSec);
                }}
              />
            </label>
          </div>
          <div className={styles.infoText}>
            该配置会下发到当前流程步骤的重试策略。网络/上游异常会按退避时间自动重试。
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
            <h4 className={styles.panelTitle}>Prompt 优化建议（Beta）</h4>
            <div className={styles.infoText}>
              最新建议时间：{formatEventTime(latestOptimization.createdAt)}
            </div>
            {latestOptimization.designPromptPatch && (
              <div className={styles.eventItem} style={{ marginTop: 10 }}>
                <div className={styles.eventHeader}>
                  <span className={styles.eventType}>设计侧 Patch</span>
                </div>
                <div className={styles.eventText}>
                  {latestOptimization.designPromptPatch.slice(0, 180)}
                  {latestOptimization.designPromptPatch.length > 180 ? '...' : ''}
                </div>
              </div>
            )}
            {latestOptimization.reviewPromptPatch && (
              <div className={styles.eventItem} style={{ marginTop: 8 }}>
                <div className={styles.eventHeader}>
                  <span className={styles.eventType}>审核侧 Patch</span>
                </div>
                <div className={styles.eventText}>
                  {latestOptimization.reviewPromptPatch.slice(0, 180)}
                  {latestOptimization.reviewPromptPatch.length > 180 ? '...' : ''}
                </div>
              </div>
            )}
          </div>
        )}

        <div className={styles.panelActions}>
          {!multiAgentBetaEnabled && (
            <button className={styles.btnSecondary} onClick={() => setSettingsOpen(true)}>
              <AlertCircle size={16} /> 前往设置开启 Beta
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
            <CheckCircle size={16} /> 提交审核任务
          </button>
        </div>
      </div>
    </div>
  );
};
