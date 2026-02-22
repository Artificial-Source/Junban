import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, openTaskDetail, closeTaskDetail } from "./helpers.js";

const dialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Task details" });

/** Click the Comments tab within the task detail dialog. */
async function clickCommentsTab(page: import("@playwright/test").Page) {
  // The Comments tab might take a moment to render after comments are fetched
  const commentsTab = dialog(page).getByRole("button", { name: /^Comments/ });
  await expect(commentsTab).toBeVisible({ timeout: 5000 });
  await commentsTab.click();
}

test.describe("Task comments", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("comments tab is visible in the task detail panel", async ({ page }) => {
    await createTaskViaApi(page, "Commentable task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Commentable task");

    // The Comments tab button should be visible in the detail panel
    const commentsTab = dialog(page).getByRole("button", { name: /^Comments/ });
    await expect(commentsTab).toBeVisible({ timeout: 5000 });
  });

  test("can add a comment to a task", async ({ page }) => {
    await createTaskViaApi(page, "Task with comment");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Task with comment");

    // Click the Comments tab to activate it
    await clickCommentsTab(page);

    // The comment input area should be visible
    const commentInput = dialog(page).getByPlaceholder("Add a comment...");
    await expect(commentInput).toBeVisible({ timeout: 5000 });

    // Type a comment
    await commentInput.click();
    await commentInput.fill("This is my first comment.");

    // Submit the comment by clicking the Comment button (exact match to avoid "Comments" tab)
    await dialog(page).getByRole("button", { name: "Comment", exact: true }).click();

    // Verify the comment appears within the dialog
    await expect(dialog(page).getByText("This is my first comment.")).toBeVisible({
      timeout: 5000,
    });

    // The comment input should be cleared after submission
    await expect(commentInput).toHaveValue("");
  });

  test("can add multiple comments", async ({ page }) => {
    await createTaskViaApi(page, "Multi-comment task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Multi-comment task");

    await clickCommentsTab(page);

    const commentInput = dialog(page).getByPlaceholder("Add a comment...");

    // Add first comment
    await commentInput.fill("First comment");
    await dialog(page).getByRole("button", { name: "Comment", exact: true }).click();
    await expect(dialog(page).getByText("First comment", { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });

    // Add second comment
    await commentInput.fill("Second comment");
    await dialog(page).getByRole("button", { name: "Comment", exact: true }).click();
    await expect(dialog(page).getByText("Second comment", { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });

    // Both comments should be visible
    await expect(dialog(page).getByText("First comment", { exact: true }).first()).toBeVisible();
    await expect(dialog(page).getByText("Second comment", { exact: true }).first()).toBeVisible();
  });

  test("can submit a comment with Enter key", async ({ page }) => {
    await createTaskViaApi(page, "Enter key comment");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Enter key comment");

    await clickCommentsTab(page);

    const commentInput = dialog(page).getByPlaceholder("Add a comment...");
    await commentInput.fill("Submitted via Enter");

    // Press Enter to submit (without Shift)
    await commentInput.press("Enter");

    // The comment should appear within the dialog
    await expect(dialog(page).getByText("Submitted via Enter").first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("empty comments cannot be submitted", async ({ page }) => {
    await createTaskViaApi(page, "No empty comments");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "No empty comments");

    await clickCommentsTab(page);

    // The submit button should be disabled when the input is empty
    const submitBtn = dialog(page).getByRole("button", { name: "Comment", exact: true });
    await expect(submitBtn).toBeDisabled();
  });

  test("comments persist after closing and reopening the detail panel", async ({ page }) => {
    await createTaskViaApi(page, "Persistent comment task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Persistent comment task");

    await clickCommentsTab(page);

    const commentInput = dialog(page).getByPlaceholder("Add a comment...");
    await commentInput.fill("Persistent comment");

    await dialog(page).getByRole("button", { name: "Comment", exact: true }).click();
    await expect(dialog(page).getByText("Persistent comment", { exact: true }).first()).toBeVisible(
      { timeout: 5000 },
    );

    // Close and reopen the detail panel
    await closeTaskDetail(page);
    await openTaskDetail(page, "Persistent comment task");

    // Click the Comments tab again
    await clickCommentsTab(page);

    // The comment should still be there
    await expect(dialog(page).getByText("Persistent comment", { exact: true }).first()).toBeVisible(
      { timeout: 5000 },
    );
  });

  test("shows empty state when no comments exist", async ({ page }) => {
    await createTaskViaApi(page, "No comments task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "No comments task");

    await clickCommentsTab(page);

    // Should show "No comments yet." empty state
    await expect(dialog(page).getByText("No comments yet.")).toBeVisible({ timeout: 5000 });
  });

  test("disabling feature_comments hides the Comments tab", async ({ page }) => {
    await createTaskViaApi(page, "Hidden comments task");

    // Disable comments via the API
    await page.request.put("/api/settings/feature_comments", {
      data: { value: "false" },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Hidden comments task");

    // The Comments tab should NOT be visible
    const commentsTab = dialog(page).getByRole("button", { name: /^Comments/ });
    await expect(commentsTab).not.toBeVisible({ timeout: 3000 });

    // Re-enable for cleanup
    await page.request.put("/api/settings/feature_comments", {
      data: { value: "true" },
    });
  });
});
