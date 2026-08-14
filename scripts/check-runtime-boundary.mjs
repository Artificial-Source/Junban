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
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Native / releasable areas that must stay free of Node runtime artifacts. */
const NATIVE_ROOTS = ["crates", "src-tauri"];

/** Explicit SDK authoring fixture: build-only Node, never a shipped backend. */
const PLUGIN_SDK_TYPESCRIPT_CONSUMER = path.join(
  "crates",
  "junban-plugin-sdk",
  "consumers",
  "typescript",
);

/** Shipped source reference whose Node dependencies are author-only build tools. */
const PLUGIN_REFERENCE_TYPESCRIPT = path.join("plugins", "reference", "import-typescript");

const REFERENCE_AUTHOR_TOOL_PACKAGES = new Set([
  "@bytecodealliance/componentize-js",
  "@bytecodealliance/jco",
  "prettier",
  "typescript",
]);

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
 * @param {(full: string, entry: fs.Dirent) => (boolean | void)} visit
 */
function walk(dir, visit) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const descend = visit(full, entry);
    if (entry.isDirectory()) {
      if (
        descend === false ||
        entry.name === "target" ||
        entry.name === "dist" ||
        entry.name.toLowerCase() === "node_modules"
      ) {
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

    if (
      rel === PLUGIN_SDK_TYPESCRIPT_CONSUMER ||
      rel.startsWith(`${PLUGIN_SDK_TYPESCRIPT_CONSUMER}${path.sep}`)
    ) {
      // Checked-in source, bindings, lock and golden component are SDK build/test
      // authorities. Never traverse an installed author-tool dependency tree.
      return entry.isDirectory() && base === "node_modules" ? false : true;
    }

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
      if (lower.endsWith(".rs")) {
        const source = fs.readFileSync(full, "utf8");
        if (/plugins[\\/]reference[\\/]import-typescript/i.test(source)) {
          errors.push(
            `${rel}: native runtime must not import the TypeScript reference source tree`,
          );
        }
        if (
          /(?:Command|TokioCommand)::new\(\s*"(?:node|nodejs|npm|npx|pnpm|yarn|bun|deno)"/i.test(
            source,
          )
        ) {
          errors.push(`${rel}: native runtime must not launch Node author tooling`);
        }
      }
    }
  });
}

const consumerPackagePath = path.join(root, PLUGIN_SDK_TYPESCRIPT_CONSUMER, "package.json");
if (fs.existsSync(consumerPackagePath)) {
  const pkg = JSON.parse(fs.readFileSync(consumerPackagePath, "utf8"));
  const expected = {
    "@bytecodealliance/componentize-js": "0.22.0",
    "@bytecodealliance/jco": "1.26.1",
  };
  if (
    pkg.private !== true ||
    Object.keys(pkg.dependencies ?? {}).length !== 0 ||
    JSON.stringify(pkg.devDependencies ?? {}) !== JSON.stringify(expected)
  ) {
    errors.push(
      `${PLUGIN_SDK_TYPESCRIPT_CONSUMER}/package.json: author tools must remain private, build-only, and exact-pinned`,
    );
  }
}

const referencePackagePath = path.join(root, PLUGIN_REFERENCE_TYPESCRIPT, "package.json");
if (!fs.existsSync(referencePackagePath)) {
  errors.push(`${PLUGIN_REFERENCE_TYPESCRIPT}/package.json: pinned author package is missing`);
} else {
  const pkg = JSON.parse(fs.readFileSync(referencePackagePath, "utf8"));
  const expected = {
    name: "junban-reference-import-typescript",
    version: "0.1.0",
    private: true,
    type: "module",
    engines: {
      node: "24.13.1",
      npm: "11.18.0",
    },
    scripts: {
      build: "node ./build.mjs --build",
      check: "node ./build.mjs --check && node --experimental-strip-types ./test/command.test.ts",
      test: "node --experimental-strip-types ./test/command.test.ts",
    },
    devDependencies: {
      "@bytecodealliance/componentize-js": "0.22.0",
      "@bytecodealliance/jco": "1.26.1",
      prettier: "3.9.6",
      typescript: "6.0.3",
    },
    overrides: {
      "@bytecodealliance/jco": {
        "@bytecodealliance/componentize-js": "0.22.0",
      },
    },
  };
  if (!isDeepStrictEqual(pkg, expected)) {
    errors.push(
      `${PLUGIN_REFERENCE_TYPESCRIPT}/package.json: author package must remain private, build-only, and exact-pinned`,
    );
  }
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
  for (const [name, specification] of Object.entries(prod)) {
    if (FORBIDDEN_PROD_PACKAGES.includes(name) || name.startsWith("@nestjs/")) {
      errors.push(`package.json: production dependency "${name}" looks like backend Node runtime`);
    }
    if (REFERENCE_AUTHOR_TOOL_PACKAGES.has(name)) {
      errors.push(
        `package.json: reference author tool "${name}" must not be a production dependency`,
      );
    }
    if (
      typeof specification === "string" &&
      /plugins[\\/]reference[\\/]import-typescript/i.test(specification)
    ) {
      errors.push(
        `package.json: production dependency "${name}" must not reference TypeScript author tooling`,
      );
    }
  }
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (/plugins[\\/]reference[\\/]import-typescript/i.test(command)) {
      errors.push(
        `package.json: root script "${name}" must not launch TypeScript reference tooling`,
      );
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
