import { randomBytes } from 'node:crypto';

const base = (process.env.CROWDTEST_BASE || 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com').replace(/\/$/, '');
const cookie = process.env.CROWDTEST_COOKIE || 'username=KzZd1nlyoi';
const userId = Number(process.env.CROWDTEST_USER_ID || '6');
const harness = process.env.CROWDTEST_HARNESS || 'hermes';
const taskIds = (process.env.CROWDTEST34_TASKS || process.argv[2] || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const minToolCalls = Number(process.env.CROWDTEST_MIN_TOOL_CALLS || '301');
const maxRound = Number(process.env.CROWDTEST_MAX_ROUND || '12');
const pollMs = Number(process.env.CROWDTEST_POLL_MS || '60000');
const iterations = Number(process.env.CROWDTEST_ITERATIONS || '1');
const stalledPollsBeforeStart = Number(process.env.CROWDTEST_STALLED_POLLS_BEFORE_START || '4');
const startCooldownPolls = Number(process.env.CROWDTEST_START_COOLDOWN_POLLS || '4');

if (taskIds.length === 0) {
  throw new Error('Set CROWDTEST34_TASKS or pass comma-separated task IDs');
}

const taskKind = {
  K7SH2XS: 'routing',
  UIVTKK0: 'sse',
};
const terminalStatuses = new Set(['completed', 'stopped', 'error', 'failed', 'evaluated']);
const busyStatuses = new Set(['pending', 'running', 'queued']);
const seenRuns = new Map();

function newTaskId() {
  return randomBytes(4).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
}

function sumToolCounts(toolCounts = {}) {
  return Object.values(toolCounts).reduce((total, value) => total + (Number(value) || 0), 0);
}

function summarizeRun(run) {
  const rounds = Array.isArray(run.rounds) && run.rounds.length ? run.rounds : [run];
  const latest = rounds.find((round) => round.isLatestRound) || rounds[rounds.length - 1] || run;
  return {
    model: run.displayName || run.modelName || run.modelId,
    modelId: run.modelId,
    latestTaskId: latest.taskId || run.taskId,
    status: latest.status || run.status,
    latestRound: Number(latest.roundNo || run.roundNo || rounds.length || 1),
    totalToolCalls: rounds.reduce((total, round) => total + sumToolCounts(round.stats?.toolCounts), 0),
    latestToolCalls: sumToolCounts(latest.stats?.toolCounts),
  };
}

function roundPrompt(kind, round) {
  const routingPrompts = [
    '继续完成当前“多 AI Endpoint 智能路由、故障降级与审计闭环”任务。先审查你上一轮已改动的真实调用点和迁移，再补齐尚未接入统一路由 helper 的 chat、stream chat、异步 task、pipeline、图片或视频入口。重点验证显式 endpoint 约束、能力匹配、优先级、上下文/stream/tool 要求和健康状态不会互相覆盖。不要扩大到无关重构；直接实现、测试并报告具体文件和命令结果。',
    '请继续修复当前任务的可靠性缺口：为 timeout、网络错误、408、429、5xx、能力不匹配分别实现受控 fallback；为 401/403、参数校验和内容安全拒绝实现明确的不 fallback 分支。检查最大尝试次数、候选去重与环路保护，并给路由审计事件补足最终 endpoint/model、错误分类、耗时、request/task/run 关联。新增或完善测试后运行验证命令。',
    '请对当前多 endpoint 路由交付做一次代码级验收并继续开发：检查 migration 对新库/旧库兼容、审计查询 API 的分页过滤和用户隔离、ai_usage_events 的实际 endpoint/model 统计、Settings/Ops 中 capability 与健康/fallback 展示、以及用户可见 fallback 提示。找出未完成或不可运行项后直接修复，补回归测试并运行 typecheck/test/build/cargo check。',
    '请以故障注入和边界数据复盘当前路由实现：模拟没有候选、显式 endpoint 不兼容、所有候选失败、重复候选、模型不匹配、超长上下文、stream/tool 限制和审计写入失败。确保系统返回可理解错误且不泄露密钥，不会无限重试；修复发现的问题，并把测试覆盖和验证结果落到代码中。',
    '请做最终交付审查：逐项核对当前任务原始需求是否真的由真实入口调用，而非仅有 helper/UI；检查测试是否可离线运行、迁移是否版本化、API 是否有认证与权限过滤、前端是否不会因审计接口失败阻断主流程。修复明确缺口并重新执行完整验证。',
  ];
  const ssePrompts = [
    '继续完成当前“AI Task 与 Pipeline SSE 断连恢复、乱序事件幂等与可见错误闭环”任务。先审查上一轮事件协议与真实前后端调用点，再补齐 AI task 和 pipeline 的稳定 event id/cursor、Last-Event-ID 或 query cursor 重放与 resync 信号。不要只靠轮询；直接实现并补测试。',
    '请继续修复 SSE 消费可靠性：处理任意 chunk 切分、多行 event/data/id/retry 帧、[DONE]/done、401 刷新后重连、指数退避上限和无 pending 时停止重连。重点确保重放/重复/乱序 queued-running 事件不会覆盖 completed/failed/cancelled/blocked 终态，不会重复写消息或重复 toast/refresh。补测试并运行验证。',
    '请针对断连恢复做端到端代码审查：断连期间服务端完成任务、游标过期、事件过多、任务范围不匹配、resync 失败、重复 terminal 事件和 API 返回与 SSE 推送竞态都应有确定行为。检查聊天 placeholder、pipeline preview 和任务 metadata 是否使用一致状态语义；修复缺口并增加 mock stream 回归测试。',
    '请继续完善当前 SSE 交付的后端兼容与持久化：新库初始化和旧库升级必须兼容；进程重启后若内存 buffer 丢失，应明确回退到数据库 resync 而不是静默丢事件。确保 completed/cancelled/blocked/failed/scope_mismatch/missing 的错误码、可见提示和日志关联 request_id/run_id/taskId 清晰且不泄露敏感信息。补测试和验证。',
    '请做最终交付审查：逐项核对原始 SSE 任务要求、真实路由是否使用新协议、重连是否避免忙循环、状态是否单调、workspace refresh 是否去重、测试是否覆盖分片/重放/乱序/401/游标过期。修复明确问题并执行 npm run typecheck、npm run test、npm run build、cargo check --manifest-path server/Cargo.toml。',
  ];
  const prompts = kind === 'routing' ? routingPrompts : ssePrompts;
  return prompts[(round - 2) % prompts.length];
}

async function requestJson(endpoint, options = {}, attempt = 1) {
  let response;
  try {
    response = await fetch(`${base}${endpoint}`, {
      ...options,
      headers: { cookie, ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
  } catch (error) {
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      return requestJson(endpoint, options, attempt + 1);
    }
    throw error;
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    if (attempt < 4 && [500, 502, 503, 504].includes(response.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      return requestJson(endpoint, options, attempt + 1);
    }
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return data;
}

async function getDetails(taskId) {
  return requestJson(`/api/task_details/${encodeURIComponent(taskId)}?_ts=${Date.now()}`);
}

async function appendRound(taskId, modelId, prompt) {
  const payload = {
    baseDir: `INCREMENTAL_FROM_${taskId}_${modelId}`,
    title: 'Continue existing implementation',
    prompt,
    taskBackground: '',
    taskOrigin: '',
    taskId: newTaskId(),
    evaluationTaskId: null,
    harness,
    models: [modelId],
    srcTaskId: taskId,
    srcModelName: modelId,
    appendToTaskId: taskId,
    appendModelId: modelId,
    userId,
    enableAgentTeams: false,
  };
  return requestJson('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ task: payload }),
  });
}

async function startRun(roundTaskId, modelId) {
  return requestJson(`/api/tasks/${encodeURIComponent(roundTaskId)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ modelId }),
  });
}

function record(runKey, summary, patch = {}) {
  const previous = seenRuns.get(runKey);
  const sameRound = previous?.latestTaskId === summary.latestTaskId;
  const stagnant = sameRound && previous.totalToolCalls === summary.totalToolCalls ? previous.stagnant + 1 : 0;
  const state = {
    latestTaskId: summary.latestTaskId,
    totalToolCalls: summary.totalToolCalls,
    stagnant,
    lastStartedAt: previous?.lastStartedAt ?? -Infinity,
    ...patch,
  };
  seenRuns.set(runKey, state);
  return state;
}

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  console.log(`=== poll ${iteration}/${iterations} ${new Date().toISOString()} ===`);
  let allComplete = true;
  for (const taskId of taskIds) {
    let details;
    try {
      details = await getDetails(taskId);
    } catch (error) {
      allComplete = false;
      console.log(`${taskId}: status request failed: ${error.message}`);
      continue;
    }
    const kind = taskKind[taskId] || 'sse';
    const runs = (details.runs || []).map(summarizeRun);
    console.log(`${taskId}: ${runs.map((run) => `${run.model}=${run.status}/${run.totalToolCalls}`).join(', ')}`);

    for (const run of runs) {
      const key = `${taskId}:${run.modelId}`;
      const state = record(key, run);
      if (run.totalToolCalls >= minToolCalls) continue;
      allComplete = false;

      if (run.status === 'stopped') {
        try {
          console.log(`  restart ${run.model} ${run.latestTaskId}`);
          await startRun(run.latestTaskId, run.modelId);
          record(key, run, { stagnant: 0, lastStartedAt: iteration });
        } catch (error) {
          console.log(`  restart failed ${run.model}: ${error.message}`);
        }
        continue;
      }

      if (busyStatuses.has(run.status) || !terminalStatuses.has(run.status)) {
        if (
          run.status === 'pending' &&
          state.stagnant >= stalledPollsBeforeStart &&
          iteration - state.lastStartedAt >= startCooldownPolls
        ) {
          try {
            console.log(`  nudge stalled ${run.model} ${run.latestTaskId}`);
            await startRun(run.latestTaskId, run.modelId);
            record(key, run, { stagnant: 0, lastStartedAt: iteration });
          } catch (error) {
            console.log(`  nudge failed ${run.model}: ${error.message}`);
          }
        }
        continue;
      }

      if (run.latestRound >= maxRound) {
        console.log(`  ${run.model} reached max round ${maxRound} at ${run.totalToolCalls} calls`);
        continue;
      }

      const nextRound = run.latestRound + 1;
      try {
        await appendRound(taskId, run.modelId, roundPrompt(kind, nextRound));
        console.log(`  appended round ${nextRound} to ${run.model}`);
        record(key, run, { stagnant: 0 });
      } catch (error) {
        console.log(`  append failed ${run.model}: ${error.message}`);
      }
    }
  }
  if (allComplete) {
    console.log(`all models reached ${minToolCalls}+ calls`);
    break;
  }
  if (iteration < iterations) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
