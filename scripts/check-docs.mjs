#!/usr/bin/env node
/**
 * Narrow repository docs check: local Markdown link targets must exist.
 * Not a general documentation framework.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} dir */
function walkMarkdown(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") {
      continue;
    }
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

const linkRe = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
/** @type {string[]} */
const errors = [];

for (const file of walkMarkdown(root)) {
  const text = fs.readFileSync(file, "utf8");
  const relFile = path.relative(root, file);
  let match;
  while ((match = linkRe.exec(text)) !== null) {
    const target = match[2].trim();
    if (
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:") ||
      target.startsWith("#")
    ) {
      continue;
    }

    const bare = target.split("#")[0]?.split("?")[0] ?? "";
    if (!bare) {
      continue;
    }

    const resolved = path.resolve(path.dirname(file), bare);
    if (!fs.existsSync(resolved)) {
      errors.push(`${relFile}: broken link -> ${target}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Documentation link check failed:\n");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log("Documentation link check passed.");
