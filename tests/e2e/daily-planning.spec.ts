import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, navigateTo, localDateKey } from "./helpers.js";

test.describe("Daily Planning Modal", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("Plan My Day button visible in Today view", async ({ page }) => {
    await navigateTo(page, "Today");
    await expect(page.getByRole("button", { name: "Plan My Day" })).toBeVisible();
  });

  test("opens modal with overdue step", async ({ page }) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    await createTaskViaApi(page, "Overdue planning task", {
      dueDate: localDateKey(yesterday),
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");
    await page.getByRole("button", { name: "Plan My Day" }).click();

    // Modal should be visible with the overdue task
    await expect(page.getByText("Review Overdue")).toBeVisible();
    // Task appears in both the task list and the modal — use first() to avoid strict mode
    await expect(page.getByText("Overdue planning task").first()).toBeVisible();
  });

  test("navigate through all steps", async ({ page }) => {
    await navigateTo(page, "Today");
    await page.getByRole("button", { name: "Plan My Day" }).click();

    // Step 0: Review Overdue
    await expect(page.getByText("Review Overdue")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 1: Today's Focus
    await expect(page.getByText("Today's Focus")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 2: Time Budget
    await expect(page.getByText("Time Budget")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 3: Ready!
    await expect(page.getByText("Ready!")).toBeVisible();
    await page.getByRole("button", { name: "Start My Day" }).click();

    // Modal should close
    await expect(page.getByText("Ready!")).not.toBeVisible();
  });

  test("reschedule overdue task", async ({ page }) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    await createTaskViaApi(page, "Rescue this task", {
      dueDate: localDateKey(yesterday),
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");
    await page.getByRole("button", { name: "Plan My Day" }).click();

    // Wait for modal + overdue step
    await expect(page.getByText("Review Overdue")).toBeVisible();
    // Task appears in both the task list and the modal — use first() to avoid strict mode
    await expect(page.getByText("Rescue this task").first()).toBeVisible();

    // Click reschedule on the overdue task (in the modal, the button says "Reschedule to today")
    await page.getByRole("button", { name: "Reschedule to today" }).click();

    // Reload and verify the task is now in the Today section
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await navigateTo(page, "Today");

    await expect(page.getByText("Rescue this task")).toBeVisible({ timeout: 5000 });
  });
});
