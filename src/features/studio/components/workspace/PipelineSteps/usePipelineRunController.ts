/**
 * usePipelineRunController —— Pipeline Run 共享控制器 hook
 *
 * 从 OutlineView.tsx 提炼的通用逻辑，供 5 个 View（Outline/Script/CharScene/Keyframe/Video）复用。
 *
 * 职责：
 * 1. 状态管理：currentRun / isLoading / loadError / isSubmitting
 * 2. 幂等键生成：projectId + conversationId + pipelineType + triggerSource + hash(payload)（治理文档 20.4）
 * 3. launch：createPipelineRun → getPipelineRun → setFocusedRunId，返回 run.id
 * 4. loadLatestRun：listPipelineRuns → 找 focusedRunId 或 runs[0] → getPipelineRun + getPipelineOptimizations
 * 5. SSE 订阅 + 兜底轮询：终态不订阅；有 focusedRunId → SSE；无 → setInterval(5000) 兜底
 * 6. 控制操作：pause/resume/cancel/retryStep 透传 serverApi + 刷新 run + toast
 * 7. 派生显示态：通过 pipelineStatusPresets 暴露 displayState/displayPreset/currentStep
 * 8. 资产刷新去重：refreshedAssetIdsRef 防止重复 refreshWorkspace
 *
 * 关键约束（req #2）：不允许通过 setTimeout 推进步骤或伪造完成状态；
 * 状态推进只能来自 API 返回或 SSE 回传。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import {
  createPipelineRun,
  getPipelineRun,
  getPipelineOptimizations,
  listPipelineRuns,
  pausePipelineRun,
  resumePipelineRun,
  cancelPipelineRun,
  retryPipelineStep,
  streamPipelineRun,
  type PipelinePromptOptimization,
  type PipelineRunSummary,
  type PipelineStepOutput,
} from '../../../../../lib/serverApi';
import { logger } from '../../../../../lib/logger';
import { useAppActions } from '../../../../../context/useAppActions';
import { useAppStore } from '../../../../../store';
import { useToast } from '../../../../../context/useToast';
import {
  deriveDisplayState,
  getDisplayPreset,
  pickCurrentStep,
  type PipelineDisplayState,
} from './pipelineStatusPresets';

/**
 * 单个步骤的输入定义（View 层构造，传给 launch）
 */
export interface PipelineStepInput {
  stepKey: string;
  stepName: string;
  stepOrder: number;
  stepType?: 'design' | 'review' | 'system' | 'image_gen' | 'video_gen';
  dependsOn?: string[];
  reviewPolicy?: Record<string, unknown>;
  maxRetries?: number;
  promptTemplate?: string;
}

/**
 * hook 配置项
 */
export interface UsePipelineRunControllerOptions {
  /** Pipeline 类型标识，用于幂等键和 listPipelineRuns 过滤 */
  pipelineType: string;
  /** 触发来源，默认 'manual' */
  triggerSource?: string;
  /** 是否启用 hook（通常 = isServerWorkspaceReady && projectId），默认 true */
  enabled?: boolean;
  /** 是否要求 Beta 开关，默认 true */
  requireBeta?: boolean;
}

/**
 * djb2 字符串哈希（确定性，无依赖）
 *
 * 用于幂等键的 payload 部分，确保相同 payload 生成相同 key。
 *
 * @param str 待哈希的字符串
 * @returns 16 进制哈希值
 *
 * @internal 导出仅供单元测试验证确定性，不作为外部 API
 */
export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash = hash & 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}

/**
 * 构造确定性幂等键
 *
 * 格式：`{projectId}:{conversationId}:{pipelineType}:{triggerSource}:{hash(stepsPayload)}`
 *
 * 治理文档 20.4 默认决策值，修正 OutlineView 现有 `Date.now()+random` 隐患。
 * 相同输入 → 相同 key → 后端命中幂等返回 409 + 既有 run（req #4）。
 *
 * @param projectId 项目 ID
 * @param conversationId 会话 ID
 * @param pipelineType Pipeline 类型
 * @param triggerSource 触发来源
 * @param steps 步骤列表（参与 hash）
 * @param scope 额外作用域标识（如 'review_only'），参与 hash
 * @returns 确定性幂等键
 */
