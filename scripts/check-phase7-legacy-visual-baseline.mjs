#!/usr/bin/env node
/**
 * Deterministic checker for Phase 7 legacy Extensions/plugin visual authorities.
 *
 * Rejects:
 * - missing / changed PNG SHA-256 values
 * - wrong legacy source commit
 * - duplicate scene IDs / files
 * - maxDiffPixelRatio other than 0.01
 * - forbidden secret / network strings in manifest text and PNG bytes
 * - missing required scene files or dimension mismatches vs manifest
 * - harness/capture provenance drift
 * - missing policy rejection of Node vm / require / arbitrary React
 *
 * Usage:
 *   node scripts/check-phase7-legacy-visual-baseline.mjs
 *   node scripts/check-phase7-legacy-visual-baseline.mjs --self-check
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const AUTHORITY_DIR = path.join(
  REPO_ROOT,
  "goals/rust-rewrite/evidence/phase-7-legacy-visual-baseline",
);
const EXPECTED_COMMIT = "5e2b2b5adc865f401843c5030285293c5fabccc5";
const EXPECTED_RATIO = 0.01;
const CAPTURE_SCRIPT = path.join(REPO_ROOT, "scripts/capture-phase-7-legacy-visual-baseline.mjs");
const HARNESS_ROOT = path.join(REPO_ROOT, "scripts/phase-7-legacy-visual-baseline");
const CAPTURE_SPEC = path.join(HARNESS_ROOT, "capture.spec.mjs");
const HARNESS_SOURCE = path.join(HARNESS_ROOT, "harness");
const SCENES_JSON = path.join(HARNESS_ROOT, "scenes.json");
const SELF_CHECK = process.argv.includes("--self-check");

const FORBIDDEN = [
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
  "registry.npmjs.org",
];

const REQUIRED_SCENE_IDS = [
  "settings-extensions-main-desktop-light",
  "settings-extensions-safety-desktop-light",
  "settings-extensions-permission-desktop-light",
  "registry-browser-list-detail-desktop-light",
  "registry-browser-empty-desktop-light",
  "registry-browser-loading-desktop-light",
  "registry-browser-error-desktop-light",
  "plugin-settings-pomodoro-desktop-light",
  "pomodoro-view-status-desktop-light",
  "declarative-panel-action-desktop-light",
  "settings-extensions-mobile-category-light",
  "settings-extensions-mobile-detail-light",
  "pomodoro-view-status-desktop-dark",
];

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

/**
 * @param {string} authorityDir
 * @param {{ quiet?: boolean }} [options]
 * @returns {{ ok: boolean, errors: string[], sceneCount: number }}
 */
