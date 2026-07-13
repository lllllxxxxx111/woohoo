import { spawn } from "node:child_process";
import process from "node:process";

const isWindows = process.platform === "win32";

function spawnCommand(command, args, label) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`[${label}] failed to start:`, error);
  });

  return child;
}

const commands = [
  {
    command: isWindows ? "cargo.exe" : "cargo",
    args: ["run", "--manifest-path", "server/Cargo.toml"],
    label: "server",
  },
  {
    command: isWindows ? "npm.cmd" : "npm",
    args: ["run", "dev:client"],
    label: "client",
  },
];

const children = commands.map((entry) =>
  spawnCommand(entry.command, entry.args, entry.label),
);

let shuttingDown = false;

function stopChild(child) {
  if (!child || child.killed) {
    return;
  }

  if (isWindows && child.pid) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
    });
    return;
  }

  child.kill("SIGTERM");
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    stopChild(child);
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 200);
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const exitCode = typeof code === "number" ? code : 1;
    const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
    console.error(`[dev-all] child exited with ${reason}`);
    shutdown(exitCode);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
