import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Isolated Playwright config for Phase 3 legacy visual-authority capture.
 *
 * Runs against a fixed Junban-legacy checkout. Never touches rewrite product
 * code or developer/packaged data. Disposable DB + synthetic token only.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const LEGACY_ROOT =
  process.env.JUNBAN_LEGACY_ROOT ?? path.resolve(REPO_ROOT, "..", "Junban-legacy");
const OUTPUT_DIR =
  process.env.PHASE3_VISUAL_OUT ??
  path.join(REPO_ROOT, "goals/rust-rewrite/evidence/phase-3-visual-baseline");

const SCREENSHOT_API_TOKEN =
  process.env.SCREENSHOT_API_TOKEN ?? "junban-phase3-visual-baseline-token";
const SCREENSHOT_API_PORT = process.env.SCREENSHOT_API_PORT ?? "4879";
const VITE_PORT = process.env.SCREENSHOT_VITE_PORT ?? "5179";

const screenshotDbDirectory = path.join(
  tmpdir(),
  `junban-phase3-visual-${process.getuid?.() ?? process.pid}`,
);
mkdirSync(screenshotDbDirectory, { recursive: true, mode: 0o700 });
// mkdir mode is umask-masked; force private perms required by legacy SQLite opener.
chmodSync(screenshotDbDirectory, 0o700);
const SCREENSHOT_DB_PATH =
  process.env.SCREENSHOT_DB_PATH ?? path.join(screenshotDbDirectory, "junban.db");

// Legacy better-sqlite3 is native-built for Node 22. Callers on a different
// ambient Node may provide a portable absolute path through JUNBAN_LEGACY_NODE.
const NODE_BIN = process.env.JUNBAN_LEGACY_NODE ?? process.execPath;
if (!existsSync(NODE_BIN)) {
  throw new Error(`JUNBAN_LEGACY_NODE does not exist: ${NODE_BIN}`);
}
const nodeVersion = execFileSync(NODE_BIN, ["--version"], { encoding: "utf8" }).trim();
if (!/^v22\./.test(nodeVersion)) {
  throw new Error(
    `Phase 3 legacy capture requires Node 22, got ${nodeVersion}; set JUNBAN_LEGACY_NODE`,
  );
}

process.env.PHASE3_VISUAL_OUT = OUTPUT_DIR;
process.env.JUNBAN_LEGACY_ROOT = LEGACY_ROOT;

const webServerCommand = [
  "pnpm",
  "exec",
  "concurrently",
  "--kill-others",
  `"${NODE_BIN} scripts/run-with-profile.mjs dev --vite-env development API_PORT=${SCREENSHOT_API_PORT} ${NODE_BIN} --import tsx src/server.ts"`,
  `"${NODE_BIN} scripts/run-with-profile.mjs dev API_PORT=${SCREENSHOT_API_PORT} VITE_USE_BACKEND=true vite --host 127.0.0.1 --port ${VITE_PORT}"`,
].join(" ");

export default defineConfig({
  testDir: __dirname,
  testMatch: "capture.spec.mjs",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    extraHTTPHeaders: { Authorization: `Bearer ${SCREENSHOT_API_TOKEN}` },
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: webServerCommand,
    cwd: LEGACY_ROOT,
    env: {
      ...process.env,
      E2E_MODE: "true",
      API_TOKEN: SCREENSHOT_API_TOKEN,
      API_PORT: SCREENSHOT_API_PORT,
      DB_PATH: SCREENSHOT_DB_PATH,
    },
    url: `http://127.0.0.1:${VITE_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
