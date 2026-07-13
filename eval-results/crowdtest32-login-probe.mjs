import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const base = (process.argv[2] || process.env.CROWDTEST_BASE || 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com').replace(/\/$/, '');
if (!base) throw new Error('Set CROWDTEST_BASE');

async function readStdinLine() {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  const line = await rl.question('');
  rl.close();
  return line;
}

function cookieHeader(headers) {
  const values = [];
  for (const [key, value] of headers) {
    if (key.toLowerCase() === 'set-cookie') values.push(value);
  }
  return values
    .flatMap((value) => value.split(/,(?=[^;,]+=)/))
    .map((value) => value.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  return { response, data, text };
}

const input = JSON.parse(await readStdinLine());
const username = String(input.username || '').trim();
const password = String(input.password || '');
if (!username || !password) throw new Error('username and password are required');

const login = await request('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});

if (!login.response.ok) {
  throw new Error(`Login failed: ${login.response.status} ${login.text}`);
}

const cookie = cookieHeader(login.response.headers) || `username=${encodeURIComponent(username)}`;
const headers = { cookie };

const [config, tasks, models] = await Promise.all([
  request('/api/config/public', { headers }),
  request('/api/evaluation-tasks/enabled', { headers }),
  request('/api/models/enabled', { headers }),
]);

const result = {
  base,
  cookie,
  login: typeof login.data === 'object' ? login.data : { raw: login.text.slice(0, 200) },
  configStatus: config.response.status,
  tasksStatus: tasks.response.status,
  modelsStatus: models.response.status,
  evaluationTasks: Array.isArray(tasks.data)
    ? tasks.data.map((task) => ({
        id: task.id,
        target: task.target,
        status: task.status,
        statusLabel: task.statusLabel,
        allowedHarnesses: task.allowedHarnesses,
        models: Array.isArray(task.models)
          ? task.models.map((model) => ({ id: model.id, displayName: model.displayName }))
          : [],
      }))
    : tasks.data,
  enabledModels: Array.isArray(models.data)
    ? models.data.map((model) => ({
        id: model.id,
        model_id: model.model_id,
        displayName: model.displayname || model.displayName || model.name,
      }))
    : models.data,
  publicConfig: typeof config.data === 'object'
    ? {
        platformName: config.data.platformName,
        allowNewTaskSubmission: config.data.allowNewTaskSubmission,
        requireExternalTaskRepository: config.data.requireExternalTaskRepository,
        taskBackgroundMode: config.data.taskBackgroundMode,
      }
    : config.data,
};

console.log(JSON.stringify(result, null, 2));
