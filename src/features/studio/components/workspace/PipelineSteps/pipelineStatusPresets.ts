/**
 * Pipeline 共享状态文案层
 *
 * 治理文档 6.1 三层状态口径：
 * - 逻辑态（PipelineRunStatus / PipelineStepStatus）：DB 存储态，受 CHECK 约束
 * - 诊断态（errorCode）：机器可识别的错误码
 * - 显示态（PipelineDisplayState）：UI 渲染用的派生态，联合 status + errorCode 推导
 *
 * 本模块只做"派生 + 文案查表"，不做副作用。所有 View 共用同一份文案表，
 * 避免各 View 各自维护一份状态文案导致口径漂移。
 */

import type {
  PipelineRun,
  PipelineRunStatus,
  PipelineRunStep,
  PipelineRunSummary,
  PipelineStepStatus,
} from '../../../../../lib/serverApi';

/**
 * Pipeline 显示态（8 态）
 *
 * 与 DB 存储态（PipelineRunStatus 6 态 + PipelineStepStatus 7 态）的关系：
 * - queued / running / completed / failed / cancelled：直接映射 PipelineRunStatus
 * - paused：直接映射 PipelineRunStatus.paused
 * - blocked：派生自 run.status='running' + 任一 step.status='blocked'
 * - manual_review_required：派生自 run.status='failed' + errorCode='MANUAL_REVIEW_REQUIRED'
 */
export type PipelineDisplayState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'manual_review_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 显示态对应的可执行下一步操作标识
 *
 * View 层根据此标识渲染对应按钮（req #5：统一下一步操作）。
 */
export type PipelineNextAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry_step'
  | 'view_error'
  | 'advance'
  | 'restart';

/**
 * 显示态对应的文案预设
 */
export interface PipelineDisplayPreset {
  /** 状态标签（如"执行中"） */
  label: string;
  /** 状态说明（含可操作提示，req #3） */
  hint: string;
  /** 进度 0-1（冻结态使用当前 completedSteps/totalSteps） */
  progress: number;
  /** 可执行的下一步操作列表 */
  nextActions: PipelineNextAction[];
  /** 是否为终态（终态不订阅 SSE，req #4） */
  isTerminal: boolean;
}

/**
 * 错误码对应的文案预设（诊断态 → 可操作提示）
 *
 * 与 OutlineView.tsx 原 RUN_ERROR_LABELS 对齐，提取为共享层。
 */
export interface PipelineErrorCodePreset {
  /** 错误码标签 */
  label: string;
  /** 可操作提示 */
  hint: string;
  /** 建议动作 */
  action: PipelineNextAction | null;
}

/**
 * 错误码文案表（与后端 RUN_ERROR_* 常量对齐）
 *
 * 后端定义位置：server/src/pipeline/orchestrator.rs 的 RUN_ERROR_MISSING_ENDPOINT 等。
 * 前端只读消费，不重复定义错误码枚举。
 */
export const PIPELINE_ERROR_CODE_PRESETS: Record<string, PipelineErrorCodePreset> = {
  MISSING_ENDPOINT: {
    label: '缺少可用端点',
    hint: '当前没有可用 AI 端点，请先在设置中配置并激活端点后重试。',
    action: 'view_error',
  },
  DEPENDENCY_UNSATISFIED: {
    label: '依赖未满足',
    hint: '步骤依赖未满足，请检查上游步骤状态或流程配置。',
    action: 'view_error',
  },
  RETRY_SCHEDULED: {
    label: '自动重试等待中',
    hint: '系统正在按退避策略等待下一次自动重试。',
    action: null,
  },
  WAITING_PREREQUISITE: {
    label: '等待前置条件',
    hint: '存在依赖未满足或端点未就绪，流程会在条件满足后继续推进。',
    action: 'view_error',
  },
  MANUAL_REVIEW_REQUIRED: {
    label: '需要人工复核',
    hint: '自动审核多次失败，建议人工检查后手动重试失败步骤。',
    action: 'retry_step',
  },
  EXECUTION_FAILED: {
    label: '执行失败',
    hint: '流程已终止，请查看失败步骤错误信息并执行重试。',
    action: 'retry_step',
  },
};

/**
 * 显示态文案表（req #5：统一状态文案、进度、下一步操作）
 */
export const PIPELINE_DISPLAY_PRESETS: Record<PipelineDisplayState, PipelineDisplayPreset> = {
  queued: {
    label: '排队中',
    hint: '流程已创建，等待 orchestrator 调度。',
    progress: 0,
    nextActions: ['cancel'],
    isTerminal: false,
  },
  running: {
    label: '执行中',
    hint: '正在执行步骤，请勿关闭页面。',
    progress: 0,
    nextActions: ['pause', 'cancel'],
    isTerminal: false,
  },
  paused: {
    label: '已暂停',
    hint: '用户主动暂停，可随时恢复继续执行。',
    progress: 0,
    nextActions: ['resume', 'cancel'],
    isTerminal: false,
  },
  blocked: {
    label: '已阻塞',
    hint: '依赖未满足或端点缺失，请查看错误信息并修复后重试。',
    progress: 0,
    nextActions: ['view_error', 'cancel'],
    isTerminal: false,
  },
  manual_review_required: {
    label: '需人工复核',
    hint: '自动审核多次失败，建议人工检查后手动重试失败步骤。',
    progress: 0,
    nextActions: ['retry_step', 'cancel'],
    isTerminal: false,
  },
  completed: {
    label: '已完成',
    hint: '全部步骤成功完成，可进入下一阶段。',
    progress: 1,
    nextActions: ['advance'],
    isTerminal: true,
  },
  failed: {
    label: '失败',
    hint: '流程已终止，请查看失败步骤错误信息并执行重试。',
    progress: 0,
    nextActions: ['retry_step', 'cancel'],
    isTerminal: true,
  },
  cancelled: {
    label: '已取消',
    hint: '用户已取消该流程，可重新启动。',
    progress: 0,
    nextActions: ['restart'],
    isTerminal: true,
  },
};

