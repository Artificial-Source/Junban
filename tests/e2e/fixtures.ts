import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export interface ServerContext {
  baseUrl: string;
  token: string;
  dataDir: string;
  restart: () => Promise<void>;
  cleanup: () => Promise<void>;
}

const HOST = "127.0.0.1";
const PORT = 4299;
const TOKEN = "test-deterministic-token-for-phase-1-visual-baseline-verification";
const SHUTDOWN_TIMEOUT_MS = 5_000;

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onExit = () => finish(true);
    const finish = (exited: boolean) => {
      if (timeout) clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
    timeout = setTimeout(() => finish(false), timeoutMs);
  });
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGINT");
  if (await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) return;

  child.kill("SIGKILL");
  if (!(await waitForExit(child, SHUTDOWN_TIMEOUT_MS))) {
    throw new Error(`Server process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
  }
}

/**
 * Start the optimized Rust server with a private temp profile and deterministic token.
 * Seeds the five documented tasks via the real API before returning.
 */
export async function startServer(options: { seed?: boolean } = {}): Promise<ServerContext> {
  const dataDir = await mkdtemp(join(tmpdir(), `junban-e2e-${randomUUID()}-`));
  const distDir = join(process.cwd(), "dist");

  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error("dist/index.html not found — run `pnpm build` first");
  }

  const binaryPath = join(process.cwd(), "target", "release", "junban-server");
  if (!existsSync(binaryPath)) {
    throw new Error("junban-server release binary not found — run `cargo build --release` first");
  }

  await writeFile(join(dataDir, "access-token"), `${TOKEN}\n`, { mode: 0o600 });

  const baseUrl = `http://${HOST}:${PORT}`;
  let child: ChildProcess | undefined;

  const launch = async () => {
    child = spawn(
      binaryPath,
      ["--bind", `${HOST}:${PORT}`, "--data-dir", dataDir, "--web-dir", distDir],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "warn" },
      },
    );

    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/v1/health`);
        if (response.ok) return;
      } catch {
        // The process has not bound its listener yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await stopServer(child);
    throw new Error(`Server failed to start. stderr: ${stderr}`);
  };

  try {
    await launch();
    if (options.seed !== false) {
      await seedTasks(baseUrl, TOKEN);
    }
  } catch (error) {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    token: TOKEN,
    dataDir,
    restart: async () => {
      await stopServer(child);
      await launch();
    },
    cleanup: async () => {
      await stopServer(child);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Seed tasks matching the visual baseline README via the real API. */
async function seedTasks(baseUrl: string, token: string): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Origin: `http://${HOST}:${PORT}`,
  };

  const tasks = [
    { title: "Review accessibility audit findings", due_date: "2026-07-23" },
    { title: "Write release notes", due_date: "2026-07-23" },
    { title: "Update onboarding copy", due_date: "2026-07-22" },
    { title: "Buy milk", due_date: null },
    { title: "Completed setup checklist", due_date: null },
  ];

  for (const task of tasks) {
    const response = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: JSON.stringify(task),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to seed task "${task.title}": ${response.status} ${await response.text()}`,
      );
    }
  }

  const listResponse = await fetch(`${baseUrl}/api/v1/tasks`, { headers });
  const list = (await listResponse.json()) as { tasks: Array<{ id: string; title: string }> };
  const checklistTask = list.tasks.find((task) => task.title === "Completed setup checklist");
  if (checklistTask) {
    await fetch(`${baseUrl}/api/v1/tasks/${checklistTask.id}/complete`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
    });
  }
}

/** Navigate to the app with the token in the URL fragment. */
export function appUrlWithToken(baseUrl: string, token: string, path: string = "/"): string {
  return `${baseUrl}${path}#access_token=${token}`;
}
