import { test, expect } from "@playwright/test";
import {
  setupPage,
  createTaskViaApi,
  completeTaskViaApi,
  openTaskDetail,
  updateTaskViaApi,
} from "./helpers.js";

test.describe("Actual Time Tracking (V2-14)", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("completed task shows actual time input", async ({ page }) => {
    const task = await createTaskViaApi(page, "Time Track Task", {
      estimatedMinutes: 30,
    });
    await completeTaskViaApi(page, task.id);
    await page.reload();

    await openTaskDetail(page, "Time Track Task");

    // Assert "Actual time (minutes)" input is visible
    await expect(page.getByText("Actual time (minutes)")).toBeVisible();
  });

  test("enter and persist actual minutes", async ({ page }) => {
    const task = await createTaskViaApi(page, "Persist Actual", {
      estimatedMinutes: 30,
    });
    await completeTaskViaApi(page, task.id);
    await page.reload();

    await openTaskDetail(page, "Persist Actual");

    // Fill in actual minutes (last spinbutton is the actual time input)
    const input = page.getByRole("spinbutton").last();
    await input.fill("45");
    // Blur to trigger save
    await input.blur();

    // Close and reopen to verify persistence
    await page.keyboard.press("Escape");
    await page.reload();
    await openTaskDetail(page, "Persist Actual");

    // Assert the value persisted
    await expect(page.getByRole("spinbutton").last()).toHaveValue("45");
  });

  test("stats shows estimation accuracy", async ({ page }) => {
    // Create tasks with estimates, complete them, set actual minutes via API
    const task1 = await createTaskViaApi(page, "Accuracy Task 1", {
      estimatedMinutes: 30,
    });
    const task2 = await createTaskViaApi(page, "Accuracy Task 2", {
      estimatedMinutes: 60,
    });

    await completeTaskViaApi(page, task1.id);
    await completeTaskViaApi(page, task2.id);

    await updateTaskViaApi(page, task1.id, { actualMinutes: 25 });
    await updateTaskViaApi(page, task2.id, { actualMinutes: 55 });

    await page.reload();

    // Navigate to Stats
    await page.getByRole("button", { name: "Stats", exact: true }).click();

    // Assert accuracy section is visible
    await expect(page.getByText("Estimation Accuracy")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Tasks tracked")).toBeVisible();
  });

  test("pending task hides actual time input", async ({ page }) => {
    await createTaskViaApi(page, "Pending No Actual", {
      estimatedMinutes: 30,
    });
    await page.reload();

    await openTaskDetail(page, "Pending No Actual");

    // Assert actual time input is NOT visible
    await expect(page.getByText("Actual time (minutes)")).not.toBeVisible();
  });
});
