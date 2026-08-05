/**
 * Phase 6 immutable visual suite.
 * Compares rewrite rendering against legacy-captured PNGs (byte-identical snapshots).
 * Never regenerates authority images; fix failures in production or fixture presentation.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { appUrlWithToken, startServer, type ServerContext } from "./fixtures";

const AUTHORITY_DIR = join(
  process.cwd(),
  "goals/rust-rewrite/evidence/phase-6-legacy-visual-baseline",
);
const SNAPSHOT_DIR = join(import.meta.dirname, "visual-phase-6.spec.ts-snapshots");
const PLATFORM =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";

// maxDiffPixelRatio is frozen at 0.01; threshold follows Phase 3 antialiasing convention.
const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.01, threshold: 0.35 };

type ManifestScene = {
  id: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  theme: "light" | "dark";
  maxDiffPixelRatio: number;
  viewport: { width: number; height: number; deviceScaleFactor: number };
};

type Manifest = {
  scenes: ManifestScene[];
  policy: { maxDiffPixelRatio: number };
  environment: { clock: string };
};

const manifest = JSON.parse(readFileSync(join(AUTHORITY_DIR, "manifest.json"), "utf8")) as Manifest;

let server: ServerContext;

test.beforeAll(async () => {
  expect(manifest.scenes).toHaveLength(16);
  expect(manifest.policy.maxDiffPixelRatio).toBe(0.01);

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const scene of manifest.scenes) {
    const src = join(AUTHORITY_DIR, scene.file);
    expect(existsSync(src), `missing authority ${scene.file}`).toBe(true);
    const bytes = readFileSync(src);
    expect(bytes.byteLength, scene.file).toBe(scene.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"), scene.file).toBe(scene.sha256);
    expect(scene.maxDiffPixelRatio).toBe(0.01);

    const dest = join(SNAPSHOT_DIR, `${scene.id}-visual-phase-6-${PLATFORM}.png`);
    copyFileSync(src, dest);
    const snapBytes = readFileSync(dest);
    expect(createHash("sha256").update(snapBytes).digest("hex"), dest).toBe(scene.sha256);
  }

  server = await startServer({ seed: false });
});

test.afterAll(async () => {
  await server.cleanup();
});

async function openScene(page: Page, scene: ManifestScene) {
  await page.setViewportSize({
    width: scene.viewport.width,
    height: scene.viewport.height,
  });
  await page.clock.setFixedTime(new Date(manifest.environment.clock));
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
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (
      url.startsWith(server.baseUrl) ||
      url.startsWith("data:") ||
      url.startsWith("blob:") ||
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost")
    ) {
      await route.continue();
      return;
    }
    await route.abort();
  });

  const path = `/?visual-fixture=phase-6&scene=${encodeURIComponent(scene.id)}`;
  await page.goto(appUrlWithToken(server.baseUrl, server.token, path), {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("phase6-scene-root")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => page.locator("html").getAttribute("data-phase6-ready"), {
      timeout: 30_000,
    })
    .toBe("1");
  await page.evaluate(() => document.fonts.ready);
  // Match the capture suite's justified font/render settle only.
  await page.waitForTimeout(400);
}

test("phase 6 legacy authority files match their immutable manifest", async () => {
  expect(manifest.scenes).toHaveLength(16);
  for (const scene of manifest.scenes) {
    const bytes = readFileSync(join(AUTHORITY_DIR, scene.file));
    expect(createHash("sha256").update(bytes).digest("hex"), scene.file).toBe(scene.sha256);
    expect(bytes.byteLength, scene.file).toBe(scene.bytes);
  }
});

for (const scene of manifest.scenes) {
  test(`visual phase-6: ${scene.id}`, async ({ page }) => {
    await openScene(page, scene);
    const root = page.getByTestId("phase6-scene-root");
    await expect(root).toHaveScreenshot(`${scene.id}.png`, {
      ...SCREENSHOT_OPTS,
      animations: "disabled",
    });
  });
}
