import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Capture Phase 7 legacy-rendered Extensions/plugin visual authorities.
 * Source components: Junban-legacy@5e2b2b5 via detached worktree + fixture mocks.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR =
  process.env.PHASE7_VISUAL_OUT ??
  path.resolve(__dirname, "../../goals/rust-rewrite/evidence/phase-7-legacy-visual-baseline");

const scenesPath = [
  path.join(__dirname, "scenes.json"),
  path.join(__dirname, "phase-7-legacy-visual-baseline/scenes.json"),
  path.resolve(__dirname, "scenes.json"),
].find((candidate) => {
  try {
    readFileSync(candidate);
    return true;
  } catch {
    return false;
  }
});
if (!scenesPath) {
  throw new Error("scenes.json not found next to capture spec");
}

/** @type {Array<{
 *   id: string,
 *   file: string,
 *   theme: "light" | "dark",
 *   width: number,
 *   height: number,
 *   componentAuthority: string,
 *   testAuthority: string,
 *   assertText?: string[],
 *   expandPlugin?: string,
 * }>} */
const SCENES = JSON.parse(readFileSync(scenesPath, "utf8"));

async function preparePage(page, scene) {
  await page.setViewportSize({ width: scene.width, height: scene.height });
  await page.clock.setFixedTime(new Date("2026-08-04T15:00:00.000Z"));
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (
      url.startsWith("http://127.0.0.1:") ||
      url.startsWith("http://localhost:") ||
      url.startsWith("data:") ||
      url.startsWith("blob:")
    ) {
      await route.continue();
      return;
    }
    await route.abort();
  });
  await page.addInitScript(() => {
    window.matchMedia = (query) => ({
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
}

async function openScene(page, scene) {
  await preparePage(page, scene);
  const url = `/?scene=${encodeURIComponent(scene.id)}&theme=${scene.theme}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("phase7-scene-root")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => page.locator("html").getAttribute("data-phase7-ready"), {
      timeout: 30_000,
    })
    .toBe("1");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  // Safety/permission/expand states are fixture-seeded on the overlaid PluginsTab.
  // Still assert the live dialog chrome before capture.
  if (scene.id === "settings-extensions-safety-desktop-light") {
    await expect(page.getByRole("dialog", { name: /Enable community plugins/i })).toBeVisible({
      timeout: 5_000,
    });
  }
  if (scene.id === "settings-extensions-permission-desktop-light") {
    await expect(page.getByRole("dialog", { name: /Plugin Permissions/i })).toBeVisible({
      timeout: 5_000,
    });
  }
  if (scene.expandPlugin) {
    await expect(
      page.getByRole("button", { name: new RegExp(`Collapse ${scene.expandPlugin}`, "i") }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Work Duration", { exact: false }).first()).toBeVisible({
      timeout: 5_000,
    });
  }

  for (const text of scene.assertText ?? []) {
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
  }
}

test.describe.configure({ mode: "serial" });

for (const scene of SCENES) {
  test(`capture ${scene.id}`, async ({ page }) => {
    mkdirSync(OUT_DIR, { recursive: true });
    await openScene(page, scene);
    const root = page.getByTestId("phase7-scene-root");
    await expect(root).toBeVisible();
    const target = path.join(OUT_DIR, scene.file);
    // Use the viewport screenshot so position:fixed legacy dialogs (safety,
    // permissions, PluginBrowser) are included. Element screenshots clip them out.
    await page.screenshot({
      path: target,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
  });
}