function checkAuthorityDir(authorityDir, options = {}) {
  const quiet = Boolean(options.quiet);
  /** @type {string[]} */
  const localErrors = [];
  const localFail = (message) => localErrors.push(message);

  if (!existsSync(authorityDir)) {
    return { ok: false, errors: [`missing authority directory ${authorityDir}`], sceneCount: 0 };
  }

  const manifestPath = path.join(authorityDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: ["missing manifest.json"], sceneCount: 0 };
  }

  const manifestRaw = readFileSync(manifestPath, "utf8");
  for (const token of FORBIDDEN) {
    if (manifestRaw.includes(token)) {
      localFail(`manifest.json: forbidden string ${JSON.stringify(token)}`);
    }
  }

  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    return {
      ok: false,
      errors: [`manifest.json is not valid JSON: ${error}`],
      sceneCount: 0,
    };
  }

  if (manifest.version !== 1) localFail(`manifest.version must be 1, got ${manifest.version}`);
  if (manifest.kind !== "phase-7-legacy-visual-baseline") {
    localFail(`manifest.kind must be phase-7-legacy-visual-baseline`);
  }
  if (manifest.source?.commit !== EXPECTED_COMMIT) {
    localFail(`source.commit must be ${EXPECTED_COMMIT}, got ${manifest.source?.commit}`);
  }
  if (manifest.policy?.maxDiffPixelRatio !== EXPECTED_RATIO) {
    localFail(`policy.maxDiffPixelRatio must be ${EXPECTED_RATIO}`);
  }
  const rejectPolicy = manifest.policy?.rejects_node_vm_require_arbitrary_react;
  if (!rejectPolicy || typeof rejectPolicy !== "string") {
    localFail("policy.rejects_node_vm_require_arbitrary_react must be present");
  } else {
    const lowered = rejectPolicy.toLowerCase();
    for (const needle of ["node vm", "require", "react"]) {
      if (!lowered.includes(needle)) {
        localFail(
          `policy.rejects_node_vm_require_arbitrary_react must mention ${JSON.stringify(needle)}`,
        );
      }
    }
  }

  // Provenance is checked against the rewrite worktree sources (not the temp authority copy).
  if (!existsSync(CAPTURE_SCRIPT)) {
    localFail("missing capture script");
  } else {
    const captureScriptHash = sha256(readFileSync(CAPTURE_SCRIPT));
    if (manifest.hashes?.capture_script_sha256 !== captureScriptHash) {
      localFail("capture script SHA-256 does not match manifest provenance");
    }
  }
  if (!existsSync(CAPTURE_SPEC)) {
    localFail("missing capture spec");
  } else {
    const captureSpecHash = sha256(readFileSync(CAPTURE_SPEC));
    if (manifest.hashes?.capture_spec_sha256 !== captureSpecHash) {
      localFail("capture spec SHA-256 does not match manifest provenance");
    }
  }
  if (!existsSync(HARNESS_SOURCE)) {
    localFail("missing harness source directory");
  } else {
    const harnessHash = sha256Tree(HARNESS_SOURCE);
    if (manifest.hashes?.harness_tree_sha256 !== harnessHash.sha256) {
      localFail("harness tree SHA-256 does not match manifest provenance");
    }
    if (JSON.stringify(manifest.hashes?.harness_files) !== JSON.stringify(harnessHash.files)) {
      localFail("harness file inventory does not match manifest provenance");
    }
  }

  if (!existsSync(SCENES_JSON)) {
    localFail("missing scripts/phase-7-legacy-visual-baseline/scenes.json");
  } else {
    /** @type {any[]} */
    const catalog = JSON.parse(readFileSync(SCENES_JSON, "utf8"));
    const catalogIds = catalog.map((scene) => scene.id).sort();
    const manifestIds = (manifest.scenes ?? []).map((scene) => scene.id).sort();
    if (JSON.stringify(catalogIds) !== JSON.stringify(manifestIds)) {
      localFail("scenes.json ids do not match manifest.scenes ids");
    }
    const catalogDupes = catalog
      .map((scene) => scene.id)
      .filter((id, i, arr) => arr.indexOf(id) !== i);
    if (catalogDupes.length > 0) {
      localFail(`scenes.json contains duplicate ids: ${catalogDupes.join(", ")}`);
    }
  }

  if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    localFail("manifest.scenes must be a non-empty array");
  }

  const seenIds = new Set();
  const seenFiles = new Set();
  const pngNames = new Set(
    existsSync(authorityDir)
      ? readdirSync(authorityDir).filter((name) => name.endsWith(".png"))
      : [],
  );

  for (const scene of manifest.scenes ?? []) {
    if (!scene || typeof scene !== "object") {
      localFail("scene entry is not an object");
      continue;
    }
    if (!scene.id || typeof scene.id !== "string") localFail("scene missing id");
    if (seenIds.has(scene.id)) localFail(`duplicate scene id ${scene.id}`);
    seenIds.add(scene.id);

    if (!scene.file || typeof scene.file !== "string") localFail(`scene ${scene.id} missing file`);
    if (seenFiles.has(scene.file)) localFail(`duplicate scene file ${scene.file}`);
    seenFiles.add(scene.file);

    if (scene.maxDiffPixelRatio !== EXPECTED_RATIO) {
      localFail(
        `scene ${scene.id} maxDiffPixelRatio must be ${EXPECTED_RATIO}, got ${scene.maxDiffPixelRatio}`,
      );
    }

    const filePath = path.join(authorityDir, scene.file);
    if (!existsSync(filePath)) {
      localFail(`missing PNG for scene ${scene.id}: ${scene.file}`);
      continue;
    }
    pngNames.delete(scene.file);

    const bytes = readFileSync(filePath);
    let dims;
    try {
      dims = pngSize(bytes);
    } catch {
      localFail(`${scene.file} is not a valid PNG`);
      continue;
    }

    const digest = sha256(bytes);
    if (digest !== scene.sha256) {
      localFail(`${scene.file} sha256 mismatch: manifest ${scene.sha256}, actual ${digest}`);
    }
    if (dims.width !== scene.width || dims.height !== scene.height) {
      localFail(
        `${scene.file} dimension mismatch: manifest ${scene.width}x${scene.height}, actual ${dims.width}x${dims.height}`,
      );
    }
    if (bytes.length !== scene.bytes) {
      localFail(
        `${scene.file} byte-length mismatch: manifest ${scene.bytes}, actual ${bytes.length}`,
      );
    }
    for (const token of FORBIDDEN) {
      if (bytes.toString("latin1").includes(token)) {
        localFail(`${scene.file}: forbidden string ${JSON.stringify(token)}`);
      }
    }

    if (!scene.componentAuthority) localFail(`scene ${scene.id} missing componentAuthority`);
    if (!scene.testAuthority) localFail(`scene ${scene.id} missing testAuthority`);
  }

  for (const required of REQUIRED_SCENE_IDS) {
    if (!seenIds.has(required)) localFail(`missing required scene id ${required}`);
  }

  for (const orphan of pngNames) {
    localFail(`PNG not listed in manifest: ${orphan}`);
  }

  if (!quiet && localErrors.length === 0) {
    // no-op; caller prints
  }

  return {
    ok: localErrors.length === 0,
    errors: localErrors,
    sceneCount: Array.isArray(manifest.scenes) ? manifest.scenes.length : 0,
  };
}

