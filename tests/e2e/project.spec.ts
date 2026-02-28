import { test, expect } from "@playwright/test";
import {
  setupPage,
  createProjectViaApi,
  createTaskViaApi,
  completeTaskViaApi,
  navigateTo,
} from "./helpers.js";

test.describe("Project view", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("create project via modal", async ({ page }) => {
    // Click the add project button in sidebar
    await page.getByRole("button", { name: "Add project" }).click();

    // Fill in the project name
    const nameInput = page.getByPlaceholder("Project name");
    await nameInput.fill("Test Project");
    await page.getByRole("button", { name: "Create" }).click();

    // Project should appear in sidebar
    await expect(page.getByText("Test Project")).toBeVisible({ timeout: 5000 });
  });

  test("project shows in sidebar", async ({ page }) => {
    await createProjectViaApi(page, "Sidebar Project");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("Sidebar Project")).toBeVisible();
  });

  test("add tasks to project", async ({ page }) => {
    const project = await createProjectViaApi(page, "Task Project");
    await createTaskViaApi(page, "Project task 1", { projectId: project.id });
    await createTaskViaApi(page, "Project task 2", { projectId: project.id });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Navigate to the project
    await page.getByText("Task Project").click();

    await expect(page.getByText("Project task 1")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Project task 2")).toBeVisible();
  });

  test("shows task count", async ({ page }) => {
    const project = await createProjectViaApi(page, "Count Project");
    await createTaskViaApi(page, "Count 1", { projectId: project.id });
    await createTaskViaApi(page, "Count 2", { projectId: project.id });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.getByText("Count Project").click();

    await expect(page.getByText("2 tasks")).toBeVisible({ timeout: 5000 });
  });

  test("shows completion ring", async ({ page }) => {
    const project = await createProjectViaApi(page, "Ring Project");
    const task1 = await createTaskViaApi(page, "Ring task 1", { projectId: project.id });
    await createTaskViaApi(page, "Ring task 2", { projectId: project.id });
    await completeTaskViaApi(page, task1.id);

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.getByText("Ring Project").click();

    // Completion ring should show (SVG circle element)
    await expect(page.locator("svg circle").first()).toBeVisible({ timeout: 5000 });
    // Should show "1 of 2" or similar completion text
    await expect(page.getByText(/1\s*of\s*2/).first()).toBeVisible();
  });

  test("project tasks not shown in Inbox", async ({ page }) => {
    const project = await createProjectViaApi(page, "Isolated Project");
    await createTaskViaApi(page, "Inbox task");
    await createTaskViaApi(page, "Hidden from inbox", { projectId: project.id });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Inbox should show the inbox task but not the project task
    await expect(page.getByText("Inbox task")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Hidden from inbox")).not.toBeVisible();
  });
});
