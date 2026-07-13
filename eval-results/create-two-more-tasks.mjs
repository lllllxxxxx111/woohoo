import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const base = 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=admin';
const userId = 674;
const evaluationTaskId = 9;
const harness = 'hermes';
const root = process.cwd();
const sourceDocPath = path.join(root, 'docs', 'agent-long-eval-31-two-more-tasks.md');

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

function extractTask(doc, label) {
  const nextLabel = label === 'A' ? 'B' : null;
  const start = doc.indexOf(`## 任务 ${label}`);
  if (start < 0) throw new Error(`Cannot find task ${label}`);
  const end = nextLabel ? doc.indexOf(`## 任务 ${nextLabel}`, start + 1) : doc.indexOf('## 通用评分参考', start + 1);
  const section = doc.slice(start, end > start ? end : undefined);
  const codeBlocks = [...section.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)].map(match => match[1].trim());
  if (codeBlocks.length < 4) {
    throw new Error(`Task ${label} has ${codeBlocks.length} text blocks, expected at least 4`);
  }
  return {
    label,
    title: codeBlocks[0],
    background: codeBlocks[1],
    prompt: codeBlocks[3],
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
    if (excludedFiles.has(entry.name)) continue;
    if (entry.name.endsWith('.zip')) continue;
    const info = await stat(absolute);
    if (info.size > 5 * 1024 * 1024) continue;
    files.push({ absolute, relative: relative.replace(/\\/g, '/') });
  }
  return files;
}

async function uploadFolder(label) {
  const folderName = `woohoo-agent31-${label.toLowerCase()}-${taskId()}`;
  const files = await walkFiles(root);
  if (files.length === 0) throw new Error('No files selected for upload');

  const form = new FormData();
  form.append('folderName', folderName);
  form.append('filePaths', JSON.stringify(files.map(file => `${folderName}/${file.relative}`)));
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
  if (!result.path) {
    throw new Error(`Upload did not return path: ${JSON.stringify(result)}`);
  }
  return result.path;
}

async function createTask(task, baseDir) {
  const id = taskId();
  const payload = {
    baseDir,
    title: task.title,
    prompt: task.prompt,
    taskBackground: task.background,
    taskOrigin: '',
    taskId: id,
    evaluationTaskId,
    harness,
    models: [],
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

const doc = await readFile(sourceDocPath, 'utf8');
const requestedLabels = new Set(process.argv.slice(2).map(value => value.toUpperCase()));
const tasks = [extractTask(doc, 'A'), extractTask(doc, 'B')].filter(
  task => requestedLabels.size === 0 || requestedLabels.has(task.label),
);

for (const task of tasks) {
  console.log(`Uploading source folder for task ${task.label}: ${task.title}`);
  let baseDir = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      baseDir = await uploadFolder(task.label);
      break;
    } catch (error) {
      console.log(`  upload attempt ${attempt} failed: ${error.message}`);
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 3000));
    }
  }
  console.log(`  upload path: ${baseDir}`);
  const created = await createTask(task, baseDir);
  console.log(`  create result: ${JSON.stringify(created.result)}`);
  const details = await taskDetails(created.id);
  console.log(
    `  verified taskId=${created.id} title=${JSON.stringify(details.title)} runs=${Array.isArray(details.runs) ? details.runs.length : 0} models=${Array.isArray(details.taskModels) ? details.taskModels.map(m => m.displayName).join(',') : ''}`,
  );
}
