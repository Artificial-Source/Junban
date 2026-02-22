import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, openTaskDetail, closeTaskDetail } from "./helpers.js";

const dialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Task details" });

test.describe("Task deadlines", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays the deadline date in the task detail metadata sidebar", async ({ page }) => {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);
    const deadlineISO = deadline.toISOString();

    await createTaskViaApi(page, "Submit report", { deadline: deadlineISO });
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Submit report");

    // The metadata sidebar should show the Deadline label
    const detailPanel = dialog(page);
    await expect(detailPanel.locator("label", { hasText: "Deadline" })).toBeVisible({
      timeout: 5000,
    });

    // The formatted date should be visible (e.g. "Feb 28")
    const expectedDate = deadline.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    await expect(detailPanel.getByText(expectedDate)).toBeVisible();
  });

  test("shows 'No deadline' after clearing the deadline", async ({ page }) => {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 5);

    await createTaskViaApi(page, "File taxes", {
      deadline: deadline.toISOString(),
    });
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "File taxes");

    const detailPanel = dialog(page);

    // Verify deadline is shown first
    await expect(detailPanel.locator("label", { hasText: "Deadline" })).toBeVisible({
      timeout: 5000,
    });

    // Click the clear deadline button (X icon next to Deadline label)
    const clearBtn = detailPanel.getByTitle("Clear deadline");
    await expect(clearBtn).toBeVisible({ timeout: 5000 });
    await clearBtn.click();

    // Verify "No deadline" text appears
    await expect(detailPanel.getByText("No deadline")).toBeVisible({ timeout: 5000 });
  });

  test("hides the Deadline section when feature_deadlines is disabled", async ({ page }) => {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 3);

    await createTaskViaApi(page, "Review contract", {
      deadline: deadline.toISOString(),
    });

    // Disable the deadlines feature via API
    await page.request.put("/api/settings/feature_deadlines", {
      data: { value: "false" },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await openTaskDetail(page, "Review contract");

    const detailPanel = dialog(page);

    // The Deadline label should not be visible
    await expect(detailPanel.locator("label", { hasText: "Deadline" })).not.toBeVisible();

    await closeTaskDetail(page);

    // Re-enable for cleanup
    await page.request.put("/api/settings/feature_deadlines", {
      data: { value: "true" },
    });
  });
});
