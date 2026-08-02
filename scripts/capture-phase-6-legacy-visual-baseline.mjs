#!/usr/bin/env node
/**
 * Capture immutable Phase 6 legacy visual authorities.
 *
 * Usage (from the rewrite worktree):
 *   node scripts/capture-phase-6-legacy-visual-baseline.mjs
 *
 * Environment:
 *   JUNBAN_LEGACY_ROOT   Path to any Junban-legacy git checkout (for object access)
 *   PHASE6_VISUAL_OUT    Output directory (default evidence/phase-6-legacy-visual-baseline)
 *   PHASE6_VITE_PORT     Harness port (default 5196)
 *
 * Creates a clean detached temporary worktree at the pinned legacy commit, overlays
 * an ephemeral fixture harness (never committed to legacy), renders deterministic
 * React component states offline, writes PNGs + manifest, then removes the worktree.
 */

import { spawn, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HARNESS_SRC = path.join(__dirname, "phase-6-legacy-visual-baseline");
const EXPECTED_LEGACY_COMMIT = "5e2b2b5adc865f401843c5030285293c5fabccc5";
const OUT_DIR =
  process.env.PHASE6_VISUAL_OUT ??
  path.join(REPO_ROOT, "goals/rust-rewrite/evidence/phase-6-legacy-visual-baseline");
const LEGACY_ROOT =
  process.env.JUNBAN_LEGACY_ROOT ?? "/home/xn3/Projects/Personal/ASF/Junban-legacy";
const VITE_PORT = process.env.PHASE6_VITE_PORT ?? "5196";

const SCENES = JSON.parse(readFileSync(path.join(HARNESS_SRC, "scenes.json"), "utf8"));

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function sha256Tree(rootDir, relativePrefixes = [""]) {
  /** @type {string[]} */
  const files = [];
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  for (const prefix of relativePrefixes) {
    const abs = path.join(rootDir, prefix);
    if (existsSync(abs)) walk(abs, prefix);
  }
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path.join(rootDir, rel)));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), files };
}

