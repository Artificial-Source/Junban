#!/usr/bin/env node
/**
 * Fail-closed source + built-asset checker for Phase 6 local browser voice.
 *
 * Scopes:
 * - Production src boundary: no static engine imports; no package CDN defaults.
 * - Built dist: walk the Vite build manifest static import closure from each
 *   initial entry and keep engine/model code out of that closure.
 * - All shipped JS chunks: reject package CDN defaults, mutable Piper roots,
 *   cross-origin workers, and real Node-only module imports.
 *
 * Does not scan node_modules package sources.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

/** Patterns that must never appear in shipped browser JS. */
const SHIPPED_FORBIDDEN = [
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "diffusionstudio/piper-voices/resolve/main",
  "huggingface.co/diffusionstudio/piper-voices/resolve/main",
];

const SHIPPED_MODULE_PATTERNS = [
  /from\s+["']onnxruntime-node["']/,
  /require\(\s*["']onnxruntime-node["']\s*\)/,
  /from\s+["']sharp["']/,
  /require\(\s*["']sharp["']\s*\)/,
  /["']onnxruntime-node\/[^"']+["']/,
];

const CROSS_ORIGIN_WORKER = /new\s+Worker\s*\(\s*[`'"]https?:\/\//;

const ENGINE_PACKAGE_NAMES = [
  "@huggingface/transformers",
  "@ricky0123/vad-web",
  "kokoro-js",
  "@mintplex-labs/piper-tts-web",
  "@diffusionstudio/piper-wasm",
];

const BOUNDARY_SOURCE_FILES = [
  "src/ui/voice/local/index.ts",
  "src/ui/voice/local/manifest.ts",
  "src/ui/voice/local/verify-fetch.ts",
  "src/ui/voice/local/types.ts",
  "src/ui/voice/local/worker-host.ts",
  "src/ui/voice/local/worker-client.ts",
  "src/ui/voice/local/protocol.ts",
  "src/ui/voice/local/engine-status.ts",
  "src/ui/voice/local/workers/worker-runtime.ts",
  "src/ui/voice/local/redirect-policy.ts",
  "src/ui/voice/local/opfs-store.ts",
  "src/ui/voice/local/download-gate.ts",
  "src/ui/voice/local/sha256.ts",
  "src/ui/voice/local/verified-model-cache.ts",
];

const WASM_SENTINEL = "/__junban_local_voice_wasm_unconfigured__/";

const ENGINE_MARKERS = [
  ...ENGINE_PACKAGE_NAMES,
  "whisper-tiny.en",
  "Kokoro-82M",
  "piper-tts-web",
  "silero_vad",
  "ort-wasm-simd-threaded",
  "piper_phonemize",
  "junban-local-voice",
];

/**
 * @param {string} dir
 * @param {(full: string, entry: fs.Dirent) => void} visit
 */
function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    visit(full, entry);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "target") continue;
      walk(full, visit);
    }
  }
}

function rel(full) {
  return path.relative(root, full);
}

function read(full) {
  return fs.readFileSync(full, "utf8");
}

function checkShippedJs(label, text, { forbidEngineMarkers = false } = {}) {
  for (const needle of SHIPPED_FORBIDDEN) {
    if (text.includes(needle)) {
      errors.push(`${label}: forbidden substring "${needle}"`);
    }
  }
  for (const pattern of SHIPPED_MODULE_PATTERNS) {
    if (pattern.test(text)) {
      errors.push(`${label}: forbidden module pattern ${pattern}`);
    }
  }
  if (CROSS_ORIGIN_WORKER.test(text)) {
    errors.push(`${label}: cross-origin Worker constructor`);
  }
  if (forbidEngineMarkers) {
    for (const marker of ENGINE_MARKERS) {
      if (text.includes(marker)) {
        errors.push(`${label}: initial static graph must not contain "${marker}"`);
      }
    }
    if (text.includes(WASM_SENTINEL)) {
      errors.push(`${label}: initial static graph must not contain wasm sentinel`);
    }
  }
}

// 1) Public boundary source must not statically import engines or CDN defaults.
for (const relPath of BOUNDARY_SOURCE_FILES) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    errors.push(`missing boundary source ${relPath}`);
    continue;
  }
  const text = read(full);
  for (const needle of ["cdn.jsdelivr.net", "cdnjs.cloudflare.com"]) {
    if (text.includes(needle)) {
      errors.push(`${relPath}: forbidden CDN host`);
    }
  }
  for (const pkg of ENGINE_PACKAGE_NAMES) {
    const staticFrom = new RegExp(
      `from\\s+["']${pkg.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}["']`,
    );
    if (staticFrom.test(text)) {
      errors.push(`${relPath}: static import of ${pkg}`);
    }
  }
}

// 2) Production src (excluding tests) must not embed package CDN defaults.
walk(path.join(root, "src"), (full, entry) => {
  if (!entry.isFile()) return;
  if (!/\.([cm]?[jt]sx?)$/.test(entry.name)) return;
  if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) return;
  if (entry.name === "opfs-mock.ts") return;
  const text = read(full);
  for (const needle of ["cdn.jsdelivr.net", "cdnjs.cloudflare.com"]) {
    if (text.includes(needle)) {
      errors.push(`${rel(full)}: forbidden CDN host in production source`);
    }
  }
});

// 3) package.json pins.
const pkg = JSON.parse(read(path.join(root, "package.json")));
const deps = pkg.dependencies ?? {};
const expected = {
  "@huggingface/transformers": "3.8.1",
  "@ricky0123/vad-web": "0.0.30",
  "kokoro-js": "1.2.1",
  "@mintplex-labs/piper-tts-web": "1.0.4",
};
for (const [name, version] of Object.entries(expected)) {
  if (deps[name] !== version) {
    errors.push(`package.json: expected ${name}@${version}, found ${deps[name] ?? "(missing)"}`);
  }
}
if (Object.prototype.hasOwnProperty.call(deps, "onnxruntime-web")) {
  errors.push("package.json: direct onnxruntime-web dependency is forbidden");
}
if (Object.prototype.hasOwnProperty.call(deps, "onnxruntime-node")) {
  errors.push("package.json: onnxruntime-node must not be a direct dependency");
}
if (Object.prototype.hasOwnProperty.call(deps, "sharp")) {
  errors.push("package.json: sharp must not be a direct dependency");
}

// 4) Built assets.
const distDir = path.join(root, "dist");
if (fs.existsSync(distDir)) {
  /** @type {string[]} */
  const jsAssets = [];
  walk(distDir, (full, entry) => {
    if (!entry.isFile()) return;
    if (!/\.m?js$/.test(entry.name)) return;
    jsAssets.push(full);
    checkShippedJs(rel(full), read(full), { forbidEngineMarkers: false });
  });

  const indexHtmlPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexHtmlPath)) {
    errors.push("dist/index.html missing after build");
  } else {
    checkShippedJs("dist/index.html", read(indexHtmlPath), { forbidEngineMarkers: true });
  }

  // Walk Vite build manifest static import closure from initial entries.
  const manifestPath = path.join(distDir, ".vite", "manifest.json");
  const altManifestPath = path.join(distDir, "manifest.json");
  const resolvedManifest = fs.existsSync(manifestPath)
    ? manifestPath
    : fs.existsSync(altManifestPath)
      ? altManifestPath
      : null;

  if (!resolvedManifest) {
    if (process.argv.includes("--require-dist")) {
      errors.push("dist Vite manifest missing; enable build.manifest and rebuild");
    }
  } else {
    const manifest = JSON.parse(read(resolvedManifest));
    /** @type {Set<string>} */
    const initialFiles = new Set();

    function addClosure(fileKey) {
      if (!fileKey || initialFiles.has(fileKey)) return;
      const entry = manifest[fileKey];
      if (!entry) return;
      initialFiles.add(fileKey);
      if (entry.file) initialFiles.add(entry.file);
      for (const imp of entry.imports ?? []) {
        addClosure(imp);
      }
      // css is fine; do not follow dynamicImports — those are deferred chunks.
    }

    for (const [key, entry] of Object.entries(manifest)) {
      if (entry.isEntry || (entry.isDynamicEntry === false && entry.src?.endsWith("index.html"))) {
        addClosure(key);
      }
      // Vite marks HTML entries with isEntry.
      if (entry.isEntry) addClosure(key);
    }

    // Also seed from index.html script tags in case of naming differences.
    if (fs.existsSync(indexHtmlPath)) {
      const indexHtml = read(indexHtmlPath);
      for (const match of indexHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
        const src = match[1].replace(/^\//, "");
        // Find manifest entry whose file matches.
        for (const [key, entry] of Object.entries(manifest)) {
          if (entry.file === src || `assets/${path.basename(src)}` === entry.file) {
            addClosure(key);
          }
        }
        // Direct file path
        initialFiles.add(src.replace(/^assets\//, "assets/"));
        if (!src.startsWith("assets/"))
          initialFiles.add(path.posix.join("assets", path.basename(src)));
        initialFiles.add(src);
      }
    }

    for (const fileKey of initialFiles) {
      const candidates = [
        path.join(distDir, fileKey),
        path.join(distDir, "assets", path.basename(fileKey)),
      ];
      // Manifest values may already be asset paths like assets/index-xx.js
      const entry = manifest[fileKey];
      if (entry?.file) candidates.push(path.join(distDir, entry.file));

      for (const candidate of candidates) {
        if (!fs.existsSync(candidate) || !/\.m?js$/.test(candidate)) continue;
        checkShippedJs(rel(candidate), read(candidate), { forbidEngineMarkers: true });
      }
    }
  }
} else if (process.argv.includes("--require-dist")) {
  errors.push("dist/ is required but missing; run pnpm build first");
}

if (errors.length > 0) {
  console.error("Local voice asset check failed:\n");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log("Local voice asset check passed.");
