#!/usr/bin/env node
/**
 * TEMPORARY Phase 7 Wave 0 TypeScript spike component build.
 * Uses exact @bytecodealliance/jco@1.26.1 and componentize-js@0.22.0.
 * Node is build-only; the resulting .wasm is executed by Wasmtime, never Node.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoGuestOut = path.resolve(root, "../../components");
const wit = path.resolve(root, "../../wit/spike-world.wit");
const source = path.resolve(root, "src/spike.js");
const outWasm = path.resolve(repoGuestOut, "typescript-spike.wasm");

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: root,
    env: process.env,
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

fs.mkdirSync(repoGuestOut, { recursive: true });

// Prefer local node_modules bins after npm/pnpm install in this directory.
const jcoJs = path.resolve(root, "node_modules/@bytecodealliance/jco/src/jco.js");
const jcoBin = path.resolve(root, "node_modules/.bin/jco");
if (!fs.existsSync(jcoBin) && !fs.existsSync(jcoJs)) {
  console.error("jco not installed; run npm install in guests/typescript-spike first");
  process.exit(2);
}

const jcoArgs = [
  "componentize",
  source,
  "--wit",
  wit,
  "-n",
  "spike",
  // Pure spike component: no WASI feature imports. Host remains deny-by-default
  // and must not grow a full WASI linker just to admit StarlingMonkey baselines.
  "--disable",
  "all",
  "-o",
  outWasm,
];

if (fs.existsSync(jcoBin)) {
  run(jcoBin, jcoArgs);
} else {
  run(process.execPath, [jcoJs, ...jcoArgs]);
}

const st = fs.statSync(outWasm);
const sha = spawnSync("sha256sum", [outWasm], { encoding: "utf8" });
console.log(
  JSON.stringify(
    {
      ok: true,
      output: outWasm,
      size_bytes: st.size,
      sha256: (sha.stdout || "").split(/\s+/)[0] || null,
      jco: "1.26.1",
      componentize_js: "0.22.0",
      note: "build-only Node; runtime is Wasmtime",
    },
    null,
    2,
  ),
);
