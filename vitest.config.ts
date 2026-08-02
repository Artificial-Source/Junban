import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default defineConfig({
  // Reuse Vite aliases (same-origin ORT asset paths) and browser resolve conditions.
  ...viteConfig,
  resolve: {
    ...viteConfig.resolve,
    conditions: ["browser", "module", "import"],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
    environment: "jsdom",
  },
});
