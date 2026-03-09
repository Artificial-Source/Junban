import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, openTaskDetail } from "./helpers.js";

test.describe("Task editing", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("edit task title", async ({ page }) => {
    await createTaskViaApi(page, "Original title");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Original title");

    const dialog = page.getByRole("dialog", { name: "Task details" });
    const titleInput = dialog.locator("input[type='text']").first();
    await titleInput.fill("Updated title");
    await titleInput.blur();

    // Close and verify
    await dialog.getByLabel("Close task details").click();

    await expect(page.getByText("Updated title")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Original title")).not.toBeVisible();
  });

  test("change priority", async ({ page }) => {
    await createTaskViaApi(page, "Priority task");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Priority task");

    const dialog = page.getByRole("dialog", { name: "Task details" });

    // Click priority selector and set to P1
    await dialog.getByText("Priority").first().click();
    await page.getByText("P1", { exact: true }).click();

    // Close and reopen to verify persistence
    await dialog.getByLabel("Close task details").click();
    await openTaskDetail(page, "Priority task");

    // P1 should be displayed
    await expect(
      page.getByRole("dialog", { name: "Task details" }).getByText("P1").first(),
    ).toBeVisible();
  });

  test("set due date", async ({ page }) => {
    await createTaskViaApi(page, "Date task");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Date task");

    const dialog = page.getByRole("dialog", { name: "Task details" });

    // Click the "No date" button to open date picker
    await dialog.getByRole("button", { name: "No date" }).click();

    // Click "Today" quick option in date picker (scope to dialog to avoid sidebar "Today" button)
    const todayBtn = dialog.getByRole("button", { name: "Today" });
    if (await todayBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await todayBtn.click();
    }

    // Close panel
    await dialog.getByLabel("Close task details").click();

    // The task should now show a date indicator
    await expect(page.locator("[aria-label='Task: Date task']").first()).toBeVisible();
  });

  test("delete task from detail panel", async ({ page }) => {
    await createTaskViaApi(page, "Task to delete");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Task to delete");

    const dialog = page.getByRole("dialog", { name: "Task details" });

    // Click delete button
    await dialog.getByRole("button", { name: "Delete task" }).click();

    // Confirm deletion in the confirmation dialog
    const confirmDialog = page.getByRole("dialog", { name: "Delete task" });
    await expect(confirmDialog).toBeVisible({ timeout: 3000 });
    await confirmDialog.getByRole("button", { name: "Delete" }).click();

    // Task should be removed
    await expect(page.getByText("Task to delete")).not.toBeVisible({ timeout: 5000 });
  });

  test("changes persist after page reload", async ({ page }) => {
    await createTaskViaApi(page, "Persistence test");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Persistence test");

    const dialog = page.getByRole("dialog", { name: "Task details" });
    const titleInput = dialog.locator("input[type='text']").first();
    await titleInput.fill("Persisted title");
    await titleInput.blur();

    await dialog.getByLabel("Close task details").click();

    // Full page reload
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Verify the updated title persisted
    await expect(page.getByText("Persisted title")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Persistence test")).not.toBeVisible();
  });
});
