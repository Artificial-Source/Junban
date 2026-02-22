import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, updateTaskViaApi, navigateTo } from "./helpers.js";

test.describe("Cancelled tasks view", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("cancelled task appears in the Cancelled view", async ({ page }) => {
    const task = await createTaskViaApi(page, "Abandoned feature");
    await updateTaskViaApi(page, task.id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Cancelled");

    // The cancelled view should show the heading
    await expect(page.getByRole("heading", { name: "Cancelled" })).toBeVisible();

    // The task should appear in the list
    await expect(page.getByText("Abandoned feature").first()).toBeVisible();
  });

  test("restoring a cancelled task removes it from Cancelled view", async ({ page }) => {
    const task = await createTaskViaApi(page, "Restore me");
    await updateTaskViaApi(page, task.id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Cancelled");
    await expect(page.getByText("Restore me").first()).toBeVisible();

    // Click the Restore button for this specific task
    await page.getByRole("button", { name: "Restore" }).first().click();

    // Wait for the task to disappear
    await page.waitForTimeout(500);
  });

  test("restored task reappears in Inbox", async ({ page }) => {
    const task = await createTaskViaApi(page, "Come back to Inbox");
    await updateTaskViaApi(page, task.id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });

    // Verify the task is in Cancelled view
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Cancelled");
    await expect(page.getByText("Come back to Inbox").first()).toBeVisible();

    // Restore the task via API (set status back to pending and clear completedAt)
    await updateTaskViaApi(page, task.id, {
      status: "pending",
      completedAt: null,
    });

    // Navigate to Inbox and verify the task is there
    await page.goto("/");
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // The task should now be visible in Inbox (it was restored from cancelled)
    await expect(page.getByText("Come back to Inbox").first()).toBeVisible({ timeout: 10000 });
  });

  test("Cancelled nav item disappears when feature_cancelled is disabled", async ({ page }) => {
    // Verify the Cancelled button exists in the sidebar
    await expect(page.getByRole("button", { name: "Cancelled", exact: true })).toBeVisible();

    // Disable the feature via API
    await page.request.put("/api/settings/feature_cancelled", {
      data: { value: "false" },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // The Cancelled nav item should no longer be in the sidebar
    await expect(page.getByRole("button", { name: "Cancelled", exact: true })).not.toBeVisible();

    // Re-enable for cleanup
    await page.request.put("/api/settings/feature_cancelled", {
      data: { value: "true" },
    });
  });
});
