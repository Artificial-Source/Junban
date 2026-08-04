#!/usr/bin/env node
/** Pinned build-only TypeScript consumer; Node is never a product runtime. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? "--check";
if (!new Set(["--build", "--check", "--check-bindings"]).has(mode)) {
  console.error(`unsupported mode: ${mode}`);
  process.exit(2);
}
const jco = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "jco.cmd" : "jco");
const temporary = mkdtempSync(join(tmpdir(), "junban-ts-consumer-"));
const generated = join(temporary, "generated");
const component = join(temporary, "typescript-consumer.wasm");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
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
  if (!sameTree(generated, join(root, "generated"))) {
    console.error("generated TypeScript bindings drifted");
    process.exit(1);
  }
  if (mode !== "--check-bindings") {
    run(jco, [
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
    // ComponentizeJS/Wizer output is not byte reproducible. Check mode instead
    // proves that the fresh source build has the exact retained Component Model
    // import/export/type structure; ordinary SDK tests consume the hash-pinned
    // retained artifact.
    if (mode === "--build") {
      copyFileSync(component, retained);
    } else if (capture(jco, ["wit", component]) !== capture(jco, ["wit", retained])) {
      console.error("fresh TypeScript component structure drifted from the retained authority");
      process.exit(1);
    }
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
