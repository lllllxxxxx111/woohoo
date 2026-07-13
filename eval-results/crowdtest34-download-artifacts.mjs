import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const base = 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=KzZd1nlyoi';
const tasks = ['K7SH2XS', 'UIVTKK0'];
const root = process.cwd();
const downloadRoot = path.join(root, 'eval-results', 'downloads', 'crowdtest34');
const artifactRoot = path.join(root, '.eval-artifacts', 'crowdtest34');
const maxBytes = Number(process.env.CROWDTEST_MAX_ARTIFACT_BYTES || 100 * 1024 * 1024);

async function request(pathname) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${await response.text()}`);
  return response;
}

async function extract(zipPath, destination) {
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive exited ${code}`)));
  });
}

await mkdir(downloadRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });

for (const taskId of tasks) {
  const details = await (await request(`/api/task_details/${taskId}?_ts=${Date.now()}`)).json();
  for (const run of details.runs ?? []) {
    const packageInfo = run.downloadPackage;
    const name = `${taskId}_${run.displayName}`;
    if (!packageInfo?.canDownload || !packageInfo.downloadUrl) {
      console.log(`SKIP ${name}: package unavailable`);
      continue;
    }
    if (Number(packageInfo.sizeBytes) > maxBytes) {
      console.log(`SKIP ${name}: ${packageInfo.sizeBytes} bytes exceeds ${maxBytes}`);
      continue;
    }
    const zipPath = path.join(downloadRoot, `${name}.zip`);
    const destination = path.join(artifactRoot, name);
    try {
      const existing = await stat(zipPath);
      if (existing.size !== Number(packageInfo.sizeBytes)) throw new Error('existing size mismatch');
      console.log(`REUSE ${name}: ${existing.size} bytes`);
    } catch {
      const response = await request(packageInfo.downloadUrl);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));
      console.log(`DOWNLOADED ${name}: ${packageInfo.sizeBytes} bytes`);
    }
    await extract(zipPath, destination);
    console.log(`EXTRACTED ${name}`);
  }
}
