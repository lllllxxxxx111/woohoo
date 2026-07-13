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

function toSqliteUrl(filePath) {
  return `sqlite://${filePath.replace(/\\/g, "/")}?mode=rwc`;
}

function parseArgs(argv) {
  const defaultRunDir = path.resolve(
    workspaceRoot,
    "data/rollback-drills",
    `cross-version-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const result = {
    runDir: defaultRunDir,
    port: 18080,
    healthTimeoutMs: 30_000,
    stableBinary: null,
    candidateBinary: path.resolve(
      workspaceRoot,
      isWindows ? "server/target/debug/woohoo-server.exe" : "server/target/debug/woohoo-server",
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    switch (current) {
      case "--run-dir":
        result.runDir = path.resolve(workspaceRoot, next);
        index += 1;
        break;
      case "--port":
        result.port = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--health-timeout-ms":
        result.healthTimeoutMs = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--stable-binary":
        result.stableBinary = path.resolve(workspaceRoot, next);
        index += 1;
        break;
      case "--candidate-binary":
        result.candidateBinary = path.resolve(workspaceRoot, next);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  if (!result.stableBinary) {
    throw new Error("--stable-binary is required");
  }

  return result;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runHelper(commandArgs, extraEnv) {
  const result = spawnSync(process.execPath, [helperScript, ...commandArgs], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() || `Helper failed: ${commandArgs.join(" ")}`,
    );
  }

  return JSON.parse(result.stdout.trim());
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

function startServer(binaryPath, cwd, env, logPrefix) {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Server binary not found: ${binaryPath}`);
  }

  ensureDir(path.dirname(logPrefix));
  const stdoutPath = `${logPrefix}.stdout.log`;
  const stderrPath = `${logPrefix}.stderr.log`;
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  const child = spawn(binaryPath, [], {
    cwd,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    shell: false,
    env: {
      ...process.env,
      ...env,
    },
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
        return await response.json();
      }
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw lastError || new Error(`Health check timed out: ${healthUrl}`);
}

