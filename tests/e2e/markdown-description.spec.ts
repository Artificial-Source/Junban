import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, openTaskDetail, updateTaskViaApi } from "./helpers.js";

const dialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Task details" });

test.describe("Markdown description rendering", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("markdown preview renders in task detail", async ({ page }) => {
    const task = await createTaskViaApi(page, "Markdown task");
    await updateTaskViaApi(page, task.id, {
      description: "## Heading\n**bold** text",
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Markdown task");

    // The rendered markdown should show an h2 heading and bold text, not raw markdown
    const detail = dialog(page);
    await expect(detail.locator("h2").filter({ hasText: "Heading" })).toBeVisible();
    await expect(detail.locator("strong").filter({ hasText: "bold" })).toBeVisible();
    // Raw markdown syntax should NOT be visible
    await expect(detail.getByText("## Heading")).not.toBeVisible();
  });

  test("click on preview enters edit mode", async ({ page }) => {
    const task = await createTaskViaApi(page, "Click to edit");
    await updateTaskViaApi(page, task.id, {
      description: "Some **markdown** content",
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Click to edit");

    const detail = dialog(page);

    // Click on the rendered markdown preview area
    await detail.locator("strong").filter({ hasText: "markdown" }).click();

    // A textarea should appear with the raw markdown
    const textarea = detail.getByLabel("Description");
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue("Some **markdown** content");
  });

  test("edit mode saves on blur", async ({ page }) => {
    const task = await createTaskViaApi(page, "Edit and blur");
    await updateTaskViaApi(page, task.id, {
      description: "Original text",
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Edit and blur");

    const detail = dialog(page);

    // Click the markdown preview to enter edit mode
    await detail.getByText("Original text").click();

    // Change the text
    const textarea = detail.getByLabel("Description");
    await textarea.fill("Updated **description**");

    // Blur by clicking the title input
    await detail.locator("input[type='text']").first().click();

    // Close and reopen to verify persistence
    await detail.getByLabel("Close task details").click();
    await openTaskDetail(page, "Edit and blur");

    // Should render the updated markdown
    await expect(dialog(page).locator("strong").filter({ hasText: "description" })).toBeVisible();
  });
});
