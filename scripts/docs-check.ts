#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS_INDEX = path.join(ROOT, "docs", "README.md");
const DOCS_SITE_DIR = path.join(ROOT, "docs", "site");
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".yml",
  ".yaml",
  ".txt",
]);
const LEGACY_DOC_PATHS = ["docs/frontend/", "docs/backend/", "docs/plugins/", "docs/planning/"];
const LEGACY_PATH_ALLOWLIST = new Set([
  normalizePath(path.join(ROOT, "docs", "guides", "DOCS_IA_AUDIT.md")),
  normalizePath(path.join(ROOT, "docs", "planning", "ROADMAP.md")),
  normalizePath(path.join(ROOT, "docs", "README.md")),
  normalizePath(path.join(ROOT, "docs", "product", "README.md")),
  normalizePath(path.join(ROOT, "README.md")),
  normalizePath(path.join(ROOT, "llms.txt")),
  normalizePath(path.join(ROOT, "scripts", "docs-check.ts")),
]);
const SITE_CANONICAL_ALLOWED_PREFIXES = ["docs/guides/", "docs/reference/", "docs/product/"];

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

function collectTextFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        [".git", "node_modules", "dist", "coverage", ".wrangler", ".sst", "target"].includes(
          entry.name,
        )
      ) {
        continue;
      }
      results.push(...collectTextFiles(fullPath));
      continue;
    }

    if (entry.name === ".gitignore" || TEXT_EXTENSIONS.has(path.extname(entry.name))) {
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

function validateLlmsFile(llmsPath: string): string[] {
  if (!fs.existsSync(llmsPath)) return [];

  const errors: string[] = [];
  const contents = readFile(llmsPath);

  for (const line of contents.split(/\r?\n/)) {
    const value = line.includes(":") ? line.split(":").slice(1).join(":") : line;
    for (const rawToken of value.split(",")) {
      const token = rawToken.trim().replace(/^-\s*/, "");
      if (!token || token.startsWith("#") || token.startsWith(">")) continue;
      if (!(token.endsWith(".md") || token.endsWith("/"))) continue;

      const resolved = path.resolve(ROOT, token);
      if (!fs.existsSync(resolved)) {
        errors.push(`Broken llms.txt path reference: ${token}`);
      }
    }
  }

  return errors;
}

function validateLegacyPathUsage(textFiles: string[]): string[] {
  const errors: string[] = [];

  for (const filePath of textFiles) {
    const normalizedPath = normalizePath(filePath);
    if (LEGACY_PATH_ALLOWLIST.has(normalizedPath)) continue;

    const contents = readFile(filePath);
    for (const legacyPath of LEGACY_DOC_PATHS) {
      if (!contents.includes(legacyPath)) continue;
      errors.push(
        `Legacy documentation path reference in ${normalizePath(path.relative(ROOT, filePath))}: ${legacyPath}`,
      );
    }
  }

  return errors;
}

function extractCanonicalSourceTarget(markdownContents: string): string | null {
  const canonicalLineMatch = markdownContents.match(/^Canonical source:\s*(.+)$/m);
  if (!canonicalLineMatch) return null;

  const canonicalLine = canonicalLineMatch[1].trim();
  const markdownLinkMatch = canonicalLine.match(/\[[^\]]+\]\(([^)]+)\)/);
  if (!markdownLinkMatch) return null;

  return markdownLinkMatch[1].trim();
}

function isAllowedSiteCanonicalPath(targetPath: string): boolean {
  return SITE_CANONICAL_ALLOWED_PREFIXES.some((prefix) => targetPath.startsWith(prefix));
}

function validateSiteCanonicalSources(siteMarkdownFiles: string[]): string[] {
  const errors: string[] = [];

  for (const filePath of siteMarkdownFiles) {
    const relativeSource = normalizePath(path.relative(ROOT, filePath));
    const contents = readFile(filePath);
    const rawTarget = extractCanonicalSourceTarget(contents);

    if (!rawTarget) {
      errors.push(
        `Missing or invalid Canonical source line in ${relativeSource} (expected: Canonical source: [label](path))`,
      );
      continue;
    }

    const targetWithoutHash = rawTarget.split("#")[0];
    const resolvedTarget = path.resolve(path.dirname(filePath), targetWithoutHash);
    const relativeResolvedTarget = normalizePath(path.relative(ROOT, resolvedTarget));

    if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
      errors.push(`Canonical source target does not exist in ${relativeSource}: ${rawTarget}`);
      continue;
    }

    const isSiteHomepage = relativeSource === "docs/site/README.md";
    const isAllowedCanonicalTarget = isSiteHomepage
      ? relativeResolvedTarget === "docs/README.md"
      : isAllowedSiteCanonicalPath(relativeResolvedTarget);

    if (!isAllowedCanonicalTarget) {
      errors.push(
        isSiteHomepage
          ? `Canonical source target for docs/site/README.md must be docs/README.md: ${rawTarget}`
          : `Canonical source target must be under docs/guides/, docs/reference/, or docs/product/ in ${relativeSource}: ${rawTarget}`,
      );
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
    path.join(ROOT, ".github", "pull_request_template.md"),
    ...collectMarkdownFiles(path.join(ROOT, ".github", "PULL_REQUEST_TEMPLATE")),
  ].filter((filePath, index, all) => all.indexOf(filePath) === index && fs.existsSync(filePath));

  const textFiles = collectTextFiles(ROOT);
  const siteMarkdownFiles = fs.existsSync(DOCS_SITE_DIR) ? collectMarkdownFiles(DOCS_SITE_DIR) : [];

  const errors = [
    ...validateOwnershipDocs(),
    ...validateMarkdownLinks(markdownFiles),
    ...validateLlmsFile(path.join(ROOT, "llms.txt")),
    ...validateLegacyPathUsage(textFiles),
    ...validateSiteCanonicalSources(siteMarkdownFiles),
  ];

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
