#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkedOpenApi = path.join(root, "openapi", "junban-v1.json");
const checkedTypes = path.join(root, "src", "ui", "api", "generated.ts");
const mode = process.argv[2];

if (mode !== "generate" && mode !== "check") {
  console.error("usage: node scripts/contract.mjs <generate|check>");
  process.exit(2);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "junban-contract-"));
const generatedOpenApi =
  mode === "generate" ? checkedOpenApi : path.join(temporary, "junban-v1.json");
const generatedTypes = mode === "generate" ? checkedTypes : path.join(temporary, "generated.ts");

try {
  fs.mkdirSync(path.dirname(generatedOpenApi), { recursive: true });
  fs.mkdirSync(path.dirname(generatedTypes), { recursive: true });
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "-p",
      "junban-server",
      "--bin",
      "generate-openapi",
      "--",
      generatedOpenApi,
    ],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync("pnpm", ["exec", "openapi-typescript", generatedOpenApi, "-o", generatedTypes], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  execFileSync(
    "pnpm",
    [
      "exec",
      "prettier",
      "--config",
      path.join(root, ".prettierrc"),
      "--write",
      generatedOpenApi,
      generatedTypes,
    ],
    {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  if (mode === "check") {
    const drift = [];
    for (const [checked, generated] of [
      [checkedOpenApi, generatedOpenApi],
      [checkedTypes, generatedTypes],
    ]) {
      if (
        !fs.existsSync(checked) ||
        fs.readFileSync(checked, "utf8") !== fs.readFileSync(generated, "utf8")
      ) {
        drift.push(path.relative(root, checked));
      }
    }
    if (drift.length > 0) {
      console.error(
        `Contract drift detected in ${drift.join(", ")}. Run \`pnpm contract:generate\`.`,
      );
      process.exitCode = 1;
    } else {
      console.log("OpenAPI and generated TypeScript contracts are current.");
    }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
