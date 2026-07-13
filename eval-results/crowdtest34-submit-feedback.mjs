import { readFile } from 'node:fs/promises';
import path from 'node:path';

const base = 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=KzZd1nlyoi';
const root = process.cwd();
const keepAlive = setInterval(() => {}, 1_000);

const entries = [
  { taskId: 'K7SH2XS', modelId: '13B1L', label: 'dynamo', scores: { quality: 8, efficiency: 8, overall: 8 }, note: 'Added a routing helper, routing-audit migration and API, call-site integration, and focused routing tests. Typecheck, 215 tests, and build passed locally.' },
  { taskId: 'K7SH2XS', modelId: 'P2EN2', label: 'aegis', scores: { quality: 8, efficiency: 7, overall: 8 }, note: 'Implemented routing-audit endpoints and route-selection coverage in the existing React and Rust structure. Typecheck, 214 tests, and build passed; additional tool calls reduced delivery efficiency.' },
  { taskId: 'K7SH2XS', modelId: 'TDOKH', label: 'basalt', scores: { quality: 6, efficiency: 5, overall: 6 }, note: 'Reached the feature and call-count requirements, but the quick artifact is about 1.02 GB. It could not be extracted proportionately for local validation, which indicates weak package hygiene.' },
  { taskId: 'K7SH2XS', modelId: 'XZ4IK', label: 'cipher', scores: { quality: 6, efficiency: 6, overall: 6 }, note: 'Completed routing work in four rounds, but the quick artifact is about 829 MB and could not be extracted within the review budget. Package bloat and missing reproducible validation lower the score.' },
  { taskId: 'UIVTKK0', modelId: '13B1L', label: 'dynamo', scores: { quality: 9, efficiency: 6, overall: 8 }, note: 'Delivered broad SSE event semantics, parser, recovery, state-machine coverage, and integration tests. Typecheck, 337 tests, and build passed locally; reaching the target used many short follow-up rounds.' },
  { taskId: 'UIVTKK0', modelId: 'P2EN2', label: 'aegis', scores: { quality: 8, efficiency: 7, overall: 8 }, note: 'Added robust fragmented-stream, Last-Event-ID, bounded reconnect, and recovery tests. Typecheck, 274 tests, and build passed locally.' },
  { taskId: 'UIVTKK0', modelId: 'TDOKH', label: 'basalt', scores: { quality: 9, efficiency: 7, overall: 8 }, note: 'Provided the strongest SSE regression breadth: cursor, parser, recovery, state semantics, and integration tests. Typecheck, 340 tests, and build passed locally.' },
  { taskId: 'UIVTKK0', modelId: 'XZ4IK', label: 'cipher', scores: { quality: 7, efficiency: 5, overall: 6 }, note: 'The downloaded pre-final artifact passed typecheck, 274 tests, and build, with useful SSE client and recovery coverage. Many short or empty follow-up rounds reduced delivery efficiency.' },
];

function sumCalls(run) {
  const rounds = Array.isArray(run.rounds) && run.rounds.length ? run.rounds : [run];
  return rounds.reduce((total, round) => total + Object.values(round.stats?.toolCounts ?? {})
    .reduce((sum, value) => sum + (Number(value) || 0), 0), 0);
}

async function requestJson(pathname, options = {}, attempt = 1) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    if (attempt < 4 && [500, 502, 503, 504].includes(response.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      return requestJson(pathname, options, attempt + 1);
    }
    throw new Error(`${pathname}: ${response.status} ${text}`);
  }
  return data;
}

async function getRuns(taskId) {
  const details = await requestJson(`/api/task_details/${taskId}?_ts=${Date.now()}`);
  return new Map((details.runs ?? []).map((run) => {
    const rounds = Array.isArray(run.rounds) && run.rounds.length ? run.rounds : [run];
    const latest = rounds.find((round) => round.isLatestRound) ?? rounds.at(-1);
    return [run.modelId, { status: latest.status, calls: sumCalls(run) }];
  }));
}

async function check(entry) {
  const scores = await requestJson(`/api/feedback/check?taskId=${entry.taskId}&modelId=${entry.modelId}`);
  const products = await requestJson(`/api/comments/user-feedback?taskId=${entry.taskId}&modelId=${entry.modelId}`);
  return {
    scores: Array.isArray(scores.feedback) ? scores.feedback.length : 0,
    products: Array.isArray(products) ? products.length : 0,
  };
}

async function submitScores(entry) {
  const responses = [
    { questionId: 3, score: entry.scores.quality, comment: `Quality assessment: ${entry.note}` },
    { questionId: 2, score: entry.scores.efficiency, comment: `Delivery efficiency: ${entry.calls} tool calls. ${entry.note}` },
    { questionId: 1, score: entry.scores.overall, comment: `Overall assessment: ${entry.note}` },
  ];
  return requestJson('/api/feedback/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ taskId: entry.taskId, modelId: entry.modelId, responses }),
  });
}

async function submitProductFeedback(entry) {
  const imagePath = path.join(root, 'eval-results', `crowdtest34_${entry.taskId}_${entry.label}_validation.png`);
  const form = new FormData();
  form.append('taskId', entry.taskId);
  form.append('modelId', entry.modelId);
  form.append('userId', '6');
  form.append('content', `Local validation: ${entry.note}\nPlatform tool calls: ${entry.calls}, meeting the over-300 requirement. Scores are based on implementation, tool trajectory, and local validation results.`);
  form.append('images', new Blob([await readFile(imagePath)], { type: 'image/png' }), path.basename(imagePath));
  return requestJson('/api/comments/user-feedback', { method: 'POST', body: form, timeoutMs: 90_000 });
}

const cache = new Map();
for (const taskId of new Set(entries.map((entry) => entry.taskId))) cache.set(taskId, await getRuns(taskId));
for (const entry of entries) {
  const run = cache.get(entry.taskId).get(entry.modelId);
  if (!run || !['completed', 'evaluated'].includes(run.status) || run.calls < 301) {
    throw new Error(`${entry.taskId}/${entry.modelId} is not eligible: ${JSON.stringify(run)}`);
  }
  entry.calls = run.calls;
  const before = await check(entry);
  await submitScores(entry);
  if (before.products < 1) await submitProductFeedback(entry);
  const after = await check(entry);
  if (after.scores < 3 || after.products < 1) throw new Error(`${entry.taskId}/${entry.modelId} feedback did not persist: ${JSON.stringify(after)}`);
  console.log(`${entry.taskId}/${entry.label}: scores=${after.scores} productFeedback=${after.products}`);
}

clearInterval(keepAlive);
