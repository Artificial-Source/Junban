import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, openTaskDetail, closeTaskDetail } from "./helpers.js";

const dialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Task details" });

test.describe("Task descriptions", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("can type a description in the task detail panel", async ({ page }) => {
    await createTaskViaApi(page, "Write docs");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Write docs");

    await dialog(page).getByLabel("Description").click();

    const textarea = dialog(page).getByLabel("Description");
    await expect(textarea).toBeVisible();

    await textarea.fill(
      "## Overview\n\n**Bold text** and regular text.\n\n- Item one\n- Item two\n- Item three",
    );

    // Click on the task title input within the dialog to blur the description
    await dialog(page).locator("input[type='text']").first().click();

    // Close and reopen the detail panel to verify persistence
    await closeTaskDetail(page);
    await openTaskDetail(page, "Write docs");

    // After reopen, the description is shown as markdown preview — check for rendered content
    await expect(dialog(page).getByText("Bold text")).toBeVisible();
    await expect(dialog(page).getByText("Item one")).toBeVisible();
  });

  test("empty description shows Description button", async ({ page }) => {
    await createTaskViaApi(page, "Empty description task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Empty description task");

    await expect(dialog(page).getByLabel("Description")).toBeVisible();
  });

  test("description persists across page reloads", async ({ page }) => {
    await createTaskViaApi(page, "Persistent description");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Persistent description");

    await dialog(page).getByLabel("Description").click();

    const textarea = dialog(page).getByLabel("Description");
    await textarea.fill("This should persist after reload.");

    // Blur to save
    await dialog(page).locator("input[type='text']").first().click();

    // Close detail panel
    await closeTaskDetail(page);

    // Reload the entire page
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Reopen the task detail
    await openTaskDetail(page, "Persistent description");

    // Description is now shown as markdown preview
    await expect(dialog(page).getByText("This should persist after reload.")).toBeVisible();
  });

  test("description can be cleared", async ({ page }) => {
    await createTaskViaApi(page, "Clear me");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Clear me");

    await dialog(page).getByLabel("Description").click();

    const textarea = dialog(page).getByLabel("Description");
    await textarea.fill("Some initial text");

    // Blur to save
    await dialog(page).locator("input[type='text']").first().click();

    // Click the markdown preview to re-enter edit mode
    await dialog(page).getByText("Some initial text").click();

    // Clear the description
    const editTextarea = dialog(page).getByLabel("Description");
    await editTextarea.fill("");

    // Blur to save
    await dialog(page).locator("input[type='text']").first().click();

    // Close and reopen to verify it was cleared
    await closeTaskDetail(page);
    await openTaskDetail(page, "Clear me");

    await expect(dialog(page).getByLabel("Description")).toBeVisible();
  });

  test("description supports multi-line text with newlines", async ({ page }) => {
    await createTaskViaApi(page, "Multi-line task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Multi-line task");

    await dialog(page).getByLabel("Description").click();

    const textarea = dialog(page).getByLabel("Description");
    const multiLineText = "Line 1\nLine 2\nLine 3\n\nParagraph 2";
    await textarea.fill(multiLineText);

    // Blur to save
    await dialog(page).locator("input[type='text']").first().click();

    // Close and reopen
    await closeTaskDetail(page);
    await openTaskDetail(page, "Multi-line task");

    // Verify the text is rendered (markdown preview)
    await expect(dialog(page).getByText("Line 1")).toBeVisible();
    await expect(dialog(page).getByText("Paragraph 2")).toBeVisible();
  });

  test("description set via API is shown in the detail panel", async ({ page }) => {
    const task = await createTaskViaApi(page, "API description task");

    // Update the task with a description
    await page.request.patch(`/api/tasks/${task.id}`, {
      data: { description: "Set via API call" },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "API description task");

    // Description should be rendered as markdown preview
    await expect(dialog(page).getByText("Set via API call")).toBeVisible();
  });
});
