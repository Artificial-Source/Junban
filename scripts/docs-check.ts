#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS_INDEX = path.join(ROOT, "docs", "README.md");
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function normalizePath(target: string): string {
  return target.replace(/\\/g, "/");
}

function collectMarkdownFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      results.push(...collectMarkdownFiles(fullPath));
      continue;
    }
    if (MARKDOWN_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }

  return results;
}

function extractOwnershipDocPaths(indexContents: string): string[] {
  const docPaths = new Set<string>();
  const lines = indexContents.split(/\r?\n/);

  for (const line of lines) {
    const matches = [...line.matchAll(/`([^`]+\.md)`/g)];
    for (const match of matches) {
      const raw = match[1];
      if (raw.startsWith("src/")) continue;
      docPaths.add(raw);
    }
  }

  return [...docPaths];
}

function validateOwnershipDocs(): string[] {
  const contents = readFile(DOCS_INDEX);
  const docPaths = extractOwnershipDocPaths(contents);
  const errors: string[] = [];

  for (const docPath of docPaths) {
    const absolute =
      docPath.startsWith("docs/") || docPath.startsWith(".github/")
        ? path.resolve(ROOT, docPath)
        : !docPath.includes("/")
          ? path.resolve(ROOT, docPath)
          : path.resolve(path.dirname(DOCS_INDEX), docPath);
    if (!fs.existsSync(absolute)) {
      errors.push(`Missing documentation target from docs/README.md ownership map: ${docPath}`);
    }
  }

  return errors;
}

function shouldValidateLink(target: string): boolean {
  if (!target || target.startsWith("http://") || target.startsWith("https://")) return false;
  if (target.startsWith("mailto:")) return false;
  if (target.startsWith("#")) return false;
  return true;
}

function validateMarkdownLinks(markdownFiles: string[]): string[] {
  const errors: string[] = [];
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;

  for (const filePath of markdownFiles) {
    const contents = readFile(filePath);
    const relativeSource = normalizePath(path.relative(ROOT, filePath));

    for (const match of contents.matchAll(linkRegex)) {
      const rawTarget = match[1].trim();
      const target = rawTarget.split("#")[0];
      if (!shouldValidateLink(target)) continue;

      const resolved = path.resolve(path.dirname(filePath), target);
      if (!fs.existsSync(resolved)) {
        errors.push(`Broken markdown link in ${relativeSource}: ${rawTarget}`);
      }
    }
  }

  return errors;
}

function main() {
  if (!fs.existsSync(DOCS_INDEX)) {
    console.error("docs/README.md not found");
    process.exit(1);
  }

  const markdownFiles = [
    ...collectMarkdownFiles(path.join(ROOT, "docs")),
    path.join(ROOT, "README.md"),
    path.join(ROOT, "AGENTS.md"),
    path.join(ROOT, "CLAUDE.md"),
    path.join(ROOT, ".github", "SECURITY.md"),
  ].filter((filePath, index, all) => all.indexOf(filePath) === index && fs.existsSync(filePath));

  const errors = [...validateOwnershipDocs(), ...validateMarkdownLinks(markdownFiles)];

  if (errors.length > 0) {
    console.error("Documentation checks failed:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Documentation checks passed for ${markdownFiles.length} markdown files.`);
}

main();
