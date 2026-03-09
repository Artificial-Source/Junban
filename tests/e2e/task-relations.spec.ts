import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, addRelationViaApi, openTaskDetail } from "./helpers.js";

test.describe("Task Relations (V2-15)", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("add blocks relation in task detail", async ({ page }) => {
    await createTaskViaApi(page, "Task Alpha");
    await createTaskViaApi(page, "Task Beta");

    await page.reload();
    await openTaskDetail(page, "Task Alpha");

    // Click "Add relation"
    await page.getByText("Add relation").click();

    // Search for Task Beta
    const searchInput = page.getByPlaceholder("Search tasks to link...");
    await searchInput.fill("Beta");

    // Select Task Beta from search results (use exact: true to avoid matching the task row)
    await page.getByRole("button", { name: "Task Beta", exact: true }).click();

    // Assert "Blocks" section shows Task Beta
    await expect(page.getByText("Blocks").first()).toBeVisible();
    await expect(
      page.locator("[class*='TaskDetailPanel'], [role='dialog']").getByText("Task Beta"),
    ).toBeVisible();
  });

  test("blocked task shows badge", async ({ page }) => {
    const taskA = await createTaskViaApi(page, "Blocker Task");
    const taskB = await createTaskViaApi(page, "Blocked Task");

    await addRelationViaApi(page, taskA.id, taskB.id);
    await page.reload();

    // Navigate to Inbox and check for Blocked badge
    await expect(page.getByText("Blocked").first()).toBeVisible({ timeout: 5000 });
  });

  test("remove relation", async ({ page }) => {
    const taskA = await createTaskViaApi(page, "Remover Task");
    const taskB = await createTaskViaApi(page, "Removed Relation");

    await addRelationViaApi(page, taskA.id, taskB.id);
    await page.reload();

    await openTaskDetail(page, "Remover Task");

    // Assert relation is shown
    await expect(page.getByText("Blocks").first()).toBeVisible();

    // Click remove button (X) on the relation
    const relationRow = page
      .locator("[class*='TaskDetailPanel'], [role='dialog']")
      .getByText("Removed Relation")
      .locator("..");
    await relationRow.getByTitle("Remove relation").click();

    // Assert relation is gone
    await expect(
      page.locator("[class*='TaskDetailPanel'], [role='dialog']").getByText("Removed Relation"),
    ).not.toBeVisible();
  });

  test("cycle prevention returns 400", async ({ page }) => {
    const taskA = await createTaskViaApi(page, "Cycle A");
    const taskB = await createTaskViaApi(page, "Cycle B");

    // Create A blocks B
    await addRelationViaApi(page, taskA.id, taskB.id);

    // Attempt B blocks A — should fail with 400
    const response = await page.request.post(`/api/tasks/${taskB.id}/relations`, {
      data: { relatedTaskId: taskA.id, type: "blocks" },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("cycle");
  });
});
