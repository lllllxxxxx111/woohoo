import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);
const base = 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=KzZd1nlyoi';
const taskIds = ['K7SH2XS', 'UIVTKK0'];
const iterations = Number(process.env.CROWDTEST_ITERATIONS || process.argv[2] || 120);
const pollMs = Number(process.env.CROWDTEST_POLL_MS || 180_000);
const minToolCalls = Number(process.env.CROWDTEST_MIN_TOOL_CALLS || 301);
const maxRounds = Number(process.env.CROWDTEST_MAX_ROUNDS || 12);
const cooldownMs = Number(process.env.CROWDTEST_APPEND_COOLDOWN_MS || 600_000);
const statePath = new URL('./crowdtest34-monitor-node-state.json', import.meta.url);
const logPath = new URL('./crowdtest34-monitor-node.log', import.meta.url);

function totalToolCalls(rounds) {
  return rounds.reduce((total, round) => total + Object.values(round.stats?.toolCounts ?? {})
    .reduce((sum, value) => sum + (Number(value) || 0), 0), 0);
}

function summarize(runRecord) {
  const rounds = Array.isArray(runRecord.rounds) && runRecord.rounds.length ? runRecord.rounds : [runRecord];
  const latest = rounds.find((round) => round.isLatestRound) ?? rounds.at(-1);
  return {
    model: runRecord.displayName ?? runRecord.modelName ?? runRecord.modelId,
    modelId: runRecord.modelId,
    status: latest.status ?? runRecord.status,
    round: Number(latest.roundNo ?? rounds.length),
    totalToolCalls: totalToolCalls(rounds),
  };
}

async function log(message) {
  await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

async function curl(argumentsList) {
  const { stdout } = await run('curl.exe', [
    '--max-time', '60', '--silent', '--show-error', '--fail-with-body', ...argumentsList,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout;
}

async function details(taskId) {
  const raw = await curl(['-H', `Cookie: ${cookie}`, `${base}/api/task_details/${taskId}?_ts=${Date.now()}`]);
  return JSON.parse(raw);
}

function promptFor(taskId, round) {
  const routing = [
    'Audit the real chat, streaming, async task, pipeline, image, and video call sites for capability routing. Repair missing integrations and add focused regression tests.',
    'Use fault injection for bounded fallback. Verify retryable network and 5xx failures can fall back, while auth, validation, policy, and safety failures cannot. Check deduplication, loop protection, audit correlation, and safe errors.',
    'Review migration compatibility, audit API authorization and pagination, Settings/Ops visibility, and actual endpoint/model usage attribution. Repair concrete gaps and run targeted verification.',
    'Perform final delivery hardening for unavailable candidates, incompatible explicit endpoints, exhausted candidates, long context, stream/tool constraints, and audit-write failures.'
  ];
  const sse = [
    'Review AI task and pipeline cursor semantics, Last-Event-ID or query-cursor replay, and explicit resync behavior. Repair real server/client integration paths and tests.',
    'Harden fragmented multi-line SSE parsing, duplicate and out-of-order events, terminal-state monotonicity, duplicate refresh/toast suppression, and bounded reconnect behavior.',
    'Exercise disconnect completion, expired cursor, scope mismatch, 401 refresh, API-versus-SSE races, and restart after in-memory event loss. Repair observable error semantics and mock-stream tests.',
    'Perform final compatibility review of migration/backfill behavior, persistence or database resync fallback, request/run/task correlation, and terminal/missing user-visible errors.'
  ];
  const focus = (taskId === 'K7SH2XS' ? routing : sse)[(round - 2) % 4];
  const domain = taskId === 'K7SH2XS'
    ? 'Woohoo Studio multi-endpoint routing, controlled fallback, and audit delivery'
    : 'Woohoo Studio AI Task and Pipeline SSE disconnect recovery, replay, out-of-order idempotency, and visible-error delivery';
  return `Continue the same ${domain}. Review the previous round before changing code. ${focus} Implement scope-relevant findings in the real React/Rust codebase, add or update offline regression tests, run relevant validation, and report exact files and results. Do not broaden scope or expose sensitive data.`;
}

async function appendRound(parentTaskId, runRecord) {
  const task = {
    baseDir: `INCREMENTAL_FROM_${parentTaskId}_${runRecord.modelId}`,
    title: 'Continue existing implementation',
    prompt: promptFor(parentTaskId, runRecord.round + 1),
    taskBackground: '',
    taskOrigin: 'work',
    taskId: randomBytes(5).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(),
    evaluationTaskId: null,
    harness: 'hermes',
    models: [runRecord.modelId],
    srcTaskId: parentTaskId,
    srcModelName: runRecord.modelId,
    appendToTaskId: parentTaskId,
    appendModelId: runRecord.modelId,
    userId: 6,
    enableAgentTeams: false,
  };
  return curl([
    '-X', 'POST', '-H', `Cookie: ${cookie}`, '-H', 'Content-Type: application/json; charset=utf-8',
    '--data-raw', JSON.stringify({ task }), `${base}/api/tasks`,
  ]);
}

async function loadState() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return {}; }
}

const state = await loadState();
const terminal = new Set(['completed', 'stopped', 'failed', 'error', 'evaluated']);

await log(`monitor started iterations=${iterations} pollMs=${pollMs}`);
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  for (const parentTaskId of taskIds) {
    let taskDetails;
    try {
      taskDetails = await details(parentTaskId);
    } catch (error) {
      await log(`${parentTaskId} detail request failed: ${error.message}`);
      continue;
    }
    for (const record of (taskDetails.runs ?? []).map(summarize)) {
      const key = `${parentTaskId}/${record.modelId}`;
      await log(`${key} round=${record.round} status=${record.status} calls=${record.totalToolCalls}`);
      if (record.totalToolCalls >= minToolCalls || record.round >= maxRounds || !terminal.has(record.status)) continue;
      if (Date.now() - (Number(state[key]) || 0) < cooldownMs) {
        await log(`${key} append cooldown active`);
        continue;
      }

      // Persist before the request: gateway disconnects can occur after the platform accepts it.
      state[key] = Date.now();
      await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
      try {
        const response = await appendRound(parentTaskId, record);
        await log(`${key} requested round ${record.round + 1}, response bytes=${response.length}`);
      } catch (error) {
        await log(`${key} append request failed: ${error.message}`);
      }
    }
  }
  if (iteration < iterations) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
