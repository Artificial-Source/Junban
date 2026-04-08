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
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
            if (id.includes("framer-motion")) {
              return "animations";
            }
            if (id.includes("@dnd-kit")) {
              return "dnd-kit";
            }
            if (id.includes("@tanstack/react-virtual")) {
              return "virtualizer";
            }
            if (id.includes("react-markdown") || id.includes("remark-gfm")) {
              return "markdown";
            }
            if (id.includes("@anthropic-ai/sdk") || id.includes("/openai/")) {
              return "ai-vendors";
            }
            if (id.includes("chrono-node")) {
              return "date-parser";
            }
            if (id.includes("/yaml/")) {
              return "yaml-parser";
            }
            if (
              id.includes("sql.js") ||
              id.includes("drizzle-orm/sql-js") ||
              id.includes("drizzle-orm/sqlite-core")
            ) {
              return "web-db";
            }
            if (id.includes("@tauri-apps/")) {
              return "tauri-runtime";
            }
            if (id.includes("lucide-react")) {
              return "icons";
            }
          }

          if (id.includes("/src/ai/tools/")) {
            return "ai-tools";
          }

          if (id.includes("/src/utils/logger.")) {
            return "app-utils";
          }

          if (id.includes("/src/ai/provider/adapters/")) {
            return "ai-adapters";
          }

          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["sql.js", "@mintplex-labs/piper-tts-web", "onnxruntime-web"],
  },
}));