export function buildIdempotencyKey(
  projectId: string,
  conversationId: string,
  pipelineType: string,
  triggerSource: string,
  steps: PipelineStepInput[],
  scope?: string,
): string {
  const payload = JSON.stringify({
    s: scope ?? '',
    t: pipelineType,
    r: triggerSource,
    steps: steps.map((s) => ({
      k: s.stepKey,
      n: s.stepName,
      o: s.stepOrder,
      y: s.stepType,
      d: s.dependsOn,
      p: s.reviewPolicy,
      m: s.maxRetries,
      pt: s.promptTemplate,
    })),
  });
  const payloadHash = hashString(payload);
  return `${projectId}:${conversationId}:${pipelineType}:${triggerSource}:${payloadHash}`;
}

/**
 * 从 PipelineStepOutput 列表提取 assetId（用于资产刷新去重）
 *
 * @param outputs 步骤输出列表
 * @returns assetId 列表
 */
export function extractOutputAssetIds(outputs: PipelineStepOutput[]): string[] {
  return outputs
    .map((output) => {
      if (!output.outputJson) return '';
      try {
        const payload = JSON.parse(output.outputJson) as Record<string, unknown>;
        if (typeof payload.assetId === 'string' && payload.assetId.trim()) {
          return payload.assetId.trim();
        }
        const nested = payload.asset as { id?: unknown } | undefined;
        if (nested && typeof nested.id === 'string' && nested.id.trim()) {
          return nested.id.trim();
        }
      } catch {
        // ignore parse error
      }
      return '';
    })
    .filter(Boolean);
}

/**
 * usePipelineRunController hook 实现
 *
 * @param options 配置项
 * @returns 控制器状态和操作
 */
