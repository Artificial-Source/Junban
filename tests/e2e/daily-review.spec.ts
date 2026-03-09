import { test, expect } from "@playwright/test";
import {
  setupPage,
  createTaskViaApi,
  completeTaskViaApi,
  navigateTo,
  localDateKey,
} from "./helpers.js";

test.describe("Daily Review Modal", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("End of Day button visible", async ({ page }) => {
    await navigateTo(page, "Today");
    await expect(page.getByRole("button", { name: "End of Day" })).toBeVisible();
  });

  test("shows completed tasks", async ({ page }) => {
    const today = localDateKey();

    const task = await createTaskViaApi(page, "Finished review task", { dueDate: today });
    await completeTaskViaApi(page, task.id);

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");
    await page.getByRole("button", { name: "End of Day" }).click();

    // Step 0: Today's Wins should show the completed task
    await expect(page.getByText("Today's Wins")).toBeVisible();
    await expect(page.getByText("Finished review task")).toBeVisible({ timeout: 5000 });
  });

  test("navigate through all steps", async ({ page }) => {
    await navigateTo(page, "Today");
    await page.getByRole("button", { name: "End of Day" }).click();

    // Step 0: Today's Wins
    await expect(page.getByText("Today's Wins")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 1: Carried Over
    await expect(page.getByText("Carried Over")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 2: Tomorrow Preview
    await expect(page.getByText("Tomorrow Preview")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 3: Done!
    await expect(page.getByText("Done!")).toBeVisible();
    await page.getByRole("button", { name: "End My Day" }).click();

    // Modal should close
    await expect(page.getByText("Done!")).not.toBeVisible();
  });

  test("carry over to tomorrow", async ({ page }) => {
    const today = localDateKey();

    await createTaskViaApi(page, "Carry me over", { dueDate: today });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");
    await page.getByRole("button", { name: "End of Day" }).click();

    // Navigate to Carried Over step
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Carried Over")).toBeVisible();

    // Click Move to Tomorrow
    await page.getByRole("button", { name: /Move to Tomorrow/i }).click();

    // Finish the flow
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "End My Day" }).click();

    // Navigate to Upcoming to verify the task was moved
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await navigateTo(page, "Upcoming");

    await expect(page.getByText("Carry me over")).toBeVisible({ timeout: 5000 });
  });
});
