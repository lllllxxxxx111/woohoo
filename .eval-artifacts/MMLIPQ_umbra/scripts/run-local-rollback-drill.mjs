import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const isWindows = process.platform === "win32";
const workspaceRoot = process.cwd();
const helperScript = path.resolve(
  workspaceRoot,
  "scripts/staging-db-rollback-drill.mjs",
);
const defaultBinaryPath = path.resolve(
  workspaceRoot,
  isWindows ? "server/target/debug/woohoo-server.exe" : "server/target/debug/woohoo-server",
);
const defaultRuntimeManifestPath = path.resolve(
  workspaceRoot,
  "data/runtime/server-info.json",
);
const defaultHealthUrl = "http://127.0.0.1:8080/health";

function parseArgs(argv) {
  const result = {
    label: "local-drill",
    binaryPath: defaultBinaryPath,
    runtimeManifestPath: defaultRuntimeManifestPath,
    healthTimeoutMs: 30_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    switch (current) {
      case "--label":
        result.label = next;
        index += 1;
        break;
      case "--binary":
        result.binaryPath = path.resolve(workspaceRoot, next);
        index += 1;
        break;
      case "--runtime-manifest":
        result.runtimeManifestPath = path.resolve(workspaceRoot, next);
        index += 1;
        break;
      case "--health-timeout-ms":
        result.healthTimeoutMs = Number.parseInt(next, 10);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return result;
}

function runNodeScript(args) {
  const result = spawnSync(process.execPath, [helperScript, ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() || `Command failed: ${args.join(" ")}`,
    );
  }

  const stdout = result.stdout?.trim();
  if (!stdout) {
    throw new Error(`Command produced no output: ${args.join(" ")}`);
  }

  return JSON.parse(stdout);
}

function readRuntimeManifest(runtimeManifestPath) {
  if (!fs.existsSync(runtimeManifestPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(runtimeManifestPath, "utf8"));
}

function isPidRunning(pid) {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPid(pid) {
  if (!isPidRunning(pid)) {
    return;
  }

  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: workspaceRoot,
      stdio: "ignore",
    });
  } else {
    process.kill(pid, "SIGTERM");
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return;
    }
    await sleep(300);
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

function startServer(binaryPath, label) {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Server binary not found: ${binaryPath}`);
  }

  const logDir = path.resolve(workspaceRoot, "data/runtime");
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, `${label}.stdout.log`);
  const stderrPath = path.join(logDir, `${label}.stderr.log`);
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  const child = spawn(binaryPath, [], {
    cwd: workspaceRoot,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    shell: false,
    env: process.env,
  });

  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  return {
    pid: child.pid,
    stdoutPath,
    stderrPath,
  };
}

async function waitForManifest(runtimeManifestPath, expectedPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const manifest = readRuntimeManifest(runtimeManifestPath);
    if (manifest?.pid === expectedPid) {
      return manifest;
    }
    await sleep(300);
  }

  return readRuntimeManifest(runtimeManifestPath);
}

async function waitForHealth(healthUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        return await response.text();
      }
      lastError = new Error(`Unexpected status: ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw lastError || new Error(`Health check timed out: ${healthUrl}`);
}

function writeReport(snapshotDir, report) {
  const reportPath = path.join(snapshotDir, "run-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    startedAt: new Date().toISOString(),
    label: options.label,
    runtimeManifestPath: options.runtimeManifestPath,
    binaryPath: options.binaryPath,
    preExistingPid: null,
    snapshotDir: null,
    candidate: null,
    restore: null,
    restored: null,
  };

  let snapshotDir = null;
  let candidatePid = null;
  let restored = false;

  try {
    const preExistingManifest = readRuntimeManifest(options.runtimeManifestPath);
    if (preExistingManifest?.pid && isPidRunning(preExistingManifest.pid)) {
      report.preExistingPid = preExistingManifest.pid;
      await stopPid(preExistingManifest.pid);
    }

    const snapshot = runNodeScript(["snapshot", options.label]);
    snapshotDir = snapshot.snapshotDir;
    report.snapshotDir = snapshot.snapshotDir;
    report.snapshotFiles = snapshot.copiedFiles;

    const candidate = startServer(options.binaryPath, "rollback-drill.candidate");
    candidatePid = candidate.pid;
    const candidateManifest = await waitForManifest(
      options.runtimeManifestPath,
      candidate.pid,
      options.healthTimeoutMs,
    );
    const candidateHealthUrl = candidateManifest?.healthUrl || defaultHealthUrl;
    const candidateHealth = await waitForHealth(
      candidateHealthUrl,
      options.healthTimeoutMs,
    );
    report.candidate = {
      pid: candidate.pid,
      stdoutPath: candidate.stdoutPath,
      stderrPath: candidate.stderrPath,
      healthUrl: candidateHealthUrl,
      health: candidateHealth,
    };

    await stopPid(candidate.pid);
    candidatePid = null;

    const restore = runNodeScript(["restore", snapshot.snapshotDir]);
    restored = true;
    report.restore = restore;

    const restoredServer = startServer(options.binaryPath, "rollback-drill.restored");
    const restoredManifest = await waitForManifest(
      options.runtimeManifestPath,
      restoredServer.pid,
      options.healthTimeoutMs,
    );
    const restoredHealthUrl = restoredManifest?.healthUrl || defaultHealthUrl;
    const restoredHealth = await waitForHealth(
      restoredHealthUrl,
      options.healthTimeoutMs,
    );
    report.restored = {
      pid: restoredServer.pid,
      stdoutPath: restoredServer.stdoutPath,
      stderrPath: restoredServer.stderrPath,
      healthUrl: restoredHealthUrl,
      health: restoredHealth,
    };
    report.completedAt = new Date().toISOString();

    const reportPath = writeReport(snapshot.snapshotDir, report);
    report.reportPath = reportPath;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failedAt = new Date().toISOString();
    report.error = error instanceof Error ? error.message : String(error);

    if (candidatePid) {
      try {
        await stopPid(candidatePid);
      } catch {
        // Best effort cleanup.
      }
    }

    if (snapshotDir && !restored) {
      try {
        report.failureRestore = runNodeScript(["restore", snapshotDir]);
      } catch (restoreError) {
        report.failureRestoreError =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
      }
    }

    if (snapshotDir) {
      const reportPath = writeReport(snapshotDir, report);
      report.reportPath = reportPath;
    }

    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

main();
