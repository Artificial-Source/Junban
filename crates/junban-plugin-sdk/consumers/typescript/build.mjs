#!/usr/bin/env node
/** Reproducible build-only TypeScript consumer; Node is never a product runtime. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? "--build";
const jco = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "jco.cmd" : "jco");
const temporary = mkdtempSync(join(tmpdir(), "junban-ts-consumer-"));
const generated = join(temporary, "generated");
const component = join(temporary, "typescript-consumer.wasm");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function componentize(args) {
  // jco 1.26.1 declares ^0.21 internally. The package override pins that edge
  // to the separately accepted 0.22.0; tolerate an old install while checking
  // by temporarily exposing the pinned top-level package to Node resolution.
  const nested = join(
    root,
    "node_modules",
    "@bytecodealliance",
    "jco",
    "node_modules",
    "@bytecodealliance",
    "componentize-js",
  );
  const hidden = join(temporary, "componentize-js-old");
  if (existsSync(nested)) renameSync(nested, hidden);
  try {
    run(jco, args);
  } finally {
    if (existsSync(hidden)) renameSync(hidden, nested);
  }
}
function files(path, prefix = "") {
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = join(prefix, entry.name);
      return entry.isDirectory() ? files(join(path, entry.name), relative) : [relative];
    })
    .sort();
}
function canonicalGenerated(path) {
  return readFileSync(path, "utf8").replace(/[ \t]+$/gm, "");
}
function sameTree(left, right) {
  const names = files(left);
  return (
    JSON.stringify(names) === JSON.stringify(files(right)) &&
    names.every(
      (name) => canonicalGenerated(join(left, name)) === canonicalGenerated(join(right, name)),
    )
  );
}

try {
  run(jco, [
    "guest-types",
    "wit",
    "-n",
    "typescript-consumer",
    "-o",
    generated,
    "--strict",
    "--quiet",
  ]);
  if (mode === "--generate-only") {
    console.error(
      "Use scripts/check-phase7-sdk-consumers.py --regenerate to update retained authorities.",
    );
    process.exit(2);
  }
  if (!sameTree(generated, join(root, "generated"))) {
    console.error("generated TypeScript bindings drifted");
    process.exit(1);
  }
  if (mode !== "--check-bindings") {
    componentize([
      "componentize",
      "src/consumer.ts",
      "--wit",
      "wit",
      "-n",
      "typescript-consumer",
      "--disable",
      "all",
      "-o",
      component,
    ]);
    const bytes = readFileSync(component);
    const retained = join(root, "artifacts", "typescript-consumer.wasm");
    // ComponentizeJS/Wizer output is not byte reproducible. Check mode compiles
    // and later structurally inspects a fresh candidate while ordinary SDK tests
    // consume the exact hash-pinned retained artifact.
    if (mode === "--build") copyFileSync(component, retained);
    console.log(
      JSON.stringify({
        sizeBytes: statSync(component).size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        jco: "1.26.1",
        componentizeJs: "0.22.0",
        wasi: "disabled-all",
      }),
    );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
