import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const base = (process.env.CROWDTEST_BASE || 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com').replace(/\/$/, '');
const cookie = process.env.CROWDTEST_COOKIE;

if (!cookie) {
  throw new Error('Set CROWDTEST_COOKIE before running this script.');
}

const root = process.cwd();
const downloadDir = path.join(root, 'eval-results', 'downloads');
const artifactRoot = path.join(root, '.eval-artifacts');

const artifacts = [
  ['JVZUMA_tempest', '/api/download_zip_jobs/artifact__JVZUMA__WIUGIG__967KC__r22__a8__run2716__quick__v4__8cf86cff2b0265a8/file'],
  ['JVZUMA_raptor', '/api/download_zip_jobs/artifact__JVZUMA__HQE0OA__D7YWL__r35__a2__run3056__quick__v4__2a75dbc672127b1d/file'],
  ['JVZUMA_umbra', '/api/download_zip_jobs/artifact__JVZUMA__VCNZDG__H7ADN__r55__a1__run3413__quick__v4__be61068df5c62052/file'],
  ['JVZUMA_saber', '/api/download_zip_jobs/artifact__JVZUMA__MR54OA__Z9KCY__r33__a4__run2922__quick__v4__66e14371bb3dcc57/file'],
  ['MMLIPQ_tempest', '/api/download_zip_jobs/artifact__MMLIPQ__4YFMVQ__967KC__r31__a6__run3064__quick__v4__09e6ea9ef6e985f3/file'],
  ['MMLIPQ_raptor', '/api/download_zip_jobs/artifact__MMLIPQ__OMKO8G__D7YWL__r23__a5__run2785__quick__v4__a2d60e550f225609/file'],
  ['MMLIPQ_umbra', '/api/download_zip_jobs/artifact__MMLIPQ__IABDVA__H7ADN__r29__a5__run2928__quick__v4__94da19dfd4e5c4c6/file'],
  ['MMLIPQ_saber', '/api/download_zip_jobs/artifact__MMLIPQ__O07VLA__Z9KCY__r26__a4__run2796__quick__v4__eb836fc93e29bfe7/file'],
];

async function download(name, urlPath) {
  const zipPath = path.join(downloadDir, `${name}_quick.zip`);
  try {
    const existing = await stat(zipPath);
    if (existing.size > 0) {
      console.log(`Using existing ${name} zip (${existing.size} bytes)`);
      return zipPath;
    }
  } catch {
    // Download below.
  }
  const response = await fetch(`${base}${urlPath}`, { headers: { cookie } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${name} download failed: ${response.status} ${response.statusText}: ${text}`);
  }
  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    response.body.pipeTo(
      new WritableStream({
        write(chunk) {
          output.write(Buffer.from(chunk));
        },
        close() {
          output.end(resolve);
        },
        abort(error) {
          output.destroy(error);
          reject(error);
        },
      }),
    ).catch(reject);
  });
  return zipPath;
}

async function extract(zipPath, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await new Promise((resolve, reject) => {
    const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const command = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)} -Force`;
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Expand-Archive failed with exit ${code}`));
    });
  });
}

await mkdir(downloadDir, { recursive: true });
await mkdir(artifactRoot, { recursive: true });

for (const [name, urlPath] of artifacts) {
  console.log(`Downloading ${name}`);
  const zipPath = await download(name, urlPath);
  console.log(`Extracting ${name}`);
  await extract(zipPath, path.join(artifactRoot, name));
}