function pngDimensions(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${filePath} is not a PNG`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function privacyScan(filePath) {
  const buf = readFileSync(filePath);
  const haystack = buf.toString("latin1");
  const banned = [
    "sk-proj-",
    "sk-ant-",
    "api_key",
    "apiKey",
    "Bearer ",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "JUNBAN_LEGACY",
    "phase6-visual-baseline-token",
    "Authorization:",
    "api.openai.com",
    "fonts.googleapis.com",
  ];
  for (const token of banned) {
    if (haystack.includes(token)) {
      throw new Error(`Privacy scan failed for ${path.basename(filePath)}: found ${token}`);
    }
  }
}

function assertNotoSans() {
  try {
    const match = execFileSync("fc-match", ["system-ui"], { encoding: "utf8" }).trim();
    if (!/Noto Sans/i.test(match)) {
      console.warn(
        `warning: fc-match system-ui => "${match}" (expected Noto Sans). Capture continues.`,
      );
    } else {
      console.log(`typography: fc-match system-ui => ${match}`);
    }
    return match;
  } catch {
    console.warn("warning: fc-match unavailable");
    return "unknown";
  }
}

function createCleanWorktree() {
  if (!existsSync(path.join(LEGACY_ROOT, ".git")) && !existsSync(LEGACY_ROOT)) {
    fail(`JUNBAN_LEGACY_ROOT does not exist: ${LEGACY_ROOT}`);
  }
  // Verify the pinned commit is reachable without checking out the main tree.
  try {
    execFileSync(
      "git",
      ["-C", LEGACY_ROOT, "cat-file", "-e", `${EXPECTED_LEGACY_COMMIT}^{commit}`],
      {
        stdio: "pipe",
      },
    );
  } catch {
    fail(`Pinned legacy commit ${EXPECTED_LEGACY_COMMIT} is not available in ${LEGACY_ROOT}`);
  }

  const parent = mkdtempSync(path.join(tmpdir(), "junban-phase6-legacy-"));
  const worktree = path.join(parent, "worktree");
  execFileSync(
    "git",
    ["-C", LEGACY_ROOT, "worktree", "add", "--detach", worktree, EXPECTED_LEGACY_COMMIT],
    { stdio: "inherit" },
  );

  // Ignore untracked .junban-builtin-* in the source checkout; worktree is clean.
  const head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== EXPECTED_LEGACY_COMMIT) {
    fail(`Worktree HEAD ${head} != ${EXPECTED_LEGACY_COMMIT}`);
  }

  // Reuse installed node_modules from the source checkout when present (same package.json pin).
  const srcModules = path.join(LEGACY_ROOT, "node_modules");
  const dstModules = path.join(worktree, "node_modules");
  if (existsSync(srcModules) && !existsSync(dstModules)) {
    symlinkSync(srcModules, dstModules, "dir");
  } else if (!existsSync(dstModules)) {
    console.log("Installing legacy dependencies in temporary worktree…");
    execFileSync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: worktree,
      stdio: "inherit",
    });
  }

  return { parent, worktree };
}

function overlayHarness(worktree) {
  // Ephemeral harness lives only in the temp worktree; never committed to legacy.
  const dest = path.join(worktree, ".phase6-visual-harness");
  cpSync(path.join(HARNESS_SRC, "harness"), dest, { recursive: true });

  // Relative imports inside legacy components do not hit Vite alias patterns, so
  // replace the few context/api modules in the detached worktree only.
  const mockPairs = [
    ["mocks/AIContext.tsx", "src/ui/context/AIContext.tsx"],
    ["mocks/AIFeatureProvider.tsx", "src/ui/context/AIFeatureProvider.tsx"],
    ["mocks/TaskContext.tsx", "src/ui/context/TaskContext.tsx"],
    ["mocks/VoiceContext.tsx", "src/ui/context/VoiceContext.tsx"],
    ["mocks/VoiceFeatureProvider.tsx", "src/ui/context/VoiceFeatureProvider.tsx"],
    ["mocks/api-ai.ts", "src/ui/api/ai.ts"],
    ["mocks/api-index.ts", "src/ui/api/index.ts"],
    ["mocks/audio-utils.ts", "src/ai/voice/audio-utils.ts"],
  ];
  // Shared helper copied beside every replaced module directory.
  const helperDirs = new Set(
    mockPairs.map(([, toRel]) => path.dirname(path.join(worktree, toRel))),
  );
  for (const dir of helperDirs) {
    cpSync(path.join(dest, "mocks/read-fixture.ts"), path.join(dir, "read-fixture.ts"));
  }
  for (const [fromRel, toRel] of mockPairs) {
    const from = path.join(dest, fromRel);
    const to = path.join(worktree, toRel);
    const backup = `${to}.phase6-original`;
    if (existsSync(to) && !existsSync(backup)) {
      cpSync(to, backup);
    }
    cpSync(from, to);
  }

  return dest;
}

async function main() {
  console.log("Phase 6 legacy visual authority capture");
  console.log(`  rewrite worktree : ${REPO_ROOT}`);
  console.log(`  legacy root      : ${LEGACY_ROOT}`);
  console.log(`  expected commit  : ${EXPECTED_LEGACY_COMMIT}`);
  console.log(`  output           : ${OUT_DIR}`);

  const fontMatch = assertNotoSans();
  mkdirSync(OUT_DIR, { recursive: true });

  const { parent, worktree } = createCleanWorktree();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      execFileSync("git", ["-C", LEGACY_ROOT, "worktree", "remove", "--force", worktree], {
        stdio: "pipe",
      });
    } catch {
      try {
        rmSync(worktree, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    const harnessDir = overlayHarness(worktree);
    // Copy playwright config + capture spec beside harness for stable paths.
    cpSync(
      path.join(HARNESS_SRC, "capture.spec.mjs"),
      path.join(worktree, "phase6-capture.spec.mjs"),
    );
    cpSync(path.join(HARNESS_SRC, "scenes.json"), path.join(worktree, "scenes.json"));
    // Rewrite playwright config to use worktree-local harness path.
    const pwConfig = `import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = process.env.JUNBAN_LEGACY_WORKTREE ?? __dirname;
const OUT_DIR = process.env.PHASE6_VISUAL_OUT;
const VITE_PORT = process.env.PHASE6_VITE_PORT ?? "5196";
const HARNESS = path.join(WORKTREE, ".phase6-visual-harness");

export default defineConfig({
  testDir: __dirname,
  testMatch: "phase6-capture.spec.mjs",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: \`http://127.0.0.1:\${VITE_PORT}\`,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    colorScheme: "light",
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    command: \`pnpm exec vite --config \${path.join(HARNESS, "vite.config.ts")} --host 127.0.0.1 --port \${VITE_PORT}\`,
    cwd: WORKTREE,
    env: {
      ...process.env,
      JUNBAN_LEGACY_WORKTREE: WORKTREE,
      PHASE6_VITE_PORT: String(VITE_PORT),
      BROWSERSLIST: "Chrome >= 120",
      NODE_PATH: [path.join(WORKTREE, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    },
    url: \`http://127.0.0.1:\${VITE_PORT}\`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
`;
    writeFileSync(path.join(worktree, "phase6-playwright.config.mjs"), pwConfig);

    // Fix harness vite root to the overlay path; JUNBAN_LEGACY_WORKTREE still points at worktree.
    const require = createRequire(path.join(worktree, "package.json"));
    let cliPath;
    try {
      cliPath = require.resolve("@playwright/test/cli");
    } catch {
      // Fall back to rewrite playwright if legacy lacks it.
      const rewriteRequire = createRequire(path.join(REPO_ROOT, "package.json"));
      try {
        cliPath = rewriteRequire.resolve("@playwright/test/cli");
      } catch {
        fail("@playwright/test is not installed in legacy or rewrite worktrees");
      }
    }

    console.log(`  worktree         : ${worktree}`);
    console.log(`  harness overlay  : ${harnessDir}`);
    console.log(`  playwright cli   : ${cliPath}`);

    await run(
      process.execPath,
      [cliPath, "test", `--config=${path.join(worktree, "phase6-playwright.config.mjs")}`],
      {
        cwd: worktree,
        env: {
          ...process.env,
          JUNBAN_LEGACY_WORKTREE: worktree,
          PHASE6_VISUAL_OUT: OUT_DIR,
          PHASE6_VITE_PORT: String(VITE_PORT),
          BROWSERSLIST: "Chrome >= 120",
          NODE_PATH: [path.join(worktree, "node_modules"), process.env.NODE_PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
      },
    );

    /** @type {string[]} */
    const sourcePaths = [
      "src/ui/components/chat/AIChatNotConfigured.tsx",
      "src/ui/components/chat/WelcomeScreen.tsx",
      "src/ui/components/chat/MessageBubble.tsx",
      "src/ui/components/chat/ChatToolResultCard.tsx",
      "src/ui/components/chat/ToolCallBadge.tsx",
      "src/ui/components/chat/ChatHistory.tsx",
      "src/ui/components/chat/VoiceButton.tsx",
      "src/ui/components/chat/ChatInput.tsx",
      "src/ui/components/VoiceCallOverlay.tsx",
      "src/ui/components/BottomNavBar.tsx",
      "src/ui/components/onboarding/StepAI.tsx",
      "src/ui/views/settings/AITab.tsx",
      "src/ui/views/settings/VoiceTab.tsx",
      "src/ui/views/AIChat.tsx",
      "src/ui/components/AIChatPanel.tsx",
      "src/ui/index.css",
      "src/ui/themes/light.css",
      "src/ui/themes/dark.css",
    ];

    const sourceHashes = {};
    for (const rel of sourcePaths) {
      const abs = path.join(worktree, rel);
      const backup = `${abs}.phase6-original`;
      const hashPath = existsSync(backup) ? backup : abs;
      if (!existsSync(hashPath)) fail(`Missing legacy source ${rel}`);
      sourceHashes[rel] = sha256File(hashPath);
    }

    const harnessHash = sha256Tree(path.join(HARNESS_SRC, "harness"));
    const captureScriptHash = sha256File(
      path.join(REPO_ROOT, "scripts/capture-phase-6-legacy-visual-baseline.mjs"),
    );
    const captureSpecHash = sha256File(path.join(HARNESS_SRC, "capture.spec.mjs"));

    /** @type {object[]} */
    const scenes = [];
    const seenIds = new Set();
    for (const scene of SCENES) {
      if (seenIds.has(scene.id)) fail(`Duplicate scene id ${scene.id}`);
      seenIds.add(scene.id);
      const filePath = path.join(OUT_DIR, scene.file);
      if (!existsSync(filePath)) fail(`Missing captured PNG ${scene.file}`);
      const dims = pngDimensions(filePath);
      if (dims.width !== scene.width || dims.height !== scene.height) {
        // Component screenshots may clip to content box; accept exact root box.
        // Root is sized to scene width/height so mismatch is an error.
        fail(
          `${scene.file} dimensions ${dims.width}x${dims.height}, expected ${scene.width}x${scene.height}`,
        );
      }
      privacyScan(filePath);
      scenes.push({
        id: scene.id,
        file: scene.file,
        width: dims.width,
        height: dims.height,
        bytes: dims.bytes,
        sha256: dims.sha256,
        theme: scene.theme,
        viewport: { width: scene.width, height: scene.height, deviceScaleFactor: 1 },
        maxDiffPixelRatio: 0.01,
        componentAuthority: scene.componentAuthority,
        testAuthority: scene.testAuthority,
        clock: "2026-08-02T15:00:00.000Z",
        reducedMotion: true,
        animations: "disabled",
      });
      console.log(
        `ok  ${scene.file}  ${dims.width}x${dims.height}  sha256=${dims.sha256.slice(0, 12)}…`,
      );
    }

    const manifest = {
      version: 1,
      kind: "phase-6-legacy-visual-baseline",
      source: {
        repository: "Artificial-Source/Junban-legacy",
        commit: EXPECTED_LEGACY_COMMIT,
        captured_at: new Date().toISOString().slice(0, 10),
        capture_host_font: fontMatch,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        browser: "playwright-chromium",
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        network: "blocked-non-local",
        providers: "none",
        microphone: "none",
        modelDownloads: "none",
        clock: "2026-08-02T15:00:00.000Z",
        typography: "Noto Sans via system-ui fallback (Outfit network font blocked)",
      },
      capture: {
        command: "node scripts/capture-phase-6-legacy-visual-baseline.mjs",
        harness: "scripts/phase-6-legacy-visual-baseline/harness/** (ephemeral overlay)",
        worktree_policy: "git worktree add --detach at pinned commit; removed after capture",
      },
      hashes: {
        capture_script_sha256: captureScriptHash,
        capture_spec_sha256: captureSpecHash,
        harness_tree_sha256: harnessHash.sha256,
        harness_files: harnessHash.files,
        legacy_sources_sha256: sourceHashes,
      },
      policy: {
        maxDiffPixelRatio: 0.01,
        immutable: true,
        rewrite_may_not_regenerate: true,
      },
      scenes,
    };

    writeFileSync(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nWrote manifest with ${scenes.length} scenes.`);
    console.log("Phase 6 legacy visual authorities captured and verified.");
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
