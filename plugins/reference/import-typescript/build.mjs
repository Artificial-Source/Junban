#!/usr/bin/env node
/** Pinned author-only build; Node is never a Junban or component runtime. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const root = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? "--check";
if (mode !== "--build" && mode !== "--check") {
  console.error(`unsupported mode: ${mode}`);
  process.exit(2);
}

const jco = resolve(root, "node_modules", "@bytecodealliance", "jco", "dist", "jco.js");
const componentize = resolve(
  root,
  "node_modules",
  "@bytecodealliance",
  "componentize-js",
  "src",
  "cli.js",
);
const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");
const temporary = mkdtempSync(join(tmpdir(), "junban-import-typescript-"));
const freshGenerated = join(temporary, "generated");
const freshComponent = join(temporary, "import-typescript.wasm");
const retainedComponent = join(root, "artifacts", "import-typescript.wasm");
const provenancePath = join(root, "component-provenance.json");

const NODE_VERSION = "24.13.1";
const NPM_VERSION = "11.18.0";
const TYPESCRIPT_VERSION = "6.0.3";
const JCO_VERSION = "1.26.1";
const COMPONENTIZE_JS_VERSION = "0.22.0";
const FROZEN_PLUGIN_WIT_SHA256 = "5705801973219a0e6981693653f2caefdf1090345b65494750c8d8a9bf4b15f4";
const LOCAL_WORLD_WIT_SHA256 = "f39df9cdcd7cd9c582526c5aac0b113231cc93abfe72dc618b2eeaf961a79753";
const EXPECTED_COMPONENT_WIT = `package root:component;

world root {
  import junban:plugin/types@0.1.0;

  export junban:plugin/guest@0.1.0;
}
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runTool(tool, args) {
  run(process.execPath, [tool, ...args]);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.replaceAll("\r\n", "\n");
}

function captureTool(tool, args) {
  return capture(process.execPath, [tool, ...args]);
}

function requireVersion(actual, expected, tool) {
  if (actual !== expected) {
    console.error(`expected ${tool} ${expected}, received ${actual}`);
    process.exit(1);
  }
}

function checkToolchain() {
  requireVersion(process.version, `v${NODE_VERSION}`, "Node.js");

  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    console.error("npm_execpath is required to verify the invoking npm CLI");
    process.exit(1);
  }
  requireVersion(capture(process.execPath, [npmCli, "--version"]).trim(), NPM_VERSION, "npm");
  requireVersion(
    captureTool(tsc, ["--version"]).trim(),
    `Version ${TYPESCRIPT_VERSION}`,
    "TypeScript",
  );
  requireVersion(captureTool(jco, ["--version"]).trim(), JCO_VERSION, "@bytecodealliance/jco");
  requireVersion(
    captureTool(componentize, ["--version"]).trim(),
    COMPONENTIZE_JS_VERSION,
    "@bytecodealliance/componentize-js",
  );
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

async function formatGeneratedTree(path) {
  for (const name of files(path)) {
    const file = join(path, name);
    writeFileSync(
      file,
      await format(readFileSync(file, "utf8"), {
        parser: "typescript",
        semi: true,
        singleQuote: false,
        trailingComma: "all",
        printWidth: 100,
      }),
    );
  }
}

function assertHash(path, expected, label) {
  if (sha256(readFileSync(path)) !== expected) {
    console.error(`${label} drifted`);
    process.exit(1);
  }
}

function inspectComponent(path) {
  const wit = `${captureTool(jco, ["wit", path]).trimEnd()}\n`;
  if (wit !== EXPECTED_COMPONENT_WIT) {
    console.error("component import/export structure drifted");
    process.stderr.write(wit);
    process.exit(1);
  }
}

function componentIdentity(path) {
  const bytes = readFileSync(path);
  return { sizeBytes: bytes.length, sha256: sha256(bytes) };
}

try {
  checkToolchain();

  assertHash(
    join(root, "wit", "deps", "junban-plugin", "plugin.wit"),
    FROZEN_PLUGIN_WIT_SHA256,
    "frozen junban:plugin WIT",
  );
  assertHash(join(root, "wit", "world.wit"), LOCAL_WORLD_WIT_SHA256, "local world WIT");

  runTool(jco, [
    "guest-types",
    "wit",
    "-n",
    "reference-import-typescript",
    "-o",
    freshGenerated,
    "--strict",
    "--quiet",
  ]);

  await formatGeneratedTree(freshGenerated);
  const retainedGenerated = join(root, "generated");
  if (mode === "--build") {
    rmSync(retainedGenerated, { recursive: true, force: true });
    cpSync(freshGenerated, retainedGenerated, { recursive: true });
  } else if (!sameTree(freshGenerated, retainedGenerated)) {
    console.error("generated strict TypeScript bindings drifted");
    process.exit(1);
  }

  runTool(tsc, ["--project", "tsconfig.json"]);
  runTool(jco, [
    "componentize",
    "src/plugin.ts",
    "--wit",
    "wit",
    "-n",
    "reference-import-typescript",
    "--disable",
    "all",
    "-o",
    freshComponent,
  ]);
  inspectComponent(freshComponent);

  if (mode === "--build") {
    mkdirSync(dirname(retainedComponent), { recursive: true });
    cpSync(freshComponent, retainedComponent);
    const retained = componentIdentity(retainedComponent);
    const provenance = {
      schemaVersion: 1,
      artifact: "artifacts/import-typescript.wasm",
      sizeBytes: retained.sizeBytes,
      sha256: retained.sha256,
      sourceWitSha256: FROZEN_PLUGIN_WIT_SHA256,
      worldWitSha256: LOCAL_WORLD_WIT_SHA256,
      node: NODE_VERSION,
      npm: NPM_VERSION,
      typescript: TYPESCRIPT_VERSION,
      jco: JCO_VERSION,
      componentizeJs: COMPONENTIZE_JS_VERSION,
      wasi: "disabled-all",
      imports: ["junban:plugin/types@0.1.0"],
      exports: ["junban:plugin/guest@0.1.0"],
      reproducibility: "structural-not-byte",
    };
    writeFileSync(
      provenancePath,
      await format(JSON.stringify(provenance), {
        parser: "json",
        semi: true,
        singleQuote: false,
        trailingComma: "all",
        printWidth: 100,
      }),
    );
  } else {
    inspectComponent(retainedComponent);
    const retained = componentIdentity(retainedComponent);
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    if (
      provenance.schemaVersion !== 1 ||
      provenance.artifact !== "artifacts/import-typescript.wasm" ||
      provenance.sizeBytes !== retained.sizeBytes ||
      provenance.sha256 !== retained.sha256 ||
      provenance.sourceWitSha256 !== FROZEN_PLUGIN_WIT_SHA256 ||
      provenance.worldWitSha256 !== LOCAL_WORLD_WIT_SHA256 ||
      provenance.node !== NODE_VERSION ||
      provenance.npm !== NPM_VERSION ||
      provenance.typescript !== TYPESCRIPT_VERSION ||
      provenance.jco !== JCO_VERSION ||
      provenance.componentizeJs !== COMPONENTIZE_JS_VERSION ||
      provenance.wasi !== "disabled-all" ||
      provenance.reproducibility !== "structural-not-byte" ||
      JSON.stringify(provenance.imports) !== JSON.stringify(["junban:plugin/types@0.1.0"]) ||
      JSON.stringify(provenance.exports) !== JSON.stringify(["junban:plugin/guest@0.1.0"])
    ) {
      console.error("retained component provenance drifted");
      process.exit(1);
    }
  }

  const fresh = componentIdentity(freshComponent);
  console.log(
    JSON.stringify({
      mode,
      freshSizeBytes: fresh.sizeBytes,
      freshSha256: fresh.sha256,
      retainedSizeBytes: statSync(retainedComponent).size,
      node: NODE_VERSION,
      npm: NPM_VERSION,
      typescript: TYPESCRIPT_VERSION,
      jco: JCO_VERSION,
      componentizeJs: COMPONENTIZE_JS_VERSION,
      imports: ["junban:plugin/types@0.1.0"],
      exports: ["junban:plugin/guest@0.1.0"],
      wasi: "disabled-all",
      reproducibility: "structural-not-byte",
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
