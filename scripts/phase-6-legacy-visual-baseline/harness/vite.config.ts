import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_ROOT = process.env.JUNBAN_LEGACY_WORKTREE;
if (!LEGACY_ROOT) {
  throw new Error("JUNBAN_LEGACY_WORKTREE is required for the Phase 6 visual harness");
}

const legacyUi = path.resolve(LEGACY_ROOT, "src/ui");

export default defineConfig({
  root: __dirname,
  // Keep the prebundle cache inside the ephemeral worktree, not the shared
  // legacy node_modules symlink (which would stale-serve prior harness builds).
  cacheDir: path.join(LEGACY_ROOT, ".phase6-vite-cache"),
  publicDir: false,
  plugins: [react(), tailwindcss()],
  // Modern browser only — Playwright Chromium; avoid downleveling deps.
  esbuild: { target: "esnext" },
  build: { target: "esnext" },
  resolve: {
    alias: [
      // @legacy points at the detached worktree src/ui, where capture.mjs has
      // already overlaid fixture mocks onto context/api modules in-place.
      { find: "@legacy", replacement: legacyUi },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PHASE6_VITE_PORT ?? 5196),
    strictPort: true,
    fs: {
      allow: [LEGACY_ROOT, __dirname],
    },
  },
  optimizeDeps: {
    entries: [path.join(__dirname, "main.tsx")],
    include: ["react", "react-dom", "react-dom/client", "lucide-react"],
    exclude: [
      "@anthropic-ai/sdk",
      "openai",
      "@google/generative-ai",
      "framer-motion",
      "better-sqlite3",
    ],
    esbuildOptions: {
      target: "esnext",
    },
  },
});
