import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

function resolveFrom(specifier: string, fromPackage: string): string {
  const parent = require.resolve(fromPackage);
  return createRequire(parent).resolve(specifier);
}

// Transitive ORT assets stay unpinned in package.json; Vite only needs absolute
// paths so dynamic voice loaders can emit same-origin URLs.
const ortVadWasm = resolveFrom("onnxruntime-web/ort-wasm-simd-threaded.wasm", "@ricky0123/vad-web");
const ortVadWasmDir = path.dirname(ortVadWasm);

const transformersRoot = path.dirname(path.dirname(require.resolve("@huggingface/transformers")));
const transformersPackageRoot = transformersRoot.endsWith(`${path.sep}dist`)
  ? path.dirname(transformersRoot)
  : transformersRoot;
const transformersOrtWasm = path.join(
  transformersPackageRoot,
  "dist",
  "ort-wasm-simd-threaded.jsep.wasm",
);
const transformersWeb = path.join(transformersPackageRoot, "dist", "transformers.web.js");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@junban/ort-vad-wasm": ortVadWasm,
      "@junban/ort-vad-wasm-dir": ortVadWasmDir,
      "@junban/ort-transformers-wasm": transformersOrtWasm,
      // Always the browser build (CDN-neutralized). Avoid the Node export map.
      "@huggingface/transformers": transformersWeb,
    },
  },
  worker: {
    format: "es",
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
