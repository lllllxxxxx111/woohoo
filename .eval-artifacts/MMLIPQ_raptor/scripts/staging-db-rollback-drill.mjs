import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_DATABASE_URL = "sqlite://data/woohoo.db?mode=rwc";
const SNAPSHOT_ROOT = path.resolve(process.cwd(), "data/rollback-drills");

function parseDatabasePath(databaseUrl) {
  if (!databaseUrl.startsWith("sqlite://")) {
    throw new Error(`Only sqlite:// URLs are supported, got: ${databaseUrl}`);
  }

  let rawPath = databaseUrl.slice("sqlite://".length).split("?")[0];
  if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(rawPath)) {
    rawPath = rawPath.slice(1);
  }

  return path.resolve(process.cwd(), rawPath);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileVariants(dbPath) {
  return [
    { source: dbPath, name: path.basename(dbPath) },
    { source: `${dbPath}-wal`, name: `${path.basename(dbPath)}-wal` },
    { source: `${dbPath}-shm`, name: `${path.basename(dbPath)}-shm` },
  ];
}

function existingVariants(dbPath) {
  return fileVariants(dbPath).filter((entry) => fs.existsSync(entry.source));
}

function writeMetadata(snapshotDir, databaseUrl, dbPath, copiedFiles) {
  const metadata = {
    createdAt: new Date().toISOString(),
    databaseUrl,
    dbPath,
    copiedFiles,
  };
  fs.writeFileSync(
    path.join(snapshotDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
}

function readMetadata(snapshotDir) {
  const metadataPath = path.join(snapshotDir, "metadata.json");
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Snapshot metadata not found: ${metadataPath}`);
  }

  return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
}

function copyIntoSnapshot(databaseUrl, dbPath, label) {
  const files = existingVariants(dbPath);
  if (files.length === 0) {
    throw new Error(`Database file not found: ${dbPath}`);
  }

  const snapshotDir = path.join(
    SNAPSHOT_ROOT,
    `${timestamp()}-${label || "manual"}`,
  );
  ensureDir(snapshotDir);

  const copiedFiles = [];
  for (const file of files) {
    const target = path.join(snapshotDir, file.name);
    fs.copyFileSync(file.source, target);
    copiedFiles.push(file.name);
  }

  writeMetadata(snapshotDir, databaseUrl, dbPath, copiedFiles);
  return { snapshotDir, copiedFiles };
}

function restoreSnapshot(snapshotDir) {
  const metadata = readMetadata(snapshotDir);
  const dbPath = path.resolve(process.cwd(), metadata.dbPath);
  ensureDir(path.dirname(dbPath));

  const currentFiles = existingVariants(dbPath);
  let currentBackupDir = null;
  if (currentFiles.length > 0) {
    currentBackupDir = path.join(snapshotDir, `_pre_restore_${timestamp()}`);
    ensureDir(currentBackupDir);
    for (const file of currentFiles) {
      fs.copyFileSync(file.source, path.join(currentBackupDir, file.name));
    }
  }

  for (const entry of fileVariants(dbPath)) {
    if (fs.existsSync(entry.source)) {
      fs.rmSync(entry.source, { force: true });
    }
  }

  for (const fileName of metadata.copiedFiles) {
    fs.copyFileSync(path.join(snapshotDir, fileName), path.join(path.dirname(dbPath), fileName));
  }

  return { dbPath, currentBackupDir, restoredFiles: metadata.copiedFiles };
}

function printUsage() {
  console.log(`Usage:
  node scripts/staging-db-rollback-drill.mjs status
  node scripts/staging-db-rollback-drill.mjs snapshot [label]
  node scripts/staging-db-rollback-drill.mjs restore <snapshotDir>

Environment:
  DATABASE_URL   Optional, defaults to ${DEFAULT_DATABASE_URL}`);
}

function main() {
  const [command, arg] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const dbPath = parseDatabasePath(databaseUrl);

  switch (command) {
    case "status": {
      console.log(
        JSON.stringify(
          {
            databaseUrl,
            dbPath,
            existingFiles: existingVariants(dbPath).map((entry) => entry.source),
            snapshotRoot: SNAPSHOT_ROOT,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "snapshot": {
      const { snapshotDir, copiedFiles } = copyIntoSnapshot(databaseUrl, dbPath, arg);
      console.log(
        JSON.stringify(
          {
            snapshotDir,
            copiedFiles,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "restore": {
      if (!arg) {
        throw new Error("restore requires <snapshotDir>");
      }
      const { dbPath: restoredDbPath, currentBackupDir, restoredFiles } =
        restoreSnapshot(path.resolve(process.cwd(), arg));
      console.log(
        JSON.stringify(
          {
            dbPath: restoredDbPath,
            restoredFiles,
            currentBackupDir,
          },
          null,
          2,
        ),
      );
      return;
    }
    default:
      printUsage();
  }
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
