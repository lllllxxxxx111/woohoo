import { appendFile } from 'node:fs/promises';

const taskId = '93H9CHU';
const modelId = 'XZ4IK';
const base = 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=KzZd1nlyoi';
const logPath = new URL('./crowdtest34-delayed-restart.log', import.meta.url);

await new Promise((resolve) => setTimeout(resolve, 300_000));
try {
  const response = await fetch(`${base}/api/tasks/${taskId}/start`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ modelId }),
    signal: AbortSignal.timeout(90_000),
  });
  await appendFile(logPath, `${new Date().toISOString()} ${response.status} ${await response.text()}\n`, 'utf8');
} catch (error) {
  await appendFile(logPath, `${new Date().toISOString()} ERROR ${error.message}\n`, 'utf8');
  process.exitCode = 1;
}
