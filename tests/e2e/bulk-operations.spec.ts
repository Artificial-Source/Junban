import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, createProjectViaApi } from "./helpers.js";

test.describe("Bulk operations", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("Ctrl+click multi-select shows count", async ({ page }) => {
    await createTaskViaApi(page, "Bulk task A");
    await createTaskViaApi(page, "Bulk task B");
    await createTaskViaApi(page, "Bulk task C");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Ctrl+click two tasks
    await page.getByLabel("Task: Bulk task A").click({ modifiers: ["Control"] });
    await page.getByLabel("Task: Bulk task B").click({ modifiers: ["Control"] });

    // Bulk action bar should show
    await expect(page.getByText("2 selected")).toBeVisible({ timeout: 5000 });
  });

  test("bulk complete", async ({ page }) => {
    await createTaskViaApi(page, "Complete me A");
    await createTaskViaApi(page, "Complete me B");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Multi-select both tasks
    await page.getByLabel("Task: Complete me A").click({ modifiers: ["Control"] });
    await page.getByLabel("Task: Complete me B").click({ modifiers: ["Control"] });

    await expect(page.getByText("2 selected")).toBeVisible();

    // Click Complete button in bulk action bar (scope to avoid sidebar "Completed" match)
    await page.getByRole("button", { name: "Complete", exact: true }).first().click();

    // Tasks should show as completed (line-through) in Inbox
    // Recently completed tasks remain visible with strikethrough styling
    await expect(page.getByText("2 selected")).not.toBeVisible({ timeout: 5000 });
    // Verify both tasks now show the "Mark task incomplete" button (meaning they are completed)
    const incompleteButtons = page.getByLabel("Mark task incomplete");
    await expect(incompleteButtons).toHaveCount(2, { timeout: 5000 });
  });

  test("bulk delete", async ({ page }) => {
    await createTaskViaApi(page, "Delete me A");
    await createTaskViaApi(page, "Delete me B");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.getByLabel("Task: Delete me A").click({ modifiers: ["Control"] });
    await page.getByLabel("Task: Delete me B").click({ modifiers: ["Control"] });

    await expect(page.getByText("2 selected")).toBeVisible();

    await page.getByRole("button", { name: "Delete", exact: true }).first().click();

    await expect(page.getByText("Delete me A")).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Delete me B")).not.toBeVisible();
  });

  test("bulk move to project", async ({ page }) => {
    const _project = await createProjectViaApi(page, "Bulk Target");
    await createTaskViaApi(page, "Move task A");
    await createTaskViaApi(page, "Move task B");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.getByLabel("Task: Move task A").click({ modifiers: ["Control"] });
    await page.getByLabel("Task: Move task B").click({ modifiers: ["Control"] });

    await expect(page.getByText("2 selected")).toBeVisible();

    // Click Move, then select project from dropdown within main content
    await page.getByRole("button", { name: "Move", exact: true }).first().click();
    // The dropdown appears inside the bulk action bar; click the project name in main area
    await page.locator("main").getByText("Bulk Target").click();

    // Tasks should disappear from Inbox (moved to project)
    await expect(page.getByText("Move task A")).not.toBeVisible({ timeout: 5000 });

    // Navigate to the project to verify
    await page.getByRole("button", { name: /^Bulk Target/ }).click();
    await expect(page.getByText("Move task A")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Move task B")).toBeVisible();
  });

  test("clear selection", async ({ page }) => {
    await createTaskViaApi(page, "Select then clear");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.getByLabel("Task: Select then clear").click({ modifiers: ["Control"] });
    await expect(page.getByText("1 selected")).toBeVisible();

    // Click the clear (X) button
    await page.getByRole("button", { name: "Clear selection" }).click();

    await expect(page.getByText("1 selected")).not.toBeVisible({ timeout: 5000 });
  });
});
