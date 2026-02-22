import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, openTaskDetail, closeTaskDetail } from "./helpers.js";

const dialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Task details" });

test.describe("Task descriptions", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("can type a description in the task detail panel", async ({ page }) => {
    // Create a task via API
    await createTaskViaApi(page, "Write docs");

    // Reload so the task appears in the Inbox
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Open the task detail panel
    await openTaskDetail(page, "Write docs");

    // Find the description textarea by its placeholder
    const descriptionField = dialog(page).getByPlaceholder("Description");
    await expect(descriptionField).toBeVisible();

    // Type a markdown description
    await descriptionField.click();
    await descriptionField.fill(
      "## Overview\n\n**Bold text** and regular text.\n\n- Item one\n- Item two\n- Item three",
    );

    // Click on the task title input within the dialog to blur the description
    await dialog(page).locator("input[type='text']").first().click();

    // Close and reopen the detail panel to verify persistence
    await closeTaskDetail(page);
    await openTaskDetail(page, "Write docs");

    // Verify the description text is preserved
    const descriptionAfterReopen = dialog(page).getByPlaceholder("Description");
    await expect(descriptionAfterReopen).toHaveValue(/Bold text/);
    await expect(descriptionAfterReopen).toHaveValue(/Item one/);
    await expect(descriptionAfterReopen).toHaveValue(/Item two/);
  });

  test("empty description shows placeholder text", async ({ page }) => {
    await createTaskViaApi(page, "Empty description task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Empty description task");

    const descriptionField = dialog(page).getByPlaceholder("Description");
    await expect(descriptionField).toBeVisible();

    // The textarea should be empty and show the placeholder
    await expect(descriptionField).toHaveValue("");
  });

  test("description persists across page reloads", async ({ page }) => {
    await createTaskViaApi(page, "Persistent description");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Persistent description");

    const descriptionField = dialog(page).getByPlaceholder("Description");
    await descriptionField.click();
    await descriptionField.fill("This should persist after reload.");

    // Blur to save
    await dialog(page).locator("input[type='text']").first().click();

    // Close detail panel
    await closeTaskDetail(page);

    // Reload the entire page
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Reopen the task detail
    await openTaskDetail(page, "Persistent description");

    const descAfterReload = dialog(page).getByPlaceholder("Description");
    await expect(descAfterReload).toHaveValue("This should persist after reload.");
  });

  test("description can be cleared", async ({ page }) => {
    await createTaskViaApi(page, "Clear me");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Clear me");

    const descriptionField = dialog(page).getByPlaceholder("Description");

    // Set initial description
    await descriptionField.click();
    await descriptionField.fill("Some initial text");

    // Blur to save — click on the title input inside the dialog
    await dialog(page).locator("input[type='text']").first().click();

    // Now clear the description
    await descriptionField.click();
    await descriptionField.fill("");

    // Blur to save
    await dialog(page).locator("input[type='text']").first().click();

    // Close and reopen to verify it was cleared
    await closeTaskDetail(page);
    await openTaskDetail(page, "Clear me");

    await expect(dialog(page).getByPlaceholder("Description")).toHaveValue("");
  });

  test("description supports multi-line text with newlines", async ({ page }) => {
    await createTaskViaApi(page, "Multi-line task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Multi-line task");

    const descriptionField = dialog(page).getByPlaceholder("Description");
    await descriptionField.click();

    const multiLineText = "Line 1\nLine 2\nLine 3\n\nParagraph 2";
    await descriptionField.fill(multiLineText);

    // Blur to save
    await dialog(page).locator("input[type='text']").first().click();

    // Close and reopen
    await closeTaskDetail(page);
    await openTaskDetail(page, "Multi-line task");

    await expect(dialog(page).getByPlaceholder("Description")).toHaveValue(multiLineText);
  });

  test("description set via API is shown in the detail panel", async ({ page }) => {
    // Create a task with a description via the API
    const task = await createTaskViaApi(page, "API description task");

    // Update the task with a description
    await page.request.patch(`/api/tasks/${task.id}`, {
      data: { description: "Set via API call" },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "API description task");

    const descriptionField = dialog(page).getByPlaceholder("Description");
    await expect(descriptionField).toHaveValue("Set via API call");
  });
});
