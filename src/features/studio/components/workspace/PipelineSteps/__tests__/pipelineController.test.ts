/**
 * Pipeline 控制器离线测试（req #9）
 *
 * 覆盖 8 类场景的纯逻辑部分：
 * 1. 创建任务 —— buildIdempotencyKey 生成确定性 key
 * 2. 依赖阻塞 —— deriveDisplayState 派生 blocked + 错误码可操作提示
 * 3. 重复提交 —— 相同 payload 相同 key（幂等基础）
 * 4. 终态保护 —— isTerminalRun + deriveDisplayState 终态判断
 * 5. 暂停恢复取消 —— 显示态 nextActions 包含 resume/cancel
 * 6. 失败重试 —— 显示态 nextActions 包含 retry_step
 * 7. 权限隔离 —— 错误码 preset 可操作提示
 * 8. SSE/API 乱序竞态 —— pickCurrentStep 优先级选取
 *
 * 说明：launch/pause/resume/cancel/retryStep 的 API 调用透传行为由后端
 * handlers.rs 集成测试（B4）覆盖；前端纯逻辑（幂等键/显示态/错误码/currentStep）
 * 在此覆盖。vitest environment='node'，不渲染 React 组件。
 */

import { describe, expect, it } from 'vitest';

import type {
  PipelineRun,
  PipelineRunStep,
  PipelineRunSummary,
  PipelineStepOutput,
} from '../../../../../../lib/serverApi';
import {
  buildIdempotencyKey,
  extractOutputAssetIds,
  type PipelineStepInput,
} from '../usePipelineRunController';
import {
  PIPELINE_DISPLAY_PRESETS,
  deriveDisplayState,
  getDisplayPreset,
  getErrorCodePreset,
  isTerminalRun,
  pickCurrentStep,
} from '../pipelineStatusPresets';

/**
 * 构造测试用 PipelineRun
 *
 * @param overrides 覆盖默认值的字段
 * @returns 完整的 PipelineRun mock
 */
function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-1',
    userId: 'user-1',
    projectId: 'project-1',
    conversationId: 'chat-1',
    pipelineType: 'script',
    triggerSource: 'manual',
    status: 'queued',
    idempotencyKey: 'key-1',
    totalSteps: 2,
    completedSteps: 0,
    failedSteps: 0,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    errorCode: null,
    ...overrides,
  };
}

/**
 * 构造测试用 PipelineRunStep
 *
 * @param overrides 覆盖默认值的字段
 * @returns 完整的 PipelineRunStep mock
 */
function makeStep(overrides: Partial<PipelineRunStep> = {}): PipelineRunStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    stepKey: 'script_design',
    stepName: '剧本设计',
    stepOrder: 1,
    aiTaskId: null,
    status: 'queued',
    attemptCount: 0,
    maxRetries: 2,
    durationMs: 0,
    inputSummary: null,
    outputRef: null,
    errorMessage: null,
    lastErrorAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * 构造测试用 PipelineRunSummary
 *
 * @param run PipelineRun
 * @param steps 步骤列表
 * @returns PipelineRunSummary mock
 */
function makeSummary(run: PipelineRun, steps: PipelineRunStep[] = []): PipelineRunSummary {
  return {
    run,
    steps,
    recentEvents: [],
    outputs: [],
    reviews: [],
  };
}

/**
 * 构造测试用 PipelineStepInput
 *
 * @param overrides 覆盖默认值的字段
 * @returns PipelineStepInput mock
 */
function makeStepInput(overrides: Partial<PipelineStepInput> = {}): PipelineStepInput {
  return {
    stepKey: 'script_design',
    stepName: '剧本设计',
    stepOrder: 1,
    stepType: 'design',
    maxRetries: 2,
    reviewPolicy: { requires: ['project:outline'] },
    promptTemplate: '请生成剧本',
    dependsOn: [],
    ...overrides,
  };
}

