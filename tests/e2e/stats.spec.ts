import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, completeTaskViaApi, navigateTo } from "./helpers.js";

test.describe("Productivity stats view", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("Stats view renders with the Productivity heading", async ({ page }) => {
    await navigateTo(page, "Stats");

    await expect(page.getByRole("heading", { name: "Productivity" })).toBeVisible();
  });

  test("displays completed task count after completing tasks", async ({ page }) => {
    // Create 3 tasks via API
    const task1 = await createTaskViaApi(page, "Stats task one");
    const task2 = await createTaskViaApi(page, "Stats task two");
    const _task3 = await createTaskViaApi(page, "Stats task three");

    // Complete 2 of them
    await completeTaskViaApi(page, task1.id);
    await completeTaskViaApi(page, task2.id);

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Stats");

    await expect(page.getByRole("heading", { name: "Productivity" })).toBeVisible();

    // The stats view should show completed task count (at least 2, may be more from previous runs)
    // Use the main content area to scope and look for "completed tasks" text
    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByText(/completed tasks/).first()).toBeVisible({ timeout: 5000 });
  });

  test("shows today's completed count", async ({ page }) => {
    // Create and complete a task
    const task = await createTaskViaApi(page, "Finish today");
    await completeTaskViaApi(page, task.id);

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Stats");

    // The main content should have a "Today" heading/label for daily stats
    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByText("Today").first()).toBeVisible();

    // There should be at least 1 task completed today (may be singular "task completed")
    await expect(mainContent.getByText(/tasks? completed/).first()).toBeVisible();
  });

  test("Stats nav item disappears when feature_stats is disabled", async ({ page }) => {
    // Verify the Stats button exists in the sidebar
    await expect(page.getByRole("button", { name: "Stats", exact: true })).toBeVisible();

    // Disable the feature via API
    await page.request.put("/api/settings/feature_stats", {
      data: { value: "false" },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // The Stats nav item should no longer be in the sidebar
    await expect(page.getByRole("button", { name: "Stats", exact: true })).not.toBeVisible();

    // Re-enable for cleanup
    await page.request.put("/api/settings/feature_stats", {
      data: { value: "true" },
    });
  });
});