/**
 * 计算当前进度（0-1）
 *
 * - 终态 completed → 1
 * - 终态 failed/cancelled → 冻结在 completedSteps/totalSteps
 * - 非终态 → completedSteps/totalSteps（可能为 0）
 *
 * @param run 当前 PipelineRun
 * @param state 派生显示态
 * @returns 0-1 之间的进度值
 */
function computeProgress(run: PipelineRun | null, state: PipelineDisplayState): number {
  if (state === 'completed') {
    return 1;
  }
  if (!run) {
    return 0;
  }
  const total = run.totalSteps || 0;
  if (total <= 0) {
    return 0;
  }
  const completed = run.completedSteps || 0;
  return Math.min(1, Math.max(0, completed / total));
}

/**
 * 从 (run.status, steps, errorCode) 三元组派生显示态
 *
 * 派生规则（治理文档 6.1 三层状态口径）：
 * - run.status='queued' → 'queued'
 * - run.status='running'：
 *   - 任一 step.status='blocked' → 'blocked'
 *   - 否则 → 'running'
 * - run.status='paused' → 'paused'
 * - run.status='completed' → 'completed'
 * - run.status='failed'：
 *   - errorCode='MANUAL_REVIEW_REQUIRED' → 'manual_review_required'
 *   - 否则 → 'failed'
 * - run.status='cancelled' → 'cancelled'
 *
 * @param run 当前 PipelineRun（可为 null，返回 'queued' 兜底）
 * @param steps 当前 run 的所有步骤（可为空数组）
 * @returns 派生显示态
 */
export function deriveDisplayState(
  run: PipelineRun | null,
  steps: PipelineRunStep[] = [],
): PipelineDisplayState {
  if (!run) {
    return 'queued';
  }

  const status = run.status as PipelineRunStatus;

  if (status === 'queued') {
    return 'queued';
  }
  if (status === 'paused') {
    return 'paused';
  }
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'cancelled') {
    return 'cancelled';
  }
  if (status === 'failed') {
    return run.errorCode === 'MANUAL_REVIEW_REQUIRED'
      ? 'manual_review_required'
      : 'failed';
  }

  // running：检查是否有 blocked step
  const hasBlockedStep = steps.some((step) => step.status === 'blocked');
  return hasBlockedStep ? 'blocked' : 'running';
}

/**
 * 获取显示态对应的文案预设（含进度计算）
 *
 * @param run 当前 PipelineRun
 * @param steps 当前 run 的所有步骤
 * @returns 文案预设（含 label/hint/progress/nextActions/isTerminal）
 */
export function getDisplayPreset(
  run: PipelineRun | null,
  steps: PipelineRunStep[] = [],
): PipelineDisplayPreset & { state: PipelineDisplayState } {
  const state = deriveDisplayState(run, steps);
  const preset = PIPELINE_DISPLAY_PRESETS[state];
  return {
    state,
    ...preset,
    progress: computeProgress(run ?? null, state),
  };
}

/**
 * 获取错误码对应的文案预设
 *
 * @param errorCode 后端返回的 errorCode（可为 null）
 * @returns 文案预设，未命中返回 null
 */
export function getErrorCodePreset(
  errorCode: string | null | undefined,
): PipelineErrorCodePreset | null {
  if (!errorCode) {
    return null;
  }
  return PIPELINE_ERROR_CODE_PRESETS[errorCode] ?? null;
}

/**
 * 判断 run 是否为终态（req #4：终态保护，不订阅 SSE）
 *
 * @param run PipelineRunSummary
 * @returns true 表示终态（completed/failed/cancelled）
 */
export function isTerminalRun(run: PipelineRunSummary | null): boolean {
  if (!run) {
    return false;
  }
  return ['completed', 'failed', 'cancelled'].includes(run.run.status);
}

/**
 * 从步骤列表中找出当前应聚焦的步骤（用于 UI 高亮）
 *
 * 优先级：running > retrying > queued > blocked
 *
 * @param steps 步骤列表
 * @returns 当前聚焦步骤，无则 null
 */
export function pickCurrentStep(steps: PipelineRunStep[]): PipelineRunStep | null {
  const priority: PipelineStepStatus[] = ['running', 'retrying', 'queued', 'blocked'];
  for (const status of priority) {
    const step = steps.find((s) => s.status === status);
    if (step) {
      return step;
    }
  }
  return null;
}
