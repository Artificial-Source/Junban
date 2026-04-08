import { test, expect } from "@playwright/test";
import { setupPage, createProjectViaApi, navigateTo } from "./helpers.js";

test.describe("Kanban / Board view", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("project with board viewStyle renders board columns", async ({ page }) => {
    // Create a project with viewStyle "board"
    const project = await createProjectViaApi(page, "Sprint Board", {
      viewStyle: "board",
    });

    // Create sections via API (POST /api/sections)
    await page.request.post("/api/sections", {
      data: { projectId: project.id, name: "To Do" },
    });
    await page.request.post("/api/sections", {
      data: { projectId: project.id, name: "Done" },
    });

    // Reload to pick up the new project and sections
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Navigate to the project
    await navigateTo(page, "Sprint Board");

    // Verify the board layout renders -- look for column headers
    // The Board component renders columns with <h3> headers for each section name
    // plus a "No section" column
    await expect(
      page.getByRole("heading", { name: "No section" }).or(page.getByText("No section").first()),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByRole("heading", { name: "To Do" }).or(page.getByText("To Do").first()),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Done" }).or(page.getByText("Done").first()),
    ).toBeVisible();

    const boardColumnHeadings = page.getByRole("heading", { level: 3 });
    await expect(boardColumnHeadings.filter({ hasText: "No section" })).toBeVisible();
  });

  test("board columns show task counts", async ({ page }) => {
    // Create a board project with a section
    const project = await createProjectViaApi(page, "Kanban Test", {
      viewStyle: "board",
    });

    await page.request.post("/api/sections", {
      data: { projectId: project.id, name: "Backlog" },
    });

    // Reload and navigate
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await navigateTo(page, "Kanban Test");

    // Each column shows a task count badge (initially 0)
    // The BoardColumn renders a count span showing the number of tasks
    const countBadges = page.locator(".rounded-full", { hasText: "0" });
    await expect(countBadges.first()).toBeVisible({ timeout: 5000 });
  });

  test("empty board columns show drop zone placeholder", async ({ page }) => {
    const project = await createProjectViaApi(page, "Empty Board", {
      viewStyle: "board",
    });

    await page.request.post("/api/sections", {
      data: { projectId: project.id, name: "In Progress" },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await navigateTo(page, "Empty Board");

    // Empty columns show "Drop tasks here" placeholder text
    await expect(page.getByText("Drop tasks here").first()).toBeVisible({ timeout: 5000 });
  });

  test("disabling feature_kanban falls back to list view", async ({ page }) => {
    // Create a board project
    const project = await createProjectViaApi(page, "Fallback Board", {
      viewStyle: "board",
    });

    await page.request.post("/api/sections", {
      data: { projectId: project.id, name: "Column A" },
    });

    // Reload and navigate -- should show board view initially
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await navigateTo(page, "Fallback Board");

    // Disable kanban via the API
    await page.request.put("/api/settings/feature_kanban", {
      data: { value: "false" },
    });

    // Reload and navigate again
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await navigateTo(page, "Fallback Board");

    await expect(page.getByRole("heading", { name: "Column A", level: 3 })).not.toBeVisible({
      timeout: 3000,
    });

    // The project should still be viewable (with its name heading visible)
    await expect(page.getByRole("heading", { name: "Fallback Board", level: 1 })).toBeVisible();

    // Re-enable kanban for cleanup
    await page.request.put("/api/settings/feature_kanban", {
      data: { value: "true" },
    });
  });

  test("board project with list viewStyle does not show board layout", async ({ page }) => {
    // Create a project with list viewStyle (default)
    await createProjectViaApi(page, "List Project");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await navigateTo(page, "List Project");

    // Should not have the board layout
    const boardContainer = page.locator(".flex.gap-4.overflow-x-auto");
    await expect(boardContainer).not.toBeVisible({ timeout: 3000 });

    // Should show the standard project heading and task input
    await expect(page.getByPlaceholder(/Add a task/i)).toBeVisible();
  });
});
