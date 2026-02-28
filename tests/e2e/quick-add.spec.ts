import { test, expect } from "@playwright/test";
import { setupPage } from "./helpers.js";

test.describe("Quick add modal", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("opens with Ctrl+N", async ({ page }) => {
    await page.keyboard.press("Control+n");

    await expect(page.getByText("Quick Add")).toBeVisible({ timeout: 5000 });
    await expect(page.getByPlaceholder(/Add a task/i)).toBeFocused();
  });

  test("creates task and closes", async ({ page }) => {
    await page.keyboard.press("Control+n");
    await expect(page.getByText("Quick Add")).toBeVisible({ timeout: 5000 });

    const input = page.getByPlaceholder(/Add a task/i).last();
    await input.fill("Quick added task");
    await input.press("Enter");

    // Modal should close after submission
    await expect(page.getByText("Quick Add")).not.toBeVisible({ timeout: 5000 });

    // Task should appear in Inbox
    await expect(page.getByText("Quick added task")).toBeVisible({ timeout: 5000 });
  });

  test("closes with Escape", async ({ page }) => {
    await page.keyboard.press("Control+n");
    await expect(page.getByText("Quick Add")).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");

    await expect(page.getByText("Quick Add")).not.toBeVisible({ timeout: 5000 });
  });
});
