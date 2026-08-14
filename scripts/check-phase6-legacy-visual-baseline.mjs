#!/usr/bin/env node
/**
 * Deterministic checker for Phase 6 legacy visual authorities.
 *
 * Rejects:
 * - missing / changed PNG SHA-256 values
 * - wrong legacy source commit
 * - duplicate scene IDs
 * - maxDiffPixelRatio other than 0.01
 * - forbidden secret / network strings in manifest text and PNG bytes
 * - missing required scene files or dimension mismatches vs manifest
 *
 * Usage:
 *   node scripts/check-phase6-legacy-visual-baseline.mjs
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const AUTHORITY_DIR = path.join(
  REPO_ROOT,
  "goals/rust-rewrite/evidence/phase-6-legacy-visual-baseline",
);
const EXPECTED_COMMIT = "5e2b2b5adc865f401843c5030285293c5fabccc5";
const EXPECTED_RATIO = 0.01;
const CAPTURE_SCRIPT = path.join(REPO_ROOT, "scripts/capture-phase-6-legacy-visual-baseline.mjs");
const HARNESS_ROOT = path.join(REPO_ROOT, "scripts/phase-6-legacy-visual-baseline");
const CAPTURE_SPEC = path.join(HARNESS_ROOT, "capture.spec.mjs");
const HARNESS_SOURCE = path.join(HARNESS_ROOT, "harness");

const FORBIDDEN = [
  // Avoid short hex-overlapping tokens like "sk-" (collides with sha256 digests).
  "sk-proj-",
  "sk-ant-",
  "api_key",
  "apiKey",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "Bearer ",
  "Authorization:",
  "wss://",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "fonts.googleapis.com",
  "cdn.jsdelivr.net",
  "huggingface.co",
];

/** @type {string[]} */
const errors = [];

function fail(message) {
  errors.push(message);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256Tree(rootDir) {
  const files = [];
  function walk(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  walk(rootDir);
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path.join(rootDir, rel)));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), files };
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("not a PNG");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function scanText(label, text) {
  for (const token of FORBIDDEN) {
    if (text.includes(token)) {
      fail(`${label}: forbidden string ${JSON.stringify(token)}`);
    }
  }
}

function scanBytes(label, buf) {
  const text = buf.toString("latin1");
  scanText(label, text);
}

if (!existsSync(AUTHORITY_DIR)) {
  console.error(`error: missing authority directory ${AUTHORITY_DIR}`);
  process.exit(1);
}

const manifestPath = path.join(AUTHORITY_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("error: missing manifest.json");
  process.exit(1);
}

const manifestRaw = readFileSync(manifestPath, "utf8");
scanText("manifest.json", manifestRaw);

/** @type {any} */
let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (error) {
  console.error(`error: manifest.json is not valid JSON: ${error}`);
  process.exit(1);
}

if (manifest.version !== 1) fail(`manifest.version must be 1, got ${manifest.version}`);
if (manifest.source?.commit !== EXPECTED_COMMIT) {
  fail(`source.commit must be ${EXPECTED_COMMIT}, got ${manifest.source?.commit}`);
}
if (manifest.policy?.maxDiffPixelRatio !== EXPECTED_RATIO) {
  fail(`policy.maxDiffPixelRatio must be ${EXPECTED_RATIO}`);
}

const captureScriptHash = sha256(readFileSync(CAPTURE_SCRIPT));
if (manifest.hashes?.capture_script_sha256 !== captureScriptHash) {
  fail("capture script SHA-256 does not match manifest provenance");
}
const captureSpecHash = sha256(readFileSync(CAPTURE_SPEC));
if (manifest.hashes?.capture_spec_sha256 !== captureSpecHash) {
  fail("capture spec SHA-256 does not match manifest provenance");
}
const harnessHash = sha256Tree(HARNESS_SOURCE);
if (manifest.hashes?.harness_tree_sha256 !== harnessHash.sha256) {
  fail("harness tree SHA-256 does not match manifest provenance");
}
if (JSON.stringify(manifest.hashes?.harness_files) !== JSON.stringify(harnessHash.files)) {
  fail("harness file inventory does not match manifest provenance");
}

if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
  fail("manifest.scenes must be a non-empty array");
}

const seenIds = new Set();
const seenFiles = new Set();
const pngNames = new Set(readdirSync(AUTHORITY_DIR).filter((name) => name.endsWith(".png")));

for (const scene of manifest.scenes ?? []) {
  if (!scene || typeof scene !== "object") {
    fail("scene entry is not an object");
    continue;
  }
  if (!scene.id || typeof scene.id !== "string") fail("scene missing id");
  if (seenIds.has(scene.id)) fail(`duplicate scene id ${scene.id}`);
  seenIds.add(scene.id);

  if (!scene.file || typeof scene.file !== "string") fail(`scene ${scene.id} missing file`);
  if (seenFiles.has(scene.file)) fail(`duplicate scene file ${scene.file}`);
  seenFiles.add(scene.file);

  if (scene.maxDiffPixelRatio !== EXPECTED_RATIO) {
    fail(
      `scene ${scene.id} maxDiffPixelRatio must be ${EXPECTED_RATIO}, got ${scene.maxDiffPixelRatio}`,
    );
  }

  const filePath = path.join(AUTHORITY_DIR, scene.file);
  if (!existsSync(filePath)) {
    fail(`missing PNG for scene ${scene.id}: ${scene.file}`);
    continue;
  }
  pngNames.delete(scene.file);

  const bytes = readFileSync(filePath);
  let dims;
  try {
    dims = pngSize(bytes);
  } catch {
    fail(`${scene.file} is not a valid PNG`);
    continue;
  }

  const digest = sha256(bytes);
  if (digest !== scene.sha256) {
    fail(`${scene.file} sha256 mismatch: manifest ${scene.sha256}, actual ${digest}`);
  }
  if (dims.width !== scene.width || dims.height !== scene.height) {
    fail(
      `${scene.file} dimension mismatch: manifest ${scene.width}x${scene.height}, actual ${dims.width}x${dims.height}`,
    );
  }
  scanBytes(scene.file, bytes);

  if (!scene.componentAuthority) fail(`scene ${scene.id} missing componentAuthority`);
  if (!scene.testAuthority) fail(`scene ${scene.id} missing testAuthority`);
}

for (const orphan of pngNames) {
  fail(`PNG not listed in manifest: ${orphan}`);
}

if (errors.length > 0) {
  console.error("Phase 6 legacy visual baseline check failed:\n");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `Phase 6 legacy visual baseline check passed (${manifest.scenes.length} scenes, commit ${EXPECTED_COMMIT}, maxDiffPixelRatio ${EXPECTED_RATIO}).`,
);
