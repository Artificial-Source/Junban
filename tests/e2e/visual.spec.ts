import { test, expect } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, appUrlWithToken, type ServerContext } from "./fixtures";

const BASELINE_DIR = join(
  process.cwd(),
  "goals",
  "rust-rewrite",
  "evidence",
  "phase-1-visual-baseline",
);

// The default Playwright snapshot path is {testFileDir}/{testFileName}-snapshots/{name}-{project}-{platform}.png
// We copy the fixed baseline files there before tests run.
// Normal test commands must NOT regenerate the fixed baseline directory.
const SNAPSHOT_DIR = join(import.meta.dirname, "visual.spec.ts-snapshots");
const PLATFORM =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";

let server: ServerContext;

test.beforeAll(async () => {
  // Copy baseline PNGs to the expected snapshot directory with Playwright's naming convention
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const scene of SCENES) {
    const src = join(BASELINE_DIR, scene.baselineFile);
    const dest = join(
      SNAPSHOT_DIR,
      `${scene.baselineFile.replace(".png", "")}-visual-${PLATFORM}.png`,
    );
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
  server = await startServer({ seed: true });
});

test.afterAll(() => {
  server.cleanup();
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-23T10:30:00-07:00"));
  await page.addInitScript(() => {
    window.matchMedia = (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  });
});

interface VisualScene {
  name: string;
  baselineFile: string;
  viewport: { width: number; height: number };
  theme: "light" | "dark";
  path: string;
}

const SCENES: VisualScene[] = [
  {
    name: "today-desktop-light",
    baselineFile: "today-desktop-light.png",
    viewport: { width: 1440, height: 900 },
    theme: "light",
    path: "/today",
  },
  {
    name: "today-desktop-dark",
    baselineFile: "today-desktop-dark.png",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
    path: "/today",
  },
  {
    name: "inbox-desktop-light",
    baselineFile: "inbox-desktop-light.png",
    viewport: { width: 1440, height: 900 },
    theme: "light",
    path: "/inbox",
  },
  {
    name: "inbox-desktop-dark",
    baselineFile: "inbox-desktop-dark.png",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
    path: "/inbox",
  },
  {
    name: "today-mobile-light",
    baselineFile: "today-mobile-light.png",
    viewport: { width: 390, height: 844 },
    theme: "light",
    path: "/today",
  },
  {
    name: "today-mobile-dark",
    baselineFile: "today-mobile-dark.png",
    viewport: { width: 390, height: 844 },
    theme: "dark",
    path: "/today",
  },
  {
    name: "inbox-mobile-light",
    baselineFile: "inbox-mobile-light.png",
    viewport: { width: 390, height: 844 },
    theme: "light",
    path: "/inbox",
  },
  {
    name: "inbox-mobile-dark",
    baselineFile: "inbox-mobile-dark.png",
    viewport: { width: 390, height: 844 },
    theme: "dark",
    path: "/inbox",
  },
];

for (const scene of SCENES) {
  test(`visual: ${scene.name} matches baseline`, async ({ page }) => {
    await page.setViewportSize({ width: scene.viewport.width, height: scene.viewport.height });

    const url = appUrlWithToken(server.baseUrl, server.token, scene.path);
    await page.goto(url);
    await page.waitForSelector("h1", { timeout: 5000 });

    // Set the theme via localStorage
    await page.evaluate((theme) => {
      localStorage.setItem("junban-theme", theme);
      const root = document.documentElement;
      root.classList.remove("dark", "nord");
      if (theme === "dark") root.classList.add("dark");
    }, scene.theme);

    await page.reload();
    await page.waitForSelector("h1", { timeout: 5000 });

    // Structural assertions — hiding content cannot game the comparison
    if (scene.path === "/today") {
      await expect(page.locator("h1")).toContainText("Today");
      await expect(page.locator("#overdue-heading")).toBeVisible();
      await expect(page.getByRole("heading", { name: /Jul 23.*Today.*Thursday/ })).toBeVisible();
    } else {
      await expect(page.locator("h1")).toContainText("Inbox");
    }

    if (scene.viewport.width >= 768) {
      await expect(page.locator('aside[aria-label="Main navigation"]')).toBeVisible();
    }

    const taskButtons = page.locator("[data-task-focus-control]");
    await expect(taskButtons.first()).toBeVisible({ timeout: 5000 });

    // Wait for fonts and render to stabilize
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);

    // Compare against the fixed baseline.
    // Per-pixel threshold 0.2, maximum 1% differing pixels.
    // The baseline PNGs were copied to the expected snapshot path in beforeAll.
    await expect(page).toHaveScreenshot(scene.baselineFile, {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
    });
  });
}
