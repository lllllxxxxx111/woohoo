import { appendFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const artifacts = process.argv.slice(2);
if (artifacts.length === 0) {
  console.error('Usage: node eval-results/validate-artifacts-light.mjs <artifact>...');
  process.exit(1);
}

const root = process.cwd();
const evalDir = path.join(root, 'eval-results');
const nodeBin = path.join(root, 'node_modules', '.bin');

async function countFiles(dir) {
  let count = 0;
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      if (entry.isFile()) count += 1;
    }
  }
  await walk(dir);
  return count;
}

function runStep({ artifact, cwd, report, label, command, args, timeoutMs = 180_000 }) {
  return new Promise(resolve => {
    appendFile(report, `\n===== ${label} =====\nStarted: ${new Date().toISOString()}\n`, 'utf8').catch(() => {});
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, PATH: `${nodeBin}${path.delimiter}${process.env.PATH || ''}` },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', chunk => appendFile(report, chunk).catch(() => {}));
    child.stderr.on('data', chunk => appendFile(report, chunk).catch(() => {}));
    child.on('error', error => appendFile(report, `ERROR: ${error.message}\n`, 'utf8').catch(() => {}));
    child.on('close', async code => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : (code ?? 1);
      await appendFile(report, `Ended: ${new Date().toISOString()}\nEXIT_CODE=${exitCode}\n`, 'utf8').catch(() => {});
      console.log(`${artifact}: ${label} -> ${exitCode}`);
      resolve(exitCode);
    });
  });
}

async function fileExists(base, relative) {
  try {
    return (await stat(path.join(base, relative))).isFile();
  } catch {
    return false;
  }
}

async function readMaybe(base, relative) {
  try {
    return await readFile(path.join(base, relative), 'utf8');
  } catch {
    return '';
  }
}

async function inspectTaskA(base) {
  const files = [
    'server/src/materials/asset_governance.rs',
    'server/src/materials/asset_governance_handlers.rs',
    'server/migrations/021_asset_governance.sql',
    'src/components/Settings/AssetGovernance.tsx',
  ];
  const contents = await Promise.all(files.map(file => readMaybe(base, file)));
  const joined = contents.join('\n').toLowerCase();
  return {
    files,
    present: await Promise.all(files.map(file => fileExists(base, file))),
    checks: {
      searchApi: /search|query|filter/.test(joined),
      tagApi: /tag|标签/.test(joined),
      referenceScan: /reference|引用|usage|in_use|safe_delete/.test(joined),
      deleteGuard: /delete|删除|blocked|confirm|audit/.test(joined),
      migration: /create table/.test(joined),
    },
  };
}

async function inspectTaskB(base) {
  const files = [
    'server/src/pipeline/review_queue.rs',
    'server/src/pipeline/review_handlers.rs',
    'server/migrations/021_pipeline_review.sql',
    'src/components/Settings/PipelineReview.tsx',
  ];
  const contents = await Promise.all(files.map(file => readMaybe(base, file)));
  const joined = contents.join('\n').toLowerCase();
  return {
    files,
    present: await Promise.all(files.map(file => fileExists(base, file))),
    checks: {
      failureDiagnosis: /diagnos|root cause|失败|failure|error/.test(joined),
      reviewQueue: /review|manual|queue|人工|复核/.test(joined),
      retryLoop: /retry|重试|rerun|backoff/.test(joined),
      auditTrail: /audit|history|event|记录/.test(joined),
      migration: /create table/.test(joined),
    },
  };
}

for (const artifact of artifacts) {
  const artifactDir = path.join(root, '.eval-artifacts', artifact);
  const report = path.join(evalDir, `${artifact}_light_validation.txt`);
  await writeFile(report, `Light validation report for ${artifact}\nGenerated: ${new Date().toISOString()}\n`, 'utf8');

  let fileCount = 0;
  try {
    fileCount = await countFiles(artifactDir);
  } catch {
    fileCount = 0;
  }
  await appendFile(report, `Artifact: ${artifactDir}\nFile count: ${fileCount}\n`, 'utf8');

  if (fileCount === 0) {
    await appendFile(report, '\n===== SUMMARY =====\ndownload/extract: FAIL\n', 'utf8');
    console.log(`${artifact}: download/extract -> FAIL`);
    continue;
  }

  const results = {
    typecheck: await runStep({ artifact, cwd: artifactDir, report, label: 'npm run typecheck', command: 'npm.cmd', args: ['run', 'typecheck'] }),
    test: await runStep({ artifact, cwd: artifactDir, report, label: 'npm run test', command: 'npm.cmd', args: ['run', 'test'] }),
    build: await runStep({ artifact, cwd: artifactDir, report, label: 'npm run build', command: 'npm.cmd', args: ['run', 'build'], timeoutMs: 240_000 }),
  };
  const inspection = artifact.startsWith('PWVLRG') ? await inspectTaskA(artifactDir) : await inspectTaskB(artifactDir);
  await appendFile(report, `\n===== IMPLEMENTATION INSPECTION =====\n${JSON.stringify(inspection, null, 2)}\n`, 'utf8');
  await appendFile(report, '\n===== SUMMARY =====\n', 'utf8');
  for (const [key, code] of Object.entries(results)) {
    await appendFile(report, `${key}: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code})\n`, 'utf8');
  }
  const presentCount = inspection.present.filter(Boolean).length;
  const checkCount = Object.values(inspection.checks).filter(Boolean).length;
  await appendFile(report, `key files: ${presentCount}/${inspection.files.length}\nkeyword coverage: ${checkCount}/${Object.keys(inspection.checks).length}\n`, 'utf8');
}
