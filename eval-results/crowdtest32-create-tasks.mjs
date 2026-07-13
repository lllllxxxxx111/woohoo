import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.CROWDTEST_BASE || 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const cookie = process.env.CROWDTEST_COOKIE || 'username=admin';
const userId = Number(process.env.CROWDTEST_USER_ID || 674);
const harness = process.env.CROWDTEST_HARNESS || 'hermes';
const root = process.cwd();
const sourceDocPath = path.join(root, 'docs', 'agent-long-eval-32-prep.md');

const excludedDirs = new Set([
  '.git',
  '.agents',
  '.codex',
  '.eval-artifacts',
  '.trae',
  'node_modules',
  'dist',
  'data',
  'runtime-logs',
  'eval-results',
  'target',
]);

const excludedFiles = new Set(['.env', '.env.local']);

function taskId() {
  return randomBytes(4).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
}

function getCodeBlockAfter(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`Cannot find marker: ${marker}`);
  const rest = text.slice(start);
  const match = rest.match(/```text\r?\n([\s\S]*?)\r?\n```/);
  if (!match) throw new Error(`Cannot find text block after marker: ${marker}`);
  return match[1].trim();
}

function sectionFor(doc, label) {
  const start = doc.indexOf(`## 任务 ${label}`);
  if (start < 0) throw new Error(`Cannot find task ${label}`);
  const nextLabel = label === 'A' ? 'B' : null;
  const end = nextLabel ? doc.indexOf(`## 任务 ${nextLabel}`, start + 1) : doc.indexOf('## 通用反馈模板', start + 1);
  return doc.slice(start, end > start ? end : undefined);
}

function extractTask(doc, label) {
  const section = sectionFor(doc, label);
  return {
    label,
    title: getCodeBlockAfter(section, '任务标题：'),
    background: getCodeBlockAfter(section, '任务背景：'),
    prompt: getCodeBlockAfter(section, `### ${label}.2 固定首轮 Prompt`),
  };
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

async function resolveEvaluationTaskId() {
  if (process.env.CROWDTEST_EVALUATION_TASK_ID) {
    return Number(process.env.CROWDTEST_EVALUATION_TASK_ID);
  }
  const target = process.env.CROWDTEST_EVALUATION_TARGET || '32期Agent长程任务众测';
  const tasks = await requestJson(`${base}/api/evaluation-tasks/enabled`);
  const match = tasks.find((item) => String(item.target || '').includes(target));
  if (!match) {
    const available = tasks.map((item) => `${item.id}:${item.target}`).join(', ');
    throw new Error(
      `Cannot find enabled evaluation task matching "${target}". Set CROWDTEST_EVALUATION_TASK_ID explicitly. Available: ${available}`,
    );
  }
  return Number(match.id);
}

function selectedModels() {
  const raw = process.env.CROWDTEST_MODEL_IDS || '';
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function walkFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute, relative)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (excludedFiles.has(entry.name) || entry.name.startsWith('.env')) continue;
    if (entry.name.endsWith('.zip')) continue;
    const info = await stat(absolute);
    if (info.size > 5 * 1024 * 1024) continue;
    files.push({ absolute, relative: relative.replace(/\\/g, '/') });
  }
  return files;
}

async function uploadFolder(label) {
  const folderName = `woohoo-agent32-${label.toLowerCase()}-${taskId()}`;
  const files = await walkFiles(root);
  if (files.length === 0) throw new Error('No files selected for upload');

  const form = new FormData();
  form.append('folderName', folderName);
  form.append('filePaths', JSON.stringify(files.map((file) => `${folderName}/${file.relative}`)));
  let totalBytes = 0;
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    totalBytes += bytes.byteLength;
    form.append('files', new Blob([bytes], { type: 'application/octet-stream' }), path.basename(file.relative));
  }
  console.log(`  uploading ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB as ${folderName}`);
  const result = await requestJson(`${base}/api/tasks/upload`, {
    method: 'POST',
    body: form,
  });
  if (!result.path) throw new Error(`Upload did not return path: ${JSON.stringify(result)}`);
  return result.path;
}

async function createTask(task, baseDir, evaluationTaskId, models) {
  const id = taskId();
  const payload = {
    baseDir,
    title: task.title,
    prompt: task.prompt,
    taskBackground: task.background,
    taskOrigin: 'work',
    taskId: id,
    evaluationTaskId,
    harness,
    models,
    srcTaskId: null,
    srcModelName: null,
    appendToTaskId: null,
    appendModelId: null,
    userId,
    enableAgentTeams: false,
  };
  const result = await requestJson(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ task: payload }),
  });
  return { id, payload, result };
}

async function taskDetails(id) {
  return requestJson(`${base}/api/task_details/${encodeURIComponent(id)}?_ts=${Date.now()}`);
}

const dryRun = process.argv.includes('--dry-run') || process.env.CROWDTEST_DRY_RUN === '1';
const labelArgs = process.argv.slice(2).filter((value) => value !== '--dry-run');
const labels = (labelArgs.length ? labelArgs : ['A', 'B']).map((value) => value.toUpperCase());
const doc = await readFile(sourceDocPath, 'utf8');

if (dryRun) {
  for (const label of labels) {
    const task = extractTask(doc, label);
    console.log(`Task ${label}: ${task.title}`);
    console.log(`  background chars=${task.background.length}`);
    console.log(`  prompt chars=${task.prompt.length}`);
  }
  process.exit(0);
}

const evaluationTaskId = await resolveEvaluationTaskId();
const models = selectedModels();

console.log(`Using evaluationTaskId=${evaluationTaskId}, harness=${harness}, models=${models.length ? models.join(',') : '(from evaluation task)'}`);

for (const label of labels) {
  const task = extractTask(doc, label);
  console.log(`Uploading source folder for task ${label}: ${task.title}`);
  let baseDir = process.env.CROWDTEST_BASE_DIR || '';
  if (baseDir) {
    console.log(`  using existing upload path: ${baseDir}`);
  } else {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        baseDir = await uploadFolder(label);
        break;
      } catch (error) {
        console.log(`  upload attempt ${attempt} failed: ${error.message}`);
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
      }
    }
  }
  console.log(`  upload path: ${baseDir}`);
  const created = await createTask(task, baseDir, evaluationTaskId, models);
  console.log(`  create result: ${JSON.stringify(created.result)}`);
  const details = await taskDetails(created.id);
  const taskModels = Array.isArray(details.taskModels)
    ? details.taskModels.map((model) => `${model.displayName || model.name}:${model.modelId || model.id}`).join(',')
    : '';
  console.log(`  verified label=${label} taskId=${created.id} title=${JSON.stringify(details.title)} models=${taskModels}`);
}