describe('Pipeline 控制器离线测试', () => {
  describe('场景 1：创建任务 —— buildIdempotencyKey 生成确定性 key', () => {
    it('key 包含 projectId/conversationId/pipelineType/triggerSource 前缀', () => {
      const steps = [makeStepInput()];
      const key = buildIdempotencyKey(
        'project-1',
        'chat-1',
        'script',
        'manual',
        steps,
      );
      // 格式：{projectId}:{conversationId}:{pipelineType}:{triggerSource}:{payloadHash}
      expect(key.startsWith('project-1:chat-1:script:manual:')).toBe(true);
    });

    it('不同 projectId 生成不同 key', () => {
      const steps = [makeStepInput()];
      const key1 = buildIdempotencyKey('project-1', 'chat-1', 'script', 'manual', steps);
      const key2 = buildIdempotencyKey('project-2', 'chat-1', 'script', 'manual', steps);
      expect(key1).not.toBe(key2);
    });

    it('不同 pipelineType 生成不同 key', () => {
      const steps = [makeStepInput()];
      const key1 = buildIdempotencyKey('project-1', 'chat-1', 'script', 'manual', steps);
      const key2 = buildIdempotencyKey('project-1', 'chat-1', 'custom', 'manual', steps);
      expect(key1).not.toBe(key2);
    });
  });

  describe('场景 2：依赖阻塞 —— deriveDisplayState 派生 blocked', () => {
    it('run.running + step.blocked → displayState=blocked', () => {
      const run = makeRun({ status: 'running', errorCode: 'DEPENDENCY_UNSATISFIED' });
      const steps = [makeStep({ status: 'blocked', errorMessage: '前置资产未满足' })];
      expect(deriveDisplayState(run, steps)).toBe('blocked');
    });

    it('errorCode=DEPENDENCY_UNSATISFIED → preset.hint 包含"依赖"', () => {
      const preset = getErrorCodePreset('DEPENDENCY_UNSATISFIED');
      expect(preset).not.toBeNull();
      expect(preset!.hint).toContain('依赖');
    });

    it('blocked 态 nextActions 包含 view_error 和 cancel', () => {
      const run = makeRun({ status: 'running' });
      const steps = [makeStep({ status: 'blocked' })];
      const preset = getDisplayPreset(run, steps);
      expect(preset.nextActions).toContain('view_error');
      expect(preset.nextActions).toContain('cancel');
    });
  });

  describe('场景 3：重复提交 —— 幂等键确定性', () => {
    it('相同 payload 两次调用返回相同 key', () => {
      const steps = [makeStepInput()];
      const key1 = buildIdempotencyKey('project-1', 'chat-1', 'script', 'manual', steps);
      const key2 = buildIdempotencyKey('project-1', 'chat-1', 'script', 'manual', steps);
      expect(key1).toBe(key2);
    });

    it('不同 stepKey 生成不同 key', () => {
      const steps1 = [makeStepInput({ stepKey: 'script_design' })];
      const steps2 = [makeStepInput({ stepKey: 'script_review' })];
      const key1 = buildIdempotencyKey('project-1', 'chat-1', 'script', 'manual', steps1);
      const key2 = buildIdempotencyKey('project-1', 'chat-1', 'script', 'manual', steps2);
      expect(key1).not.toBe(key2);
    });

    it('不同 reviewPolicy 生成不同 key', () => {
      const steps1 = [makeStepInput({ reviewPolicy: { requires: ['project:outline'] } })];
      const steps2 = [makeStepInput({ reviewPolicy: { requires: ['project:script'] } })];
      const key1 = buildIdempotencyKey('project-1', 'chat-1', 'script', 'manual', steps1);
      const key2 = buildIdempotencyKey('project-1', 'chat-1', 'script', 'manual', steps2);
      expect(key1).not.toBe(key2);
    });

    it('不同 idempotencyScope 生成不同 key', () => {
      const steps = [makeStepInput()];
      const key1 = buildIdempotencyKey(
        'project-1',
        'chat-1',
        'custom',
        'keyframe',
        steps,
        'batch:start',
      );
      const key2 = buildIdempotencyKey(
        'project-1',
        'chat-1',
        'custom',
        'keyframe',
        steps,
        'batch:end',
      );
      expect(key1).not.toBe(key2);
    });
  });

  describe('场景 4：终态保护 —— isTerminalRun + deriveDisplayState', () => {
    it('completed → isTerminalRun=true + displayState=completed + preset.isTerminal=true', () => {
      const run = makeRun({ status: 'completed', completedSteps: 2 });
      const summary = makeSummary(run, [makeStep({ status: 'completed' })]);
      expect(isTerminalRun(summary)).toBe(true);
      expect(deriveDisplayState(run, summary.steps)).toBe('completed');
      expect(getDisplayPreset(run, summary.steps).isTerminal).toBe(true);
    });

    it('failed → isTerminalRun=true + displayState=failed + preset.isTerminal=true', () => {
      const run = makeRun({ status: 'failed', errorCode: 'EXECUTION_FAILED' });
      const summary = makeSummary(run, [makeStep({ status: 'failed' })]);
      expect(isTerminalRun(summary)).toBe(true);
      expect(deriveDisplayState(run, summary.steps)).toBe('failed');
      expect(getDisplayPreset(run, summary.steps).isTerminal).toBe(true);
    });

    it('cancelled → isTerminalRun=true + displayState=cancelled', () => {
      const run = makeRun({ status: 'cancelled' });
      const summary = makeSummary(run, []);
      expect(isTerminalRun(summary)).toBe(true);
      expect(deriveDisplayState(run, [])).toBe('cancelled');
    });

    it('running → isTerminalRun=false（非终态，应订阅 SSE）', () => {
      const run = makeRun({ status: 'running' });
      const summary = makeSummary(run, [makeStep({ status: 'running' })]);
      expect(isTerminalRun(summary)).toBe(false);
    });

    it('null run → isTerminalRun=false（不订阅）', () => {
      expect(isTerminalRun(null)).toBe(false);
    });
  });

  describe('场景 5：暂停恢复取消 —— paused 显示态 nextActions', () => {
    it('paused → displayState=paused + nextActions 包含 resume 和 cancel', () => {
      const run = makeRun({ status: 'paused' });
      const preset = getDisplayPreset(run, []);
      expect(deriveDisplayState(run, [])).toBe('paused');
      expect(preset.nextActions).toContain('resume');
      expect(preset.nextActions).toContain('cancel');
    });

    it('running → nextActions 包含 pause 和 cancel', () => {
      const run = makeRun({ status: 'running' });
      const steps = [makeStep({ status: 'running' })];
      const preset = getDisplayPreset(run, steps);
      expect(preset.nextActions).toContain('pause');
      expect(preset.nextActions).toContain('cancel');
    });

    it('cancelled → nextActions 包含 restart', () => {
      const run = makeRun({ status: 'cancelled' });
      const preset = getDisplayPreset(run, []);
      expect(preset.nextActions).toContain('restart');
    });
  });

  describe('场景 6：失败重试 —— failed/manual_review_required 显示态', () => {
    it('failed + 无 errorCode → displayState=failed + nextActions 包含 retry_step', () => {
      const run = makeRun({ status: 'failed', errorCode: null });
      const steps = [makeStep({ status: 'failed' })];
      const preset = getDisplayPreset(run, steps);
      expect(deriveDisplayState(run, steps)).toBe('failed');
      expect(preset.nextActions).toContain('retry_step');
    });

    it('failed + errorCode=MANUAL_REVIEW_REQUIRED → displayState=manual_review_required', () => {
      const run = makeRun({ status: 'failed', errorCode: 'MANUAL_REVIEW_REQUIRED' });
      const steps = [makeStep({ status: 'failed' })];
      expect(deriveDisplayState(run, steps)).toBe('manual_review_required');
      const preset = getDisplayPreset(run, steps);
      expect(preset.nextActions).toContain('retry_step');
    });

    it('errorCode=MANUAL_REVIEW_REQUIRED → preset.action=retry_step', () => {
      const preset = getErrorCodePreset('MANUAL_REVIEW_REQUIRED');
      expect(preset).not.toBeNull();
      expect(preset!.action).toBe('retry_step');
    });

    it('errorCode=EXECUTION_FAILED → preset.action=retry_step', () => {
      const preset = getErrorCodePreset('EXECUTION_FAILED');
      expect(preset).not.toBeNull();
      expect(preset!.action).toBe('retry_step');
    });
  });

  describe('场景 7：权限隔离 —— 错误码 preset 可操作提示', () => {
    it('所有 6 个错误码 preset 都有非空 label 和 hint', () => {
      const errorCodes = [
        'MISSING_ENDPOINT',
        'DEPENDENCY_UNSATISFIED',
        'RETRY_SCHEDULED',
        'WAITING_PREREQUISITE',
        'MANUAL_REVIEW_REQUIRED',
        'EXECUTION_FAILED',
      ];
      for (const code of errorCodes) {
        const preset = getErrorCodePreset(code);
        expect(preset).not.toBeNull();
        expect(preset!.label.length).toBeGreaterThan(0);
        expect(preset!.hint.length).toBeGreaterThan(0);
      }
    });

    it('MISSING_ENDPOINT → hint 包含"端点"（req #3 可操作提示）', () => {
      const preset = getErrorCodePreset('MISSING_ENDPOINT');
      expect(preset!.hint).toContain('端点');
    });

    it('null errorCode → 返回 null（无错误码时不展示错误提示）', () => {
      expect(getErrorCodePreset(null)).toBeNull();
    });

    it('未知 errorCode → 返回 null（不展示误导性提示）', () => {
      expect(getErrorCodePreset('UNKNOWN_CODE_XYZ')).toBeNull();
    });
  });

  describe('场景 8：SSE/API 乱序竞态 —— pickCurrentStep 优先级', () => {
    it('优先级 running > retrying > queued > blocked', () => {
      const blockedStep = makeStep({ id: 's-blocked', status: 'blocked' });
      const queuedStep = makeStep({ id: 's-queued', status: 'queued' });
      const retryingStep = makeStep({ id: 's-retrying', status: 'retrying' });
      const runningStep = makeStep({ id: 's-running', status: 'running' });
      // 乱序输入
      const steps = [blockedStep, queuedStep, retryingStep, runningStep];
      expect(pickCurrentStep(steps)?.id).toBe('s-running');
    });

    it('无 running 时选取 retrying', () => {
      const steps = [
        makeStep({ id: 's-blocked', status: 'blocked' }),
        makeStep({ id: 's-retrying', status: 'retrying' }),
      ];
      expect(pickCurrentStep(steps)?.id).toBe('s-retrying');
    });

    it('无 running/retrying 时选取 queued', () => {
      const steps = [
        makeStep({ id: 's-blocked', status: 'blocked' }),
        makeStep({ id: 's-queued', status: 'queued' }),
      ];
      expect(pickCurrentStep(steps)?.id).toBe('s-queued');
    });

    it('只有 blocked 时选取 blocked', () => {
      const steps = [makeStep({ id: 's-blocked', status: 'blocked' })];
      expect(pickCurrentStep(steps)?.id).toBe('s-blocked');
    });

    it('空 steps 或全部终态 → 返回 null', () => {
      expect(pickCurrentStep([])).toBeNull();
      expect(
        pickCurrentStep([
          makeStep({ id: 's-completed', status: 'completed' }),
          makeStep({ id: 's-failed', status: 'failed' }),
        ]),
      ).toBeNull();
    });
  });

  describe('附加：extractOutputAssetIds 资产刷新去重（req #7）', () => {
    /**
     * 构造测试用 PipelineStepOutput
     *
     * @param outputJson outputJson 字段内容
     * @returns PipelineStepOutput mock
     */
    function makeOutput(outputJson: string | null): PipelineStepOutput {
      return {
        id: 'out-1',
        runId: 'run-1',
        stepId: 'step-1',
        taskId: null,
        outputType: 'asset',
        outputJson,
        rawContent: null,
        reviewDecision: null,
        reviewScore: null,
        reviewIssuesJson: null,
        retryHintsJson: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
    }

    it('从 outputJson.assetId 提取 assetId', () => {
      const outputs = [makeOutput(JSON.stringify({ assetId: 'asset-001' }))];
      expect(extractOutputAssetIds(outputs)).toEqual(['asset-001']);
    });

    it('从嵌套 outputJson.asset.id 提取 assetId', () => {
      const outputs = [makeOutput(JSON.stringify({ asset: { id: 'asset-002' } }))];
      expect(extractOutputAssetIds(outputs)).toEqual(['asset-002']);
    });

    it('outputJson 为 null → 返回空数组', () => {
      const outputs = [makeOutput(null)];
      expect(extractOutputAssetIds(outputs)).toEqual([]);
    });

    it('outputJson 为非法 JSON → 静默跳过，返回空数组', () => {
      const outputs = [makeOutput('{invalid json')];
      expect(extractOutputAssetIds(outputs)).toEqual([]);
    });

    it('多个输出提取多个 assetId（含重复去重由调用方处理）', () => {
      const outputs = [
        makeOutput(JSON.stringify({ assetId: 'asset-1' })),
        makeOutput(JSON.stringify({ assetId: 'asset-2' })),
        makeOutput(JSON.stringify({ asset: { id: 'asset-3' } })),
      ];
      expect(extractOutputAssetIds(outputs)).toEqual(['asset-1', 'asset-2', 'asset-3']);
    });
  });

  describe('附加：PIPELINE_DISPLAY_PRESETS 8 态完整性', () => {
    it('8 个显示态都有 preset', () => {
      const states = [
        'queued',
        'running',
        'paused',
        'blocked',
        'manual_review_required',
        'completed',
        'failed',
        'cancelled',
      ] as const;
      for (const state of states) {
        expect(PIPELINE_DISPLAY_PRESETS[state]).toBeDefined();
        expect(PIPELINE_DISPLAY_PRESETS[state].label.length).toBeGreaterThan(0);
        expect(PIPELINE_DISPLAY_PRESETS[state].hint.length).toBeGreaterThan(0);
        expect(Array.isArray(PIPELINE_DISPLAY_PRESETS[state].nextActions)).toBe(true);
      }
    });

    it('completed preset.progress=1', () => {
      expect(PIPELINE_DISPLAY_PRESETS.completed.progress).toBe(1);
    });

    it('终态 isTerminal=true（completed/failed/cancelled）', () => {
      expect(PIPELINE_DISPLAY_PRESETS.completed.isTerminal).toBe(true);
      expect(PIPELINE_DISPLAY_PRESETS.failed.isTerminal).toBe(true);
      expect(PIPELINE_DISPLAY_PRESETS.cancelled.isTerminal).toBe(true);
    });

    it('非终态 isTerminal=false（queued/running/paused/blocked/manual_review_required）', () => {
      expect(PIPELINE_DISPLAY_PRESETS.queued.isTerminal).toBe(false);
      expect(PIPELINE_DISPLAY_PRESETS.running.isTerminal).toBe(false);
      expect(PIPELINE_DISPLAY_PRESETS.paused.isTerminal).toBe(false);
      expect(PIPELINE_DISPLAY_PRESETS.blocked.isTerminal).toBe(false);
      expect(PIPELINE_DISPLAY_PRESETS.manual_review_required.isTerminal).toBe(false);
    });
  });
});
