import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startServer, appUrlWithToken, type ServerContext } from "./fixtures";

let server: ServerContext;

test.beforeAll(async () => {
  server = await startServer({ seed: true });
});

test.afterAll(async () => {
  await server.cleanup();
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-23T10:30:00-07:00"));
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

test("keyboard: task dialog traps focus, escapes, and restores its opener", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page, "/today");

  const opener = page.getByRole("button", {
    name: "Edit task: Review accessibility audit findings",
  });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: /Task: Review accessibility audit findings/ });
  await expect(dialog.getByRole("textbox", { name: "Task title", exact: true })).toBeFocused();
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => Boolean(element.closest('[inert][aria-hidden="true"]'))),
  ).toBe(true);

  const close = dialog.getByRole("button", { name: "Close task details" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Delete task" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(
    await page.locator("#main-content").evaluate((element) => Boolean(element.closest("[inert]"))),
  ).toBe(false);
});

test("a11y: mobile drawer traps focus, escapes, and restores menu trigger (P2-A11Y-001)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authenticate(page, "/today");

  const menu = page.getByRole("button", { name: "Open navigation menu" });
  await menu.click();

  const drawer = page.getByRole("dialog", { name: "Navigation drawer" });
  await expect(drawer).toBeVisible();
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => Boolean(element.closest('[inert][aria-hidden="true"]'))),
  ).toBe(true);

  const focusedInDrawer = await page.evaluate(() => {
    const d = document.querySelector('[aria-label="Navigation drawer"]');
    return !!(d && document.activeElement && d.contains(document.activeElement));
  });
  expect(focusedInDrawer).toBe(true);

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();
});

test("a11y: command palette combobox is labelled without nested option buttons (P2-A11Y-006)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page, "/today");

  await page.keyboard.press("Control+Shift+P");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  const combobox = dialog.getByRole("combobox", { name: "Filter commands" });
  await expect(combobox).toBeVisible();
  await expect(combobox).toBeFocused();

  await expect(dialog.getByRole("option").first()).toBeVisible();
  const nestedButtons = await dialog.locator('[role="option"] button').count();
  expect(nestedButtons).toBe(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a11y: Add Project closes on Escape (P2-A11Y-004)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page, "/today");

  await page.keyboard.press("Control+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New Project" });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