async function postJson(url, payload, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function seedStableData(baseUrl) {
  const seedId = Date.now().toString();
  const username = `rollback_${seedId}`;
  const email = `${username}@example.com`;
  const password = `Rollback${seedId.slice(-6)}A1`;

  const auth = await postJson(`${baseUrl}/api/auth/register`, {
    username,
    email,
    password,
  });
  const token = auth.token;

  const project = await postJson(
    `${baseUrl}/api/projects`,
    {
      name: `Rollback Drill ${seedId}`,
      description: "cross-version rollback drill",
    },
    token,
  );

  const projects = await getJson(`${baseUrl}/api/projects`, token);
  return {
    username,
    email,
    token,
    projectId: project.id,
    projectName: project.name,
    listedProjectCount: projects?.data?.length ?? 0,
  };
}

function writeReport(runDir, report) {
  const reportPath = path.join(runDir, "cross-version-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}

async function verifyProjects(baseUrl, token, expectedProjectId) {
  const projects = await getJson(`${baseUrl}/api/projects`, token);
  const ids = Array.isArray(projects?.data)
    ? projects.data.map((project) => project.id)
    : [];
  if (!ids.includes(expectedProjectId)) {
    throw new Error(`Expected project ${expectedProjectId} not found at ${baseUrl}`);
  }
  return {
    total: ids.length,
    ids,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = options.runDir;
  ensureDir(runDir);

  const databasePath = path.join(runDir, "woohoo.db");
  const databaseUrl = toSqliteUrl(databasePath);
  const runtimeManifestPath = path.join(runDir, "server-info.json");
  const stableRoot = path.resolve(options.stableBinary, "..", "..", "..");
  const candidateRoot = path.resolve(options.candidateBinary, "..", "..", "..");

  const report = {
    startedAt: new Date().toISOString(),
    runDir,
    databaseUrl,
    runtimeManifestPath,
    stableBinary: options.stableBinary,
    candidateBinary: options.candidateBinary,
    port: options.port,
  };

  let stablePid = null;
  let candidatePid = null;
  let snapshotDir = null;

  try {
    const preExistingManifest = readRuntimeManifest(runtimeManifestPath);
    if (preExistingManifest?.pid && isPidRunning(preExistingManifest.pid)) {
      report.preExistingPid = preExistingManifest.pid;
      await stopPid(preExistingManifest.pid);
    }

    const serverEnv = {
      DATABASE_URL: databaseUrl,
      PORT: String(options.port),
      RUNTIME_MANIFEST_PATH: runtimeManifestPath,
    };

    const stableStart = startServer(
      options.stableBinary,
      stableRoot,
      serverEnv,
      path.join(runDir, "stable-initial"),
    );
    stablePid = stableStart.pid;
    const stableManifest = await waitForManifest(
      runtimeManifestPath,
      stablePid,
      options.healthTimeoutMs,
    );
    const stableHealth = await waitForHealth(
      stableManifest?.healthUrl || `http://127.0.0.1:${options.port}/health`,
      options.healthTimeoutMs,
    );
    const seed = await seedStableData(stableManifest.baseUrl);
    report.stableInitial = {
      pid: stablePid,
      stdoutPath: stableStart.stdoutPath,
      stderrPath: stableStart.stderrPath,
      health: stableHealth,
      seed,
    };

    await stopPid(stablePid);
    stablePid = null;

    const snapshot = runHelper(["snapshot", "cross-version-pre-release"], {
      DATABASE_URL: databaseUrl,
    });
    snapshotDir = snapshot.snapshotDir;
    report.snapshot = snapshot;

    const candidateStart = startServer(
      options.candidateBinary,
      candidateRoot,
      serverEnv,
      path.join(runDir, "candidate"),
    );
    candidatePid = candidateStart.pid;
    const candidateManifest = await waitForManifest(
      runtimeManifestPath,
      candidatePid,
      options.healthTimeoutMs,
    );
    const candidateHealth = await waitForHealth(
      candidateManifest?.healthUrl || `http://127.0.0.1:${options.port}/health`,
      options.healthTimeoutMs,
    );
    const candidateProjects = await verifyProjects(
      candidateManifest.baseUrl,
      report.stableInitial.seed.token,
      report.stableInitial.seed.projectId,
    );
    report.candidate = {
      pid: candidatePid,
      stdoutPath: candidateStart.stdoutPath,
      stderrPath: candidateStart.stderrPath,
      health: candidateHealth,
      projects: candidateProjects,
    };

    await stopPid(candidatePid);
    candidatePid = null;

    const restore = runHelper(["restore", snapshotDir], {
      DATABASE_URL: databaseUrl,
    });
    report.restore = restore;

    const stableReturnStart = startServer(
      options.stableBinary,
      stableRoot,
      serverEnv,
      path.join(runDir, "stable-restored"),
    );
    stablePid = stableReturnStart.pid;
    const stableReturnManifest = await waitForManifest(
      runtimeManifestPath,
      stablePid,
      options.healthTimeoutMs,
    );
    const stableReturnHealth = await waitForHealth(
      stableReturnManifest?.healthUrl || `http://127.0.0.1:${options.port}/health`,
      options.healthTimeoutMs,
    );
    const restoredProjects = await verifyProjects(
      stableReturnManifest.baseUrl,
      report.stableInitial.seed.token,
      report.stableInitial.seed.projectId,
    );
    report.stableRestored = {
      pid: stablePid,
      stdoutPath: stableReturnStart.stdoutPath,
      stderrPath: stableReturnStart.stderrPath,
      health: stableReturnHealth,
      projects: restoredProjects,
    };

    report.completedAt = new Date().toISOString();
    const reportPath = writeReport(runDir, report);
    report.reportPath = reportPath;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failedAt = new Date().toISOString();
    report.error = error instanceof Error ? error.message : String(error);

    for (const pid of [stablePid, candidatePid]) {
      if (pid) {
        try {
          await stopPid(pid);
        } catch {
          // Best effort cleanup.
        }
      }
    }

    if (snapshotDir) {
      try {
        report.failureRestore = runHelper(["restore", snapshotDir], {
          DATABASE_URL: databaseUrl,
        });
      } catch (restoreError) {
        report.failureRestoreError =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
      }
    }

    const reportPath = writeReport(runDir, report);
    report.reportPath = reportPath;
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

main();
