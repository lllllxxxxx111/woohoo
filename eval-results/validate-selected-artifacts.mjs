import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const artifacts = process.argv.slice(2);
if (artifacts.length === 0) {
  console.error('Usage: node eval-results/validate-selected-artifacts.mjs <artifact>...');
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
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  await walk(dir);
  return count;
}

async function runStep({ artifact, cwd, report, label, command, args, timeoutMs = 180_000 }) {
  await appendFile(report, `\n===== ${label} =====\nStarted: ${new Date().toISOString()}\n`, 'utf8');
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        PATH: `${nodeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', chunk => appendFile(report, chunk));
    child.stderr.on('data', chunk => appendFile(report, chunk));
    child.on('error', error => appendFile(report, `ERROR: ${error.message}\n`, 'utf8'));
    child.on('close', async code => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : (code ?? 1);
      await appendFile(report, `Ended: ${new Date().toISOString()}\nEXIT_CODE=${exitCode}\n`, 'utf8');
      console.log(`${artifact}: ${label} -> ${exitCode}`);
      resolve(exitCode);
    });
  });
}

for (const artifact of artifacts) {
  const artifactDir = path.join(root, '.eval-artifacts', artifact);
  const report = path.join(evalDir, `${artifact}_validation.txt`);
  await writeFile(report, `Validation report for ${artifact}\nGenerated: ${new Date().toISOString()}\n`, 'utf8');

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

  const targetDir = path.join(evalDir, 'cargo-target', artifact);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  const results = {
    'npm run typecheck': await runStep({
      artifact,
      cwd: artifactDir,
      report,
      label: 'npm run typecheck',
      command: 'npm.cmd',
      args: ['run', 'typecheck'],
    }),
    'npm run test': await runStep({
      artifact,
      cwd: artifactDir,
      report,
      label: 'npm run test',
      command: 'npm.cmd',
      args: ['run', 'test'],
    }),
    'npm run build': await runStep({
      artifact,
      cwd: artifactDir,
      report,
      label: 'npm run build',
      command: 'npm.cmd',
      args: ['run', 'build'],
      timeoutMs: 240_000,
    }),
    'cargo check': await runStep({
      artifact,
      cwd: artifactDir,
      report,
      label: 'cargo check --manifest-path server\\Cargo.toml',
      command: 'cargo.exe',
      args: ['check', '--manifest-path', 'server\\Cargo.toml', '--target-dir', targetDir],
      timeoutMs: 300_000,
    }),
  };

  await appendFile(report, '\n===== SUMMARY =====\n', 'utf8');
  for (const [key, code] of Object.entries(results)) {
    await appendFile(report, `${key}: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code})\n`, 'utf8');
  }
}
