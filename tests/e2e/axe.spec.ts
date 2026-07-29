import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startServer, appUrlWithToken, type ServerContext } from "./fixtures";

let server: ServerContext;

test.beforeAll(async () => {
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

async function authenticate(
  page: import("@playwright/test").Page,
  path: string = "/today",
): Promise<void> {
  await page.goto(appUrlWithToken(server.baseUrl, server.token, path));
  await page.waitForSelector("h1", { timeout: 5000 });
}

test("axe: Today desktop has no serious/critical violations", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page, "/today");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(serious, `${JSON.stringify(serious, null, 2)}`).toHaveLength(0);
});

test("axe: Inbox desktop has no serious/critical violations", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page, "/inbox");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(serious, `${JSON.stringify(serious, null, 2)}`).toHaveLength(0);
});

test("axe: Today mobile has no serious/critical violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authenticate(page, "/today");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(serious, `${JSON.stringify(serious, null, 2)}`).toHaveLength(0);
});

test("axe: Inbox mobile has no serious/critical violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authenticate(page, "/inbox");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(serious, `${JSON.stringify(serious, null, 2)}`).toHaveLength(0);
});

test("axe: 320x240 representative check has no serious/critical violations", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 240 });
  await authenticate(page, "/today");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(serious, `${JSON.stringify(serious, null, 2)}`).toHaveLength(0);
});

test("keyboard: skip link is focusable and functional", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page, "/today");

  // Tab to focus the skip link
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeVisible();
  await skipLink.press("Enter");

  // Main content should be focused
  const main = page.locator("#main-content");
  await expect(main).toBeFocused();
});

test("keyboard: task input is focusable and operable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page, "/today");

  // Tab to find the task input
  const input = page.getByPlaceholder("Add a task for today...");
  await input.focus();
  await expect(input).toBeFocused();

  // Type and submit
  await input.fill("Keyboard test task");
  await input.press("Enter");
  await expect(page.getByText("Keyboard test task")).toBeVisible({ timeout: 5000 });
});
