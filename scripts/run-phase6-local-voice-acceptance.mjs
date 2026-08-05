#!/usr/bin/env node
/**
 * Opt-in Phase 6 Wave 5 local-voice acceptance driver.
 *
 * Builds are expected beforehand (or pass --build). Never part of ordinary CI.
 *
 * Usage:
 *   node scripts/run-phase6-local-voice-acceptance.mjs
 *   node scripts/run-phase6-local-voice-acceptance.mjs --build
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(root, "goals/rust-rewrite/evidence");
const blockerPath = path.join(evidenceDir, "phase-6-wave-5-local-voice-acceptance-blocker.json");
const wantBuild = process.argv.includes("--build");

function run(command, args, env = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
}

function writeBlocker(reason, extra = {}) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    blockerPath,
    `${JSON.stringify(
      {
        id: "phase-6-local-voice",
        version: 1,
        status: "blocked",
        reason,
        at: new Date().toISOString(),
        note: "Executable harness present; acceptance not claimed.",
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
  console.error(`Wrote blocker evidence: ${blockerPath}`);
}

if (wantBuild) {
  if (run("pnpm", ["build"]) !== 0) {
    writeBlocker("pnpm build failed");
    process.exit(1);
  }
  if (run("cargo", ["build", "--locked", "--release", "-p", "junban-server"]) !== 0) {
    writeBlocker("cargo release build failed");
    process.exit(1);
  }
}

const dist = path.join(root, "dist/index.html");
const bin = path.join(root, "target/release/junban-server");
if (!existsSync(dist)) {
  writeBlocker("dist/index.html missing — run pnpm build or pass --build");
  process.exit(1);
}
if (!existsSync(bin)) {
  writeBlocker("junban-server release binary missing — cargo build --release -p junban-server");
  process.exit(1);
}

const status = run(
  "pnpm",
  ["exec", "playwright", "test", "-c", "playwright.local-voice-acceptance.config.ts"],
  { JUNBAN_LOCAL_VOICE_ACCEPTANCE: "1" },
);

if (status !== 0) {
  if (!existsSync(path.join(evidenceDir, "phase-6-wave-5-local-voice-acceptance.json"))) {
    writeBlocker("playwright acceptance exited non-zero without a pass evidence file", {
      exitStatus: status,
    });
  }
  process.exit(status);
}

console.log("Local-voice acceptance passed. Evidence:");
console.log("  goals/rust-rewrite/evidence/phase-6-wave-5-local-voice-acceptance.json");
process.exit(0);
