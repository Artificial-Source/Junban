import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in Phase 6 Wave 5 local-voice acceptance config.
 * Excluded from ordinary `pnpm test:e2e` so large model downloads never block CI.
 *
 *   JUNBAN_LOCAL_VOICE_ACCEPTANCE=1 pnpm test:e2e:local-voice-acceptance
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 45 * 60_000,
  expect: {
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4299",
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    {
      name: "acceptance-phase-6-local-voice",
      testMatch: /acceptance-phase-6-local-voice\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
        permissions: ["microphone"],
      },
    },
  ],
});
