import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, navigateTo, localDateKey } from "./helpers.js";

test.describe("Today view", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("shows today's tasks", async ({ page }) => {
    const today = localDateKey();
    await createTaskViaApi(page, "Today task A", { dueDate: today });
    await createTaskViaApi(page, "Today task B", { dueDate: today });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");

    await expect(page.getByText("Today task A")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Today task B")).toBeVisible();
  });

  test("shows overdue tasks", async ({ page }) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    await createTaskViaApi(page, "Overdue task", {
      dueDate: localDateKey(yesterday),
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");

    await expect(page.getByText("Overdue task")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/overdue/i).first()).toBeVisible();
  });

  test("shows task count", async ({ page }) => {
    const today = localDateKey();
    await createTaskViaApi(page, "Count task 1", { dueDate: today });
    await createTaskViaApi(page, "Count task 2", { dueDate: today });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");

    await expect(page.getByText("2 tasks")).toBeVisible({ timeout: 5000 });
  });

  test("shows date header with Today label", async ({ page }) => {
    const today = localDateKey();
    await createTaskViaApi(page, "Header test", { dueDate: today });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");

    // Date header should contain "Today"
    await expect(page.getByText(/· Today ·/).first()).toBeVisible({ timeout: 5000 });
  });

  test("new task created in Today defaults to today", async ({ page }) => {
    await navigateTo(page, "Today");

    const input = page.getByPlaceholder(/Add a task/i);
    await input.click();
    await input.fill("Quick errand for now");
    await input.press("Enter");

    await expect(page.getByText("Quick errand for now")).toBeVisible({ timeout: 5000 });
  });
});
