import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const base = 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=admin';
const userId = 674;
const root = process.cwd();
const sourceDocPath = path.join(root, 'docs', 'agent-long-eval-31-two-more-tasks.md');

const tasks = {
  A: { taskId: 'PWVLRG', title: '跨项目素材治理与安全删除' },
  B: { taskId: '7VZPUW', title: 'Pipeline 失败复核闭环' },
};

const modelIds = ['OM5KP', 'LODPC', 'A1XCY', 'JH0M0'];

function newTaskId() {
  return randomBytes(4).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
}

function sectionFor(doc, label) {
  const nextLabel = label === 'A' ? 'B' : null;
  const start = doc.indexOf(`## 任务 ${label}`);
  if (start < 0) throw new Error(`Cannot find task ${label}`);
  const end = nextLabel ? doc.indexOf(`## 任务 ${nextLabel}`, start + 1) : doc.indexOf('## 通用评分参考', start + 1);
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
    harness: 'hermes',
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

const round = Number(process.argv[2] || '2');
const labels = (process.argv.slice(3).length ? process.argv.slice(3) : ['A', 'B']).map(value => value.toUpperCase());
const doc = await readFile(sourceDocPath, 'utf8');

for (const label of labels) {
  const task = tasks[label];
  if (!task) throw new Error(`Unknown task label ${label}`);
  const prompt = promptForRound(doc, label, round);
  const details = await getDetails(task.taskId);
  console.log(`Task ${label} ${task.taskId}: ${details.title}`);
  for (const modelId of modelIds) {
    const run = (details.runs || []).find(item => item.modelId === modelId && item.isLatestRound) || (details.runs || []).find(item => item.modelId === modelId);
    if (run?.status === 'running') {
      console.log(`  skip ${modelId}: latest round is running`);
      continue;
    }
    try {
      const result = await appendRound(task.taskId, modelId, prompt);
      console.log(`  appended round ${round} to ${run?.displayName || modelId}/${modelId}: ${JSON.stringify(result)}`);
    } catch (error) {
      console.log(`  failed ${run?.displayName || modelId}/${modelId}: ${error.message}`);
    }
  }
}
