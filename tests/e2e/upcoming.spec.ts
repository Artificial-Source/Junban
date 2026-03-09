import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, navigateTo, localDateKey } from "./helpers.js";

test.describe("Upcoming view", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("tasks grouped by date", async ({ page }) => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(today);
    dayAfter.setDate(dayAfter.getDate() + 2);

    await createTaskViaApi(page, "Tomorrow task", { dueDate: localDateKey(tomorrow) });
    await createTaskViaApi(page, "Day after task", { dueDate: localDateKey(dayAfter) });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Upcoming");

    await expect(page.getByText("Tomorrow task")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Day after task")).toBeVisible();
  });

  test("shows overdue tasks", async ({ page }) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    await createTaskViaApi(page, "Overdue upcoming", {
      dueDate: localDateKey(yesterday),
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Upcoming");

    await expect(page.getByText("Overdue upcoming")).toBeVisible({ timeout: 5000 });
  });

  test("empty state when no upcoming tasks", async ({ page }) => {
    await navigateTo(page, "Upcoming");

    await expect(page.getByText("No upcoming tasks")).toBeVisible({ timeout: 5000 });
  });

  test("displays task count", async ({ page }) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    await createTaskViaApi(page, "Upcoming 1", { dueDate: localDateKey(tomorrow) });
    await createTaskViaApi(page, "Upcoming 2", { dueDate: localDateKey(tomorrow) });
    await createTaskViaApi(page, "Upcoming 3", { dueDate: localDateKey(tomorrow) });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Upcoming");

    await expect(page.getByText("3 tasks")).toBeVisible({ timeout: 5000 });
  });
});
