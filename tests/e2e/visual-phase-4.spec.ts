import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { appUrlWithToken, startServer, type ServerContext } from "./fixtures";

let server: ServerContext;

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };
const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.01, threshold: 0.2 };

type Theme = "light" | "dark";
type Tab =
  | "essentials"
  | "appearance"
  | "features"
  | "keyboard"
  | "templates"
  | "data"
  | "hosted"
  | "diagnostics";

const TAB_LABEL: Record<Tab, string> = {
  essentials: "Essentials",
  appearance: "Appearance",
  features: "Features",
  keyboard: "Keyboard",
  templates: "Templates",
  data: "Data",
  hosted: "Hosted",
  diagnostics: "Diagnostics",
};

test.beforeAll(async () => {
  server = await startServer({ seed: false });
});

test.afterAll(async () => {
  await server.cleanup();
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-01T12:00:00Z"));
  await page.addInitScript(() => {
    window.matchMedia = (query: string) => ({
      matches:
        query === "(prefers-reduced-motion: reduce)" ||
        (query === "(max-width: 767px)" && window.innerWidth <= 767),
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

async function openSettings(
  page: Page,
  tab: Tab,
  theme: Theme,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize(viewport);
  await page.addInitScript((value: Theme) => {
    localStorage.setItem("junban-theme", value);
  }, theme);

  if (viewport.width >= 768) {
    await page.goto(appUrlWithToken(server.baseUrl, server.token, "/inbox?visual-fixture=phase-4"));
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    if (tab !== "essentials") {
      await dialog.getByRole("button", { name: new RegExp(`^${TAB_LABEL[tab]}`) }).click();
    }
  } else {
    await page.goto(
      appUrlWithToken(server.baseUrl, server.token, `/settings/${tab}?visual-fixture=phase-4`),
    );
  }

  await expect(
    page.getByRole("heading", { name: TAB_LABEL[tab], exact: true }).first(),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

test("phase 4 legacy authority files match their immutable manifest", async () => {
  const authorityDir = join(process.cwd(), "goals/rust-rewrite/evidence/phase-4-visual-authority");
  const manifest = JSON.parse(await readFile(join(authorityDir, "manifest.json"), "utf8")) as {
    scenes: Array<{ file: string; sha256: string }>;
  };
  expect(manifest.scenes).toHaveLength(10);
  for (const scene of manifest.scenes) {
    const bytes = await readFile(join(authorityDir, scene.file));
    expect(createHash("sha256").update(bytes).digest("hex"), scene.file).toBe(scene.sha256);
  }
});

test("visual phase-4: essentials-desktop-light", async ({ page }) => {
  // The frozen legacy System-theme authority resolved dark on its capture host.
  await openSettings(page, "essentials", "dark", DESKTOP);
  await expect(page).toHaveScreenshot("essentials-desktop-light.png", SCREENSHOT_OPTS);
});

test("visual phase-4: appearance-desktop-dark", async ({ page }) => {
  await openSettings(page, "appearance", "dark", DESKTOP);
  await expect(page).toHaveScreenshot("appearance-desktop-dark.png", SCREENSHOT_OPTS);
});

test("visual phase-4: features-desktop-light", async ({ page }) => {
  await openSettings(page, "features", "light", DESKTOP);
  await expect(page).toHaveScreenshot("features-desktop-light.png", SCREENSHOT_OPTS);
});

test("visual phase-4: keyboard-desktop-dark", async ({ page }) => {
  await openSettings(page, "keyboard", "dark", DESKTOP);
  await expect(page).toHaveScreenshot("keyboard-desktop-dark.png", SCREENSHOT_OPTS);
});

test("visual phase-4: templates-desktop-light", async ({ page }) => {
  await openSettings(page, "templates", "light", DESKTOP);
  await expect(page).toHaveScreenshot("templates-desktop-light.png", SCREENSHOT_OPTS);
});

test("visual phase-4: data-desktop-light", async ({ page }) => {
  await openSettings(page, "data", "light", DESKTOP);
  await expect(page).toHaveScreenshot("data-desktop-light.png", SCREENSHOT_OPTS);
});

test("visual phase-4: hosted-desktop-dark", async ({ page }) => {
  await openSettings(page, "hosted", "dark", DESKTOP);
  await expect(page).toHaveScreenshot("hosted-desktop-dark.png", SCREENSHOT_OPTS);
});

test("visual phase-4: diagnostics-desktop-light", async ({ page }) => {
  await openSettings(page, "diagnostics", "light", DESKTOP);
  await expect(page).toHaveScreenshot("diagnostics-desktop-light.png", SCREENSHOT_OPTS);
});

test("visual phase-4: data-mobile-light", async ({ page }) => {
  await openSettings(page, "data", "light", MOBILE);
  await expect(page).toHaveScreenshot("data-mobile-light.png", SCREENSHOT_OPTS);
});

test("visual phase-4: appearance-mobile-dark", async ({ page }) => {
  await openSettings(page, "appearance", "dark", MOBILE);
  await expect(page).toHaveScreenshot("appearance-mobile-dark.png", SCREENSHOT_OPTS);
});
