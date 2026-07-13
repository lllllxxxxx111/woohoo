import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.CROWDTEST_BASE || 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const cookie = process.env.CROWDTEST_COOKIE || 'username=admin';
const userId = Number(process.env.CROWDTEST_USER_ID || 674);
const harness = process.env.CROWDTEST_HARNESS || 'hermes';
const root = process.cwd();
const sourceDocPath = path.join(root, 'docs', 'agent-long-eval-32-prep.md');

function newTaskId() {
  return randomBytes(4).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
}

function sectionFor(doc, label) {
  const start = doc.indexOf(`## 任务 ${label}`);
  if (start < 0) throw new Error(`Cannot find task ${label}`);
  const nextLabel = label === 'A' ? 'B' : null;
  const end = nextLabel ? doc.indexOf(`## 任务 ${nextLabel}`, start + 1) : doc.indexOf('## 通用反馈模板', start + 1);
  return doc.slice(start, end > start ? end : undefined);
}

function promptForRound(doc, label, round) {
  const section = sectionFor(doc, label);
  const marker = `第 ${round} 轮`;
  const start = section.indexOf(marker);
  if (start < 0) throw new Error(`Cannot find round ${round} for task ${label}`);
  const rest = section.slice(start);
  const match = rest.match(/```text\r?\n([\s\S]*?)\r?\n```/);
  if (!match) throw new Error(`Cannot find text block for task ${label} round ${round}`);
  return match[1].trim();
}

function taskMap() {
  const map = {
    A: process.env.CROWDTEST32_TASK_A || '',
    B: process.env.CROWDTEST32_TASK_B || '',
  };
  return Object.fromEntries(Object.entries(map).filter(([, value]) => value));
}

function configuredModelIds() {
  return (process.env.CROWDTEST_MODEL_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
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
  return requestJson(`${base}/api/task_details/${encodeURIComponent(taskId)}?_ts=${Date.now()}`);
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
  return requestJson(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ task: payload }),
  });
}

function modelIdsFromDetails(details) {
  const configured = configuredModelIds();
  if (configured.length) return configured;
  if (Array.isArray(details.taskModels) && details.taskModels.length) {
    return details.taskModels.map((model) => model.modelId || model.id || model.name).filter(Boolean);
  }
  if (Array.isArray(details.runs) && details.runs.length) {
    return [...new Set(details.runs.map((run) => run.modelId).filter(Boolean))];
  }
  throw new Error(`Cannot infer model IDs for task ${details.taskId}`);
}

const round = Number(process.argv[2] || '2');
if (!Number.isInteger(round) || round < 2 || round > 10) {
  throw new Error('Usage: node eval-results/crowdtest32-append-rounds.mjs <round 2..10> [A] [B]');
}

const labels = (process.argv.slice(3).length ? process.argv.slice(3) : ['A', 'B']).map((value) => value.toUpperCase());
const tasks = taskMap();
if (Object.keys(tasks).length === 0) {
  throw new Error('Set CROWDTEST32_TASK_A and/or CROWDTEST32_TASK_B to created task IDs before appending rounds.');
}

const doc = await readFile(sourceDocPath, 'utf8');

for (const label of labels) {
  const taskId = tasks[label];
  if (!taskId) {
    console.log(`Skip task ${label}: no CROWDTEST32_TASK_${label} configured`);
    continue;
  }
  const prompt = promptForRound(doc, label, round);
  const details = await getDetails(taskId);
  const modelIds = modelIdsFromDetails(details);
  console.log(`Task ${label} ${taskId}: ${details.title}; round=${round}; models=${modelIds.join(',')}`);
  for (const modelId of modelIds) {
    const latestRun =
      (details.runs || []).find((item) => item.modelId === modelId && item.isLatestRound) ||
      (details.runs || []).find((item) => item.modelId === modelId);
    if (latestRun?.status === 'running') {
      console.log(`  skip ${modelId}: latest round is running`);
      continue;
    }
    try {
      const result = await appendRound(taskId, modelId, prompt);
      console.log(`  appended round ${round} to ${latestRun?.displayName || modelId}/${modelId}: ${JSON.stringify(result)}`);
    } catch (error) {
      console.log(`  failed ${latestRun?.displayName || modelId}/${modelId}: ${error.message}`);
    }
  }
}
