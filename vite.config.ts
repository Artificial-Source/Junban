import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiPlugin } from "./vite-api-plugin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// When VITE_USE_BACKEND=true (e.g. `pnpm dev:full`), the standalone Hono API
// server is running separately on port 4822. In that mode we skip the inline
// apiPlugin and proxy /api requests to it instead.
const useBackend = process.env.VITE_USE_BACKEND === "true";

export default defineConfig(({ command }) => ({
  plugins: [
    tailwindcss(),
    react(),
    ...(command === "serve" && !useBackend ? [apiPlugin()] : []),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
          dest: "",
        },
        {
          src: "node_modules/onnxruntime-web/dist/*.wasm",
          dest: "",
        },
      ],
    }),
  ],
  server: {
    ...(useBackend
      ? {
          proxy: {
            "/api": {
              target: "http://localhost:4822",
              changeOrigin: true,
            },
          },
        }
      : {}),
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  resolve: {
    alias: {
      "@": "/src",
      // kokoro-js default entry imports Node.js-only modules (path, fs/promises).
      // Point to the self-contained web build for browser/worker compatibility.
      "kokoro-js": path.resolve(__dirname, "node_modules/kokoro-js/dist/kokoro.web.js"),
    },
  },
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      external: ["better-sqlite3"],
    },
  },
  optimizeDeps: {
    exclude: ["sql.js", "@mintplex-labs/piper-tts-web", "onnxruntime-web"],
  },
}));
