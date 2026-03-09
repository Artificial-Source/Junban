import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, navigateTo, localDateKey } from "./helpers.js";

test.describe("Workload capacity bar", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("capacity bar shows planned vs capacity", async ({ page }) => {
    const today = localDateKey();

    await createTaskViaApi(page, "Task A", { dueDate: today, estimatedMinutes: 60 });
    await createTaskViaApi(page, "Task B", { dueDate: today, estimatedMinutes: 60 });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");

    // Wait for tasks to appear
    await expect(page.getByText("Task A")).toBeVisible({ timeout: 5000 });

    // Should show "2h / 8h planned" (default capacity is 8h = 480min)
    await expect(page.getByText(/2h.*\/.*8h.*planned/)).toBeVisible({ timeout: 5000 });
  });

  test("over-capacity shows warning", async ({ page }) => {
    const today = localDateKey();

    // Create tasks summing to 600 minutes (10 hours, over 8h default capacity)
    await createTaskViaApi(page, "Big task 1", { dueDate: today, estimatedMinutes: 300 });
    await createTaskViaApi(page, "Big task 2", { dueDate: today, estimatedMinutes: 300 });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");

    // Wait for tasks to appear
    await expect(page.getByText("Big task 1")).toBeVisible({ timeout: 5000 });

    // Should show "+Xh over" in the capacity bar
    await expect(page.getByText(/\+.*over/)).toBeVisible({ timeout: 5000 });
  });

  test("hidden when no estimates", async ({ page }) => {
    const today = localDateKey();

    await createTaskViaApi(page, "No estimate task", { dueDate: today });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");

    // The capacity bar should not appear when there are no estimated minutes
    await expect(page.getByText(/planned/)).not.toBeVisible();
  });
});
