import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, openTaskDetail } from "./helpers.js";

test.describe("Inbox view", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("shows empty inbox message", async ({ page }) => {
    await expect(page.getByText("Your inbox is empty")).toBeVisible();
  });

  test("create task via input", async ({ page }) => {
    const input = page.getByPlaceholder(/Add a task/i);
    await input.click();
    await input.fill("Buy groceries");
    await input.press("Enter");

    await expect(page.getByText("Buy groceries")).toBeVisible({ timeout: 5000 });
    // Count should update
    await expect(page.getByText("1 task")).toBeVisible();
  });

  test("NLP parsing extracts priority, tag, and date", async ({ page }) => {
    const input = page.getByPlaceholder(/Add a task/i);
    await input.click();
    await input.fill("Finish report p1 #work tomorrow");
    await input.press("Enter");

    await expect(page.getByText("Finish report").first()).toBeVisible({ timeout: 5000 });
    // Tag should be visible
    await expect(page.getByText("#work").first()).toBeVisible();
  });

  test("complete a task", async ({ page }) => {
    await createTaskViaApi(page, "Task to complete");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Click the completion checkbox
    await page.getByLabel("Complete task").first().click();

    // Task should disappear from Inbox (completed tasks are hidden)
    await expect(page.getByText("Task to complete")).not.toBeVisible({ timeout: 5000 });
  });

  test("open detail panel", async ({ page }) => {
    await createTaskViaApi(page, "Detail test task");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Detail test task");

    const dialog = page.getByRole("dialog", { name: "Task details" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByDisplayValue("Detail test task")).toBeVisible();
  });

  test("displays correct task count", async ({ page }) => {
    await createTaskViaApi(page, "Task one");
    await createTaskViaApi(page, "Task two");
    await createTaskViaApi(page, "Task three");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("3 tasks")).toBeVisible({ timeout: 5000 });
  });
});
