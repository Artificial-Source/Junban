import { test, expect } from "@playwright/test";
import { setupPage, localDateKey } from "./helpers";

const TB_PERMISSIONS = [
  "task:read",
  "task:write",
  "commands",
  "ui:view",
  "ui:status",
  "storage",
  "settings",
];

test.describe("Timeblocking Plugin", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    // Approve timeblocking plugin permissions so it loads
    await page.request.post("/api/plugins/timeblocking/permissions/approve", {
      data: { permissions: TB_PERMISSIONS },
    });
    // Reload to pick up the newly loaded plugin
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    // Wait for plugin views to load
    await expect(page.getByRole("button", { name: /Timeblocking/i })).toBeVisible({
      timeout: 10000,
    });
  });

  test("navigates to timeblocking view", async ({ page }) => {
    const tbButton = page.getByRole("button", { name: /Timeblocking/i });
    await tbButton.click();

    // Wait for the view to render (lazy-loaded via proxy)
    await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15000 });
    // Use locator scoped to main content to avoid matching sidebar "Today" nav
    await expect(
      page.locator("#main-content").getByRole("button", { name: "Today" }),
    ).toBeVisible();
    await expect(page.getByTestId("date-range-label")).toBeVisible();
  });

  test("renders timeline column for today", async ({ page }) => {
    const tbButton = page.getByRole("button", { name: /Timeblocking/i });
    await tbButton.click();
    await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15000 });

    // Timeline column for today should be rendered
    const today = localDateKey();
    const column = page.getByTestId(`timeline-column-${today}`);
    await expect(column).toBeVisible();
  });

  test("switches between day and week views", async ({ page }) => {
    const tbButton = page.getByRole("button", { name: /Timeblocking/i });
    await tbButton.click();
    await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15000 });

    // Default is day view (1 column)
    await expect(page.getByTestId("view-mode-1")).toBeVisible();

    // Click Week button
    await page.getByTestId("view-mode-7").click();

    // Should see multiple column headers
    const today = localDateKey();
    await expect(page.getByTestId(`column-header-${today}`)).toBeVisible();

    // Click Day button to go back
    await page.getByTestId("view-mode-1").click();
    // Column headers should disappear (day view has no column headers)
    await expect(page.getByTestId(`column-header-${today}`)).not.toBeVisible();
  });

  test("navigates dates with arrows", async ({ page }) => {
    const tbButton = page.getByRole("button", { name: /Timeblocking/i });
    await tbButton.click();
    await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15000 });

    // Note the current date label
    const dateLabel = page.getByTestId("date-range-label");
    const initialText = await dateLabel.textContent();

    // Click next arrow
    await page.getByLabel("Next day").click();
    const nextText = await dateLabel.textContent();
    expect(nextText).not.toBe(initialText);

    // Click Today button (scoped to main content to avoid sidebar nav)
    await page.locator("#main-content").getByRole("button", { name: "Today" }).click();
    await expect(dateLabel).toHaveText(initialText!);
  });

  test("shows view mode buttons and 3D/5D views work", async ({ page }) => {
    const tbButton = page.getByRole("button", { name: /Timeblocking/i });
    await tbButton.click();
    await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15000 });

    // Click 3D button
    await page.getByTestId("view-mode-3").click();

    // Should see 3 columns
    const columns = page.locator('[data-testid^="timeline-column-"]');
    await expect(columns).toHaveCount(3);

    // Click 5D button
    await page.getByTestId("view-mode-5").click();
    await expect(columns).toHaveCount(5);
  });

  test("has settings popover accessible from header", async ({ page }) => {
    const tbButton = page.getByRole("button", { name: /Timeblocking/i });
    await tbButton.click();
    await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15000 });

    // Click settings gear
    await page.getByTestId("tb-settings-trigger").click();

    // Settings popover should appear
    await expect(page.getByTestId("tb-settings-popover")).toBeVisible();
    await expect(page.getByTestId("tb-setting-start")).toBeVisible();
    await expect(page.getByTestId("tb-setting-end")).toBeVisible();
    await expect(page.getByTestId("tb-setting-grid")).toBeVisible();
    await expect(page.getByTestId("tb-setting-duration")).toBeVisible();
  });

  test("sidebar toggle works", async ({ page }) => {
    const tbButton = page.getByRole("button", { name: /Timeblocking/i });
    await tbButton.click();
    await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15000 });

    // Sidebar should be visible initially
    const toggle = page.getByTestId("sidebar-toggle");
    await expect(toggle).toBeVisible();

    // Click to collapse
    await toggle.click();
    // Sidebar divider should not be visible
    await expect(page.getByTestId("sidebar-divider")).not.toBeVisible();

    // Click to expand
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("sidebar-divider")).toBeVisible();
  });
});
