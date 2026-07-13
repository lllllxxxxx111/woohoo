import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const base = (process.env.CROWDTEST_BASE || 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com').replace(/\/$/, '');
const cookie = process.env.CROWDTEST_COOKIE || 'username=KzZd1nlyoi';
const userId = Number(process.env.CROWDTEST_USER_ID || 6);
const harness = process.env.CROWDTEST_HARNESS || 'hermes';
const taskIds = (process.env.CROWDTEST32_TASKS || process.argv[2] || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const root = process.cwd();
const sourceDocPath = path.join(root, 'docs', 'agent-long-eval-32-prep.md');
const minToolCalls = Number(process.env.CROWDTEST_MIN_TOOL_CALLS || 301);
const maxRound = Number(process.env.CROWDTEST_MAX_ROUND || 12);
const sleepMs = Number(process.env.CROWDTEST_POLL_MS || 60000);
const iterations = Number(process.env.CROWDTEST_ITERATIONS || 1);
const stalledPollsBeforeStart = Number(process.env.CROWDTEST_STALLED_POLLS_BEFORE_START || 4);
const startCooldownPolls = Number(process.env.CROWDTEST_START_COOLDOWN_POLLS || 4);

if (taskIds.length === 0) {
  throw new Error('Set CROWDTEST32_TASKS or pass comma-separated task IDs');
}

const terminalStatuses = new Set(['completed', 'stopped', 'error', 'evaluated']);
const busyStatuses = new Set(['pending', 'running', 'queued']);
const seenRuns = new Map();

function newTaskId() {
  return randomBytes(4).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
}

function sectionFor(doc, label) {
  const start = doc.indexOf(`## 任务 ${label}`);
  if (start < 0) throw new Error(`Cannot find task ${label}`);
  const end = doc.indexOf('## 通用反馈模板', start + 1);
  return doc.slice(start, end > start ? end : undefined);
}

function promptForRound(doc, label, round) {
  const section = sectionFor(doc, label);
  const marker = `第 ${round} 轮`;
  const start = section.indexOf(marker);
  if (start >= 0) {
    const rest = section.slice(start);
    const match = rest.match(/```text\r?\n([\s\S]*?)\r?\n```/);
    if (match) return match[1].trim();
  }
  const extras = {
    11: '继续做最终缺口审计：逐项检查 manifest、workspace_snapshot、validation_report、预检 UI、导出历史 API、敏感信息剔除、测试覆盖和构建结果。只修明显缺口，不扩大范围，并给出具体文件级说明。',
    12: '请做一次端到端交付验收：用最小示例数据说明导出前预检、导出包生成、manifest hash、缺失资产记录、后端审计写入和历史查询的完整链路。发现未实现或失败项请直接补齐并重新运行验证。',
  };
  return extras[round] || extras[12];
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
    roundCount: run.roundCount || rounds.length,
    latestRound: Number(latest.roundNo || run.roundNo || rounds.length || 1),
    totalToolCalls: rounds.reduce((total, round) => total + sumToolCounts(round.stats?.toolCounts), 0),
    latestToolCalls: sumToolCounts(latest.stats?.toolCounts),
  };
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      cookie,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return data;
}

async function getDetails(taskId) {
  return requestJson(`/api/task_details/${encodeURIComponent(taskId)}?_ts=${Date.now()}`);
}

async function appendRound(taskId, modelId, prompt) {
  const id = newTaskId();
  const payload = {
    baseDir: `INCREMENTAL_FROM_${taskId}_${modelId}`,
    title: 'Initializing...',
    prompt,
    taskBackground: '',
    taskOrigin: '',
    taskId: id,
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

async function startRun(taskId, modelId) {
  return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ modelId }),
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(runKey, summary, patch = {}) {
  const previous = seenRuns.get(runKey);
  const sameLatestRound = previous?.latestTaskId === summary.latestTaskId;
  const stagnant =
    sameLatestRound && previous.totalToolCalls === summary.totalToolCalls
      ? previous.stagnant + 1
      : 0;
  const next = {
    latestTaskId: summary.latestTaskId,
    totalToolCalls: summary.totalToolCalls,
    stagnant,
    lastStartedAt: previous?.lastStartedAt ?? -Infinity,
    ...patch,
  };
  seenRuns.set(runKey, next);
  return next;
}

const doc = await readFile(sourceDocPath, 'utf8');

for (let i = 1; i <= iterations; i += 1) {
  console.log(`\n=== iteration ${i}/${iterations} ${new Date().toISOString()} ===`);
  let allDone = true;
  for (const taskId of taskIds) {
    let details;
    try {
      details = await getDetails(taskId);
    } catch (error) {
      console.log(`${taskId}: detail failed: ${error.message}`);
      allDone = false;
      continue;
    }
    const summaries = (details.runs || []).map(summarizeRun);
    console.log(`${taskId}: ${details.title}`);
    for (const summary of summaries) {
      console.log(`  ${summary.model}/${summary.modelId}: status=${summary.status} round=${summary.latestRound} totalTools=${summary.totalToolCalls} latestTools=${summary.latestToolCalls}`);
    }
    for (const summary of summaries) {
      const runKey = `${taskId}:${summary.modelId}`;
      const state = record(runKey, summary);
      if (summary.totalToolCalls >= minToolCalls) continue;
      allDone = false;

      if (summary.status === 'stopped') {
        try {
          const result = await startRun(summary.latestTaskId, summary.modelId);
          record(runKey, summary, { stagnant: 0, lastStartedAt: i });
          console.log(`  restarted ${summary.model}/${summary.modelId} task=${summary.latestTaskId}: ${JSON.stringify(result)}`);
        } catch (error) {
          console.log(`  restart failed ${summary.model}/${summary.modelId} task=${summary.latestTaskId}: ${error.message}`);
        }
        continue;
      }

      if (busyStatuses.has(summary.status) || !terminalStatuses.has(summary.status)) {
        if (
          state.stagnant >= stalledPollsBeforeStart &&
          i - state.lastStartedAt >= startCooldownPolls
        ) {
          try {
            const result = await startRun(summary.latestTaskId, summary.modelId);
            record(runKey, summary, { stagnant: 0, lastStartedAt: i });
            console.log(`  nudged stalled ${summary.model}/${summary.modelId} task=${summary.latestTaskId} stagnantPolls=${state.stagnant}: ${JSON.stringify(result)}`);
          } catch (error) {
            record(runKey, summary, { lastStartedAt: i });
            console.log(`  nudge failed ${summary.model}/${summary.modelId} task=${summary.latestTaskId} stagnantPolls=${state.stagnant}: ${error.message}`);
          }
        }
        continue;
      }

      if (summary.latestRound >= maxRound) {
        console.log(`  skip ${summary.model}: reached max round ${maxRound} with totalTools=${summary.totalToolCalls}`);
        continue;
      }

      const nextRound = summary.latestRound + 1;
      const prompt = promptForRound(doc, 'B', nextRound);
      try {
        const result = await appendRound(taskId, summary.modelId, prompt);
        record(runKey, summary, { stagnant: 0 });
        console.log(`  appended round ${nextRound} to ${summary.model}/${summary.modelId}: ${JSON.stringify(result)}`);
      } catch (error) {
        console.log(`  append failed ${summary.model}/${summary.modelId}: ${error.message}`);
      }
    }
  }
  if (allDone) {
    console.log(`all selected tasks reached ${minToolCalls}+ tool calls`);
    break;
  }
  if (i < iterations) await wait(sleepMs);
}
