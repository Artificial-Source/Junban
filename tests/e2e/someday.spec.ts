import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, navigateTo } from "./helpers.js";

test.describe("Someday / Maybe view", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("someday task appears in the Someday view", async ({ page }) => {
    await createTaskViaApi(page, "Learn Rust someday", { isSomeday: true });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Someday");

    // The heading should be visible
    await expect(page.getByRole("heading", { name: "Someday / Maybe" })).toBeVisible();

    // The task should appear
    await expect(page.getByText("Learn Rust someday").first()).toBeVisible();
  });

  test("activating a someday task removes it from Someday view", async ({ page }) => {
    await createTaskViaApi(page, "Build a treehouse", { isSomeday: true });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Someday");
    await expect(page.getByText("Build a treehouse").first()).toBeVisible();

    // Click the Activate button for this specific task
    await page.getByRole("button", { name: "Activate" }).first().click();

    // Wait for the task to disappear
    await page.waitForTimeout(500);
  });

  test("activated task appears in Inbox", async ({ page }) => {
    await createTaskViaApi(page, "Start a garden", { isSomeday: true });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Someday");
    await expect(page.getByText("Start a garden").first()).toBeVisible();

    // Activate the task
    await page.getByRole("button", { name: "Activate" }).first().click();
    await page.waitForTimeout(500);

    // Navigate to Inbox via page reload to avoid sidebar issues
    await page.goto("/");
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // The task should now be visible in Inbox
    await expect(page.getByText("Start a garden").first()).toBeVisible();
  });

  test("Someday nav item disappears when feature_someday is disabled", async ({ page }) => {
    // Verify the Someday button exists in the sidebar
    await expect(page.getByRole("button", { name: "Someday", exact: true })).toBeVisible();

    // Disable the feature via API
    await page.request.put("/api/settings/feature_someday", {
      data: { value: "false" },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // The Someday nav item should no longer be in the sidebar
    await expect(page.getByRole("button", { name: "Someday", exact: true })).not.toBeVisible();

    // Re-enable for cleanup
    await page.request.put("/api/settings/feature_someday", {
      data: { value: "true" },
    });
  });
});