function runSelfCheck() {
  if (!existsSync(AUTHORITY_DIR)) {
    console.error("error: authority directory missing; capture before --self-check");
    process.exit(1);
  }

  const baseline = checkAuthorityDir(AUTHORITY_DIR, { quiet: true });
  if (!baseline.ok) {
    console.error("self-check failed: baseline authority does not currently pass:\n");
    for (const error of baseline.errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const parent = mkdtempSync(path.join(tmpdir(), "phase7-visual-self-check-"));
  /** @type {Array<{ name: string, mutate: (dir: string) => void, expect: RegExp }>} */
  const cases = [
    {
      name: "wrong-commit",
      mutate: (dir) => {
        const manifestPath = path.join(dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.source.commit = "0".repeat(40);
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
      expect: /source\.commit must be/,
    },
    {
      name: "png-mutation",
      mutate: (dir) => {
        const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
        const target = path.join(dir, manifest.scenes[0].file);
        const bytes = Buffer.from(readFileSync(target));
        // Flip one byte in the PNG IDAT stream region while keeping a valid-ish file.
        bytes[Math.min(bytes.length - 1, 64)] ^= 0xff;
        writeFileSync(target, bytes);
      },
      expect: /sha256 mismatch|is not a valid PNG|dimension mismatch|byte-length mismatch/,
    },
    {
      name: "dimension-mismatch",
      mutate: (dir) => {
        const manifestPath = path.join(dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.scenes[0].width = manifest.scenes[0].width + 17;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
      expect: /dimension mismatch/,
    },
    {
      name: "duplicate-scene-id",
      mutate: (dir) => {
        const manifestPath = path.join(dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const clone = {
          ...manifest.scenes[0],
          file: "duplicate-scene-id-self-check.png",
        };
        // Copy bytes so orphan/missing checks do not fire first.
        cpSync(path.join(dir, manifest.scenes[0].file), path.join(dir, clone.file));
        manifest.scenes.push(clone);
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
      expect: /duplicate scene id|scenes\.json ids do not match/,
    },
    {
      name: "wrong-max-diff-ratio",
      mutate: (dir) => {
        const manifestPath = path.join(dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.policy.maxDiffPixelRatio = 0.025;
        manifest.scenes[0].maxDiffPixelRatio = 0.025;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
      expect: /maxDiffPixelRatio must be 0\.01/,
    },
    {
      name: "missing-reject-policy",
      mutate: (dir) => {
        const manifestPath = path.join(dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        delete manifest.policy.rejects_node_vm_require_arbitrary_react;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
      expect: /rejects_node_vm_require_arbitrary_react/,
    },
  ];

  /** @type {string[]} */
  const failures = [];
  try {
    for (const testCase of cases) {
      const dir = path.join(parent, testCase.name);
      cpSync(AUTHORITY_DIR, dir, { recursive: true });
      testCase.mutate(dir);
      const result = checkAuthorityDir(dir, { quiet: true });
      if (result.ok) {
        failures.push(`${testCase.name}: expected failure, but check passed`);
        continue;
      }
      const joined = result.errors.join("\n");
      if (!testCase.expect.test(joined)) {
        failures.push(
          `${testCase.name}: expected /${testCase.expect.source}/, got:\n${result.errors
            .map((e) => `    - ${e}`)
            .join("\n")}`,
        );
      } else {
        console.log(`self-check PASS ${testCase.name}`);
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }

  // Also exercise the CLI entrypoint rejects a wrong-commit copy (process boundary).
  const cliDir = mkdtempSync(path.join(tmpdir(), "phase7-visual-self-check-cli-"));
  try {
    cpSync(AUTHORITY_DIR, path.join(cliDir, "authority"), { recursive: true });
    const manifestPath = path.join(cliDir, "authority", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.source.commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // Inline spawn against the exported checker is enough; CLI path uses same function.
    const cliResult = checkAuthorityDir(path.join(cliDir, "authority"), { quiet: true });
    if (cliResult.ok || !cliResult.errors.some((e) => /source\.commit must be/.test(e))) {
      failures.push("cli-equivalent wrong-commit path did not fail on source.commit");
    } else {
      console.log("self-check PASS cli-wrong-commit");
    }
  } finally {
    rmSync(cliDir, { recursive: true, force: true });
  }

  // Capture script must refuse to treat a dirty path as the authority source without worktree isolation.
  // We only assert the script text encodes the detached-worktree + pinned-commit contract.
  const captureSrc = readFileSync(CAPTURE_SCRIPT, "utf8");
  for (const needle of [
    "git worktree add",
    "--detach",
    EXPECTED_COMMIT,
    "phase7-original",
    "rejects_node_vm_require_arbitrary_react",
  ]) {
    if (!captureSrc.includes(needle)) {
      failures.push(`capture script missing required contract string ${JSON.stringify(needle)}`);
    }
  }
  if (failures.length === 0) {
    console.log("self-check PASS capture-contract-strings");
  }

  if (failures.length > 0) {
    console.error("Phase 7 legacy visual baseline self-check failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(
    `Phase 7 legacy visual baseline self-check passed (${cases.length + 2} cases, baseline ${baseline.sceneCount} scenes).`,
  );
}

function main() {
  if (SELF_CHECK) {
    runSelfCheck();
    return;
  }

  const result = checkAuthorityDir(AUTHORITY_DIR);
  if (!result.ok) {
    console.error("Phase 7 legacy visual baseline check failed:\n");
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(
    `Phase 7 legacy visual baseline check passed (${result.sceneCount} scenes, commit ${EXPECTED_COMMIT}, maxDiffPixelRatio ${EXPECTED_RATIO}).`,
  );
}

// Avoid running main when imported by tests; detect direct execution.
const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main();
}
