import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const sidecarDir = path.join(rootDir, "src-tauri", "gen", "sidecar");
const backendDir = path.join(sidecarDir, "backend");
const backendMigrationsDir = path.join(backendDir, "db", "migrations");
const nodeModulesDir = path.join(sidecarDir, "node_modules");
const binariesDir = path.join(rootDir, "src-tauri", "binaries");
const removablePnpmPackagePrefixes = ["sharp@", "@img+sharp-", "@img+sharp-libvips-"];
const SIDECAR_START_TIMEOUT_MS = 20000;
const SIDECAR_RETRY_DELAY_MS = 200;
const MIGRATIONS_TABLE = "__drizzle_migrations";
const LEGACY_PROJECT_ID = "legacy-project";
const LEGACY_TASK_ID = "legacy-task";
const HEALTH_RESPONSE = {
  ok: true,
  service: "junban-backend",
  runtime: "node",
};

function detectTargetTriple() {
  const { platform, arch } = process;

  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
  if (platform === "win32" && arch === "ia32") return "i686-pc-windows-msvc";

  throw new Error(`Unsupported Tauri sidecar platform: ${platform} ${arch}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertExists(targetPath, description) {
  assert(fs.existsSync(targetPath), `${description} is missing: ${targetPath}`);
}

function assertNotExists(targetPath, description) {
  assert(!fs.existsSync(targetPath), `${description} should not exist: ${targetPath}`);
}

function collectFiles(targetDir, matcher, collected = []) {
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const entryPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      collectFiles(entryPath, matcher, collected);
      continue;
    }

    if (entry.isFile() && matcher(entryPath, entry)) {
      collected.push(entryPath);
    }
  }

  return collected;
}

function getSidecarBinaryPath() {
  const extension = process.platform === "win32" ? ".exe" : "";
  return path.join(binariesDir, `junban-node-${detectTargetTriple()}${extension}`);
}

function getBetterSqliteBindingPaths() {
  const packageDir = fs.realpathSync(path.join(nodeModulesDir, "better-sqlite3"));
  return collectFiles(
    packageDir,
    (entryPath, entry) => entry.name === "better_sqlite3.node" && entryPath.endsWith(".node"),
  );
}

function createTempRuntimePaths() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junban-sidecar-"));
  const runtimePaths = {
    tempRoot,
    dbPath: path.join(tempRoot, "junban.db"),
    markdownPath: path.join(tempRoot, "tasks"),
    pluginDir: path.join(tempRoot, "plugins"),
  };

  fs.mkdirSync(runtimePaths.markdownPath, { recursive: true });
  fs.mkdirSync(runtimePaths.pluginDir, { recursive: true });

  return runtimePaths;
}

function getOutputText(chunks) {
  return Buffer.concat(chunks).toString("utf8").trim();
}

function formatFailureContext(stdoutChunks, stderrChunks) {
  const stdout = getOutputText(stdoutChunks);
  const stderr = getOutputText(stderrChunks);
  const sections = [];

  if (stdout) {
    sections.push(`stdout:\n${stdout}`);
  }

  if (stderr) {
    sections.push(`stderr:\n${stderr}`);
  }

  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

async function reservePort() {
  const { createServer } = await import("node:net");

  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine reserved sidecar port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitMigrationStatements(sql) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function readPreparedMigrationJournal() {
  return JSON.parse(fs.readFileSync(path.join(backendMigrationsDir, "meta", "_journal.json"), "utf8"));
}

async function seedLegacySchemafulDbWithoutLedger(dbPath) {
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(dbPath);
  const migrationJournal = readPreparedMigrationJournal();

  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    for (const entry of migrationJournal.entries) {
      const sql = fs.readFileSync(path.join(backendMigrationsDir, `${entry.tag}.sql`), "utf8");

      for (const statement of splitMigrationStatements(sql)) {
        sqlite.exec(statement);
      }
    }

    sqlite
      .prepare(
        `INSERT INTO projects (id, name, color, icon, sort_order, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(LEGACY_PROJECT_ID, "Legacy Upgrade Project", "#3b82f6", null, 0, 0, "2026-01-01T00:00:00.000Z");

    sqlite
      .prepare(
        `INSERT INTO tasks (
          id, title, description, status, priority, due_date, due_time, completed_at,
          project_id, recurrence, sort_order, estimated_minutes, actual_minutes, deadline,
          is_someday, dread_level, section_id, parent_id, remind_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        LEGACY_TASK_ID,
        "Legacy Upgrade Task",
        "Seeded before sidecar startup",
        "pending",
        2,
        null,
        0,
        null,
        LEGACY_PROJECT_ID,
        null,
        0,
        null,
        null,
        null,
        0,
        3,
        null,
        null,
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
  } finally {
    sqlite.close();
  }
}

async function assertLegacyUpgradeResult(dbPath) {
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(dbPath, { readonly: true });
  const migrationJournal = readPreparedMigrationJournal();

  try {
    const migrationRow = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM "${MIGRATIONS_TABLE}"`)
      .get();
    assert(
      Number(migrationRow?.count ?? 0) === migrationJournal.entries.length,
      "Legacy upgrade smoke run must backfill the full migration ledger",
    );

    const taskRow = sqlite
      .prepare("SELECT title, description FROM tasks WHERE id = ?")
      .get(LEGACY_TASK_ID);
    assert(taskRow?.title === "Legacy Upgrade Task", "Legacy upgrade smoke run must preserve seeded task data");
    assert(
      taskRow?.description === "Seeded before sidecar startup",
      "Legacy upgrade smoke run must preserve seeded task description",
    );
  } finally {
    sqlite.close();
  }
}

function assertHealthPayload(payload) {
  assert(payload && typeof payload === "object", "Health response must be a JSON object");

  for (const [key, expectedValue] of Object.entries(HEALTH_RESPONSE)) {
    assert(
      payload[key] === expectedValue,
      `Health response field ${key} must be ${JSON.stringify(expectedValue)}, received ${JSON.stringify(payload[key])}`,
    );
  }
}

async function terminateSidecar(child, exitPromise, hasExited) {
  if (hasExited()) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await Promise.race([exitPromise, delay(5000).then(() => null)]);

  if (exited === null) {
    child.kill("SIGKILL");
    await exitPromise;
  }
}

async function smokeExecutePreparedBackend(sidecarBinaryPath, options = {}) {
  const { label = "fresh-db", seedLegacyDb = false } = options;
  const runtimePaths = createTempRuntimePaths();
  const apiPort = await reservePort();
  const stdoutChunks = [];
  const stderrChunks = [];
  const serverEntryPath = path.join(backendDir, "server.js");

  if (seedLegacyDb) {
    await seedLegacySchemafulDbWithoutLedger(runtimePaths.dbPath);
  }

  const child = spawn(sidecarBinaryPath, [serverEntryPath], {
    cwd: sidecarDir,
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      STORAGE_MODE: "sqlite",
      DB_PATH: runtimePaths.dbPath,
      MARKDOWN_PATH: runtimePaths.markdownPath,
      PLUGIN_DIR: runtimePaths.pluginDir,
      LOG_LEVEL: "info",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  let spawnError = null;
  let exitResult = null;
  const exitPromise = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });
  const hasExited = () => spawnError !== null || exitResult !== null;

  try {
    const startedAt = Date.now();
    let lastError = null;
    const healthUrl = `http://127.0.0.1:${apiPort}/api/health`;

    while (Date.now() - startedAt < SIDECAR_START_TIMEOUT_MS) {
      if (spawnError) {
        throw new Error(
          `Prepared sidecar failed to spawn during ${label}: ${spawnError.message}${formatFailureContext(stdoutChunks, stderrChunks)}`,
        );
      }

      if (hasExited()) {
        const { code, signal } = await exitPromise;
        throw new Error(
          `Prepared sidecar exited before health became ready during ${label} (code=${String(code)}, signal=${String(signal)})${formatFailureContext(stdoutChunks, stderrChunks)}`,
        );
      }

      try {
        const response = await fetch(healthUrl);
        if (!response.ok) {
          lastError = new Error(`Health check returned HTTP ${response.status}`);
        } else {
          const payload = await response.json();
          assertHealthPayload(payload);

          if (seedLegacyDb) {
            await assertLegacyUpgradeResult(runtimePaths.dbPath);
          }

          return;
        }
      } catch (error) {
        lastError = error;
      }

      await delay(SIDECAR_RETRY_DELAY_MS);
    }

    throw new Error(
      `Prepared sidecar did not satisfy /api/health within ${SIDECAR_START_TIMEOUT_MS}ms during ${label}${
        lastError instanceof Error ? `: ${lastError.message}` : ""
      }${formatFailureContext(stdoutChunks, stderrChunks)}`,
    );
  } finally {
    await terminateSidecar(child, exitPromise, hasExited);
    fs.rmSync(runtimePaths.tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  assertExists(sidecarDir, "Prepared sidecar directory");
  assertExists(backendDir, "Compiled backend directory");
  assertExists(nodeModulesDir, "Deployed sidecar node_modules directory");

  const backendPackageJsonPath = path.join(backendDir, "package.json");
  assertExists(backendPackageJsonPath, "Backend package.json");

  const backendPackageJson = JSON.parse(fs.readFileSync(backendPackageJsonPath, "utf8"));
  assert(backendPackageJson.type === "module", "Backend package.json must set type=module");

  assertExists(path.join(backendDir, "server.js"), "Compiled sidecar server entry");
  assertExists(path.join(backendMigrationsDir, "meta", "_journal.json"), "Copied migration journal");

  const migrationJournal = readPreparedMigrationJournal();
  for (const entry of migrationJournal.entries) {
    assertExists(
      path.join(backendMigrationsDir, `${entry.tag}.sql`),
      `Copied migration SQL for ${entry.tag}`,
    );
  }

  assertExists(path.join(nodeModulesDir, "better-sqlite3", "package.json"), "Deployed better-sqlite3 package");
  const betterSqliteBindings = getBetterSqliteBindingPaths();
  assert(betterSqliteBindings.length > 0, "Deployed better-sqlite3 native binding");
  assertExists(path.join(nodeModulesDir, "hono", "package.json"), "Deployed hono package");
  assertNotExists(path.join(nodeModulesDir, "sharp"), "Pruned sharp top-level package");

  const pnpmDir = path.join(nodeModulesDir, ".pnpm");
  if (fs.existsSync(pnpmDir)) {
    const staleSharpPackages = fs
      .readdirSync(pnpmDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          removablePnpmPackagePrefixes.some((prefix) => entry.name.startsWith(prefix)),
      )
      .map((entry) => entry.name);

    assert(
      staleSharpPackages.length === 0,
      `Bundling-incompatible sharp packages still present: ${staleSharpPackages.join(", ")}`,
    );
  }

  const sidecarBinaryPath = getSidecarBinaryPath();
  assertExists(sidecarBinaryPath, "Prepared sidecar binary");
  assert(fs.statSync(sidecarBinaryPath).size > 0, "Prepared sidecar binary must not be empty");

  if (process.platform !== "win32") {
    assert((fs.statSync(sidecarBinaryPath).mode & 0o111) !== 0, "Sidecar binary must be executable");
  }

  await smokeExecutePreparedBackend(sidecarBinaryPath, { label: "fresh-db" });
  await smokeExecutePreparedBackend(sidecarBinaryPath, {
    label: "legacy-ledgerless-upgrade",
    seedLegacyDb: true,
  });

  console.log("Tauri sidecar smoke validation passed.");
}

await main();
