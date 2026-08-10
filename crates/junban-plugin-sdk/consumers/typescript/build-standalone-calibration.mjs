#!/usr/bin/env node
/** Build/check the non-shipped pure TypeScript Slice 2E calibration component. */
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? "--check";
if (!new Set(["--build", "--check"]).has(mode)) {
  console.error(`unsupported mode: ${mode}`);
  process.exit(2);
}
const jco = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "jco.cmd" : "jco");
const temporary = mkdtempSync(join(tmpdir(), "junban-ts-standalone-"));
const component = join(temporary, "typescript-standalone-calibration.wasm");
const retained = join(root, "artifacts", "typescript-standalone-calibration.wasm");
const provenancePath = join(root, "standalone-calibration-provenance.json");

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return capture ? result.stdout : "";
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function componentStructure(path) {
  return run(jco, ["wit", path], true);
}
function importNames(wit) {
  return wit
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import "))
    .map((line) => line.slice("import ".length, -1))
    .sort();
}
function provenance(path) {
  const bytes = readFileSync(path);
  return {
    schemaVersion: 1,
    calibrationOnly: true,
    shipped: false,
    authority: "crates/junban-plugin-sdk/wit/plugin.wit",
    witSha256: sha256(readFileSync(join(root, "../../wit/plugin.wit"))),
    source: "crates/junban-plugin-sdk/consumers/typescript/src/standalone-calibration.ts",
    artifact:
      "crates/junban-plugin-sdk/consumers/typescript/artifacts/typescript-standalone-calibration.wasm",
    jco: "1.26.1",
    componentizeJs: "0.22.0",
    wasi: "--disable all",
    byteReproducible: false,
    sizeBytes: statSync(path).size,
    sha256: sha256(bytes),
    imports: ["junban:plugin/types@0.1.0"],
    exports: ["junban:plugin/guest@0.1.0"],
  };
}
function formattedProvenance(path) {
  return `${JSON.stringify(provenance(path), null, 2)
    .replace(/"imports": \[\n\s+"([^"]+)"\n\s+\]/, '"imports": ["$1"]')
    .replace(/"exports": \[\n\s+"([^"]+)"\n\s+\]/, '"exports": ["$1"]')}\n`;
}

try {
  if (run(jco, ["--version"], true).trim() !== "1.26.1") {
    console.error("expected jco 1.26.1");
    process.exit(1);
  }
  run(jco, [
    "componentize",
    "src/standalone-calibration.ts",
    "--wit",
    "wit",
    "-n",
    "typescript-standalone-calibration",
    "--disable",
    "all",
    "-o",
    component,
  ]);
  const structure = componentStructure(component);
  if (JSON.stringify(importNames(structure)) !== JSON.stringify(["junban:plugin/types@0.1.0"])) {
    console.error("standalone calibration component gained a capability or WASI import");
    process.exit(1);
  }
  if (statSync(component).size > 32 * 1024 * 1024) {
    console.error("standalone calibration component exceeds the 32 MiB component ceiling");
    process.exit(1);
  }
  if (mode === "--build") {
    copyFileSync(component, retained);
    writeFileSync(provenancePath, formattedProvenance(retained), "utf8");
  } else {
    if (structure !== componentStructure(retained)) {
      console.error("fresh standalone calibration component structure drifted");
      process.exit(1);
    }
    const expected = formattedProvenance(retained);
    if (readFileSync(provenancePath, "utf8") !== expected) {
      console.error("standalone calibration provenance drifted");
      process.exit(1);
    }
  }
  console.log(JSON.stringify(provenance(mode === "--build" ? retained : component)));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