export function usePipelineRunController(
  options: UsePipelineRunControllerOptions,
): {
  currentRun: PipelineRunSummary | null;
  isLoading: boolean;
  loadError: string;
  isSubmitting: boolean;
  promptOptimizations: PipelinePromptOptimization[];
  displayState: PipelineDisplayState;
  displayPreset: ReturnType<typeof getDisplayPreset>;
  currentStep: ReturnType<typeof pickCurrentStep>;
  launch: (
    steps: PipelineStepInput[],
    launchOptions?: { idempotencyScope?: string },
  ) => Promise<string | null>;
  loadLatestRun: () => Promise<void>;
  pause: (reason?: string) => Promise<void>;
  resume: () => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  retryStep: (stepId: string, reason?: string) => Promise<void>;
} {
  const { pipelineType, triggerSource = 'manual', enabled = true, requireBeta = true } = options;

  const [currentRun, setCurrentRun] = useState<PipelineRunSummary | null>(null);
  const [promptOptimizations, setPromptOptimizations] = useState<PipelinePromptOptimization[]>(
    [],
  );
  const [isLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const focusedRunIdRef = useRef<string | null>(null);
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
  const projectId = activeState.projectId ?? '';
  const conversationId = activeState.chatSessionId ?? '';

  const currentRunStatus = currentRun?.run.status;
  const currentRunSteps = currentRun?.steps ?? [];
  const currentRunOutputs = currentRun?.outputs ?? [];

  const displayState = useMemo(
    () => deriveDisplayState(currentRun?.run ?? null, currentRunSteps),
    [currentRun, currentRunSteps],
  );
  const displayPreset = useMemo(
    () => getDisplayPreset(currentRun?.run ?? null, currentRunSteps),
    [currentRun, currentRunSteps],
  );
  const currentStep = useMemo(
    () => pickCurrentStep(currentRunSteps),
    [currentRunSteps],
  );

  const pipelineOutputAssetIds = useMemo(
    () => extractOutputAssetIds(currentRunOutputs),
    [currentRunOutputs],
  );

  /**
   * 加载当前项目的最新流程运行状态
   *
   * 逻辑：
   * 1. listPipelineRuns({projectId, conversationId, limit:30})
   * 2. 找 focusedRunId 或 runs[0]
   * 3. 终态 run 清空 focusedRunId（req #4：终态保护）
   * 4. 并发 getPipelineRun + getPipelineOptimizations
   */
  const loadLatestRun = useCallback(async () => {
    if (!projectId) {
      setLoadError('');
      return;
    }
    try {
      setLoadError('');
      const runs = await listPipelineRuns({
        projectId,
        conversationId: conversationId || undefined,
        limit: 30,
      });
      // 按 pipelineType + triggerSource 过滤，确保每个 View 只显示自己类型的 run
      // （DB pipeline_type CHECK 白名单不含 char_scene/keyframe/video，用 custom + triggerSource 区分）
      const filteredRuns = runs.filter(
        (run) => run.pipelineType === pipelineType && run.triggerSource === triggerSource,
      );
      if (filteredRuns.length === 0) {
        setCurrentRun(null);
        setPromptOptimizations([]);
        return;
      }
      const focusedRunId = focusedRunIdRef.current;
      const targetRun =
        (focusedRunId ? filteredRuns.find((run) => run.id === focusedRunId) : null) ??
        filteredRuns[0];
      if (
        targetRun.status === 'completed' ||
        targetRun.status === 'failed' ||
        targetRun.status === 'cancelled'
      ) {
        focusedRunIdRef.current = null;
      } else {
        focusedRunIdRef.current = targetRun.id;
      }
      const [detail, optimizations] = await Promise.all([
        getPipelineRun(targetRun.id),
        getPipelineOptimizations(targetRun.id),
      ]);
      setCurrentRun(detail);
      setPromptOptimizations(optimizations);
    } catch (error) {
      const message = error instanceof Error ? error.message : '流程数据加载失败，请稍后重试';
      setLoadError(message === 'UNAUTHORIZED' ? '登录状态已失效，请重新登录后再查看流程。' : message);
      logger.error('Failed to load pipeline run:', error);
    }
  }, [projectId, conversationId, pipelineType, triggerSource]);

  /**
   * 启动新的 Pipeline Run
   *
   * 逻辑：
   * 1. Beta / 服务端 / 项目 / 会话 前置校验
   * 2. 构造确定性幂等键（req #4）
   * 3. createPipelineRun → getPipelineRun 拿详情
   * 4. setFocusedRunId + setCurrentRun + toast
   * 5. 409 幂等命中：catch 后 loadLatestRun 刷新既有 run，返回 null
   *
   * @param steps 步骤列表
   * @param launchOptions 启动选项（idempotencyScope 用于区分同类型不同模式的 run）
   * @returns run.id，失败返回 null
   */
  const launch = useCallback(
    async (
      steps: PipelineStepInput[],
      launchOptions?: { idempotencyScope?: string },
    ): Promise<string | null> => {
      if (requireBeta && !multiAgentBetaEnabled) {
        showToast({
          type: 'warning',
          title: 'Beta 功能未开启',
          message: '请在 设置 > 制作流程 中开启"多智能体自动编排（Beta）"后再试。',
        });
        setSettingsOpen(true);
        return null;
      }

      if (!isServerWorkspaceReady) {
        showToast({
          type: 'error',
          title: '服务端未就绪',
          message: '请先确保后端已启动，再执行流程。',
        });
        return null;
      }

      if (!projectId) {
        showToast({
          type: 'warning',
          title: '缺少项目上下文',
          message: '请先选择项目后再启动流程。',
        });
        return null;
      }

      if (!conversationId) {
        showToast({
          type: 'warning',
          title: '缺少会话上下文',
          message: '请先进入项目对话，再启动流程。',
        });
        return null;
      }

      const idempotencyKey = buildIdempotencyKey(
        projectId,
        conversationId,
        pipelineType,
        triggerSource,
        steps,
        launchOptions?.idempotencyScope,
      );

      setIsSubmitting(true);
      try {
        const run = await createPipelineRun({
          projectId,
          conversationId,
          pipelineType,
          triggerSource,
          betaEnabled: multiAgentBetaEnabled,
          idempotencyKey,
          steps,
        });

        focusedRunIdRef.current = run.id;
        const detail = await getPipelineRun(run.id);
        setCurrentRun(detail);
        showToast({
          type: 'success',
          title: '流程已启动',
          message: `运行ID: ${run.id.slice(0, 8)}...`,
        });
        return run.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法创建流程运行';
        // 幂等命中（409 CONFLICT）：刷新既有 run，不展示错误 toast
        if (message.includes('409') || message.includes('CONFLICT')) {
          await loadLatestRun();
          showToast({
            type: 'info',
            title: '已有运行中的流程',
            message: '相同流程已在执行中，已为你切回既有运行。',
          });
          return null;
        }
        showToast({
          type: 'error',
          title: '流程启动失败',
          message,
        });
        return null;
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      requireBeta,
      multiAgentBetaEnabled,
      isServerWorkspaceReady,
      projectId,
      conversationId,
      pipelineType,
      triggerSource,
      setSettingsOpen,
      showToast,
      loadLatestRun,
    ],
  );

  /**
   * 暂停流程（req #6：操作权限由后端 user_id 隔离）
   */
  const pause = useCallback(
    async (reason?: string) => {
      const runId = focusedRunIdRef.current ?? currentRun?.run.id;
      if (!runId) return;
      try {
        await pausePipelineRun(runId, reason);
        await loadLatestRun();
        showToast({ type: 'success', title: '已暂停', message: '流程已暂停' });
      } catch (error) {
        showToast({
          type: 'error',
          title: '暂停失败',
          message: error instanceof Error ? error.message : '无法暂停流程',
        });
      }
    },
    [currentRun, showToast, loadLatestRun],
  );

  /**
   * 恢复流程（req #6：操作权限由后端 user_id 隔离）
   */
  const resume = useCallback(async () => {
    const runId = focusedRunIdRef.current ?? currentRun?.run.id;
    if (!runId) return;
    try {
      await resumePipelineRun(runId);
      await loadLatestRun();
      showToast({ type: 'success', title: '已恢复', message: '流程已恢复执行' });
    } catch (error) {
      showToast({
        type: 'error',
        title: '恢复失败',
        message: error instanceof Error ? error.message : '无法恢复流程',
      });
    }
  }, [currentRun, showToast, loadLatestRun]);

  /**
   * 取消流程（req #6：操作权限由后端 user_id 隔离）
   */
  const cancel = useCallback(
    async (reason?: string) => {
      const runId = focusedRunIdRef.current ?? currentRun?.run.id;
      if (!runId) return;
      try {
        await cancelPipelineRun(runId, reason);
        await loadLatestRun();
        showToast({ type: 'success', title: '已取消', message: '流程已取消' });
      } catch (error) {
        showToast({
          type: 'error',
          title: '取消失败',
          message: error instanceof Error ? error.message : '无法取消流程',
        });
      }
    },
    [currentRun, showToast, loadLatestRun],
  );

  /**
   * 重试指定步骤（req #6：终态保护由后端 retry_pipeline_step 强制）
   */
  const retryStep = useCallback(
    async (stepId: string, reason?: string) => {
      const runId = focusedRunIdRef.current ?? currentRun?.run.id;
      if (!runId) return;
      try {
        await retryPipelineStep(runId, stepId, reason);
        await loadLatestRun();
        showToast({ type: 'success', title: '已重试', message: '步骤已重新加入执行队列' });
      } catch (error) {
        showToast({
          type: 'error',
          title: '重试失败',
          message: error instanceof Error ? error.message : '无法重试步骤',
        });
      }
    },
    [currentRun, showToast, loadLatestRun],
  );

  /**
   * 初始化加载 + SSE 订阅 + 兜底轮询
   *
   * 逻辑（与 OutlineView 现有实现对齐）：
   * 1. enabled && projectId → loadLatestRun
   * 2. 终态不订阅（req #4）
   * 3. 有 focusedRunId → streamPipelineRun SSE 订阅
   * 4. 无 focusedRunId → setInterval(5000) 兜底轮询（仅用于恢复无主 run）
   * 5. 组件卸载/依赖变化 → abort + clearInterval
   */
  useEffect(() => {
    if (!enabled || !projectId) {
      return;
    }

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

    return () => controller.abort();
  }, [enabled, projectId, currentRunStatus, loadLatestRun]);

  /**
   * 资产刷新去重（req #7：避免重复刷新）
   *
   * 当 pipeline 产出新 assetId 时，刷新工作区资产库，但每个 assetId 只刷新一次。
   */
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

  return {
    currentRun,
    isLoading,
    loadError,
    isSubmitting,
    promptOptimizations,
    displayState,
    displayPreset,
    currentStep,
    launch,
    loadLatestRun,
    pause,
    resume,
    cancel,
    retryStep,
  };
}
