#!/usr/bin/env node
/**
 * Capture immutable Phase 7 legacy Extensions/plugin visual authorities.
 *
 * Usage (from the rewrite worktree):
 *   node scripts/capture-phase-7-legacy-visual-baseline.mjs
 *
 * Environment:
 *   JUNBAN_LEGACY_ROOT   Path to any Junban-legacy git checkout (for object access)
 *   PHASE7_VISUAL_OUT    Output directory (default evidence/phase-7-legacy-visual-baseline)
 *   PHASE7_VITE_PORT     Harness port (default 5197)
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
const HARNESS_SRC = path.join(__dirname, "phase-7-legacy-visual-baseline");
const EXPECTED_LEGACY_COMMIT = "5e2b2b5adc865f401843c5030285293c5fabccc5";
const OUT_DIR =
  process.env.PHASE7_VISUAL_OUT ??
  path.join(REPO_ROOT, "goals/rust-rewrite/evidence/phase-7-legacy-visual-baseline");
const LEGACY_ROOT =
  process.env.JUNBAN_LEGACY_ROOT ?? "/home/xn3/Projects/Personal/ASF/Junban-legacy";
const VITE_PORT = process.env.PHASE7_VITE_PORT ?? "5197";

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

function sha256Tree(rootDir) {
  /** @type {string[]} */
  const files = [];
  function walk(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  walk(rootDir);
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
    "phase7-visual-baseline-token",
    "Authorization:",
    "api.openai.com",
    "fonts.googleapis.com",
    "cdn.jsdelivr.net",
    "huggingface.co",
    "registry.npmjs.org",
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

  const parent = mkdtempSync(path.join(tmpdir(), "junban-phase7-legacy-"));
  const worktree = path.join(parent, "worktree");
  execFileSync(
    "git",
    ["-C", LEGACY_ROOT, "worktree", "add", "--detach", worktree, EXPECTED_LEGACY_COMMIT],
    { stdio: "inherit" },
  );

  const head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== EXPECTED_LEGACY_COMMIT) {
    fail(`Worktree HEAD ${head} != ${EXPECTED_LEGACY_COMMIT}`);
  }

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

function ensureTailwindSources(worktree) {
  // Vite root is the ephemeral harness directory. Tailwind v4's automatic source
  // detection therefore misses legacy components outside that root, dropping
  // utilities such as sr-only / line-clamp used only by SettingsPluginCard.
  // Keep the original legacy index.css bytes for provenance hashing via the
  // .phase7-original backup, and inject @source only into the live overlay copy.
  const indexCss = path.join(worktree, "src/ui/index.css");
  const backup = `${indexCss}.phase7-original`;
  if (existsSync(indexCss) && !existsSync(backup)) {
    cpSync(indexCss, backup);
  }
  const css = readFileSync(indexCss, "utf8");
  const marker = "/* phase7-visual-baseline-sources */";
  if (css.includes(marker)) return;
  if (!css.includes('@import "tailwindcss"')) {
    fail('legacy index.css is missing @import "tailwindcss"; cannot inject @source');
  }
  const injection = `${marker}
@source "./**/*.{js,ts,jsx,tsx,html}";
@source "../../.phase7-visual-harness/**/*.{js,ts,jsx,tsx,html}";
`;
  writeFileSync(
    indexCss,
    css.replace('@import "tailwindcss";', `@import "tailwindcss";\n${injection}`),
  );
}

function overlayHarness(worktree) {
  const dest = path.join(worktree, ".phase7-visual-harness");
  cpSync(path.join(HARNESS_SRC, "harness"), dest, { recursive: true });

  // Relative imports inside legacy components do not hit Vite alias patterns, so
  // replace the few context/api modules in the detached worktree only.
  const mockPairs = [
    ["mocks/PluginContext.tsx", "src/ui/context/PluginContext.tsx"],
    ["mocks/SettingsContext.tsx", "src/ui/context/SettingsContext.tsx"],
    ["mocks/api-index.ts", "src/ui/api/index.ts"],
    ["mocks/api-helpers.ts", "src/ui/api/helpers.ts"],
    ["mocks/PluginsTab.tsx", "src/ui/views/settings/PluginsTab.tsx"],
    ["mocks/useIsMobile.ts", "src/ui/hooks/useIsMobile.ts"],
    ["mocks/PluginBrowser.tsx", "src/ui/components/PluginBrowser.tsx"],
  ];
  const helperDirs = new Set(
    mockPairs.map(([, toRel]) => path.dirname(path.join(worktree, toRel))),
  );
  for (const dir of helperDirs) {
    cpSync(path.join(dest, "mocks/read-fixture.ts"), path.join(dir, "read-fixture.ts"));
  }
  // Plugin settings state + scenes import fixture helpers beside overlaid modules.
  cpSync(
    path.join(dest, "mocks/read-fixture.ts"),
    path.join(worktree, "src/ui/components/plugin-browser/read-fixture.ts"),
  );
  for (const [fromRel, toRel] of mockPairs) {
    const from = path.join(dest, fromRel);
    const to = path.join(worktree, toRel);
    const backup = `${to}.phase7-original`;
    if (existsSync(to) && !existsSync(backup)) {
      cpSync(to, backup);
    }
    cpSync(from, to);
  }

  ensureTailwindSources(worktree);
  return dest;
}

