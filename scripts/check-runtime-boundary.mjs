#!/usr/bin/env node
/**
 * Runtime boundary check for Phase 0.
 *
 * Shipped backend/native areas must not contain Node runtimes, backend Node
 * packages, or Node executables/sidecars. Bundled frontend assets under dist/
 * are allowed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Native / releasable areas that must stay free of Node runtime artifacts. */
const NATIVE_ROOTS = ["crates", "src-tauri"];

/** Filenames that indicate a Node package or install tree. */
const FORBIDDEN_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "node_modules",
]);

/** Executable / sidecar basenames that must not appear under native roots. */
const FORBIDDEN_BINARIES = new Set(["node", "nodejs", "npm", "npx", "pnpm", "yarn", "bun", "deno"]);

/**
 * Production dependency names that would indicate a backend Node server.
 * Root package.json may only use these as accidental mistakes to catch early.
 */
const FORBIDDEN_PROD_PACKAGES = [
  "express",
  "fastify",
  "hono",
  "koa",
  "nest",
  "@nestjs/core",
  "next",
  "nuxt",
  "sql.js",
  "better-sqlite3",
  "sqlite3",
  "electron",
  "ws",
];

/** @type {string[]} */
const errors = [];

/**
 * @param {string} dir
 * @param {(full: string, entry: fs.Dirent) => void} visit
 */
function walk(dir, visit) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    visit(full, entry);
    if (entry.isDirectory()) {
      if (entry.name === "target" || entry.name === "dist") {
        continue;
      }
      walk(full, visit);
    }
  }
}

for (const nativeRoot of NATIVE_ROOTS) {
  const abs = path.join(root, nativeRoot);
  walk(abs, (full, entry) => {
    const rel = path.relative(root, full);
    const base = entry.name.toLowerCase();

    if (FORBIDDEN_NAMES.has(entry.name) || FORBIDDEN_NAMES.has(base)) {
      errors.push(`${rel}: Node package or install tree is not allowed under ${nativeRoot}/`);
      return;
    }

    if (FORBIDDEN_BINARIES.has(base)) {
      errors.push(`${rel}: Node/runtime executable name is not allowed under ${nativeRoot}/`);
      return;
    }

    if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (
        lower.endsWith(".js") ||
        lower.endsWith(".mjs") ||
        lower.endsWith(".cjs") ||
        lower.endsWith(".ts")
      ) {
        errors.push(`${rel}: backend/native JavaScript or TypeScript is not allowed`);
      }
    }
  });
}

// Frontend source must stay browser-only even though the development scripts use Node.
const frontendDir = path.join(root, "src");
const nodeImportPattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']node:/;
walk(frontendDir, (full, entry) => {
  if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) {
    return;
  }
  const source = fs.readFileSync(full, "utf8");
  if (nodeImportPattern.test(source)) {
    errors.push(`${path.relative(root, full)}: frontend source must not import Node APIs`);
  }
});

// Root package.json is frontend build tooling only: production deps must stay browser-safe.
const rootPackagePath = path.join(root, "package.json");
if (fs.existsSync(rootPackagePath)) {
  const pkg = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  const prod = pkg.dependencies ?? {};
  for (const name of Object.keys(prod)) {
    if (FORBIDDEN_PROD_PACKAGES.includes(name) || name.startsWith("@nestjs/")) {
      errors.push(`package.json: production dependency "${name}" looks like backend Node runtime`);
    }
  }
}

// dist may contain bundled frontend JS, but never a Node runtime tree or executable.
const distDir = path.join(root, "dist");
if (fs.existsSync(distDir)) {
  walk(distDir, (full, entry) => {
    const rel = path.relative(root, full);
    const base = entry.name.toLowerCase();
    if (entry.name === "node_modules" || base === "node_modules") {
      errors.push(`${rel}: node_modules must not appear in dist/`);
    }
    if (FORBIDDEN_BINARIES.has(base)) {
      errors.push(`${rel}: Node/runtime executable must not appear in dist/`);
    }
    if (entry.name === "package.json") {
      errors.push(`${rel}: package.json must not appear in dist/`);
    }
  });
}

if (errors.length > 0) {
  console.error("Runtime boundary check failed:\n");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log("Runtime boundary check passed.");
