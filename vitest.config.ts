import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    restoreMocks: true,
    setupFiles: ["tests/ui/setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: ["tests/ui/**", "tests/**/components/**/*.test.tsx"],
          globals: true,
          restoreMocks: true,
        },
      },
      {
        test: {
          name: "ui",
          include: ["tests/ui/**/*.test.ts", "tests/ui/**/*.test.tsx"],
          environment: "jsdom",
          globals: true,
          restoreMocks: true,
          setupFiles: ["tests/ui/setup.ts"],
        },
      },
      {
        test: {
          name: "plugin-ui",
          include: ["tests/**/components/**/*.test.tsx"],
          exclude: ["tests/ui/**"],
          environment: "jsdom",
          globals: true,
          restoreMocks: true,
          setupFiles: ["tests/ui/setup.ts"],
        },
      },
    ],
  },
});
