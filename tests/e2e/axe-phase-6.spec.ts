/**
 * Phase 6 accessibility coverage for AI/voice surfaces.
 * Uses exact fixture state; no provider/mic/model side effects.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { appUrlWithToken, startServer, type ServerContext } from "./fixtures";

let server: ServerContext;

const SCENES = [
  {
    id: "ai-welcome-briefing-desktop-light",
    viewport: { width: 1440, height: 900 },
  },
  {
    id: "ai-conversation-tools-desktop-light",
    viewport: { width: 1440, height: 900 },
  },
  {
    id: "ai-chat-history-desktop-light",
    viewport: { width: 1440, height: 900 },
  },
  {
    id: "settings-ai-unconfigured-desktop-light",
    viewport: { width: 1280, height: 900 },
  },
  {
    id: "settings-voice-defaults-desktop-light",
    viewport: { width: 1280, height: 900 },
  },
  {
    id: "ptt-error-desktop-light",
    viewport: { width: 480, height: 320 },
  },
  {
    id: "ptt-listening-desktop-light",
    viewport: { width: 480, height: 320 },
  },
  {
    id: "vad-grace-desktop-light",
    viewport: { width: 480, height: 420 },
  },
  {
    id: "voice-call-states-desktop-light",
    viewport: { width: 1280, height: 900 },
  },
  {
    id: "ai-mobile-view-nav-light",
    viewport: { width: 390, height: 844 },
  },
] as const;

test.beforeAll(async () => {
  server = await startServer({ seed: false });
});

test.afterAll(async () => {
  await server.cleanup();
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-02T15:00:00.000Z"));
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

async function openFixture(
  page: Page,
  sceneId: string,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize(viewport);
  const path = `/?visual-fixture=phase-6&scene=${encodeURIComponent(sceneId)}`;
  await page.goto(appUrlWithToken(server.baseUrl, server.token, path));
  await expect(page.getByTestId("phase6-scene-root")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoSerious(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(serious, `${label}: ${JSON.stringify(serious, null, 2)}`).toHaveLength(0);
}

for (const scene of SCENES) {
  test(`axe phase-6: ${scene.id} has no serious/critical violations`, async ({ page }) => {
    await openFixture(page, scene.id, scene.viewport);
    await expectNoSerious(page, scene.id);
  });
}

test("a11y phase-6: history close control and list semantics", async ({ page }) => {
  await openFixture(page, "ai-chat-history-desktop-light", { width: 1440, height: 900 });
  const history = page.getByLabel("Chat history");
  await expect(history).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
  await page.getByRole("button", { name: "Hide" }).focus();
  await expect(page.getByRole("button", { name: "Hide" })).toBeFocused();
});

test("a11y phase-6: PTT error guidance and retry are keyboard reachable", async ({ page }) => {
  await openFixture(page, "ptt-error-desktop-light", { width: 480, height: 320 });
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/Microphone access was denied/i);
  const retry = page.getByRole("button", { name: /Retry microphone access/i });
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
});

test("a11y phase-6: call overlay End control is distinct and labelled", async ({ page }) => {
  await openFixture(page, "vad-grace-desktop-light", { width: 480, height: 420 });
  const end = page.getByRole("button", { name: "End call" });
  await expect(end).toBeVisible();
  await expect(page.getByTestId("call-state-label")).toHaveText("Waiting...");
  await end.focus();
  await expect(end).toBeFocused();
});

test("a11y phase-6: settings keyboard path reaches AI provider control", async ({ page }) => {
  await openFixture(page, "settings-ai-unconfigured-desktop-light", {
    width: 1280,
    height: 900,
  });
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible();
  const provider = page.locator("#ai-provider");
  await provider.focus();
  await expect(provider).toBeFocused();
});

test("a11y phase-6: mobile AI nav raised control is named", async ({ page }) => {
  await openFixture(page, "ai-mobile-view-nav-light", { width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI Assistant" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible();
});
