import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const base = (process.env.CROWDTEST_BASE || 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com').replace(/\/$/, '');
const cookie = process.env.CROWDTEST_COOKIE || 'username=KzZd1nlyoi';
const userId = Number(process.env.CROWDTEST_USER_ID || '6');
const harness = process.env.CROWDTEST_HARNESS || 'hermes';
const evaluationTaskId = Number(process.env.CROWDTEST_EVALUATION_TASK_ID || '7');
const root = process.cwd();
const sourceDoc = path.join(root, 'docs', 'agent-long-eval-34-prep.md');

const modelIds = ['13B1L', 'XZ4IK', 'TDOKH', 'P2EN2'];
const includedRoots = [
  'README.md',
  'package.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'docs',
  'scripts',
  'server',
  'src',
];
const excludedDirectories = new Set([
  '.git',
  '.agents',
  '.codex',
  '.eval-artifacts',
  '.trae',
  'node_modules',
  'dist',
  'data',
  'runtime-logs',
  'target',
  'eval-results',
]);
const maxFileBytes = 3 * 1024 * 1024;

function createTaskId() {
  return randomBytes(5).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
}

function parseTasks(document) {
  return ['A', 'B'].map((label) => {
    const start = document.indexOf(`## 任务 ${label}`);
    const next = label === 'A' ? document.indexOf('## 任务 B', start + 1) : document.length;
    if (start < 0 || next <= start) {
      throw new Error(`Cannot find task ${label} in ${sourceDoc}`);
    }
    const blocks = [...document.slice(start, next).matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1].trim());
    if (blocks.length !== 3) {
      throw new Error(`Task ${label} should contain title, background, and prompt blocks`);
    }
    return { label, title: blocks[0], background: blocks[1], prompt: blocks[2] };
  });
}

async function requestJson(endpoint, options = {}) {
  const response = await fetch(`${base}${endpoint}`, {
    ...options,
    headers: {
      cookie,
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
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

async function collectFiles(absoluteDir, relativeDir) {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const collected = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(absoluteDir, entry.name);
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectFiles(absolute, relative)));
      continue;
    }
    if (!entry.isFile() || entry.name.startsWith('.env')) continue;
    const metadata = await stat(absolute);
    if (metadata.size > maxFileBytes) continue;
    collected.push({ absolute, relative });
  }
  return collected;
}

async function sourceFiles() {
  const files = [];
  for (const relative of includedRoots) {
    const absolute = path.join(root, relative);
    try {
      const metadata = await stat(absolute);
      if (metadata.isDirectory()) {
        files.push(...(await collectFiles(absolute, relative)));
      } else if (metadata.isFile() && metadata.size <= maxFileBytes) {
        files.push({ absolute, relative: relative.replace(/\\/g, '/') });
      }
    } catch {
      // Optional config files differ across branches; omit absent entries.
    }
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

async function uploadSource(label) {
  const folderName = `woohoo-agent34-${label.toLowerCase()}-${createTaskId().toLowerCase()}`;
  const files = await sourceFiles();
  if (files.length === 0) throw new Error('No source files selected for upload');

  const form = new FormData();
  form.append('folderName', folderName);
  form.append('filePaths', JSON.stringify(files.map((file) => `${folderName}/${file.relative}`)));
  let totalBytes = 0;
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    totalBytes += bytes.byteLength;
    form.append('files', new Blob([bytes], { type: 'application/octet-stream' }), path.basename(file.relative));
  }

  console.log(`Uploading task ${label}: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  const result = await requestJson('/api/tasks/upload', { method: 'POST', body: form, timeoutMs: 300_000 });
  if (!result.path) throw new Error(`Upload response did not contain path: ${JSON.stringify(result)}`);
  return result.path;
}

async function createTask(task, baseDir) {
  const taskId = createTaskId();
  const payload = {
    baseDir,
    title: task.title,
    prompt: task.prompt,
    taskBackground: task.background,
    taskOrigin: 'work',
    taskId,
    evaluationTaskId,
    harness,
    models: modelIds,
    srcTaskId: null,
    srcModelName: null,
    appendToTaskId: null,
    appendModelId: null,
    userId,
    enableAgentTeams: false,
  };
  const result = await requestJson('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ task: payload }),
  });
  return { taskId, result };
}

async function main() {
  const requestedLabels = process.argv.slice(2).map((value) => value.trim().toUpperCase()).filter(Boolean);
  const labels = requestedLabels.length ? requestedLabels : ['A', 'B'];
  if (labels.some((label) => !['A', 'B'].includes(label))) {
    throw new Error('Usage: node eval-results/crowdtest34-create-tasks.mjs [A] [B]');
  }

  const enabled = await requestJson('/api/evaluation-tasks/enabled');
  const evaluation = enabled.find((item) => Number(item.id) === evaluationTaskId);
  if (!evaluation || !String(evaluation.target || '').includes('34期方舟Agent长程评测')) {
    throw new Error(`Evaluation task ${evaluationTaskId} is not the expected 34th long-running evaluation`);
  }
  if (Number(evaluation.remainingTaskCount) < labels.length) {
    throw new Error(`Only ${evaluation.remainingTaskCount} task slots remain, cannot create ${labels.length}`);
  }

  const tasks = parseTasks(await readFile(sourceDoc, 'utf8')).filter((task) => labels.includes(task.label));
  for (const task of tasks) {
    const baseDir = await uploadSource(task.label);
    const created = await createTask(task, baseDir);
    const details = await requestJson(`/api/task_details/${encodeURIComponent(created.taskId)}?_ts=${Date.now()}`);
    const models = (details.runs || details.taskModels || []).map((item) => item.displayName || item.modelName || item.modelId);
    console.log(JSON.stringify({ label: task.label, taskId: created.taskId, title: task.title, baseDir, models }, null, 2));
  }
}

await main();
