import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR =
  process.env.PHASE6_VISUAL_OUT ??
  path.join(REPO_ROOT, "goals/rust-rewrite/evidence/phase-6-legacy-visual-baseline");
const VITE_PORT = process.env.PHASE6_VITE_PORT ?? "5196";
const WORKTREE = process.env.JUNBAN_LEGACY_WORKTREE;
if (!WORKTREE) {
  throw new Error("JUNBAN_LEGACY_WORKTREE is required");
}

process.env.PHASE6_VISUAL_OUT = OUT_DIR;

export default defineConfig({
  testDir: __dirname,
  testMatch: "capture.spec.mjs",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    colorScheme: "light",
    trace: "retain-on-failure",
    // Offline capture: no Google Fonts / provider / model network.
    serviceWorkers: "block",
  },
  webServer: {
    command: `pnpm exec vite --config ${path.join(__dirname, "harness/vite.config.ts")} --host 127.0.0.1 --port ${VITE_PORT}`,
    cwd: WORKTREE,
    env: {
      ...process.env,
      JUNBAN_LEGACY_WORKTREE: WORKTREE,
      PHASE6_VITE_PORT: String(VITE_PORT),
      // Resolve vite/react from the legacy install.
      NODE_PATH: [path.join(WORKTREE, "node_modules"), process.env.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter),
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
