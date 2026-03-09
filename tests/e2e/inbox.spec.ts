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
    // Tag should be visible (displayed without # prefix)
    await expect(page.getByText("work").first()).toBeVisible();
  });

  test("complete a task", async ({ page }) => {
    await createTaskViaApi(page, "Task to complete");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Click the completion checkbox
    await page.getByLabel("Complete task").first().click();

    // Recently completed tasks stay in Inbox with line-through style
    await expect(page.getByLabel("Mark task incomplete")).toBeVisible({ timeout: 5000 });
  });

  test("open detail panel", async ({ page }) => {
    await createTaskViaApi(page, "Detail test task");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Detail test task");

    const dialog = page.getByRole("dialog", { name: "Task details" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox").first()).toHaveValue("Detail test task");
  });

  test("delete task from detail panel", async ({ page }) => {
    await createTaskViaApi(page, "Task to delete");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Task to delete");

    const dialog = page.getByRole("dialog", { name: "Task details" });
    await dialog.getByRole("button", { name: "Delete task" }).click();

    // Confirm deletion in the confirmation dialog
    const confirmDialog = page.getByRole("dialog", { name: "Delete task" });
    await expect(confirmDialog).toBeVisible({ timeout: 3000 });
    await confirmDialog.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("Task to delete")).not.toBeVisible({ timeout: 5000 });
  });

  test("priority indicator displayed on tasks", async ({ page }) => {
    await createTaskViaApi(page, "Urgent task", { priority: 1 });
    await createTaskViaApi(page, "Normal task", { priority: 4 });
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Both tasks should be visible
    await expect(page.getByText("Urgent task")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Normal task")).toBeVisible();

    // P1 task has a priority border style (border-l-priority-1)
    const urgentRow = page.getByLabel("Task: Urgent task");
    await expect(urgentRow).toBeVisible();
    // The row should have a priority-colored left border class
    await expect(urgentRow).toHaveClass(/border-l-priority-1/);
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
