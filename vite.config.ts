import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);

function resolveFrom(specifier: string, fromPackage: string): string {
  const parent = require.resolve(fromPackage);
  return createRequire(parent).resolve(specifier);
}

// Resolve assets from the same ORT installations as the engine imports; the
// Transformers runtime differs from the shared Piper/VAD runtime.
const ortVadWasm = resolveFrom("onnxruntime-web/ort-wasm-simd-threaded.wasm", "@ricky0123/vad-web");
const ortVadMjs = resolveFrom("onnxruntime-web/ort-wasm-simd-threaded.mjs", "@ricky0123/vad-web");
const ortVadWasmDir = path.dirname(ortVadWasm);

const transformersPackage = "@huggingface/transformers";
const transformersWeb = path.join(
  path.dirname(require.resolve(transformersPackage)),
  "transformers.web.js",
);
const transformersOrtWasm = resolveFrom(
  "onnxruntime-web/ort-wasm-simd-threaded.wasm",
  transformersPackage,
);
const transformersOrtMjs = resolveFrom(
  "onnxruntime-web/ort-wasm-simd-threaded.mjs",
  transformersPackage,
);

/**
 * Rolldown does not reliably apply string aliases when the import carries `?url`
 * for absolute binary/asset paths. Force those junban asset ids to `path?url`.
 */
function junbanBinaryAssetUrls(): Plugin {
  const assets = new Map<string, string>([
    ["@junban/ort-vad-wasm", ortVadWasm],
    ["@junban/ort-vad-mjs", ortVadMjs],
    ["@junban/ort-transformers-wasm", transformersOrtWasm],
    ["@junban/ort-transformers-mjs", transformersOrtMjs],
  ]);
  return {
    name: "junban-binary-asset-urls",
    enforce: "pre",
    resolveId(id) {
      const q = id.indexOf("?");
      const bare = q === -1 ? id : id.slice(0, q);
      const target = assets.get(bare);
      if (!target) return null;
      // Always emit as a URL string — wasm binaries and ORT mjs glue, not app modules.
      return `${target}?url`;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), junbanBinaryAssetUrls()],
  resolve: {
    alias: {
      "@junban/ort-vad-wasm": ortVadWasm,
      "@junban/ort-vad-mjs": ortVadMjs,
      "@junban/ort-vad-wasm-dir": ortVadWasmDir,
      "@junban/ort-transformers-wasm": transformersOrtWasm,
      "@junban/ort-transformers-mjs": transformersOrtMjs,
      // Always the browser build (CDN-neutralized). Avoid the Node export map.
      "@huggingface/transformers": transformersWeb,
    },
  },
  worker: {
    format: "es",
    // Worker builds use a separate pipeline; without this plugin the
    // `@junban/ort-*-wasm?url` ids fail to resolve inside engine workers.
    plugins: () => [junbanBinaryAssetUrls()],
  },
  build: {
    // Enables scripts/check-local-voice-assets.mjs to walk the static import graph.
    manifest: true,
  },
  optimizeDeps: {
    exclude: [
      "@huggingface/transformers",
      "@ricky0123/vad-web",
      "kokoro-js",
      "@mintplex-labs/piper-tts-web",
      "@diffusionstudio/piper-wasm",
    ],
  },
});
