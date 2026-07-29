import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export interface ServerContext {
  baseUrl: string;
  token: string;
  dataDir: string;
  cleanup: () => void;
}

const HOST = "127.0.0.1";
const PORT = 4299;
const TOKEN = "test-deterministic-token-for-phase-1-visual-baseline-verification";

/**
 * Start the optimized Rust server with a private temp profile and deterministic token.
 * Seeds the five documented tasks via the real API before returning.
 * Returns a cleanup function that kills the server and removes the temp directory.
 */
export async function startServer(options: { seed?: boolean } = {}): Promise<ServerContext> {
  const dataDir = mkdtempSync(join(tmpdir(), `junban-e2e-${randomUUID()}-`));
  const distDir = join(process.cwd(), "dist");

  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error("dist/index.html not found — run `pnpm build` first");
  }

  // Write the deterministic token directly to the profile
  writeFileSync(join(dataDir, "access-token"), `${TOKEN}\n`, { mode: 0o600 });

  // Build the server binary if not already built
  const binaryPath = join(process.cwd(), "target", "release", "junban-server");
  if (!existsSync(binaryPath)) {
    throw new Error("junban-server release binary not found — run `cargo build --release` first");
  }

  const child = spawn(
    binaryPath,
    ["--bind", `${HOST}:${PORT}`, "--data-dir", dataDir, "--web-dir", distDir],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: "warn" },
    },
  );

  let stderrBuffer = "";
  child.stderr?.on("data", (data) => {
    stderrBuffer += data.toString();
  });

  // Wait for server to be ready
  const baseUrl = `http://${HOST}:${PORT}`;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!ready) {
    child.kill("SIGKILL");
    throw new Error(`Server failed to start. stderr: ${stderrBuffer}`);
  }

  // Seed tasks if requested
  if (options.seed !== false) {
    await seedTasks(baseUrl, TOKEN);
  }

  const cleanup = () => {
    try {
      child.kill("SIGTERM");
      // Give it a moment to shut down gracefully
      child.kill("SIGKILL");
    } catch {
      // Already dead
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  return { baseUrl, token: TOKEN, dataDir, cleanup };
}

/**
 * Seed the five documented Phase 1 tasks via the real API.
 * Tasks match the visual baseline README.
 */
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
      headers: {
        ...headers,
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(task),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to seed task "${task.title}": ${response.status} ${text}`);
    }
  }

  // Complete the last task ("Completed setup checklist")
  const listResponse = await fetch(`${baseUrl}/api/v1/tasks`, { headers });
  const list = (await listResponse.json()) as { tasks: Array<{ id: string; title: string }> };
  const checklistTask = list.tasks.find((t) => t.title === "Completed setup checklist");
  if (checklistTask) {
    await fetch(`${baseUrl}/api/v1/tasks/${checklistTask.id}/complete`, {
      method: "POST",
      headers: {
        ...headers,
        "Idempotency-Key": randomUUID(),
      },
    });
  }
}

/**
 * Navigate to the app with the token in the URL fragment.
 * The app will save it to sessionStorage and scrub the fragment.
 */
export function appUrlWithToken(baseUrl: string, token: string, path: string = "/"): string {
  return `${baseUrl}${path}#access_token=${token}`;
}
