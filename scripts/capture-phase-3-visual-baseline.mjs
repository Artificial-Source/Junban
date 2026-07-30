#!/usr/bin/env node
/**
 * Capture the twelve immutable Phase 3 legacy visual authorities.
 *
 * Usage (from the rewrite worktree):
 *   node scripts/capture-phase-3-visual-baseline.mjs
 *
 * Environment:
 *   JUNBAN_LEGACY_ROOT   Absolute path to Junban-legacy pinned at 5e2b2b5
 *   PHASE3_VISUAL_OUT    Output directory for PNGs + (caller writes) README
 *   SCREENSHOT_API_PORT  Backend port (default 4879)
 *   SCREENSHOT_VITE_PORT Frontend port (default 5179)
 *
 * Requires: Node >=22, pnpm, Playwright Chromium, Noto Sans (system-ui).
 * Does not modify legacy product sources or rewrite React code.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HARNESS_DIR = path.join(__dirname, "phase-3-visual-baseline");
const LEGACY_ROOT =
  process.env.JUNBAN_LEGACY_ROOT ?? path.resolve(REPO_ROOT, "..", "Junban-legacy");
const OUT_DIR =
  process.env.PHASE3_VISUAL_OUT ??
  path.join(REPO_ROOT, "goals/rust-rewrite/evidence/phase-3-visual-baseline");
const EXPECTED_LEGACY_COMMIT = "5e2b2b5adc865f401843c5030285293c5fabccc5";

const REQUIRED_PNGS = [
  "calendar-day-desktop-light.png",
  "calendar-week-desktop-dark.png",
  "calendar-month-mobile-light.png",
  "matrix-desktop-nord.png",
  "plan-my-day-desktop-light.png",
  "end-of-day-desktop-dark.png",
  "weekly-review-desktop-light.png",
  "focus-mobile-light.png",
  "task-reminder-recurrence-desktop-light.png",
  "stats-smart-nudge-desktop-light.png",
  "timeblocking-day-slots-desktop-light.png",
  "timeblocking-week-desktop-dark.png",
];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function legacyCommit() {
  return execFileSync("git", ["-C", LEGACY_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function assertLegacyPin() {
  if (!existsSync(LEGACY_ROOT)) {
    fail(`JUNBAN_LEGACY_ROOT does not exist: ${LEGACY_ROOT}`);
  }
  const head = legacyCommit();
  if (head !== EXPECTED_LEGACY_COMMIT) {
    fail(`Legacy HEAD is ${head}; expected fixed authority commit ${EXPECTED_LEGACY_COMMIT}`);
  }
}

function assertNotoSans() {
  try {
    const match = execFileSync("fc-match", ["system-ui"], { encoding: "utf8" }).trim();
    if (!/Noto Sans/i.test(match)) {
      console.warn(
        `warning: fc-match system-ui => "${match}" (expected Noto Sans). Capture will proceed but may not match CI typography.`,
      );
    } else {
      console.log(`typography: fc-match system-ui => ${match}`);
    }
  } catch {
    console.warn("warning: fc-match unavailable; cannot verify Noto Sans");
  }
}

function pngDimensions(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${filePath} is not a PNG`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return {
    width,
    height,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function privacyScan(filePath) {
  // Scan uncompressed PNG textual chunks plus the full byte string for the known
  // synthetic capture token. Compressed IDAT is not OCR'd here; scene content is
  // asserted during capture to be synthetic demo copy only.
  const buf = readFileSync(filePath);
  const haystack = buf.toString("latin1");
  const bannedExact = ["junban-phase3-visual-baseline-token", "SCREENSHOT_API_TOKEN", "Bearer "];
  for (const token of bannedExact) {
    if (haystack.includes(token)) {
      throw new Error(`Privacy scan failed for ${path.basename(filePath)}: found ${token}`);
    }
  }
}

function verifyOutputs() {
  const report = [];
  for (const name of REQUIRED_PNGS) {
    const filePath = path.join(OUT_DIR, name);
    if (!existsSync(filePath)) {
      fail(`Missing required authority image: ${name}`);
    }
    const dims = pngDimensions(filePath);
    const isMobile = name.includes("mobile");
    const expected = isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    if (dims.width !== expected.width || dims.height !== expected.height) {
      fail(
        `${name} dimensions ${dims.width}x${dims.height}, expected ${expected.width}x${expected.height}`,
      );
    }
    privacyScan(filePath);
    report.push({ name, ...dims });
    console.log(
      `ok  ${name}  ${dims.width}x${dims.height}  ${dims.bytes} bytes  sha256=${dims.sha256.slice(0, 12)}…`,
    );
  }
  return report;
}

async function main() {
  console.log("Phase 3 legacy visual baseline capture");
  console.log(`  rewrite worktree : ${REPO_ROOT}`);
  console.log(`  legacy root      : ${LEGACY_ROOT}`);
  console.log(`  output           : ${OUT_DIR}`);

  assertLegacyPin();
  console.log(`  legacy commit    : ${EXPECTED_LEGACY_COMMIT}`);
  assertNotoSans();
  mkdirSync(OUT_DIR, { recursive: true });

  // Prefer the rewrite's Playwright if installed; otherwise use legacy's.
  const rewritePlaywright = path.join(REPO_ROOT, "node_modules", "@playwright", "test");
  const legacyPlaywright = path.join(LEGACY_ROOT, "node_modules", "@playwright", "test");
  let playwrightCli;
  let cwdForModules;
  if (existsSync(rewritePlaywright)) {
    playwrightCli = path.join(REPO_ROOT, "node_modules", "@playwright", "test", "cli.js");
    if (!existsSync(playwrightCli)) {
      playwrightCli = path.join(REPO_ROOT, "node_modules", "playwright", "cli.js");
    }
    cwdForModules = REPO_ROOT;
  } else if (existsSync(legacyPlaywright)) {
    playwrightCli = path.join(LEGACY_ROOT, "node_modules", "@playwright", "test", "cli.js");
    cwdForModules = LEGACY_ROOT;
  } else {
    fail("Neither rewrite nor legacy has @playwright/test installed");
  }

  // Resolve CLI via require so package exports work.
  const require = createRequire(path.join(cwdForModules, "package.json"));
  let cliPath;
  try {
    cliPath = require.resolve("@playwright/test/cli");
  } catch {
    cliPath = playwrightCli;
  }

  const configPath = path.join(HARNESS_DIR, "playwright.config.mjs");
  console.log(`  playwright cli   : ${cliPath}`);
  console.log(`  config           : ${configPath}`);

  await run(process.execPath, [cliPath, "test", `--config=${configPath}`], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      JUNBAN_LEGACY_ROOT: LEGACY_ROOT,
      PHASE3_VISUAL_OUT: OUT_DIR,
      // Ensure Node resolves playwright from the chosen install.
      NODE_PATH: [path.join(cwdForModules, "node_modules"), process.env.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });

  console.log("\nVerifying captured authorities…");
  verifyOutputs();
  console.log("\nAll twelve Phase 3 visual authorities captured and verified.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
