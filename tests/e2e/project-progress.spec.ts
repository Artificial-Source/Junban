import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, createProjectViaApi, completeTaskViaApi } from "./helpers.js";

test.describe("Project progress tracking", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("CompletionRing shows in project header", async ({ page }) => {
    const project = await createProjectViaApi(page, "Progress Project");

    await createTaskViaApi(page, "Task 1", { projectId: project.id });
    const task2 = await createTaskViaApi(page, "Task 2", { projectId: project.id });
    await createTaskViaApi(page, "Task 3", { projectId: project.id });

    // Complete one task
    await completeTaskViaApi(page, task2.id);

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Navigate to the project
    await page.getByRole("button", { name: /^Progress Project/ }).click();

    // The CompletionRing should show 1 of 3 completed
    await expect(page.getByLabel("1 of 3 tasks completed")).toBeVisible({ timeout: 5000 });
  });

  test("sidebar shows mini progress bar", async ({ page }) => {
    const project = await createProjectViaApi(page, "Sidebar Progress");

    const task1 = await createTaskViaApi(page, "Done task", { projectId: project.id });
    await createTaskViaApi(page, "Pending task", { projectId: project.id });

    await completeTaskViaApi(page, task1.id);

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // The sidebar project button should have a progress bar (title with "% complete")
    const sidebar = page.locator("aside[aria-label='Main navigation']");
    await expect(sidebar.locator("[title*='% complete']").first()).toBeVisible({ timeout: 5000 });
  });
});