async function main() {
  console.log("Phase 7 legacy visual authority capture");
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
    cpSync(
      path.join(HARNESS_SRC, "capture.spec.mjs"),
      path.join(worktree, "phase7-capture.spec.mjs"),
    );
    cpSync(path.join(HARNESS_SRC, "scenes.json"), path.join(worktree, "scenes.json"));

    const pwConfig = `import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = process.env.JUNBAN_LEGACY_WORKTREE ?? __dirname;
const OUT_DIR = process.env.PHASE7_VISUAL_OUT;
const VITE_PORT = process.env.PHASE7_VITE_PORT ?? "5197";
const HARNESS = path.join(WORKTREE, ".phase7-visual-harness");

export default defineConfig({
  testDir: __dirname,
  testMatch: "phase7-capture.spec.mjs",
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
      PHASE7_VITE_PORT: String(VITE_PORT),
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
    writeFileSync(path.join(worktree, "phase7-playwright.config.mjs"), pwConfig);

    const require = createRequire(path.join(worktree, "package.json"));
    let cliPath;
    try {
      cliPath = require.resolve("@playwright/test/cli");
    } catch {
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
      [cliPath, "test", `--config=${path.join(worktree, "phase7-playwright.config.mjs")}`],
      {
        cwd: worktree,
        env: {
          ...process.env,
          JUNBAN_LEGACY_WORKTREE: worktree,
          PHASE7_VISUAL_OUT: OUT_DIR,
          PHASE7_VITE_PORT: String(VITE_PORT),
          BROWSERSLIST: "Chrome >= 120",
          NODE_PATH: [path.join(worktree, "node_modules"), process.env.NODE_PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
      },
    );

    /** @type {string[]} */
    const sourcePaths = [
      "src/ui/views/settings/PluginsTab.tsx",
      "src/ui/views/Settings.tsx",
      "src/ui/components/PermissionDialog.tsx",
      "src/ui/components/PluginBrowser.tsx",
      "src/ui/components/plugin-browser/PluginDetail.tsx",
      "src/ui/components/plugin-browser/PluginListItem.tsx",
      "src/ui/components/plugin-browser/PluginSettingsPanel.tsx",
      "src/ui/components/plugin-browser/SettingsPluginCard.tsx",
      "src/ui/components/PluginPanel.tsx",
      "src/ui/components/PluginCard.tsx",
      "src/ui/components/StatusBar.tsx",
      "src/ui/components/StructuredContentRenderer.tsx",
      "src/plugins/builtin/pomodoro/index.ts",
      "src/plugins/builtin/pomodoro/manifest.json",
      "src/ui/index.css",
      "src/ui/themes/light.css",
      "src/ui/themes/dark.css",
    ];
    // Provenance must hash the unmodified legacy bytes (*.phase7-original when overlaid).

    const sourceHashes = {};
    for (const rel of sourcePaths) {
      const abs = path.join(worktree, rel);
      const backup = `${abs}.phase7-original`;
      const hashPath = existsSync(backup) ? backup : abs;
      if (!existsSync(hashPath)) fail(`Missing legacy source ${rel}`);
      sourceHashes[rel] = sha256File(hashPath);
    }

    const harnessHash = sha256Tree(path.join(HARNESS_SRC, "harness"));
    const captureScriptHash = sha256File(
      path.join(REPO_ROOT, "scripts/capture-phase-7-legacy-visual-baseline.mjs"),
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
        clock: "2026-08-04T15:00:00.000Z",
        reducedMotion: true,
        animations: "disabled",
      });
      console.log(
        `ok  ${scene.file}  ${dims.width}x${dims.height}  sha256=${dims.sha256.slice(0, 12)}…`,
      );
    }

    const manifest = {
      version: 1,
      kind: "phase-7-legacy-visual-baseline",
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
        marketplace: "none",
        registry: "offline-fixture",
        clock: "2026-08-04T15:00:00.000Z",
        typography: "Noto Sans via system-ui fallback (Outfit network font blocked)",
      },
      capture: {
        command: "node scripts/capture-phase-7-legacy-visual-baseline.mjs",
        harness: "scripts/phase-7-legacy-visual-baseline/harness/** (ephemeral overlay)",
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
        rejects_node_vm_require_arbitrary_react:
          "Behavioral/visual authority only. Do not copy Node vm, require, archive extraction, or arbitrary guest React architecture from legacy plugins.",
      },
      authority_gaps: [
        {
          id: "legacy-react-content-type",
          disposition: "behavior-only",
          note: 'Legacy contentType:"react" guest components are deliberately rejected by Phase 7. Nearest visual authority is StructuredContentRenderer + PluginPanel declarative actions.',
        },
        {
          id: "first-party-views-not-plugins",
          disposition: "out-of-scope-for-plugin-rewrite",
          note: "Calendar, Matrix, Stats, Timeblocking, Someday, Completed, Cancelled, and Quick Wins remain first-party Phase 2/3 surfaces and are not rewrapped as plugins.",
        },
      ],
      scenes,
    };

    writeFileSync(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nWrote manifest with ${scenes.length} scenes.`);
    console.log("Phase 7 legacy visual authorities captured and verified.");
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
